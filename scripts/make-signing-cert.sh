#!/bin/sh
# Makes Breakpatch's own code signing certificate. The owner runs this ONCE, on a Mac.
#
#   scripts/make-signing-cert.sh            # writes the secret files to a new private folder
#   scripts/make-signing-cert.sh --out DIR  # somewhere else (an empty or new folder)
#   scripts/make-signing-cert.sh --force    # replace a committed certificate (see below)
#   scripts/make-signing-cert.sh --public-dir DIR   # write the public files elsewhere (to try it)
#
# Why: Breakpatch keeps saved secrets and the licence in the macOS Keychain, and the Keychain
# lets an app back in only while its code signature satisfies the same "designated requirement".
# Releases signed with this one certificate keep that requirement the same from version to
# version, so updates never cause Keychain prompts. It isn't an Apple Developer ID: Gatekeeper
# doesn't know it (the install command avoids that), and an Apple ID can replace it later.
#
# It writes:
#   secret, to the private folder:  breakpatch-codesign.p12 (+ .p12.base64), the key, the password
#   public, into this checkout:     app/src-tauri/signing/breakpatch-codesign.cer (DER)
#                                   app/src-tauri/signing/fingerprint.txt (SHA-256)
# The release (scripts/build-release.sh) fails if the certificate in the BP_CODESIGN_P12 secret
# isn't the committed one. A new certificate means one Keychain prompt per saved item for every
# user after their next update, so --force is needed to replace a committed one.
#
# Works with the macOS openssl (LibreSSL) and OpenSSL 3 (Homebrew, Linux). On a Mac it also
# checks that `security import` accepts the .p12 and that codesign can sign with it.
# Environment: BP_CODESIGN_P12_PASSWORD  use this .p12 password instead of a random one.
set -eu

name="Breakpatch Code Signing"
days=3650
repo=$(cd "$(dirname "$0")/.." && pwd)
public_dir="$repo/app/src-tauri/signing"
out=""
force=0

say() { printf '%s\n' "$*"; }
die() { printf 'make-signing-cert: %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --out) [ $# -ge 2 ] || die "--out needs a folder"; out=$2; shift 2 ;;
    --force) force=1; shift ;;
    --public-dir) [ $# -ge 2 ] || die "--public-dir needs a folder"; public_dir=$2; shift 2 ;;
    -h|--help) sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option $1 (see --help)" ;;
  esac
done

command -v openssl >/dev/null 2>&1 || die "openssl not found"

if [ -f "$public_dir/fingerprint.txt" ] && [ "$force" -eq 0 ]; then
  die "$public_dir/fingerprint.txt exists: a certificate is committed already.
Releases must keep using it (a new one causes Keychain prompts for every user). Find the
.p12 in your password manager. To replace it on purpose, run again with --force."
fi

# The secret files go to a folder only you can read (macOS TMPDIR is per user already).
umask 077
if [ -n "$out" ]; then
  case "$out" in /*) ;; *) out="$PWD/$out" ;; esac
  case "$out/" in "$repo"/*) die "keep the secret files outside the checkout, not in $out" ;; esac
fi
if [ -z "$out" ]; then
  out=$(mktemp -d "${TMPDIR:-/tmp}/breakpatch-codesign.XXXXXX")
else
  mkdir -p "$out"
  [ -z "$(ls -A "$out")" ] || die "$out isn't empty"
fi
chmod 700 "$out"

key="$out/breakpatch-codesign.key.pem"
crt="$out/breakpatch-codesign.crt.pem"
p12="$out/breakpatch-codesign.p12"
cfg="$out/openssl.cnf"

password=${BP_CODESIGN_P12_PASSWORD:-$(openssl rand -base64 24 | tr -d '/+=\n')}
export BP_P12_PASS="$password"

# ---------------------------------------------------------------- the certificate

# A self-signed leaf for code signing only: not a CA, digital signature, the codeSigning EKU.
cat > "$cfg" <<EOF
[ req ]
distinguished_name = dn
prompt             = no
x509_extensions    = codesign
[ dn ]
CN = $name
O  = Breakpatch
[ codesign ]
basicConstraints       = critical, CA:false
keyUsage               = critical, digitalSignature
extendedKeyUsage       = critical, codeSigning
subjectKeyIdentifier   = hash
EOF

say "Making the certificate \"$name\" ($(openssl version | cut -d' ' -f1-2), valid $days days)…"
openssl req -x509 -new -newkey rsa:3072 -nodes -sha256 -days "$days" \
  -config "$cfg" -keyout "$key" -out "$crt" 2>"$out/openssl.log" \
  || { cat "$out/openssl.log" >&2; die "openssl couldn't make the certificate"; }

openssl x509 -in "$crt" -noout -text | grep -q "Code Signing" \
  || die "the certificate has no codeSigning extended key usage"

# ---------------------------------------------------------------- the .p12

# macOS `security import` reads only the old PKCS#12 algorithms (3DES, SHA-1 MAC). LibreSSL
# writes those by default; OpenSSL 3 writes AES + PBKDF2, which macOS rejects as a wrong
# password. So on OpenSSL 3 ask for the old ones by name (no legacy provider needed), else
# with -legacy.
export_p12() {
  openssl pkcs12 -export -inkey "$key" -in "$crt" -name "$name" -out "$p12" -passout env:BP_P12_PASS "$@"
}
case "$(openssl version)" in
  "OpenSSL 3"*)
    export_p12 -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES -macalg sha1 2>/dev/null \
      || export_p12 -legacy \
      || die "openssl couldn't write the .p12" ;;
  *)
    export_p12 || die "openssl couldn't write the .p12" ;;
esac

# Read it back (with -legacy if this OpenSSL needs it for the old algorithms).
p12_cert() {
  openssl pkcs12 -in "$p12" -nokeys -clcerts -passin env:BP_P12_PASS 2>/dev/null \
    || openssl pkcs12 -legacy -in "$p12" -nokeys -clcerts -passin env:BP_P12_PASS 2>/dev/null
}
p12_cert | openssl x509 -noout >/dev/null 2>&1 || die "couldn't read the .p12 back"
openssl base64 -A -in "$p12" > "$p12.base64"

sha256=$(openssl x509 -in "$crt" -noout -fingerprint -sha256 | sed 's/^.*=//')
sha1=$(openssl x509 -in "$crt" -noout -fingerprint -sha1 | sed 's/^.*=//' | tr -d ':' | tr 'A-F' 'a-f')

# ---------------------------------------------------------------- macOS: import and sign once

if [ "$(uname -s)" = Darwin ] && command -v security >/dev/null 2>&1; then
  say "Checking that macOS accepts it…"
  kc="$out/check.keychain-db"
  kc_pass=$(openssl rand -hex 16)
  # codesign only finds identities in keychains on the search list, so the check keychain goes
  # on it for the check (as build-release.sh does), and the list is put back afterwards.
  saved_list="$out/keychains.txt"
  security list-keychains -d user | sed 's/^[[:space:]]*"//; s/"[[:space:]]*$//' > "$saved_list"
  restore_keychains() {
    set --
    while IFS= read -r k; do [ -z "$k" ] || set -- "$@" "$k"; done < "$saved_list"
    security list-keychains -d user -s "$@"
  }
  cleanup_check() {
    restore_keychains 2>/dev/null || true
    security delete-keychain "$kc" 2>/dev/null || true
    rm -f "$saved_list" "$out/signing-check" "$out/signing-check.log"
  }
  security create-keychain -p "$kc_pass" "$kc"
  trap cleanup_check EXIT
  security set-keychain-settings -lut 600 "$kc"
  security unlock-keychain -p "$kc_pass" "$kc"
  security import "$p12" -k "$kc" -f pkcs12 -P "$password" -T /usr/bin/codesign >/dev/null \
    || die "macOS couldn't import the .p12"
  security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$kc_pass" "$kc" >/dev/null
  set --
  while IFS= read -r k; do [ -z "$k" ] || set -- "$@" "$k"; done < "$saved_list"
  security list-keychains -d user -s "$kc" "$@"
  security find-identity -p codesigning "$kc" | grep -qi "$sha1" \
    || die "macOS doesn't list it as a code signing identity"
  cp /usr/bin/true "$out/signing-check"
  codesign --force --sign "$sha1" --keychain "$kc" "$out/signing-check" 2>"$out/signing-check.log" \
    || die "codesign couldn't sign with it: $(cat "$out/signing-check.log")"
  codesign -d -r- "$out/signing-check" 2>&1 | grep -qi "$sha1" \
    || die "the test signature doesn't name this certificate"
  cleanup_check
  trap - EXIT
  say "macOS imports it and codesign signs with it."
else
  say "Not a Mac: skipped checking it with macOS security and codesign."
fi

# ---------------------------------------------------------------- the public part

umask 022
mkdir -p "$public_dir"
openssl x509 -in "$crt" -outform der -out "$public_dir/breakpatch-codesign.cer"
chmod 644 "$public_dir/breakpatch-codesign.cer"
printf '%s\n' "$sha256" > "$public_dir/fingerprint.txt"
chmod 644 "$public_dir/fingerprint.txt"

cat <<EOF

Done. The certificate "$name":
  SHA-256  $sha256
  SHA-1    $sha1   (what codesign shows in the designated requirement)
  expires  $(openssl x509 -in "$crt" -noout -enddate | sed 's/^notAfter=//')

Secret files (only you can read them): $out

1. Add two secrets to BreakPatch/breakpatch (Settings → Secrets and variables → Actions):

     BP_CODESIGN_P12           the contents of $p12.base64
     BP_CODESIGN_P12_PASSWORD  $password

   or with the GitHub CLI:

     gh secret set BP_CODESIGN_P12 --repo BreakPatch/breakpatch < "$p12.base64"
     gh secret set BP_CODESIGN_P12_PASSWORD --repo BreakPatch/breakpatch   # paste the password

2. Keep a backup: put $p12 and the password in your password manager.
   Without them, later releases can't keep the same signature.

3. Commit the public part:

     git add app/src-tauri/signing/breakpatch-codesign.cer app/src-tauri/signing/fingerprint.txt

4. Delete the working files:

     rm -rf "$out"
EOF
