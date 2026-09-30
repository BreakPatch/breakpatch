//! Workspace keys: end-to-end encryption of a Team workspace's test content (Team issue #39 H2,
//! docs/manual.md "Encryption and the recovery code").
//!
//! Test, app, suite and shared-step names, descriptions, steps, start addresses, run results and
//! explanations, and where results and issues go are sealed on the Mac before they reach the
//! workspace, so the database holds ciphertext. Ids, times, versions, pass/fail, counts, roles and
//! membership stay readable: the security rules and the run history's expiry need them.
//!
//! All the cryptography is here, in the open repo, so it can be audited. The UI hands in content
//! and gets content back; it never gets a key (the recovery code and the machine key are shown to
//! the admin once, to write down, and the invite link's key goes to the clipboard from here).
//!
//! **Keys.**
//! - The *data key*: 32 random bytes per key version (`kid` 1, 2, …), made on the first admin's
//!   Mac. Kept in the Keychain, service `dev.breakpatch.workspace-keys`, entry `people:<ws>`, with
//!   every version this Mac holds (content sealed under an older version stays readable).
//! - The *device key*: an X25519 pair per workspace per Mac (`device:<ws>`). An admin's Mac seals
//!   the data keys to its public half when the admin approves the Mac.
//! - The *recovery code*: 128 random bits shown once as `BPR1-XXXX-…` (Crockford base32 and a
//!   check character). An X25519 pair is derived from it; the workspace keeps the public half and a
//!   copy of the data keys sealed to it (`keys/recovery`). Any admin's Mac can re-lock that copy
//!   after a new key version without the code. The service never sees the code.
//! - The *machine key* (`bpmk1_…`): the same idea for the local runner and `breakpatch-ci`
//!   (`BREAKPATCH_MACHINE_KEY`), in `keys/machine`.
//!
//! **Formats** (test vectors in `testdata/workspace-keys-v1.json`; the Team engine's Python reads
//! the same):
//! - A content field is `{ enc, kid }`: `enc` is base64 of a 24-byte nonce and the
//!   XChaCha20-Poly1305 ciphertext of the field's JSON. The key is
//!   `HKDF-SHA256(salt = ws, ikm = data key, info = "bp-field-v1")`; the associated data
//!   `bp-field-v1|<ws>|<document path>|<field>|<kid>` binds it to the workspace, the document, the
//!   field and the key version, so it can't be moved to another place unnoticed.
//! - A sealed key is `{ kid, epk, enc }`: an ephemeral X25519 key `epk`, the key
//!   `HKDF-SHA256(salt = epk ‖ recipient public key, ikm = shared secret, info = "bp-seal-v1")`, and
//!   the data key sealed with associated data `bp-seal-v1|<ws>|<recipient>|<kid>` (the recipient is
//!   a device id, `recovery` or `machine`).
//! - `ws` is the workspace's connection id (`team:<project>/<database>` or `hosted:<id>`), and a
//!   document path is relative to the workspace (`apps/<id>/tests/<id>`), the same for own Firebase
//!   and Breakpatch Cloud.

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex};

use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine as _;
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use hkdf::Hkdf;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use x25519_dalek::{PublicKey, StaticSecret};
use zeroize::Zeroizing;

use crate::secrets::SecretStore;

pub const SERVICE: &str = "dev.breakpatch.workspace-keys";
const FIELD_INFO: &str = "bp-field-v1";
const SEAL_INFO: &str = "bp-seal-v1";
const RECOVERY_INFO: &str = "bp-recovery-v1";
const MACHINE_INFO: &str = "bp-machine-v1";
const RECOVERY_PREFIX: &str = "BPR1";
const MACHINE_PREFIX: &str = "bpmk1_";
/// The most content one field may carry (the rules cap the stored text a little above this).
pub const MAX_FIELD_BYTES: usize = 700_000;
/// The most fields one call seals or opens.
pub const MAX_ITEMS: usize = 2000;

type Key = Zeroizing<[u8; 32]>;

fn random<const N: usize>() -> Result<[u8; N], String> {
    let mut b = [0u8; N];
    getrandom::fill(&mut b).map_err(|e| format!("This Mac couldn't make a random key: {e}"))?;
    Ok(b)
}

fn hkdf32(salt: &[u8], ikm: &[u8], info: &str) -> Key {
    let mut out = Zeroizing::new([0u8; 32]);
    Hkdf::<Sha256>::new(Some(salt), ikm).expand(info.as_bytes(), &mut out[..]).expect("32 bytes is a valid HKDF length");
    out
}

fn aead(key: &[u8; 32]) -> XChaCha20Poly1305 {
    XChaCha20Poly1305::new(key.into())
}

fn plain_part(s: &str, what: &str) -> Result<(), String> {
    if s.is_empty() || s.contains('|') || s.len() > 512 {
        return Err(format!("{what} can't be used in a sealed field"));
    }
    Ok(())
}

fn key32(b64: &str) -> Result<Key, String> {
    let raw = STANDARD.decode(b64.trim()).or_else(|_| URL_SAFE_NO_PAD.decode(b64.trim())).map_err(|_| "not a key")?;
    let arr: [u8; 32] = raw.as_slice().try_into().map_err(|_| "not a 32-byte key")?;
    Ok(Zeroizing::new(arr))
}

// ---- Content fields -------------------------------------------------------------------------

/// The associated data of a content field.
pub fn field_ad(ws: &str, path: &str, field: &str, kid: u32) -> String {
    format!("{FIELD_INFO}|{ws}|{path}|{field}|{kid}")
}

/// Seals one field's JSON with a given nonce (tests use fixed ones; `seal_field` a random one).
pub fn seal_field_with(data_key: &[u8; 32], ws: &str, path: &str, field: &str, kid: u32, nonce: [u8; 24], json: &[u8]) -> Result<String, String> {
    plain_part(ws, "The workspace")?;
    plain_part(field, "The field name")?;
    if path.is_empty() || path.len() > 1500 {
        return Err("The document path can't be used in a sealed field".into());
    }
    if json.len() > MAX_FIELD_BYTES {
        return Err(format!("{field} is too big to save ({} KB; the most is {} KB).", json.len() / 1024, MAX_FIELD_BYTES / 1024));
    }
    let key = hkdf32(ws.as_bytes(), data_key, FIELD_INFO);
    let ad = field_ad(ws, path, field, kid);
    let ct = aead(&key)
        .encrypt(XNonce::from_slice(&nonce), Payload { msg: json, aad: ad.as_bytes() })
        .map_err(|_| "Couldn't seal the field.".to_string())?;
    let mut out = nonce.to_vec();
    out.extend_from_slice(&ct);
    Ok(STANDARD.encode(out))
}

pub fn seal_field(data_key: &[u8; 32], ws: &str, path: &str, field: &str, kid: u32, json: &[u8]) -> Result<String, String> {
    seal_field_with(data_key, ws, path, field, kid, random()?, json)
}

/// Opens one field: its JSON, or an error when it isn't this workspace's, place's or key's.
pub fn open_field(data_key: &[u8; 32], ws: &str, path: &str, field: &str, kid: u32, enc: &str) -> Result<Vec<u8>, String> {
    let raw = STANDARD.decode(enc.trim()).map_err(|_| "The sealed field isn't readable.".to_string())?;
    if raw.len() < 24 + 16 {
        return Err("The sealed field is too short.".into());
    }
    let key = hkdf32(ws.as_bytes(), data_key, FIELD_INFO);
    let ad = field_ad(ws, path, field, kid);
    aead(&key).decrypt(XNonce::from_slice(&raw[..24]), Payload { msg: &raw[24..], aad: ad.as_bytes() })
        .map_err(|_| "The sealed field doesn't open with this key.".to_string())
}

// ---- Sealing a key to an X25519 public key (devices, the recovery code, the machine key) ------

/// A data key version sealed to one recipient: `keys/recovery`, `keys/machine`, `keyGrants/*`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct Sealed {
    pub kid: u32,
    pub epk: String,
    pub enc: String,
}

pub fn seal_ad(ws: &str, recipient: &str, kid: u32) -> String {
    format!("{SEAL_INFO}|{ws}|{recipient}|{kid}")
}

fn seal_key(epk: &[u8; 32], pk: &[u8; 32], shared: &[u8; 32]) -> Key {
    let mut salt = [0u8; 64];
    salt[..32].copy_from_slice(epk);
    salt[32..].copy_from_slice(pk);
    hkdf32(&salt, shared, SEAL_INFO)
}

/// Seals `key` to `recipient_pk` with a given ephemeral secret and nonce (for the test vectors).
pub fn seal_to_with(recipient_pk: &[u8; 32], eph: [u8; 32], nonce: [u8; 24], ws: &str, recipient: &str, kid: u32, key: &[u8; 32]) -> Result<Sealed, String> {
    plain_part(ws, "The workspace")?;
    plain_part(recipient, "The recipient")?;
    let eph = StaticSecret::from(eph);
    let epk = PublicKey::from(&eph).to_bytes();
    let shared = eph.diffie_hellman(&PublicKey::from(*recipient_pk));
    if !shared.was_contributory() {
        return Err("That device key isn't valid.".into());
    }
    let k = seal_key(&epk, recipient_pk, shared.as_bytes());
    let ad = seal_ad(ws, recipient, kid);
    let ct = aead(&k)
        .encrypt(XNonce::from_slice(&nonce), Payload { msg: key, aad: ad.as_bytes() })
        .map_err(|_| "Couldn't seal the key.".to_string())?;
    let mut out = nonce.to_vec();
    out.extend_from_slice(&ct);
    Ok(Sealed { kid, epk: STANDARD.encode(epk), enc: STANDARD.encode(out) })
}

pub fn seal_to(recipient_pk: &[u8; 32], ws: &str, recipient: &str, kid: u32, key: &[u8; 32]) -> Result<Sealed, String> {
    seal_to_with(recipient_pk, random()?, random()?, ws, recipient, kid, key)
}

pub fn open_sealed(secret: &StaticSecret, ws: &str, recipient: &str, s: &Sealed) -> Result<Key, String> {
    let bad = || "That key copy doesn't open here.".to_string();
    let epk: [u8; 32] = STANDARD.decode(&s.epk).ok().and_then(|b| b.try_into().ok()).ok_or_else(bad)?;
    let raw = STANDARD.decode(&s.enc).map_err(|_| bad())?;
    if raw.len() != 24 + 32 + 16 {
        return Err(bad());
    }
    let pk = PublicKey::from(secret).to_bytes();
    let shared = secret.diffie_hellman(&PublicKey::from(epk));
    if !shared.was_contributory() {
        return Err(bad());
    }
    let k = seal_key(&epk, &pk, shared.as_bytes());
    let ad = seal_ad(ws, recipient, s.kid);
    let key = aead(&k)
        .decrypt(XNonce::from_slice(&raw[..24]), Payload { msg: &raw[24..], aad: ad.as_bytes() })
        .map_err(|_| bad())?;
    let arr: [u8; 32] = key.as_slice().try_into().map_err(|_| bad())?;
    Ok(Zeroizing::new(arr))
}

pub fn public_of(secret: &StaticSecret) -> String {
    STANDARD.encode(PublicKey::from(secret).to_bytes())
}

fn parse_public(b64: &str) -> Result<[u8; 32], String> {
    STANDARD
        .decode(b64.trim())
        .ok()
        .and_then(|b| b.try_into().ok())
        .ok_or_else(|| "That isn't a device key.".to_string())
}

// ---- Device ids and fingerprints ---------------------------------------------------------------

/// A device's id in the workspace (`devices/<id>`): the first 8 bytes of SHA-256 over its public key.
pub fn device_id(pk: &[u8; 32]) -> String {
    let mut h = Sha256::new();
    h.update(b"bp-device-v1");
    h.update(pk);
    h.finalize()[..8].iter().map(|b| format!("{b:02x}")).collect()
}

include!("workspace_keys_words.rs");

/// Four words both admins can read out to check they approve the right Mac.
pub fn fingerprint(pk: &[u8; 32]) -> String {
    let mut out = [0u8; 4];
    Hkdf::<Sha256>::new(None, pk).expand(b"bp-fingerprint-v1", &mut out).expect("4 bytes");
    out.iter().map(|b| WORDS[*b as usize]).collect::<Vec<_>>().join(" ")
}

// ---- The recovery code and the machine key -----------------------------------------------------

const B32: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

fn check_symbol(code: &[u8; 16]) -> u8 {
    let mut h = Sha256::new();
    h.update(b"bp-recovery-check");
    h.update(code);
    B32[(h.finalize()[0] >> 3) as usize]
}

/// `BPR1-` and the 128 bits in Crockford base32 (26 characters) with a check character, in groups of 4.
pub fn recovery_code_text(code: &[u8; 16]) -> String {
    let v = u128::from_be_bytes(*code);
    let mut s: Vec<u8> = (0..26).map(|i| B32[((v >> (5 * (25 - i))) & 31) as usize]).collect();
    s.push(check_symbol(code));
    let groups: Vec<String> = s.chunks(4).map(|c| String::from_utf8_lossy(c).into_owned()).collect();
    format!("{RECOVERY_PREFIX}-{}", groups.join("-"))
}

/// Reads a recovery code as typed: any case, spaces or dashes; O is 0, I and L are 1.
pub fn parse_recovery_code(text: &str) -> Result<[u8; 16], String> {
    let bad = "That isn't a recovery code. It starts with BPR1- and has 27 letters and numbers after it.";
    let mut s: String = text.chars().filter(|c| c.is_ascii_alphanumeric()).collect::<String>().to_ascii_uppercase();
    if !s.starts_with(RECOVERY_PREFIX) {
        return Err(bad.into());
    }
    s.drain(..RECOVERY_PREFIX.len());
    let syms: Vec<u8> = s
        .bytes()
        .map(|c| match c {
            b'O' => b'0',
            b'I' | b'L' => b'1',
            c => c,
        })
        .collect();
    if syms.len() != 27 {
        return Err(bad.into());
    }
    let mut v: u128 = 0;
    for (i, c) in syms[..26].iter().enumerate() {
        let d = B32.iter().position(|b| b == c).ok_or(bad)? as u128;
        if i == 0 && d > 7 {
            return Err(bad.into());
        }
        v = (v << 5) | d;
    }
    let code = v.to_be_bytes();
    if check_symbol(&code) != syms[26] {
        return Err("That recovery code has a typo: check each character again.".into());
    }
    Ok(code)
}

pub fn recovery_secret(code: &[u8; 16], ws: &str) -> StaticSecret {
    StaticSecret::from(*hkdf32(ws.as_bytes(), code, RECOVERY_INFO))
}

pub fn machine_key_text(key: &[u8; 32]) -> String {
    format!("{MACHINE_PREFIX}{}", URL_SAFE_NO_PAD.encode(key))
}

pub fn parse_machine_key(text: &str) -> Result<Key, String> {
    let bad = || "That isn't a machine key. It starts with bpmk1_.".to_string();
    let t = text.trim();
    let rest = t.strip_prefix(MACHINE_PREFIX).ok_or_else(bad)?;
    let raw = URL_SAFE_NO_PAD.decode(rest).map_err(|_| bad())?;
    let arr: [u8; 32] = raw.as_slice().try_into().map_err(|_| bad())?;
    Ok(Zeroizing::new(arr))
}

pub fn machine_secret(key: &[u8; 32], ws: &str) -> StaticSecret {
    StaticSecret::from(*hkdf32(ws.as_bytes(), key, MACHINE_INFO))
}

// ---- The recovery kit ------------------------------------------------------------------------

fn pdf_text(s: &str) -> String {
    s.chars()
        .map(|c| match c {
            '(' | ')' | '\\' => format!("\\{c}"),
            c if (' '..='~').contains(&c) => c.to_string(),
            c if (c as u32) >= 0xA0 && (c as u32) <= 0xFF => format!("\\{:03o}", c as u32),
            '\u{2019}' => "'".into(),
            '\u{2014}' | '\u{2013}' => "-".into(),
            _ => "?".into(),
        })
        .collect()
}

/// A one-page PDF with the recovery code and what it's for, to print or keep with the admin's
/// papers. Plain Helvetica, nothing fetched.
pub fn recovery_kit_pdf(workspace: &str, code: &str, date: &str) -> Vec<u8> {
    let lines: Vec<(f32, f32, &str, String)> = vec![
        (72.0, 740.0, "F2", "Breakpatch recovery kit".into()),
        (72.0, 712.0, "F1", format!("Workspace: {workspace}")),
        (72.0, 696.0, "F1", format!("Made on {date}")),
        (72.0, 650.0, "F1", "Your recovery code".into()),
        (72.0, 622.0, "F3", code.to_string()),
        (72.0, 580.0, "F1", "This code opens the tests of this workspace if every Mac that holds its key is lost.".into()),
        (72.0, 564.0, "F1", "Breakpatch never sees it and can't make it again. Keep it in a safe place, such as".into()),
        (72.0, 548.0, "F1", "your password manager or with your company's papers.".into()),
        (72.0, 516.0, "F1", "To use it: open Breakpatch, sign in as an admin of the workspace, then Settings,".into()),
        (72.0, 500.0, "F1", "Workspace, Encryption, I lost access to the key.".into()),
        (72.0, 468.0, "F1", "Anyone with this code and an admin's sign-in can read the tests. A new code (Settings,".into()),
        (72.0, 452.0, "F1", "Workspace, Encryption, Make a new recovery code) stops this one from working.".into()),
    ];
    let mut content = String::new();
    for (x, y, font, text) in &lines {
        let size = match *font {
            "F2" => 20,
            "F3" => 15,
            _ => 11,
        };
        content.push_str(&format!("BT /{font} {size} Tf {x} {y} Td ({}) Tj ET\n", pdf_text(text)));
    }
    let objects = [
        "<< /Type /Catalog /Pages 2 0 R >>".to_string(),
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_string(),
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R /F2 5 0 R /F3 6 0 R >> >> /Contents 7 0 R >>".to_string(),
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>".to_string(),
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>".to_string(),
        "<< /Type /Font /Subtype /Type1 /BaseFont /Courier-Bold /Encoding /WinAnsiEncoding >>".to_string(),
        format!("<< /Length {} >>\nstream\n{content}endstream", content.len()),
    ];
    let mut out = b"%PDF-1.4\n".to_vec();
    let mut offsets = Vec::new();
    for (i, o) in objects.iter().enumerate() {
        offsets.push(out.len());
        out.extend_from_slice(format!("{} 0 obj\n{o}\nendobj\n", i + 1).as_bytes());
    }
    let xref = out.len();
    out.extend_from_slice(format!("xref\n0 {}\n0000000000 65535 f \n", objects.len() + 1).as_bytes());
    for off in offsets {
        out.extend_from_slice(format!("{off:010} 00000 n \n").as_bytes());
    }
    out.extend_from_slice(format!("trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n", objects.len() + 1).as_bytes());
    out
}

/// YYYY-MM-DD for a Unix time (UTC).
pub fn ymd(unix: i64) -> String {
    let z = unix.div_euclid(86_400) + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}")
}

// ---- What this Mac holds ---------------------------------------------------------------------

/// The data key versions this Mac holds for one workspace (the Keychain entry `people:<ws>`).
#[derive(Default)]
struct Ring {
    keys: BTreeMap<u32, Key>,
}

#[derive(Serialize, Deserialize)]
struct RingFile {
    v: u32,
    keys: BTreeMap<String, String>,
}

impl Ring {
    fn current(&self) -> Option<u32> {
        self.keys.keys().next_back().copied()
    }
    fn to_json(&self) -> String {
        let keys = self.keys.iter().map(|(k, v)| (k.to_string(), STANDARD.encode(&v[..]))).collect();
        serde_json::to_string(&RingFile { v: 1, keys }).expect("a ring serialises")
    }
    fn from_json(text: &str) -> Result<Ring, String> {
        let f: RingFile = serde_json::from_str(text).map_err(|_| "The workspace key on this Mac is damaged.".to_string())?;
        let mut keys = BTreeMap::new();
        for (k, v) in f.keys {
            let kid: u32 = k.parse().map_err(|_| "The workspace key on this Mac is damaged.".to_string())?;
            keys.insert(kid, key32(&v)?);
        }
        Ok(Ring { keys })
    }
}

/// What the UI may know: whether this Mac holds the key, and which versions.
#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub has_key: bool,
    pub current: Option<u32>,
    pub kids: Vec<u32>,
}

/// This Mac's device key for the workspace, as the workspace shows it (`devices/<id>`).
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    pub id: String,
    pub public_key: String,
    pub fingerprint: String,
}

#[derive(Deserialize, Debug)]
pub struct SealItem {
    pub path: String,
    pub field: String,
    /// The field's JSON.
    pub value: String,
}

#[derive(Deserialize, Debug)]
pub struct OpenItem {
    pub path: String,
    pub field: String,
    pub enc: String,
    pub kid: u32,
}

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
pub struct Blob {
    pub enc: String,
    pub kid: u32,
}

/// A new recovery code: shown once; the workspace keeps `publicKey` and `sealed` (`keys/recovery`).
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct NewLock {
    /// The recovery code (`BPR1-…`) or the machine key (`bpmk1_…`), for the admin to write down.
    pub secret: String,
    pub public_key: String,
    pub sealed: Vec<Sealed>,
}

#[derive(Serialize, Deserialize)]
struct Invite {
    v: u32,
    ws: String,
    keys: BTreeMap<String, String>,
}

pub struct WorkspaceKeys<S: SecretStore> {
    store: S,
    rings: Mutex<HashMap<String, Arc<Mutex<Ring>>>>,
    devices: Mutex<HashMap<String, Zeroizing<[u8; 32]>>>,
    /// The recovery code made last, for the recovery kit (until the dialog is done).
    pending: Mutex<Option<(String, Zeroizing<String>)>>,
}

impl<S: SecretStore> WorkspaceKeys<S> {
    pub fn new(store: S) -> Self {
        Self { store, rings: Mutex::default(), devices: Mutex::default(), pending: Mutex::default() }
    }

    fn check_ws(ws: &str) -> Result<(), String> {
        if ws.is_empty() || ws.len() > 200 || ws.contains('|') || ws.chars().any(char::is_control) {
            return Err("That isn't a workspace.".into());
        }
        Ok(())
    }

    /// The ring for `ws`, read from the Keychain once per launch.
    fn ring(&self, ws: &str) -> Result<Arc<Mutex<Ring>>, String> {
        Self::check_ws(ws)?;
        if let Some(r) = self.rings.lock().unwrap().get(ws) {
            return Ok(Arc::clone(r));
        }
        let ring = match self.store.get(&format!("people:{ws}"))? {
            Some(text) => Ring::from_json(&text)?,
            None => Ring::default(),
        };
        let r = Arc::new(Mutex::new(ring));
        self.rings.lock().unwrap().insert(ws.to_string(), Arc::clone(&r));
        Ok(r)
    }

    fn save(&self, ws: &str, ring: &Ring) -> Result<(), String> {
        self.store.set(&format!("people:{ws}"), &ring.to_json())
    }

    /// Adds key versions; a version this Mac holds with another key is refused (never replaced).
    fn add_keys(&self, ws: &str, keys: Vec<(u32, Key)>) -> Result<Vec<u32>, String> {
        let r = self.ring(ws)?;
        let mut ring = r.lock().unwrap();
        let mut changed = false;
        for (kid, key) in keys {
            if kid == 0 {
                return Err("That key version isn't valid.".into());
            }
            match ring.keys.get(&kid) {
                Some(have) if **have != *key => {
                    return Err(format!("This Mac already holds another key {kid} for this workspace."))
                }
                Some(_) => {}
                None => {
                    ring.keys.insert(kid, key);
                    changed = true;
                }
            }
        }
        if changed {
            self.save(ws, &ring)?;
        }
        Ok(ring.keys.keys().copied().collect())
    }

    pub fn status(&self, ws: &str) -> Result<Status, String> {
        let r = self.ring(ws)?;
        let ring = r.lock().unwrap();
        Ok(Status { has_key: !ring.keys.is_empty(), current: ring.current(), kids: ring.keys.keys().copied().collect() })
    }

    /// The first key of a workspace (its first admin's Mac): version 1, or `kid` when every copy of
    /// the key was lost and an admin starts again with the next version. Refused when this Mac holds one.
    pub fn create(&self, ws: &str, kid: Option<u32>) -> Result<u32, String> {
        if self.status(ws)?.has_key {
            return Err("This Mac already holds this workspace's key.".into());
        }
        let kid = kid.unwrap_or(1).max(1);
        self.add_keys(ws, vec![(kid, Zeroizing::new(random()?))])?;
        Ok(kid)
    }

    /// A new key version (after someone leaves). New content is sealed with it.
    pub fn rotate(&self, ws: &str) -> Result<u32, String> {
        let next = self.status(ws)?.current.ok_or("This Mac doesn't hold this workspace's key.")? + 1;
        self.add_keys(ws, vec![(next, Zeroizing::new(random()?))])?;
        Ok(next)
    }

    fn key(&self, ws: &str, kid: Option<u32>) -> Result<(u32, Key), String> {
        let r = self.ring(ws)?;
        let ring = r.lock().unwrap();
        let kid = kid.or(ring.current()).ok_or("This Mac doesn't hold this workspace's key.")?;
        let key = ring.keys.get(&kid).ok_or_else(|| format!("This Mac doesn't hold key {kid} of this workspace."))?;
        Ok((kid, key.clone()))
    }

    /// Seals fields with key `kid` (None: the newest this Mac holds).
    pub fn seal(&self, ws: &str, kid: Option<u32>, items: &[SealItem]) -> Result<Vec<Blob>, String> {
        if items.len() > MAX_ITEMS {
            return Err("Too many fields at once.".into());
        }
        let (kid, key) = self.key(ws, kid)?;
        items
            .iter()
            .map(|i| Ok(Blob { enc: seal_field(&key, ws, &i.path, &i.field, kid, i.value.as_bytes())?, kid }))
            .collect()
    }

    /// Opens fields: each one's JSON, or None when this Mac can't (no such key, or not this place's).
    pub fn open(&self, ws: &str, items: &[OpenItem]) -> Result<Vec<Option<String>>, String> {
        if items.len() > MAX_ITEMS {
            return Err("Too many fields at once.".into());
        }
        let r = self.ring(ws)?;
        let ring = r.lock().unwrap();
        Ok(items
            .iter()
            .map(|i| {
                let key = ring.keys.get(&i.kid)?;
                let json = open_field(key, ws, &i.path, &i.field, i.kid, &i.enc).ok()?;
                String::from_utf8(json).ok()
            })
            .collect())
    }

    fn device_secret(&self, ws: &str) -> Result<StaticSecret, String> {
        Self::check_ws(ws)?;
        if let Some(s) = self.devices.lock().unwrap().get(ws) {
            return Ok(StaticSecret::from(**s));
        }
        let entry = format!("device:{ws}");
        let secret = match self.store.get(&entry)? {
            Some(text) => key32(&text)?,
            None => {
                let k = Zeroizing::new(random()?);
                self.store.set(&entry, &STANDARD.encode(&k[..]))?;
                k
            }
        };
        let s = StaticSecret::from(*secret);
        self.devices.lock().unwrap().insert(ws.to_string(), secret);
        Ok(s)
    }

    /// This Mac's device key for the workspace (made the first time).
    pub fn device(&self, ws: &str) -> Result<Device, String> {
        let pk = PublicKey::from(&self.device_secret(ws)?).to_bytes();
        Ok(Device { id: device_id(&pk), public_key: STANDARD.encode(pk), fingerprint: fingerprint(&pk) })
    }

    /// Every key version this Mac holds, sealed to `public_key` (a device being approved, the
    /// recovery code's or the machine key's). `recipient`: the device id, `recovery` or `machine`.
    pub fn grant(&self, ws: &str, recipient: &str, public_key: &str) -> Result<Vec<Sealed>, String> {
        let pk = parse_public(public_key)?;
        if recipient != "recovery" && recipient != "machine" && recipient != device_id(&pk) {
            return Err("That device key doesn't belong to that device.".into());
        }
        let r = self.ring(ws)?;
        let ring = r.lock().unwrap();
        if ring.keys.is_empty() {
            return Err("This Mac doesn't hold this workspace's key.".into());
        }
        ring.keys.iter().map(|(kid, key)| seal_to(&pk, ws, recipient, *kid, key)).collect()
    }

    /// Takes the key versions an admin sealed to this Mac.
    pub fn accept(&self, ws: &str, sealed: &[Sealed]) -> Result<Vec<u32>, String> {
        let secret = self.device_secret(ws)?;
        let id = device_id(&PublicKey::from(&secret).to_bytes());
        let keys = sealed.iter().map(|s| Ok((s.kid, open_sealed(&secret, ws, &id, s)?))).collect::<Result<Vec<_>, String>>()?;
        self.add_keys(ws, keys)
    }

    /// A new recovery code, with every key version sealed to it. Kept for the recovery kit until `forget_pending`.
    pub fn recovery_new(&self, ws: &str) -> Result<NewLock, String> {
        Self::check_ws(ws)?;
        let code = Zeroizing::new(random::<16>()?);
        let secret = recovery_secret(&code, ws);
        let public_key = public_of(&secret);
        let sealed = self.grant(ws, "recovery", &public_key)?;
        let text = recovery_code_text(&code);
        *self.pending.lock().unwrap() = Some((ws.to_string(), Zeroizing::new(text.clone())));
        Ok(NewLock { secret: text, public_key, sealed })
    }

    pub fn pending_code(&self, ws: &str) -> Option<Zeroizing<String>> {
        self.pending.lock().unwrap().as_ref().filter(|(w, _)| w == ws).map(|(_, c)| c.clone())
    }

    pub fn forget_pending(&self) {
        *self.pending.lock().unwrap() = None;
    }

    /// Opens `keys/recovery` with the recovery code the admin typed.
    pub fn recover(&self, ws: &str, code: &str, public_key: &str, sealed: &[Sealed]) -> Result<Vec<u32>, String> {
        Self::check_ws(ws)?;
        let secret = recovery_secret(&parse_recovery_code(code)?, ws);
        if public_of(&secret) != public_key.trim() {
            return Err("That recovery code isn't this workspace's, or a newer one was made since.".into());
        }
        let keys = sealed.iter().map(|s| Ok((s.kid, open_sealed(&secret, ws, "recovery", s)?))).collect::<Result<Vec<_>, String>>()?;
        self.add_keys(ws, keys)
    }

    /// A new machine key for the runner and CI, with every key version sealed to it (`keys/machine`).
    pub fn machine_new(&self, ws: &str) -> Result<NewLock, String> {
        Self::check_ws(ws)?;
        let key = Zeroizing::new(random::<32>()?);
        let secret = machine_secret(&key, ws);
        let public_key = public_of(&secret);
        let sealed = self.grant(ws, "machine", &public_key)?;
        Ok(NewLock { secret: machine_key_text(&key), public_key, sealed })
    }

    /// A runner Mac given the machine key: opens `keys/machine` with it.
    pub fn machine_use(&self, ws: &str, machine_key: &str, public_key: &str, sealed: &[Sealed]) -> Result<Vec<u32>, String> {
        Self::check_ws(ws)?;
        let key = parse_machine_key(machine_key)?;
        let secret = machine_secret(&key, ws);
        if public_of(&secret) != public_key.trim() {
            return Err("That machine key isn't this workspace's, or a newer one was made since.".into());
        }
        let keys = sealed.iter().map(|s| Ok((s.kid, open_sealed(&secret, ws, "machine", s)?))).collect::<Result<Vec<_>, String>>()?;
        self.add_keys(ws, keys)
    }

    /// The `k=` part of an invite link: every key version, for this workspace only.
    pub fn invite(&self, ws: &str) -> Result<String, String> {
        let r = self.ring(ws)?;
        let ring = r.lock().unwrap();
        if ring.keys.is_empty() {
            return Err("This Mac doesn't hold this workspace's key.".into());
        }
        let keys = ring.keys.iter().map(|(k, v)| (k.to_string(), URL_SAFE_NO_PAD.encode(&v[..]))).collect();
        let json = Zeroizing::new(serde_json::to_string(&Invite { v: 1, ws: ws.to_string(), keys }).expect("invite serialises"));
        Ok(URL_SAFE_NO_PAD.encode(json.as_bytes()))
    }

    /// Takes the keys from an invite link's `k=` part.
    pub fn import_invite(&self, ws: &str, bundle: &str) -> Result<Vec<u32>, String> {
        let bad = || "The key in the invite link is incomplete. Ask for a new link.".to_string();
        let raw = Zeroizing::new(URL_SAFE_NO_PAD.decode(bundle.trim()).map_err(|_| bad())?);
        let inv: Invite = serde_json::from_slice(&raw).map_err(|_| bad())?;
        if inv.v != 1 {
            return Err(bad());
        }
        if inv.ws != ws {
            return Err("The key in the invite link is for another workspace.".into());
        }
        let keys = inv
            .keys
            .iter()
            .map(|(k, v)| Ok((k.parse::<u32>().map_err(|_| bad())?, key32(v).map_err(|_| bad())?)))
            .collect::<Result<Vec<_>, String>>()?;
        self.add_keys(ws, keys)
    }

    /// Forgets this workspace's keys on this Mac (after Disconnect this Mac).
    pub fn forget(&self, ws: &str) -> Result<(), String> {
        Self::check_ws(ws)?;
        self.rings.lock().unwrap().remove(ws);
        self.devices.lock().unwrap().remove(ws);
        self.store.delete(&format!("people:{ws}"))?;
        self.store.delete(&format!("device:{ws}"))
    }
}

// ---- Tauri commands (the UI: the Team module's data/firebase/sealing.ts) -------------------------

pub mod commands {
    use super::*;
    use crate::secrets::KeyringStore;
    use tauri::State;

    pub type KeysState = Arc<WorkspaceKeys<KeyringStore>>;

    async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
        tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
    }

    #[tauri::command]
    pub async fn workspace_keys_status(k: State<'_, KeysState>, ws: String) -> Result<Status, String> {
        let k = Arc::clone(&k);
        blocking(move || k.status(&ws)).await
    }

    #[tauri::command]
    pub async fn workspace_keys_create(k: State<'_, KeysState>, ws: String, kid: Option<u32>) -> Result<u32, String> {
        let k = Arc::clone(&k);
        blocking(move || k.create(&ws, kid)).await
    }

    #[tauri::command]
    pub async fn workspace_keys_rotate(k: State<'_, KeysState>, ws: String) -> Result<u32, String> {
        let k = Arc::clone(&k);
        blocking(move || k.rotate(&ws)).await
    }

    #[tauri::command]
    pub async fn workspace_keys_seal(k: State<'_, KeysState>, ws: String, kid: Option<u32>, items: Vec<SealItem>) -> Result<Vec<Blob>, String> {
        let k = Arc::clone(&k);
        blocking(move || k.seal(&ws, kid, &items)).await
    }

    #[tauri::command]
    pub async fn workspace_keys_open(k: State<'_, KeysState>, ws: String, items: Vec<OpenItem>) -> Result<Vec<Option<String>>, String> {
        let k = Arc::clone(&k);
        blocking(move || k.open(&ws, &items)).await
    }

    #[tauri::command]
    pub async fn workspace_keys_device(k: State<'_, KeysState>, ws: String) -> Result<Device, String> {
        let k = Arc::clone(&k);
        blocking(move || k.device(&ws)).await
    }

    /// The four words for a device key (an admin checks them before approving).
    #[tauri::command]
    pub fn workspace_keys_fingerprint(public_key: String) -> Result<String, String> {
        Ok(fingerprint(&parse_public(&public_key)?))
    }

    #[tauri::command]
    pub async fn workspace_keys_grant(k: State<'_, KeysState>, ws: String, recipient: String, public_key: String) -> Result<Vec<Sealed>, String> {
        let k = Arc::clone(&k);
        blocking(move || k.grant(&ws, &recipient, &public_key)).await
    }

    #[tauri::command]
    pub async fn workspace_keys_accept(k: State<'_, KeysState>, ws: String, sealed: Vec<Sealed>) -> Result<Vec<u32>, String> {
        let k = Arc::clone(&k);
        blocking(move || k.accept(&ws, &sealed)).await
    }

    #[tauri::command]
    pub async fn workspace_keys_recovery_new(k: State<'_, KeysState>, ws: String) -> Result<NewLock, String> {
        let k = Arc::clone(&k);
        blocking(move || k.recovery_new(&ws)).await
    }

    /// Saves the recovery kit PDF for the code made last, where the admin picks. None: cancelled.
    #[tauri::command]
    pub async fn workspace_keys_recovery_kit(app: tauri::AppHandle, k: State<'_, KeysState>, ws: String, workspace_name: String) -> Result<Option<String>, String> {
        use tauri_plugin_dialog::DialogExt;
        let code = k.pending_code(&ws).ok_or("Make a new recovery code first.")?;
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0);
        let pdf = recovery_kit_pdf(&workspace_name, &code, &ymd(now));
        let safe: String = workspace_name.chars().map(|c| if c.is_alphanumeric() || c == ' ' || c == '-' { c } else { '-' }).collect();
        blocking(move || {
            let Some(picked) = app
                .dialog()
                .file()
                .set_title("Save the recovery kit")
                .set_file_name(format!("Breakpatch recovery kit - {}.pdf", safe.trim()))
                .add_filter("PDF", &["pdf"])
                .blocking_save_file()
            else {
                return Ok(None);
            };
            let path = picked.into_path().map_err(|e| e.to_string())?;
            std::fs::write(&path, pdf).map_err(|e| format!("Couldn't save the recovery kit: {e}"))?;
            Ok(Some(path.to_string_lossy().into_owned()))
        })
        .await
    }

    /// The recovery code dialog is done: the code isn't kept any longer.
    #[tauri::command]
    pub fn workspace_keys_recovery_done(k: State<'_, KeysState>) {
        k.forget_pending();
    }

    #[tauri::command]
    pub async fn workspace_keys_recover(k: State<'_, KeysState>, ws: String, code: String, public_key: String, sealed: Vec<Sealed>) -> Result<Vec<u32>, String> {
        let k = Arc::clone(&k);
        blocking(move || k.recover(&ws, &code, &public_key, &sealed)).await
    }

    #[tauri::command]
    pub async fn workspace_keys_machine_new(k: State<'_, KeysState>, ws: String) -> Result<NewLock, String> {
        let k = Arc::clone(&k);
        blocking(move || k.machine_new(&ws)).await
    }

    #[tauri::command]
    pub async fn workspace_keys_machine_use(k: State<'_, KeysState>, ws: String, machine_key: String, public_key: String, sealed: Vec<Sealed>) -> Result<Vec<u32>, String> {
        let k = Arc::clone(&k);
        blocking(move || k.machine_use(&ws, &machine_key, &public_key, &sealed)).await
    }

    /// Puts the invite link with the key in its fragment on the clipboard (the UI never holds it).
    #[tauri::command]
    pub async fn workspace_keys_copy_invite(app: tauri::AppHandle, k: State<'_, KeysState>, ws: String, link: String) -> Result<(), String> {
        use tauri_plugin_clipboard_manager::ClipboardExt;
        if !link.starts_with("https://breakpatch.dev/") && !link.starts_with("breakpatch://") {
            return Err("That isn't an invite link.".into());
        }
        let k2 = Arc::clone(&k);
        let bundle = blocking(move || k2.invite(&ws)).await?;
        let sep = if link.contains('#') { '&' } else { '#' };
        app.clipboard().write_text(format!("{link}{sep}k={bundle}")).map_err(|e| e.to_string())
    }

    #[tauri::command]
    pub async fn workspace_keys_import_invite(k: State<'_, KeysState>, ws: String, bundle: String) -> Result<Vec<u32>, String> {
        let k = Arc::clone(&k);
        blocking(move || k.import_invite(&ws, &bundle)).await
    }

    #[tauri::command]
    pub async fn workspace_keys_forget(k: State<'_, KeysState>, ws: String) -> Result<(), String> {
        let k = Arc::clone(&k);
        blocking(move || k.forget(&ws)).await
    }
}

#[cfg(test)]
#[path = "workspace_keys_tests.rs"]
mod tests;
