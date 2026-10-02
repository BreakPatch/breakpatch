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
//! - The *signing key*: an Ed25519 pair per workspace per Mac, kept with the device key. An admin's
//!   Mac signs what it writes that makes other Macs take a key: every sealed copy (grants, the
//!   recovery code's and the machine key's copies) and every key version it announces.
//!
//! **Trust** (so that whoever can write the workspace's documents, Breakpatch included through the
//! Admin SDK, can never get a key or make a Mac take one of theirs):
//! - A Mac takes a key only from a copy signed by an admin's signing key it trusts, and only when
//!   the key matches the *commitment* announced for that version in `keys/meta.checks`, also signed
//!   by a trusted admin. The commitment is HMAC-SHA256 under the data key over
//!   `bp-check-v1|<ws>|<kid>`, so it says nothing about the key but tells a wrong one apart.
//! - Trusted keys are *pinned* on the Mac (with its key versions, in `people:<ws>`). The first is
//!   pinned when the Mac joins: from the invite link's key bundle, which carries the signing key of
//!   the admin who copied it, or from that admin's four words, shown on this Mac and confirmed by the
//!   person. The recovery code and the machine key pin the admin who made them: their copy carries a
//!   *vouch*, an HMAC under a key derived from the code or machine key over that admin's signing key,
//!   which only someone who saw the code could make.
//! - Later admins are trusted when a trusted admin signs their signing key (`keys/signers`); a Mac
//!   follows those endorsements from the keys it has pinned.
//! - When an admin is removed or made a member, a remaining admin's Mac *withdraws* their signing
//!   key (`keys/signers.revoked`): a signed revocation that also names the signing keys that admin
//!   still trusts (`keep`). A Mac that sees a revocation by an admin it trusts stops trusting the
//!   withdrawn key, and what it endorsed, from then on: it keeps the withdrawn key in its Keychain
//!   entry, so deleting the document later doesn't bring it back. It pins the `keep` keys it
//!   already trusted, so a Mac that trusted the team through the admin who left still trusts the
//!   admins who are still there. Keys taken earlier stay; copies and announcements signed by the
//!   withdrawn key are refused, so the remaining admin's Mac signs them again. Two admins
//!   withdrawing each other both lose trust (refused rather than guessed); the person then checks
//!   a remaining admin's words again.
//! - A Mac that holds the key proves it to admins' Macs with a MAC under the current data key over
//!   its device id and signing key (`devices/<id>.proof`); a key version is passed on to a Mac only
//!   when an admin let it in, or it proved it holds the key already.
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
//! - A signature is Ed25519 over `bp-sealed-v1|<ws>|<recipient>|<kid>|<epk>|<enc>` (a sealed copy),
//!   `bp-key-v1|<ws>|<kid>|<check>` (an announced key version), `bp-signer-v1|<ws>|<signing key>`
//!   (an endorsement) or `bp-revoke-v1|<ws>|<signing key>|<keep, sorted, joined by commas>` (a
//!   withdrawn signing key). Keys, signatures, MACs and checks are standard base64.
//! - `ws` is the workspace's connection id (`team:<project>/<database>` or `hosted:<id>`), and a
//!   document path is relative to the workspace (`apps/<id>/tests/<id>`), the same for own Firebase
//!   and Breakpatch Cloud.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine as _;
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use ed25519_dalek::{Signature, Signer as _, SigningKey, VerifyingKey};
use hkdf::hmac::{Hmac, Mac};
use hkdf::Hkdf;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use x25519_dalek::{PublicKey, StaticSecret};
use zeroize::{Zeroize, Zeroizing};

use crate::secrets::SecretStore;

pub const SERVICE: &str = "dev.breakpatch.workspace-keys";
const FIELD_INFO: &str = "bp-field-v1";
const SEAL_INFO: &str = "bp-seal-v1";
const RECOVERY_INFO: &str = "bp-recovery-v1";
const MACHINE_INFO: &str = "bp-machine-v1";
const RECOVERY_PREFIX: &str = "BPR1";
const MACHINE_PREFIX: &str = "bpmk1_";
const SEALED_SIG: &str = "bp-sealed-v1";
const KEY_SIG: &str = "bp-key-v1";
const SIGNER_SIG: &str = "bp-signer-v1";
const REVOKE_SIG: &str = "bp-revoke-v1";
const CHECK_INFO: &str = "bp-check-v1";
const HOLDS_INFO: &str = "bp-holds-v1";
const VOUCH_INFO: &str = "bp-vouch-v1";
/// How long the recovery code made last is kept for the recovery kit.
const PENDING_FOR: Duration = Duration::from_secs(15 * 60);
/// The most signers and announced key versions a workspace's trust documents may list.
const MAX_SIGNERS: usize = 200;
const MAX_CHECKS: usize = 1000;
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
/// `by` and `sig`: the signing key of the admin's Mac that sealed it, and its signature.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct Sealed {
    pub kid: u32,
    pub epk: String,
    pub enc: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub by: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub sig: String,
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
    Ok(Sealed { kid, epk: STANDARD.encode(epk), enc: STANDARD.encode(out), by: String::new(), sig: String::new() })
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

/// A Mac's four words, read out to check the right Mac is let in, or that an admin's Mac is the
/// one that let this Mac in. Over both its keys: its device key (X25519) and its signing key.
pub fn fingerprint(pk: &[u8; 32], sign_pk: &[u8; 32]) -> String {
    let mut ikm = [0u8; 64];
    ikm[..32].copy_from_slice(pk);
    ikm[32..].copy_from_slice(sign_pk);
    let mut out = [0u8; 4];
    Hkdf::<Sha256>::new(None, &ikm).expand(b"bp-fingerprint-v2", &mut out).expect("4 bytes");
    out.iter().map(|b| WORDS[*b as usize]).collect::<Vec<_>>().join(" ")
}

// ---- Signatures, key commitments and trust ----------------------------------------------------

type HmacSha256 = Hmac<Sha256>;

fn hmac(key: &[u8], msg: &str) -> [u8; 32] {
    let mut m = <HmacSha256 as Mac>::new_from_slice(key).expect("HMAC takes any key length");
    m.update(msg.as_bytes());
    m.finalize().into_bytes().into()
}

/// Constant-time equality of two base64 MACs or checks as stored.
fn same_b64(a: &str, b: &[u8; 32]) -> bool {
    let Ok(raw) = STANDARD.decode(a.trim()) else { return false };
    raw.len() == 32 && raw.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

pub fn sealed_msg(ws: &str, recipient: &str, s: &Sealed) -> String {
    format!("{SEALED_SIG}|{ws}|{recipient}|{}|{}|{}", s.kid, s.epk, s.enc)
}
pub fn key_msg(ws: &str, kid: u32, check: &str) -> String {
    format!("{KEY_SIG}|{ws}|{kid}|{check}")
}
pub fn signer_msg(ws: &str, sign_pk: &str) -> String {
    format!("{SIGNER_SIG}|{ws}|{sign_pk}")
}
pub fn revoke_msg(ws: &str, sign_pk: &str, keep: &[String]) -> String {
    format!("{REVOKE_SIG}|{ws}|{sign_pk}|{}", keep.join(","))
}

/// The commitment to a data key version: HMAC-SHA256(data key, `bp-check-v1|<ws>|<kid>`), base64.
pub fn key_check(data_key: &[u8; 32], ws: &str, kid: u32) -> String {
    STANDARD.encode(hmac(data_key, &format!("{CHECK_INFO}|{ws}|{kid}")))
}

/// A device's proof that it holds key `kid`: HMAC-SHA256(data key, `bp-holds-v1|<ws>|<device id>|<signing key>`).
pub fn holds_mac(data_key: &[u8; 32], ws: &str, device: &str, sign_pk: &str) -> [u8; 32] {
    hmac(data_key, &format!("{HOLDS_INFO}|{ws}|{device}|{sign_pk}"))
}

/// The vouch of a recovery code or machine key for the admin who made it: HMAC-SHA256 under
/// HKDF-SHA256(salt = ws, ikm = the code or key, info = "bp-vouch-v1") over `bp-vouch-v1|<ws>|<recipient>|<signing key>`.
pub fn vouch_mac(secret: &[u8], ws: &str, recipient: &str, sign_pk: &str) -> [u8; 32] {
    let k = hkdf32(ws.as_bytes(), secret, VOUCH_INFO);
    hmac(&k[..], &format!("{VOUCH_INFO}|{ws}|{recipient}|{sign_pk}"))
}

fn parse_signer(b64: &str) -> Result<VerifyingKey, String> {
    let raw: [u8; 32] = STANDARD.decode(b64.trim()).ok().and_then(|b| b.try_into().ok()).ok_or("That isn't a signing key.")?;
    VerifyingKey::from_bytes(&raw).map_err(|_| "That isn't a signing key.".to_string())
}

pub fn sign_with(seed: &[u8; 32], msg: &str) -> String {
    STANDARD.encode(SigningKey::from_bytes(seed).sign(msg.as_bytes()).to_bytes())
}

pub fn signer_public(seed: &[u8; 32]) -> String {
    STANDARD.encode(SigningKey::from_bytes(seed).verifying_key().to_bytes())
}

/// Whether `sig` is `by`'s signature of `msg`.
pub fn verify_sig(by: &str, msg: &str, sig: &str) -> bool {
    let Ok(pk) = parse_signer(by) else { return false };
    let Some(sig) = STANDARD.decode(sig.trim()).ok().and_then(|b| <[u8; 64]>::try_from(b.as_slice()).ok()) else { return false };
    pk.verify_strict(msg.as_bytes(), &Signature::from_bytes(&sig)).is_ok()
}

/// A key version as `keys/meta.checks.<kid>` announces it.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct Check {
    pub check: String,
    pub by: String,
    pub sig: String,
}

/// An admin's signing key, signed by another admin's (`keys/signers.list.<id>`).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct Endorsement {
    pub pk: String,
    pub by: String,
    pub sig: String,
}

/// An admin's signing key withdrawn by another admin (`keys/signers.revoked.<id>`), with the signing
/// keys `by` still trusts (sorted): a Mac that trusted the team through `pk` keeps those.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct Revocation {
    pub pk: String,
    #[serde(default)]
    pub keep: Vec<String>,
    pub by: String,
    pub sig: String,
}

/// The recovery code's or machine key's vouch for the admin who made it (`keys/recovery.vouch`).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct Vouch {
    pub by: String,
    pub mac: String,
}

/// A device's proof that it holds the key (`devices/<id>.proof`).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct Proof {
    pub kid: u32,
    pub mac: String,
}

/// What the workspace says about its key versions and admins: `keys/meta.checks` and `keys/signers.list`.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
pub struct Trust {
    #[serde(default)]
    pub checks: BTreeMap<String, Check>,
    #[serde(default)]
    pub signers: Vec<Endorsement>,
    /// `keys/signers.revoked`: admins' signing keys withdrawn by another admin.
    #[serde(default)]
    pub revoked: Vec<Revocation>,
}

/// What a Mac trusts once the workspace's revocations are applied (`Trust::resolve`).
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Resolved {
    pub trusted: BTreeSet<String>,
    /// Every withdrawn key: the ones the Mac knew of, and the ones signed by a key it trusts.
    pub revoked: BTreeSet<String>,
    /// Keys a revocation kept that the Mac trusted: pinned, so they stay trusted without the withdrawn key.
    pub kept: BTreeSet<String>,
}

impl Trust {
    fn checked(&self) -> Result<(), String> {
        if self.checks.len() > MAX_CHECKS || self.signers.len() > MAX_SIGNERS || self.revoked.len() > MAX_SIGNERS
            || self.revoked.iter().any(|r| r.keep.len() > MAX_SIGNERS) {
            return Err("The workspace's key list is too long.".into());
        }
        Ok(())
    }

    /// `roots` and every signing key they endorse, directly or through others (no revocations; the tests').
    #[cfg(test)]
    pub fn trusted_from(&self, ws: &str, roots: BTreeSet<String>) -> BTreeSet<String> {
        self.closure(ws, roots, &BTreeSet::new())
    }

    /// `roots` and what they endorse, leaving out withdrawn keys and what only they endorsed.
    fn closure(&self, ws: &str, roots: BTreeSet<String>, revoked: &BTreeSet<String>) -> BTreeSet<String> {
        let mut t: BTreeSet<String> = roots.into_iter().filter(|r| !revoked.contains(r)).collect();
        loop {
            let before = t.len();
            for e in &self.signers {
                if !t.contains(&e.pk) && !revoked.contains(&e.pk) && t.contains(&e.by) && verify_sig(&e.by, &signer_msg(ws, &e.pk), &e.sig) {
                    t.insert(e.pk.clone());
                }
            }
            if t.len() == before {
                return t;
            }
        }
    }

    /// The keys trusted from `roots` once every revocation signed by a trusted key is applied,
    /// with `revoked` (those this Mac already knows of) left out from the start.
    ///
    /// Each round checks every revocation against what is trusted at its start, so the order of the
    /// list never matters: two keys withdrawing each other in the same round both go, and neither's
    /// `keep` is followed. A revocation's `keep` only keeps keys already trusted then; it never adds one.
    pub fn resolve(&self, ws: &str, roots: BTreeSet<String>, revoked: BTreeSet<String>) -> Resolved {
        let mut roots = roots;
        let mut revoked = revoked;
        let mut kept = BTreeSet::new();
        loop {
            let t = self.closure(ws, roots.clone(), &revoked);
            let valid: Vec<&Revocation> = self
                .revoked
                .iter()
                .filter(|r| !revoked.contains(&r.pk) && t.contains(&r.by) && verify_sig(&r.by, &revoke_msg(ws, &r.pk, &r.keep), &r.sig))
                .collect();
            if valid.is_empty() {
                kept.retain(|k| !revoked.contains(k));
                return Resolved { trusted: t, revoked, kept };
            }
            let gone: BTreeSet<String> = valid.iter().map(|r| r.pk.clone()).collect();
            for r in &valid {
                if gone.contains(&r.by) {
                    continue;
                }
                for k in &r.keep {
                    if t.contains(k) && !gone.contains(k) && !revoked.contains(k) {
                        roots.insert(k.clone());
                        kept.insert(k.clone());
                    }
                }
            }
            revoked.extend(gone);
        }
    }

    /// Refuses a key unless its version was announced, by a trusted admin, with this key's commitment.
    pub fn check_key(&self, ws: &str, trusted: &BTreeSet<String>, kid: u32, key: &[u8; 32]) -> Result<(), String> {
        let c = self.checks.get(&kid.to_string()).ok_or_else(|| format!("Key {kid} isn't one the workspace announced, so this Mac doesn't take it."))?;
        if !trusted.contains(&c.by) || !verify_sig(&c.by, &key_msg(ws, kid, &c.check), &c.sig) {
            return Err(format!("Key {kid} wasn't announced by an admin this Mac trusts, so it doesn't take it."));
        }
        if c.check != key_check(key, ws, kid) {
            return Err(format!("Key {kid} isn't the one the workspace announced, so this Mac doesn't take it."));
        }
        Ok(())
    }
}

/// Refuses a sealed copy that isn't signed by a trusted admin.
fn check_sealed(ws: &str, recipient: &str, trusted: &BTreeSet<String>, s: &Sealed) -> Result<(), String> {
    if s.by.is_empty() || s.sig.is_empty() {
        return Err("That key copy isn't signed by an admin's Mac, so this Mac doesn't take it.".into());
    }
    if !trusted.contains(&s.by) {
        return Err("That key copy was signed by a Mac this Mac doesn't trust, so it doesn't take it.".into());
    }
    if !verify_sig(&s.by, &sealed_msg(ws, recipient, s), &s.sig) {
        return Err("That key copy's signature doesn't match, so this Mac doesn't take it.".into());
    }
    Ok(())
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
    let t = text.trim().to_ascii_uppercase();
    match crate::licence::machine_secret(&t) {
        Some(crate::licence::MachineSecret::CiToken) => {
            return Err("That's a CI token (BPC1-…), not the recovery code. The recovery code starts with BPR1-.".into());
        }
        Some(crate::licence::MachineSecret::RunnerToken) => {
            return Err("That's a runner token (BPM1-…), not the recovery code. The recovery code starts with BPR1-.".into());
        }
        Some(crate::licence::MachineSecret::MachinePass) => {
            return Err("That's the runner's machine pass, not the recovery code. The recovery code starts with BPR1-.".into());
        }
        None => {}
    }
    if t.starts_with("BPMK1_") {
        return Err("That's the machine key, not the recovery code. The recovery code starts with BPR1-.".into());
    }
    if t.starts_with("BP-") {
        return Err("That's a licence key, not the recovery code. The recovery code starts with BPR1-.".into());
    }
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

/// An X25519 secret from derived bytes, leaving no copy of them behind.
fn x_secret(k: Key) -> StaticSecret {
    let mut b: [u8; 32] = *k;
    let s = StaticSecret::from(b);
    b.zeroize();
    s
}

pub fn recovery_secret(code: &[u8; 16], ws: &str) -> StaticSecret {
    x_secret(hkdf32(ws.as_bytes(), code, RECOVERY_INFO))
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
    x_secret(hkdf32(ws.as_bytes(), key, MACHINE_INFO))
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

/// The data key versions this Mac holds for one workspace, and the admins' signing keys it trusts
/// (the Keychain entry `people:<ws>`): saved together, so a key is never kept without what let it in.
#[derive(Default, Clone)]
struct Ring {
    keys: BTreeMap<u32, Key>,
    trusted: BTreeSet<String>,
    /// Admins' signing keys withdrawn (`keys/signers.revoked`), never trusted again on this Mac.
    revoked: BTreeSet<String>,
}

#[derive(Serialize, Deserialize)]
struct RingFile {
    v: u32,
    keys: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "BTreeSet::is_empty")]
    trusted: BTreeSet<String>,
    #[serde(default, skip_serializing_if = "BTreeSet::is_empty")]
    revoked: BTreeSet<String>,
}

impl Ring {
    fn current(&self) -> Option<u32> {
        self.keys.keys().next_back().copied()
    }
    /// Pins that still count (a pinned key withdrawn since doesn't).
    fn pinned(&self) -> bool {
        self.trusted.iter().any(|t| !self.revoked.contains(t))
    }
    fn to_json(&self) -> Zeroizing<String> {
        let keys = self.keys.iter().map(|(k, v)| (k.to_string(), STANDARD.encode(&v[..]))).collect();
        Zeroizing::new(serde_json::to_string(&RingFile { v: 2, keys, trusted: self.trusted.clone(), revoked: self.revoked.clone() }).expect("a ring serialises"))
    }
    fn from_json(text: &str) -> Result<Ring, String> {
        let damaged = || "The workspace key on this Mac is damaged.".to_string();
        let f: RingFile = serde_json::from_str(text).map_err(|_| damaged())?;
        if f.v != 1 && f.v != 2 {
            return Err(damaged());
        }
        let mut keys = BTreeMap::new();
        for (k, v) in f.keys {
            let kid: u32 = k.parse().map_err(|_| damaged())?;
            keys.insert(kid, key32(&v)?);
        }
        Ok(Ring { keys, trusted: f.trusted, revoked: f.revoked })
    }
}

/// This Mac's two secrets for a workspace (the Keychain entry `device:<ws>`): the device key
/// (X25519, grants are sealed to it) and the signing key (Ed25519, it signs what an admin's Mac writes).
struct DeviceSecrets {
    x: Key,
    ed: Key,
}

#[derive(Serialize, Deserialize)]
struct DeviceFile {
    v: u32,
    x: String,
    ed: String,
}

impl DeviceSecrets {
    fn x_secret(&self) -> StaticSecret {
        x_secret(self.x.clone())
    }
    fn public(&self) -> [u8; 32] {
        PublicKey::from(&self.x_secret()).to_bytes()
    }
    fn signer(&self) -> String {
        signer_public(&self.ed)
    }
    fn sign(&self, msg: &str) -> String {
        sign_with(&self.ed, msg)
    }
    fn id(&self) -> String {
        device_id(&self.public())
    }
}

/// What the UI may know: whether this Mac holds the key, which versions, and whether it trusts an admin yet.
#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub has_key: bool,
    pub current: Option<u32>,
    pub kids: Vec<u32>,
    /// This Mac has pinned an admin's signing key for the workspace (one that wasn't withdrawn since).
    pub pinned: bool,
    /// This Mac's own signing key was withdrawn (its person stopped being an admin): it signs
    /// nothing with it, and makes a new one with `renew` if they're an admin again.
    pub withdrawn: bool,
}

/// What `review` found: the signing keys this Mac trusts and those withdrawn, after the workspace's revocations.
#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Review {
    pub trusted: Vec<String>,
    pub revoked: Vec<String>,
    pub withdrawn: bool,
}

/// This Mac's keys for the workspace, as the workspace shows them (`devices/<id>`).
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    pub id: String,
    pub public_key: String,
    pub sign_key: String,
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

/// A new recovery code or machine key: shown once; the workspace keeps `publicKey`, `sealed` and `vouch`.
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct NewLock {
    /// The recovery code (`BPR1-…`) or the machine key (`bpmk1_…`), for the admin to write down.
    pub secret: String,
    pub public_key: String,
    pub sealed: Vec<Sealed>,
    pub vouch: Vouch,
}

/// A key version this Mac just made, and its announcement for `keys/meta.checks`.
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
pub struct Announced {
    pub kid: u32,
    pub check: Check,
}

#[derive(Serialize, Deserialize)]
struct Invite {
    v: u32,
    ws: String,
    keys: BTreeMap<String, String>,
    /// v2: the signing key of the admin's Mac that copied the link (pinned when it's taken).
    #[serde(default)]
    signer: String,
}

pub struct WorkspaceKeys<S: SecretStore> {
    store: S,
    rings: Mutex<HashMap<String, Arc<Mutex<Ring>>>>,
    devices: Mutex<HashMap<String, Arc<DeviceSecrets>>>,
    /// The recovery code made last, for the recovery kit (until the dialog is done, or a while).
    pending: Mutex<Option<(String, Zeroizing<String>, Instant)>>,
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

    /// The ring for `ws`, read from the Keychain once per launch. The map stays locked from the
    /// look-up to the insert, so two first calls at the same time share one ring.
    fn ring(&self, ws: &str) -> Result<Arc<Mutex<Ring>>, String> {
        Self::check_ws(ws)?;
        let mut rings = self.rings.lock().unwrap();
        if let Some(r) = rings.get(ws) {
            return Ok(Arc::clone(r));
        }
        let ring = match self.store.get(&format!("people:{ws}"))? {
            Some(text) => Ring::from_json(&Zeroizing::new(text))?,
            None => Ring::default(),
        };
        let r = Arc::new(Mutex::new(ring));
        rings.insert(ws.to_string(), Arc::clone(&r));
        Ok(r)
    }

    /// Changes the ring on a copy, saves the copy, and only then uses it: a failed Keychain write
    /// leaves this Mac as it was, never using a key it won't have after a relaunch.
    fn update_ring<T>(&self, ws: &str, f: impl FnOnce(&mut Ring) -> Result<(T, bool), String>) -> Result<T, String> {
        let r = self.ring(ws)?;
        let mut ring = r.lock().unwrap();
        let mut next = ring.clone();
        let (out, changed) = f(&mut next)?;
        if changed {
            self.store.set(&format!("people:{ws}"), &next.to_json())?;
            *ring = next;
        }
        Ok(out)
    }

    /// Adds key versions (and trusted signing keys); a version this Mac holds with another key is refused (never replaced).
    fn add_keys(&self, ws: &str, keys: Vec<(u32, Key)>, pin: &[String]) -> Result<Vec<u32>, String> {
        self.update_ring(ws, |ring| {
            let mut changed = false;
            for (kid, key) in keys {
                if kid == 0 {
                    return Err("That key version isn't valid.".into());
                }
                match ring.keys.get(&kid) {
                    Some(have) if **have != *key => return Err(format!("This Mac already holds another key {kid} for this workspace.")),
                    Some(_) => {}
                    None => {
                        ring.keys.insert(kid, key);
                        changed = true;
                    }
                }
            }
            for p in pin {
                changed |= ring.trusted.insert(p.clone());
            }
            Ok((ring.keys.keys().copied().collect(), changed))
        })
    }

    pub fn status(&self, ws: &str) -> Result<Status, String> {
        let (st, revoked) = {
            let r = self.ring(ws)?;
            let ring = r.lock().unwrap();
            let st = Status { has_key: !ring.keys.is_empty(), current: ring.current(), kids: ring.keys.keys().copied().collect(), pinned: ring.pinned(), withdrawn: false };
            (st, (!ring.revoked.is_empty()).then(|| ring.revoked.clone()))
        };
        // Only a Mac that knows of a withdrawn key looks at its own (so a first status makes no device key).
        let withdrawn = match revoked {
            Some(rv) => rv.contains(&self.device_secrets(ws)?.signer()),
            None => false,
        };
        Ok(Status { withdrawn, ..st })
    }

    /// What this Mac trusts for `ws`: its pins, its own key and `also`, what they endorse in `trust`,
    /// less every withdrawn key. Without `also`, what it learnt is kept in the Keychain: the keys
    /// withdrawn (for good) and the keys a revocation kept (pinned). With `also` (an invite link's
    /// admin, a recovery code's or machine key's) nothing is kept: that admin isn't trusted yet.
    fn resolve(&self, ws: &str, trust: &Trust, also: Option<&str>) -> Result<Resolved, String> {
        trust.checked()?;
        let own = self.device_secrets(ws)?.signer();
        let (mut roots, known) = {
            let r = self.ring(ws)?;
            let ring = r.lock().unwrap();
            (ring.trusted.clone(), ring.revoked.clone())
        };
        roots.insert(own);
        if let Some(a) = also {
            roots.insert(a.to_string());
        }
        let res = trust.resolve(ws, roots, known);
        if also.is_none() {
            self.update_ring(ws, |ring| {
                let mut changed = false;
                for k in &res.revoked {
                    changed |= ring.revoked.insert(k.clone());
                }
                for k in &res.kept {
                    if !ring.revoked.contains(k) {
                        changed |= ring.trusted.insert(k.clone());
                    }
                }
                Ok(((), changed))
            })?;
        }
        Ok(res)
    }

    /// The signing keys this Mac trusts for `ws` (see `resolve`).
    fn trusted(&self, ws: &str, trust: &Trust, also: Option<&str>) -> Result<BTreeSet<String>, String> {
        Ok(self.resolve(ws, trust, also)?.trusted)
    }

    /// Whether this Mac trusts `signer` (directly, or through the workspace's endorsements).
    pub fn signer_trusted(&self, ws: &str, signer: &str, trust: &Trust) -> Result<bool, String> {
        Ok(self.trusted(ws, trust, None)?.contains(signer))
    }

    /// Applies the workspace's revocations on this Mac (kept from then on) and says what it trusts,
    /// what is withdrawn, and whether its own signing key is.
    pub fn review(&self, ws: &str, trust: &Trust) -> Result<Review, String> {
        let res = self.resolve(ws, trust, None)?;
        let own = self.device_secrets(ws)?.signer();
        Ok(Review { withdrawn: res.revoked.contains(&own), trusted: res.trusted.into_iter().collect(), revoked: res.revoked.into_iter().collect() })
    }

    /// Pins an admin's signing key: the person checked that admin's four words. Never a withdrawn one.
    pub fn trust(&self, ws: &str, signer: &str) -> Result<(), String> {
        parse_signer(signer)?;
        self.update_ring(ws, |ring| {
            if ring.revoked.contains(signer) {
                return Err("That Mac's admin isn't an admin of the workspace any more, so this Mac doesn't trust it.".into());
            }
            Ok(((), ring.trusted.insert(signer.to_string())))
        })
    }

    /// This Mac's secrets, to sign with: refused once its signing key was withdrawn.
    fn signing(&self, ws: &str) -> Result<Arc<DeviceSecrets>, String> {
        let d = self.device_secrets(ws)?;
        let r = self.ring(ws)?;
        if r.lock().unwrap().revoked.contains(&d.signer()) {
            return Err("This Mac's signing key for the workspace was withdrawn when its person stopped being an admin, so other Macs don't take what it signs.".into());
        }
        Ok(d)
    }

    /// Withdraws another admin's signing key (they were removed, or made a member): the revocation
    /// for `keys/signers.revoked`, signed by this Mac, and kept here at once. `keep`: the signing keys
    /// of the admins still there; only those this Mac trusts are named, with its own.
    pub fn revoke(&self, ws: &str, sign_key: &str, keep: &[String], trust: &Trust) -> Result<Revocation, String> {
        parse_signer(sign_key)?;
        let d = self.signing(ws)?;
        let own = d.signer();
        if sign_key == own {
            return Err("This Mac can't withdraw its own signing key.".into());
        }
        let trusted = self.trusted(ws, trust, None)?;
        let mut kept: BTreeSet<String> = keep.iter().filter(|k| *k != sign_key && trusted.contains(*k)).cloned().collect();
        kept.insert(own.clone());
        let keep: Vec<String> = kept.into_iter().collect();
        let sig = d.sign(&revoke_msg(ws, sign_key, &keep));
        self.update_ring(ws, |ring| Ok(((), ring.revoked.insert(sign_key.to_string()))))?;
        Ok(Revocation { pk: sign_key.to_string(), keep, by: own, sig })
    }

    /// A new device and signing key for this Mac, once its old signing key was withdrawn and its
    /// person is an admin again. Its key versions stay; its new keys show as a new Mac, which proves
    /// it holds the key, so another admin's Mac endorses it. Refused while the old key is good.
    pub fn renew(&self, ws: &str) -> Result<Device, String> {
        if !self.status(ws)?.withdrawn {
            return Err("This Mac's signing key wasn't withdrawn.".into());
        }
        let secrets = DeviceSecrets { x: Zeroizing::new(random()?), ed: Zeroizing::new(random()?) };
        let f = Zeroizing::new(serde_json::to_string(&DeviceFile { v: 2, x: STANDARD.encode(&secrets.x[..]), ed: STANDARD.encode(&secrets.ed[..]) }).expect("serialises"));
        let mut devices = self.devices.lock().unwrap();
        self.store.set(&format!("device:{ws}"), &f)?;
        devices.insert(ws.to_string(), Arc::new(secrets));
        drop(devices);
        self.device(ws)
    }

    /// The first key of a workspace (its first admin's Mac): version 1, or `kid` when every copy of
    /// the key was lost and an admin starts again with the next version. Refused when this Mac holds one.
    /// Returns its announcement, signed by this Mac.
    pub fn create(&self, ws: &str, kid: Option<u32>) -> Result<Announced, String> {
        if self.status(ws)?.has_key {
            return Err("This Mac already holds this workspace's key.".into());
        }
        let kid = kid.unwrap_or(1).max(1);
        self.signing(ws)?;
        self.add_keys(ws, vec![(kid, Zeroizing::new(random()?))], &[])?;
        self.announce(ws, kid)
    }

    /// A new key version (after someone leaves). New content is sealed with it. Returns its announcement.
    pub fn rotate(&self, ws: &str) -> Result<Announced, String> {
        self.signing(ws)?;
        let next = self.status(ws)?.current.ok_or("This Mac doesn't hold this workspace's key.")? + 1;
        self.add_keys(ws, vec![(next, Zeroizing::new(random()?))], &[])?;
        self.announce(ws, next)
    }

    /// The announcement of key `kid` for `keys/meta.checks`: its commitment, signed by this Mac.
    pub fn announce(&self, ws: &str, kid: u32) -> Result<Announced, String> {
        let (kid, key) = self.key(ws, Some(kid))?;
        let d = self.signing(ws)?;
        let check = key_check(&key, ws, kid);
        let sig = d.sign(&key_msg(ws, kid, &check));
        Ok(Announced { kid, check: Check { check, by: d.signer(), sig } })
    }

    /// Signs another admin's signing key, so the team's Macs trust what that admin's Mac signs.
    pub fn endorse(&self, ws: &str, sign_key: &str) -> Result<Endorsement, String> {
        parse_signer(sign_key)?;
        let d = self.signing(ws)?;
        Ok(Endorsement { pk: sign_key.to_string(), by: d.signer(), sig: d.sign(&signer_msg(ws, sign_key)) })
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

    /// This Mac's device and signing secrets for `ws`, made the first time. The map stays locked
    /// from the look-up to the insert, so two first calls never make two different keys; a secret
    /// whose Keychain write failed isn't kept.
    fn device_secrets(&self, ws: &str) -> Result<Arc<DeviceSecrets>, String> {
        Self::check_ws(ws)?;
        let mut devices = self.devices.lock().unwrap();
        if let Some(d) = devices.get(ws) {
            return Ok(Arc::clone(d));
        }
        let entry = format!("device:{ws}");
        let damaged = || "This Mac's device key for the workspace is damaged.".to_string();
        let stored = self.store.get(&entry)?.map(Zeroizing::new);
        let (secrets, save) = match stored.as_deref() {
            Some(text) if text.trim_start().starts_with('{') => {
                let f: DeviceFile = serde_json::from_str(text).map_err(|_| damaged())?;
                (DeviceSecrets { x: key32(&f.x).map_err(|_| damaged())?, ed: key32(&f.ed).map_err(|_| damaged())? }, false)
            }
            // A device key from before signing keys: it keeps its id, and gets a signing key now.
            Some(text) => (DeviceSecrets { x: key32(text)?, ed: Zeroizing::new(random()?) }, true),
            None => (DeviceSecrets { x: Zeroizing::new(random()?), ed: Zeroizing::new(random()?) }, true),
        };
        if save {
            let f = Zeroizing::new(serde_json::to_string(&DeviceFile { v: 2, x: STANDARD.encode(&secrets.x[..]), ed: STANDARD.encode(&secrets.ed[..]) }).expect("serialises"));
            self.store.set(&entry, &f)?;
        }
        let d = Arc::new(secrets);
        devices.insert(ws.to_string(), Arc::clone(&d));
        Ok(d)
    }

    /// This Mac's keys for the workspace (made the first time).
    pub fn device(&self, ws: &str) -> Result<Device, String> {
        let d = self.device_secrets(ws)?;
        let pk = d.public();
        let sign = SigningKey::from_bytes(&d.ed).verifying_key().to_bytes();
        Ok(Device { id: device_id(&pk), public_key: STANDARD.encode(pk), sign_key: STANDARD.encode(sign), fingerprint: fingerprint(&pk, &sign) })
    }

    /// Every key version this Mac holds, sealed to `public_key` (a device being approved, the
    /// recovery code's or the machine key's) and signed by this Mac. `recipient`: the device id,
    /// `recovery` or `machine`.
    pub fn grant(&self, ws: &str, recipient: &str, public_key: &str) -> Result<Vec<Sealed>, String> {
        let pk = parse_public(public_key)?;
        if recipient != "recovery" && recipient != "machine" && recipient != device_id(&pk) {
            return Err("That device key doesn't belong to that device.".into());
        }
        let d = self.signing(ws)?;
        let r = self.ring(ws)?;
        let ring = r.lock().unwrap();
        if ring.keys.is_empty() {
            return Err("This Mac doesn't hold this workspace's key.".into());
        }
        let by = d.signer();
        ring.keys
            .iter()
            .map(|(kid, key)| {
                let mut s = seal_to(&pk, ws, recipient, *kid, key)?;
                s.by = by.clone();
                s.sig = d.sign(&sealed_msg(ws, recipient, &s));
                Ok(s)
            })
            .collect()
    }

    /// Opens sealed copies after checking each is signed by a trusted admin and is the key announced.
    fn take_sealed(&self, ws: &str, secret: &StaticSecret, recipient: &str, sealed: &[Sealed], trust: &Trust, root: Option<&str>) -> Result<Vec<u32>, String> {
        if sealed.is_empty() || sealed.len() > 100 {
            return Err("That key copy is empty.".into());
        }
        let res = self.resolve(ws, trust, root)?;
        if root.is_some_and(|r| res.revoked.contains(r)) {
            let what = if recipient == "machine" { "machine key" } else { "recovery code" };
            return Err(format!("This {what} was made by an admin who isn't an admin of the workspace any more, so this Mac doesn't take it. An admin makes a new one in Settings → Workspace → Encryption."));
        }
        let trusted = res.trusted;
        let mut keys = Vec::new();
        for s in sealed {
            check_sealed(ws, recipient, &trusted, s)?;
            let key = open_sealed(secret, ws, recipient, s)?;
            trust.check_key(ws, &trusted, s.kid, &key)?;
            keys.push((s.kid, key));
        }
        let pin: Vec<String> = root.map(|r| vec![r.to_string()]).unwrap_or_default();
        self.add_keys(ws, keys, &pin)
    }

    /// Takes the key versions an admin sealed to this Mac: only when an admin this Mac trusts signed
    /// them, and each matches the version the workspace announced.
    pub fn accept(&self, ws: &str, sealed: &[Sealed], trust: &Trust) -> Result<Vec<u32>, String> {
        let d = self.device_secrets(ws)?;
        self.take_sealed(ws, &d.x_secret(), &d.id(), sealed, trust, None)
    }

    /// This Mac's proof that it holds the newest key it has, for its device document.
    pub fn prove(&self, ws: &str) -> Result<Proof, String> {
        let (kid, key) = self.key(ws, None)?;
        let d = self.device_secrets(ws)?;
        Ok(Proof { kid, mac: STANDARD.encode(holds_mac(&key, ws, &d.id(), &d.signer())) })
    }

    /// An admin's Mac checks another device's proof (false when this Mac doesn't hold that key version).
    pub fn check_proof(&self, ws: &str, device: &str, sign_key: &str, proof: &Proof) -> Result<bool, String> {
        let r = self.ring(ws)?;
        let ring = r.lock().unwrap();
        let Some(key) = ring.keys.get(&proof.kid) else { return Ok(false) };
        Ok(same_b64(&proof.mac, &holds_mac(key, ws, device, sign_key)))
    }

    fn vouch(&self, ws: &str, recipient: &str, secret: &[u8]) -> Result<Vouch, String> {
        let by = self.signing(ws)?.signer();
        let mac = STANDARD.encode(vouch_mac(secret, ws, recipient, &by));
        Ok(Vouch { by, mac })
    }

    /// The admin a recovery code's or machine key's copy vouches for (an error when it doesn't).
    fn vouched(ws: &str, recipient: &str, secret: &[u8], vouch: &Vouch) -> Result<String, String> {
        parse_signer(&vouch.by)?;
        if !same_b64(&vouch.mac, &vouch_mac(secret, ws, recipient, &vouch.by)) {
            return Err(format!("The workspace's {recipient} copy isn't one an admin made with this {}, so this Mac doesn't take it.",
                if recipient == "recovery" { "recovery code" } else { "machine key" }));
        }
        Ok(vouch.by.clone())
    }

    /// A new recovery code, with every key version sealed to it. Kept for the recovery kit until `forget_pending`.
    pub fn recovery_new(&self, ws: &str) -> Result<NewLock, String> {
        Self::check_ws(ws)?;
        let code = Zeroizing::new(random::<16>()?);
        let secret = recovery_secret(&code, ws);
        let public_key = public_of(&secret);
        let sealed = self.grant(ws, "recovery", &public_key)?;
        let vouch = self.vouch(ws, "recovery", &code[..])?;
        let text = recovery_code_text(&code);
        *self.pending.lock().unwrap() = Some((ws.to_string(), Zeroizing::new(text.clone()), Instant::now()));
        Ok(NewLock { secret: text, public_key, sealed, vouch })
    }

    pub fn pending_code(&self, ws: &str) -> Option<Zeroizing<String>> {
        let mut p = self.pending.lock().unwrap();
        if p.as_ref().is_some_and(|(_, _, at)| at.elapsed() > PENDING_FOR) {
            *p = None;
        }
        p.as_ref().filter(|(w, _, _)| w == ws).map(|(_, c, _)| c.clone())
    }

    pub fn forget_pending(&self) {
        *self.pending.lock().unwrap() = None;
    }

    /// Opens `keys/recovery` with the recovery code the admin typed: only a copy the code vouches for,
    /// signed by that admin or one it endorsed.
    pub fn recover(&self, ws: &str, code: &str, public_key: &str, sealed: &[Sealed], vouch: &Vouch, trust: &Trust) -> Result<Vec<u32>, String> {
        Self::check_ws(ws)?;
        let code = Zeroizing::new(parse_recovery_code(code)?);
        let secret = recovery_secret(&code, ws);
        if public_of(&secret) != public_key.trim() {
            return Err("That recovery code isn't this workspace's, or a newer one was made since.".into());
        }
        let root = Self::vouched(ws, "recovery", &code[..], vouch)?;
        self.take_sealed(ws, &secret, "recovery", sealed, trust, Some(&root))
    }

    /// A new machine key for the runner and CI, with every key version sealed to it (`keys/machine`).
    pub fn machine_new(&self, ws: &str) -> Result<NewLock, String> {
        Self::check_ws(ws)?;
        let key = Zeroizing::new(random::<32>()?);
        let secret = machine_secret(&key, ws);
        let public_key = public_of(&secret);
        let sealed = self.grant(ws, "machine", &public_key)?;
        let vouch = self.vouch(ws, "machine", &key[..])?;
        Ok(NewLock { secret: machine_key_text(&key), public_key, sealed, vouch })
    }

    /// A runner Mac given the machine key: opens `keys/machine` with it, as `recover` does.
    pub fn machine_use(&self, ws: &str, machine_key: &str, public_key: &str, sealed: &[Sealed], vouch: &Vouch, trust: &Trust) -> Result<Vec<u32>, String> {
        Self::check_ws(ws)?;
        let key = parse_machine_key(machine_key)?;
        let secret = machine_secret(&key, ws);
        if public_of(&secret) != public_key.trim() {
            return Err("That machine key isn't this workspace's, or a newer one was made since.".into());
        }
        let root = Self::vouched(ws, "machine", &key[..], vouch)?;
        self.take_sealed(ws, &secret, "machine", sealed, trust, Some(&root))
    }

    /// The `k=` part of an invite link: every key version, for this workspace only, with this Mac's signing key.
    pub fn invite(&self, ws: &str) -> Result<Zeroizing<String>, String> {
        let signer = self.signing(ws)?.signer();
        let r = self.ring(ws)?;
        let ring = r.lock().unwrap();
        if ring.keys.is_empty() {
            return Err("This Mac doesn't hold this workspace's key.".into());
        }
        let keys = ring.keys.iter().map(|(k, v)| (k.to_string(), URL_SAFE_NO_PAD.encode(&v[..]))).collect();
        let json = Zeroizing::new(serde_json::to_string(&Invite { v: 2, ws: ws.to_string(), keys, signer }).expect("invite serialises"));
        Ok(Zeroizing::new(URL_SAFE_NO_PAD.encode(json.as_bytes())))
    }

    /// Takes the keys from an invite link's `k=` part, once the person accepted the workspace: each
    /// must be the version the workspace announced, by the link's admin (pinned then, when this Mac
    /// trusts nobody yet) or an admin this Mac already trusts.
    pub fn import_invite(&self, ws: &str, bundle: &str, trust: &Trust) -> Result<Vec<u32>, String> {
        let bad = || "The key in the invite link is incomplete. Ask for a new link.".to_string();
        let raw = Zeroizing::new(URL_SAFE_NO_PAD.decode(bundle.trim()).map_err(|_| bad())?);
        let inv: Invite = serde_json::from_slice(&raw).map_err(|_| bad())?;
        if inv.v != 2 || parse_signer(&inv.signer).is_err() {
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
        if keys.is_empty() {
            return Err(bad());
        }
        let pinned = self.status(ws)?.pinned;
        let trusted = self.trusted(ws, trust, if pinned { None } else { Some(&inv.signer) })?;
        if !trusted.contains(&inv.signer) {
            return Err("The invite link wasn't made by an admin this Mac trusts. Ask an admin of the workspace for a new link.".into());
        }
        for (kid, key) in &keys {
            trust.check_key(ws, &trusted, *kid, key)?;
        }
        self.add_keys(ws, keys, &[inv.signer])
    }

    /// Drops the key versions older than `keep`, once everything is sealed with `keep` (the reseal
    /// job finished for it). Refused unless this Mac holds `keep`, so it never ends up with no key.
    /// Returns the versions it still holds.
    pub fn retire(&self, ws: &str, keep: u32) -> Result<Vec<u32>, String> {
        self.update_ring(ws, |ring| {
            if !ring.keys.contains_key(&keep) {
                return Err(format!("This Mac doesn't hold key {keep} of this workspace."));
            }
            let before = ring.keys.len();
            ring.keys.retain(|kid, _| *kid >= keep);
            let changed = ring.keys.len() != before;
            Ok((ring.keys.keys().copied().collect(), changed))
        })
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
    pub async fn workspace_keys_create(k: State<'_, KeysState>, ws: String, kid: Option<u32>) -> Result<Announced, String> {
        let k = Arc::clone(&k);
        blocking(move || k.create(&ws, kid)).await
    }

    #[tauri::command]
    pub async fn workspace_keys_rotate(k: State<'_, KeysState>, ws: String) -> Result<Announced, String> {
        let k = Arc::clone(&k);
        blocking(move || k.rotate(&ws)).await
    }

    #[tauri::command]
    pub async fn workspace_keys_announce(k: State<'_, KeysState>, ws: String, kid: u32) -> Result<Announced, String> {
        let k = Arc::clone(&k);
        blocking(move || k.announce(&ws, kid)).await
    }

    #[tauri::command]
    pub async fn workspace_keys_endorse(k: State<'_, KeysState>, ws: String, sign_key: String) -> Result<Endorsement, String> {
        let k = Arc::clone(&k);
        blocking(move || k.endorse(&ws, &sign_key)).await
    }

    #[tauri::command]
    pub async fn workspace_keys_trust(k: State<'_, KeysState>, ws: String, signer: String) -> Result<(), String> {
        let k = Arc::clone(&k);
        blocking(move || k.trust(&ws, &signer)).await
    }

    #[tauri::command]
    pub async fn workspace_keys_signer_trusted(k: State<'_, KeysState>, ws: String, signer: String, trust: Trust) -> Result<bool, String> {
        let k = Arc::clone(&k);
        blocking(move || k.signer_trusted(&ws, &signer, &trust)).await
    }

    #[tauri::command]
    pub async fn workspace_keys_review(k: State<'_, KeysState>, ws: String, trust: Trust) -> Result<Review, String> {
        let k = Arc::clone(&k);
        blocking(move || k.review(&ws, &trust)).await
    }

    #[tauri::command]
    pub async fn workspace_keys_revoke(k: State<'_, KeysState>, ws: String, sign_key: String, keep: Vec<String>, trust: Trust) -> Result<Revocation, String> {
        let k = Arc::clone(&k);
        blocking(move || k.revoke(&ws, &sign_key, &keep, &trust)).await
    }

    #[tauri::command]
    pub async fn workspace_keys_renew(k: State<'_, KeysState>, ws: String) -> Result<Device, String> {
        let k = Arc::clone(&k);
        blocking(move || k.renew(&ws)).await
    }

    #[tauri::command]
    pub async fn workspace_keys_prove(k: State<'_, KeysState>, ws: String) -> Result<Proof, String> {
        let k = Arc::clone(&k);
        blocking(move || k.prove(&ws)).await
    }

    #[tauri::command]
    pub async fn workspace_keys_check_proof(k: State<'_, KeysState>, ws: String, device: String, sign_key: String, proof: Proof) -> Result<bool, String> {
        let k = Arc::clone(&k);
        blocking(move || k.check_proof(&ws, &device, &sign_key, &proof)).await
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

    /// The four words for a Mac's two keys (an admin checks them before approving; a new Mac checks
    /// the admin's Mac that let it in).
    #[tauri::command]
    pub fn workspace_keys_fingerprint(public_key: String, sign_key: String) -> Result<String, String> {
        Ok(fingerprint(&parse_public(&public_key)?, &parse_signer(&sign_key)?.to_bytes()))
    }

    #[tauri::command]
    pub async fn workspace_keys_grant(k: State<'_, KeysState>, ws: String, recipient: String, public_key: String) -> Result<Vec<Sealed>, String> {
        let k = Arc::clone(&k);
        blocking(move || k.grant(&ws, &recipient, &public_key)).await
    }

    #[tauri::command]
    pub async fn workspace_keys_accept(k: State<'_, KeysState>, ws: String, sealed: Vec<Sealed>, trust: Trust) -> Result<Vec<u32>, String> {
        let k = Arc::clone(&k);
        blocking(move || k.accept(&ws, &sealed, &trust)).await
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
    pub async fn workspace_keys_recover(k: State<'_, KeysState>, ws: String, code: String, public_key: String, sealed: Vec<Sealed>, vouch: Vouch, trust: Trust) -> Result<Vec<u32>, String> {
        let k = Arc::clone(&k);
        let code = Zeroizing::new(code);
        blocking(move || k.recover(&ws, &code, &public_key, &sealed, &vouch, &trust)).await
    }

    #[tauri::command]
    pub async fn workspace_keys_machine_new(k: State<'_, KeysState>, ws: String) -> Result<NewLock, String> {
        let k = Arc::clone(&k);
        blocking(move || k.machine_new(&ws)).await
    }

    #[tauri::command]
    pub async fn workspace_keys_machine_use(k: State<'_, KeysState>, ws: String, machine_key: String, public_key: String, sealed: Vec<Sealed>, vouch: Vouch, trust: Trust) -> Result<Vec<u32>, String> {
        let k = Arc::clone(&k);
        let machine_key = Zeroizing::new(machine_key);
        blocking(move || k.machine_use(&ws, &machine_key, &public_key, &sealed, &vouch, &trust)).await
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
        let text = Zeroizing::new(format!("{link}{sep}k={}", bundle.as_str()));
        app.clipboard().write_text(text.as_str()).map_err(|e| e.to_string())
    }

    #[tauri::command]
    pub async fn workspace_keys_import_invite(k: State<'_, KeysState>, ws: String, bundle: String, trust: Trust) -> Result<Vec<u32>, String> {
        let k = Arc::clone(&k);
        let bundle = Zeroizing::new(bundle);
        blocking(move || k.import_invite(&ws, &bundle, &trust)).await
    }

    #[tauri::command]
    pub async fn workspace_keys_retire(k: State<'_, KeysState>, ws: String, keep: u32) -> Result<Vec<u32>, String> {
        let k = Arc::clone(&k);
        blocking(move || k.retire(&ws, keep)).await
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
