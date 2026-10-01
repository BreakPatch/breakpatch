//! Breakpatch Team licence check (docs/editions.md; the Team back office README, "Licence tokens").
//!
//! The licence service hands out compact JWS tokens signed with Ed25519. This module checks them
//! offline against public keys built into the app at compile time: `BREAKPATCH_LICENCE_PUBKEYS`,
//! a JSON map kid → base64url key, which build.rs writes into the build masked and split
//! (licence_embed.rs), never as a plain string. Community and source builds have no keys, so every
//! licence command answers "not available in this edition".
//!
//! Each activation and refresh sends this Mac's `deviceId` (the hashed hardware id, or a random id
//! kept in the Keychain). A token the service bound to a device (`dev`) only works on that Mac.
//! The latest time seen is kept with the licence: a clock set back by more than a day makes the
//! licence `invalid` until an online refresh works.
//!
//! The token, the licence key and who it was activated for live in one Keychain entry per
//! workspace (service `dev.breakpatch.licence`, entry `licence:<wsKey>`). Keys and tokens never go
//! to the log.
//!
//! Licences per workspace (the Team repo's docs/migration-and-workspaces.md): the UI names the open
//! connection with [`Licensing::select`] (`licence_select`) whenever it changes; the engine's token
//! and the usage counts follow that. Status, activate, refresh and release name the connection
//! they're for (`wsKey`), so a switch while one is on its way never puts one workspace's licence
//! in another's entry; without one they use the selected entry. With nothing selected, nothing is
//! unlocked. A `wsKey` is the
//! connection's key as the UI makes it: `team:<projectId>/<database>` for a Team workspace, and a
//! local tests folder's connection may hold one too (the Solo plan), so nothing here assumes a
//! licence belongs to a Team workspace. The single `licence` entry of earlier versions moves to
//! the workspace it was activated for the first time that workspace is selected.
//!
//! Solo (the Team repo's issues #26 and #36): a Solo licence works with no workspace, on a tests
//! folder. Its entry is the folder's own (`licence:local:<hash>`, the UI's connectionIds.ts); it
//! activates with an empty `workspaceProjectId` and always with this Mac's deviceId, and its token
//! says `"tier": "solo"`, `"workspaceProjectId": ""` and `parallelRuns` (one run at a time). The
//! UI asks about a folder with the workspace `""`, so only a token with no workspace unlocks it.
//! The same person (the purchase email) connecting a workspace later reuses the seat: an empty key
//! activates with the key stored for another connection (`key_from`), so the UI never holds it.
//! A refusal the service words for Solo keeps its words, and the stored tier gives Solo's words to
//! the states worked out here. A key that takes a connection over from another licence (Solo to
//! Team) gives the old licence's seat back.
//!
//! Each refresh also carries this Mac's usage counts (usage.rs: numbers only), which are cleared
//! only when the service answers `usageAccepted: true`.
//!
//! States (`Status::state`), checked on this Mac with no network:
//! - `active`  the token's `exp` hasn't passed;
//! - `grace`   after `exp`, before `offlineUntil` (capped at [`OFFLINE_DAYS`]): still unlocked;
//! - `expired` after that, or once the licence's end date has passed;
//! - `invalid` a bad signature or an unknown key id;
//! - `none`    nothing stored, or the service refused (the code and message say why);
//! - `unavailable` no keys built in.

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::secrets::SecretStore;
use crate::usage::UsageStore;

pub const KEYCHAIN_SERVICE: &str = "dev.breakpatch.licence";
/// The one entry of versions before licences per workspace; moved by [`Licensing::select`].
const LEGACY_ENTRY: &str = "licence";

/// The Keychain entry for a workspace's licence.
pub fn entry_for(ws_key: &str) -> String {
    format!("licence:{ws_key}")
}

/// The project of a Team workspace's key (`team:<projectId>/<database>`), else None.
fn ws_project(ws_key: &str) -> Option<&str> {
    ws_key.strip_prefix("team:")?.split_once('/').map(|(p, _)| p).filter(|p| !p.is_empty())
}

/// A connection key the UI may name: short, printable, no spaces or control characters. The UI
/// makes them in the open repo's app/src/state/connectionIds.ts, whose test pins the format; a
/// change there has to keep every key it makes valid here, or the Keychain entries are orphaned.
pub fn valid_ws_key(k: &str) -> bool {
    !k.is_empty()
        && k.len() <= 200
        && k.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-' | b':' | b'/' | b'@'))
}

/// Longest a licence keeps working without reaching the service, counted from when its token was
/// issued. The service puts the same limit in each token (`offlineUntil`); the app holds to the
/// smaller of the two, so this is the one place to change it on the app side.
pub const OFFLINE_DAYS: i64 = 30;
const ISSUER: &str = "breakpatch-backoffice";
const TOKEN_VERSION: i64 = 1;

/// The public keys built in, masked (build.rs writes this from `BREAKPATCH_LICENCE_PUBKEYS`,
/// set by scripts/build-release.sh).
mod built {
    include!(concat!(env!("OUT_DIR"), "/licence_keys.rs"));
}
#[path = "licence_embed.rs"]
mod embed;

/// A clock more than this far behind the latest time seen means someone set it back.
pub const CLOCK_SLACK: i64 = 86_400;
/// How often the latest time seen is written to the Keychain (not on every status check).
const SEEN_EVERY: i64 = 3_600;
const DEVICE_ENTRY: &str = "device";

/// The service's address; `BP_LICENCE_URL` overrides it in development builds (tests, the emulator).
pub const DEFAULT_URL: &str = match option_env!("BREAKPATCH_LICENCE_URL") {
    Some(u) => u,
    None => "https://account.breakpatch.dev/api",
};

// ---- Public keys -------------------------------------------------------------------------------

#[derive(Clone, Default)]
pub struct KeyTable(BTreeMap<String, VerifyingKey>);

impl KeyTable {
    /// The keys this build was compiled with; empty in Community and source builds.
    pub fn compiled() -> Self {
        // black_box: the optimiser mustn't fold the key back into a plain constant, and the
        // digests build-release.sh checks for must stay in the binary.
        let digests = std::hint::black_box(built::DIGESTS);
        let masked = std::hint::black_box(&built::MASKED);
        let pads = std::hint::black_box(&built::PADS);
        let mut out = BTreeMap::new();
        for (i, kid) in built::KIDS.iter().enumerate() {
            match VerifyingKey::from_bytes(&embed::mask(&masked[i], &pads[i])) {
                Ok(k) => {
                    out.insert(kid.to_string(), k);
                }
                Err(e) => log::error!("the licence key {kid} built into this app is unusable: {e}"),
            }
        }
        if out.len() != digests.split(';').filter(|d| !d.is_empty()).count() {
            log::error!("the licence keys built into this app don't match their digests");
        }
        Self(out)
    }

    /// Whether this build has licence keys at all (Team), without reading them.
    #[cfg(test)]
    pub fn built_in() -> bool {
        !built::KIDS.is_empty()
    }

    /// `{"<kid>": "<base64url 32-byte Ed25519 public key>", …}`
    #[cfg(test)]
    pub fn parse(json: &str) -> Result<Self, String> {
        let map: BTreeMap<String, String> =
            serde_json::from_str(json).map_err(|e| format!("not a JSON map of key id to key: {e}"))?;
        let mut out = BTreeMap::new();
        for (kid, b64) in map {
            let bytes = URL_SAFE_NO_PAD.decode(b64.trim()).map_err(|e| format!("key {kid}: {e}"))?;
            let raw: [u8; 32] = bytes.try_into().map_err(|_| format!("key {kid}: not 32 bytes"))?;
            let key = VerifyingKey::from_bytes(&raw).map_err(|e| format!("key {kid}: {e}"))?;
            out.insert(kid, key);
        }
        Ok(Self(out))
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    #[cfg(test)]
    pub fn kids(&self) -> Vec<&str> {
        self.0.keys().map(String::as_str).collect()
    }
}

// ---- Tokens ------------------------------------------------------------------------------------

#[derive(Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Claims {
    pub iss: String,
    pub v: i64,
    pub licence_id: String,
    pub activation_id: String,
    pub tier: String,
    pub features: Vec<String>,
    pub seats: u32,
    pub machines: u32,
    pub subject_hash: String,
    pub kind: Kind,
    pub workspace_project_id: String,
    pub iat: i64,
    pub exp: i64,
    pub offline_until: i64,
    pub licence_expires_at: i64,
    /// The device the service bound the seat to (R1): a hash of this Mac's `deviceId` with the
    /// activation, see [`device_hash`]. Older tokens don't have it.
    #[serde(default)]
    pub dev: Option<String>,
    /// Solo only: test runs at once on this activation (this Mac, or this machine licence). The
    /// service says 1; tokens of other tiers don't have it.
    #[serde(default)]
    pub parallel_runs: Option<u32>,
}

/// The token's `dev` for `device` on `activation_id`, as the back office works it out
/// (functions/src/licensing.ts `deviceHash`): SHA-256 of `device:<activationId>:<deviceId>`,
/// first 32 hex characters.
pub fn device_hash(activation_id: &str, device: &str) -> String {
    use sha2::{Digest, Sha256};
    let d = Sha256::digest(format!("device:{activation_id}:{device}").as_bytes());
    d.iter().take(16).map(|b| format!("{b:02x}")).collect()
}

/// Whether a token bound to a device (`dev`) belongs to this Mac. Tokens without `dev` do.
pub fn dev_matches(c: &Claims, device: Option<&str>) -> bool {
    match (&c.dev, device) {
        (None, _) => true,
        (Some(_), None) => false,
        (Some(dev), Some(me)) => dev == me || *dev == device_hash(&c.activation_id, me),
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum VerifyError {
    Malformed,
    UnknownKid,
    BadSignature,
    NotOurs,
}

#[derive(Deserialize)]
struct Header {
    alg: String,
    kid: String,
}

/// Checks the signature with the key named by the header's `kid`, then the issuer and version.
pub fn verify(token: &str, keys: &KeyTable) -> Result<Claims, VerifyError> {
    let mut parts = token.trim().split('.');
    let (h, p, s) = match (parts.next(), parts.next(), parts.next(), parts.next()) {
        (Some(h), Some(p), Some(s), None) => (h, p, s),
        _ => return Err(VerifyError::Malformed),
    };
    let header: Header = decode_json(h)?;
    if header.alg != "EdDSA" {
        return Err(VerifyError::NotOurs);
    }
    let key = keys.0.get(&header.kid).ok_or(VerifyError::UnknownKid)?;
    let sig: [u8; 64] = URL_SAFE_NO_PAD
        .decode(s)
        .map_err(|_| VerifyError::Malformed)?
        .try_into()
        .map_err(|_| VerifyError::Malformed)?;
    key.verify(format!("{h}.{p}").as_bytes(), &Signature::from_bytes(&sig)).map_err(|_| VerifyError::BadSignature)?;
    let claims: Claims = decode_json(p)?;
    if claims.iss != ISSUER || claims.v != TOKEN_VERSION {
        return Err(VerifyError::NotOurs);
    }
    Ok(claims)
}

fn decode_json<T: for<'de> Deserialize<'de>>(part: &str) -> Result<T, VerifyError> {
    let bytes = URL_SAFE_NO_PAD.decode(part).map_err(|_| VerifyError::Malformed)?;
    serde_json::from_slice(&bytes).map_err(|_| VerifyError::Malformed)
}

// ---- What's stored, and the status the UI sees -----------------------------------------------------

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Person,
    Machine,
}

impl Kind {
    fn parse(s: &str) -> Option<Self> {
        match s {
            "person" => Some(Self::Person),
            "machine" => Some(Self::Machine),
            _ => None,
        }
    }
}

/// The Keychain entry. No `Debug`: it holds the licence key and the token.
#[derive(Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
struct Stored {
    key: String,
    subject: String,
    kind: Kind,
    workspace_project_id: String,
    #[serde(default)]
    machine_name: Option<String>,
    #[serde(default)]
    token: Option<String>,
    /// From the service's last answer (the token doesn't carry them).
    #[serde(default)]
    seats_used: Option<u32>,
    #[serde(default)]
    machines_used: Option<u32>,
    #[serde(default)]
    customer_name: Option<String>,
    /// The code of the refusal that left this Mac without a token (out_of_seats, revoked, …).
    #[serde(default)]
    error: Option<String>,
    /// The latest time seen (Unix seconds), for spotting a clock set back (R7).
    #[serde(default)]
    seen_at: Option<i64>,
    /// The clock was found set back: invalid until an online refresh works.
    #[serde(default)]
    clock_back: bool,
    /// The tier of the last token taken (or "solo" when the service's refusal said so), so a
    /// refusal kept without a token still gets its tier's words.
    #[serde(default)]
    tier: Option<String>,
}

impl Stored {
    fn same_holder(&self, subject: &str, kind: Kind, ws: &str) -> bool {
        self.subject == subject && self.kind == kind && self.workspace_project_id == ws
    }
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum State {
    None,
    Active,
    Grace,
    Expired,
    Invalid,
    Unavailable,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub state: State,
    /// Unlocked features: the token's while `active` or `grace`, else none.
    pub features: Vec<String>,
    pub tier: Option<String>,
    /// The licence the token is for, so the UI can tell two connections hold the same one.
    pub licence_id: Option<String>,
    /// Solo: test runs at once on this activation (the token's `parallelRuns`).
    pub parallel_runs: Option<u32>,
    pub seats: Option<u32>,
    pub seats_used: Option<u32>,
    pub machines: Option<u32>,
    pub machines_used: Option<u32>,
    pub customer_name: Option<String>,
    pub kind: Option<Kind>,
    /// Who holds the seat: the email for a person, this Mac's id for a machine.
    pub subject: Option<String>,
    pub workspace_project_id: Option<String>,
    /// Unix seconds. `expiresAt` is the token's `exp` (refresh before it).
    pub expires_at: Option<i64>,
    pub offline_until: Option<i64>,
    pub licence_expires_at: Option<i64>,
    /// Last four characters of the key, for "key ending 7K2Q".
    pub key_hint: Option<String>,
    /// Why it's locked (a service code such as `out_of_seats`, or `offline_too_long`).
    pub code: Option<String>,
    pub message: Option<String>,
}

impl Status {
    fn bare(state: State) -> Self {
        Self {
            state,
            features: Vec::new(),
            tier: None,
            licence_id: None,
            parallel_runs: None,
            seats: None,
            seats_used: None,
            machines: None,
            machines_used: None,
            customer_name: None,
            kind: None,
            subject: None,
            workspace_project_id: None,
            expires_at: None,
            offline_until: None,
            licence_expires_at: None,
            key_hint: None,
            code: None,
            message: None,
        }
    }
    fn with_code(mut self, code: &str) -> Self {
        let solo = self.tier.as_deref() == Some(SOLO);
        self.message = Some(message_for_tier(code, None, solo));
        self.code = Some(code.to_string());
        self
    }
}

/// The tier with no workspace needed and one person on one Mac (the back office's tiers.ts).
pub const SOLO: &str = "solo";

/// Whether a service message is one of Solo's own (licensing.ts words them "…Solo…").
fn names_solo(service_message: Option<&str>) -> bool {
    service_message.is_some_and(|m| m.contains("Solo"))
}

/// [`message_for`], in Solo's words when `solo`: one person on one Mac, nobody to ask, and the
/// account page to free the Mac or renew. A Solo refusal's own message from the service is kept.
pub fn message_for_tier(code: &str, service_message: Option<&str>, solo: bool) -> String {
    if !solo {
        return message_for(code, service_message);
    }
    let m = match code {
        "revoked" => "This Solo licence is no longer active. Contact Breakpatch at support@breakpatch.dev.",
        "expired" => "Your Solo licence has expired. Renew it at account.breakpatch.dev.",
        "out_of_seats" => "This Solo licence is already used by someone else. Solo is for one person: for more people, choose Team.",
        "out_of_machines" => "This Solo licence's machine licence is in use. Free it at account.breakpatch.dev, then try again.",
        "released" => "This Mac's Solo seat was freed. Activate again to use Solo here.",
        "over_seats" => "This Mac's Solo seat was freed. Activate again to use Solo here.",
        "too_many_devices" => "This Solo licence is in use on another Mac. Free it at account.breakpatch.dev, then try again.",
        "other_device" => "This Solo licence was activated on another Mac. Free it at account.breakpatch.dev, then activate it here.",
        "grace" => "Breakpatch couldn't check your Solo licence lately. Reconnect soon to keep Solo features.",
        "invalid_token" => "This Solo licence couldn't be checked. Activate it again.",
        _ if names_solo(service_message) => return service_message.unwrap_or_default().to_string(),
        _ => return message_for(code, service_message),
    };
    m.to_string()
}

/// Plain words for each code. Service codes first (they never change; new ones may be added),
/// then the app's own.
pub fn message_for(code: &str, service_message: Option<&str>) -> String {
    let m = match code {
        "bad_request" => "Something is missing from the request. Update Breakpatch and try again.",
        "unknown_key" => "This licence key isn't recognised. Check it and try again.",
        "revoked" => "This licence is no longer active. Ask your admin for help.",
        "expired" => "Your licence has expired. Ask your admin to renew it.",
        "out_of_seats" => "Your team is out of seats. Ask your admin to add one.",
        "out_of_machines" => "Your team has no machine licences left. Ask your admin to add one.",
        "invalid_token" => "This licence couldn't be checked. Sign in again.",
        "released" => "This seat was freed. Sign in again to take a seat.",
        "rate_limited" => "Too many tries. Wait a few minutes and try again.",
        "over_seats" => "Your team is using more seats than it pays for, so this Mac's seat was freed. Ask your admin to add seats, then sign in again.",
        "too_many_devices" => "Your seat is already used on too many Macs. Ask your admin to free one, then sign in again.",
        "internal" => "Something went wrong on our side. Try again in a minute.",
        "offline" => "Couldn't reach the licence service. Check your connection and try again.",
        "offline_too_long" => "Reconnect to check your licence.",
        "grace" => "Breakpatch couldn't check your licence lately. Reconnect soon to keep Team features.",
        "other_workspace" => "This licence is for another workspace.",
        "other_device" => "This licence was activated on another Mac. Sign in again on this one.",
        "clock_back" => "This Mac's clock is behind. Set the right date and time, then reconnect to check your licence.",
        "unavailable" => "Licences aren't available in this edition of Breakpatch.",
        "needs_workspace" => "This is a Team licence key. Team licences are used in a workspace: connect or create one, then enter the key there.",
        "no_device" => "Breakpatch couldn't tell which Mac this is, so a Solo licence can't be activated here.",
        _ => return service_message.map(str::to_string).unwrap_or_else(|| "The licence couldn't be checked.".into()),
    };
    m.to_string()
}

/// The status of what's stored, at `now` (Unix seconds). `workspace`: the open workspace's
/// project id, when the caller knows it; a token for another workspace unlocks nothing.
/// `device`: this Mac's deviceId; a token bound to another device is invalid here.
fn evaluate(
    stored: Option<&Stored>,
    keys: &KeyTable,
    now: i64,
    workspace: Option<&str>,
    device: Option<&str>,
) -> Status {
    if keys.is_empty() {
        return Status::bare(State::Unavailable).with_code("unavailable");
    }
    let Some(s) = stored else { return Status::bare(State::None) };
    let mut st = Status::bare(State::None);
    st.kind = Some(s.kind);
    st.subject = Some(s.subject.clone());
    st.workspace_project_id = Some(s.workspace_project_id.clone());
    st.key_hint = key_hint(&s.key);
    st.seats_used = s.seats_used;
    st.machines_used = s.machines_used;
    st.customer_name = s.customer_name.clone();
    st.tier = s.tier.clone();
    let Some(token) = &s.token else {
        return match &s.error {
            Some(code) => st.with_code(code),
            None => st,
        };
    };
    let c = match verify(token, keys) {
        Ok(c) => c,
        Err(_) => {
            st.state = State::Invalid;
            return st.with_code("invalid_token");
        }
    };
    st.tier = Some(c.tier.clone());
    st.licence_id = Some(c.licence_id.clone());
    st.parallel_runs = c.parallel_runs;
    st.seats = Some(c.seats);
    st.machines = Some(c.machines);
    st.workspace_project_id = Some(c.workspace_project_id.clone());
    st.expires_at = Some(c.exp);
    let offline_until = c.offline_until.min(c.iat + OFFLINE_DAYS * 86_400);
    st.offline_until = Some(offline_until);
    st.licence_expires_at = Some(c.licence_expires_at);
    if !dev_matches(&c, device) {
        st.state = State::Invalid;
        return st.with_code("other_device");
    }
    if s.clock_back || now + CLOCK_SLACK < c.iat {
        st.state = State::Invalid;
        return st.with_code("clock_back");
    }
    if workspace.is_some_and(|w| w != c.workspace_project_id) {
        return st.with_code("other_workspace");
    }
    if now >= c.licence_expires_at {
        st.state = State::Expired;
        return st.with_code("expired");
    }
    if now < c.exp {
        st.state = State::Active;
    } else if now < offline_until {
        st.state = State::Grace;
        st = st.with_code("grace");
    } else {
        st.state = State::Expired;
        return st.with_code("offline_too_long");
    }
    st.features = c.features;
    st
}

fn key_hint(key: &str) -> Option<String> {
    let k: Vec<char> = key.chars().filter(|c| c.is_ascii_alphanumeric()).collect();
    (k.len() >= 4).then(|| k[k.len() - 4..].iter().collect::<String>().to_uppercase())
}

// ---- The service -------------------------------------------------------------------------------

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Failure {
    pub code: String,
    pub message: String,
}

impl Failure {
    fn new(code: &str, service_message: Option<&str>) -> Self {
        Self { code: code.into(), message: message_for(code, service_message) }
    }
    /// In Solo's words when the licence is a Solo (the stored tier, or the service's message says so).
    fn for_tier(code: &str, service_message: Option<&str>, solo: bool) -> Self {
        Self { code: code.into(), message: message_for_tier(code, service_message, solo || names_solo(service_message)) }
    }
}

enum CallError {
    /// No answer, or the service is having trouble (5xx, rate limited): nothing is decided.
    Unreachable,
    /// The service decided (`code` from its table).
    Refused { code: String, message: Option<String> },
}

struct Service {
    base: String,
    client: reqwest::Client,
}

impl Service {
    fn new(base: String) -> Self {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(20))
            .user_agent(concat!("Breakpatch/", env!("CARGO_PKG_VERSION")))
            .build()
            .unwrap_or_default();
        Self { base: base.trim_end_matches('/').to_string(), client }
    }

    async fn post(&self, endpoint: &str, body: &Value) -> Result<Value, CallError> {
        let url = format!("{}/{endpoint}", self.base);
        let res = match self.client.post(&url).json(body).send().await {
            Ok(r) => r,
            Err(e) => {
                // The error names the address only; the body (key, token) is never logged.
                log::warn!("licence {endpoint}: couldn't reach the service ({})", e.without_url());
                return Err(CallError::Unreachable);
            }
        };
        let status = res.status();
        let json: Value = res.json().await.unwrap_or(Value::Null);
        if json.get("ok").and_then(Value::as_bool) == Some(true) {
            return Ok(json);
        }
        let code = json.pointer("/error/code").and_then(Value::as_str);
        log::info!("licence {endpoint}: HTTP {} {}", status.as_u16(), code.unwrap_or("-"));
        match code {
            Some("rate_limited" | "internal") => Err(CallError::Unreachable),
            Some(code) => Err(CallError::Refused {
                code: code.to_string(),
                message: json.pointer("/error/message").and_then(Value::as_str).map(str::to_string),
            }),
            None if status.is_server_error() || status.as_u16() == 429 => Err(CallError::Unreachable),
            None => Err(CallError::Refused { code: "internal".into(), message: None }),
        }
    }
}

// ---- Licensing -----------------------------------------------------------------------------------

pub struct ActivateRequest {
    /// The connection whose licence this is (the UI names it, so a switch while the call is out
    /// can't store it under another one). None: the selected one.
    pub ws_key: Option<String>,
    /// The licence key. Empty: the key already stored for `key_from` (or, without it, for this
    /// connection), which the UI never sees: taking the seat again on a tests folder, or bringing
    /// a Solo licence from the tests folder into a workspace.
    pub key: String,
    /// The connection whose stored key an empty `key` means. None: this one.
    pub key_from: Option<String>,
    /// The workspace's project id; empty for a tests folder (Solo), which then always sends this
    /// Mac's deviceId.
    pub workspace_project_id: String,
    /// The signed-in email (person); empty for a machine, which uses this Mac's own id.
    pub subject: Option<String>,
    pub kind: String,
}

type Clock = Box<dyn Fn() -> i64 + Send + Sync>;
type MachineId = Box<dyn Fn() -> (String, Option<String>) + Send + Sync>;

pub struct Licensing<S: SecretStore> {
    store: S,
    keys: KeyTable,
    service: Service,
    now: Clock,
    machine: MachineId,
    app_version: String,
    /// The workspace whose licence the calls work on (`licence_select`); None: nothing unlocked.
    selected: Mutex<Option<String>>,
    /// What's in the Keychain for one workspace, read once: (wsKey, entry).
    cache: Mutex<Option<(String, Option<Stored>)>>,
    /// One activate, refresh or release at a time.
    busy: tokio::sync::Mutex<()>,
    /// The usage counts sent with each refresh (usage.rs).
    usage: Option<Arc<UsageStore>>,
    /// The entry of earlier versions is known to be gone (it never comes back while the app runs).
    legacy_gone: std::sync::atomic::AtomicBool,
    /// Tokens of seats left behind when the earlier entry and a workspace's own both held one:
    /// given back by [`Licensing::release_stale`].
    stale: Mutex<Vec<String>>,
    /// This Mac's hashed hardware id, when it has one (macOS); else a random id in the Keychain.
    hardware: HardwareId,
    device: std::sync::OnceLock<Option<String>>,
}

type HardwareId = Box<dyn Fn() -> Option<String> + Send + Sync>;

fn unix_now() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

/// The address built in. `BP_LICENCE_URL` replaces it in development builds only (tests, the
/// emulator): a release build always talks to the service it was built for.
pub fn service_url() -> String {
    service_url_from(std::env::var("BP_LICENCE_URL").ok(), cfg!(debug_assertions))
}

fn service_url_from(env: Option<String>, development: bool) -> String {
    env.filter(|u| development && !u.trim().is_empty()).unwrap_or_else(|| DEFAULT_URL.to_string())
}

impl<S: SecretStore> Licensing<S> {
    pub fn new(store: S, keys: KeyTable, base_url: String, machine: MachineId) -> Self {
        Self {
            store,
            keys,
            service: Service::new(base_url),
            now: Box::new(unix_now),
            machine,
            app_version: env!("CARGO_PKG_VERSION").to_string(),
            selected: Mutex::new(None),
            cache: Mutex::new(None),
            busy: tokio::sync::Mutex::new(()),
            usage: None,
            legacy_gone: std::sync::atomic::AtomicBool::new(false),
            stale: Mutex::new(Vec::new()),
            hardware: Box::new(|| platform_uuid().map(|u| hash_id(&u))),
            device: std::sync::OnceLock::new(),
        }
    }

    #[cfg(test)]
    fn with_hardware(mut self, hardware: HardwareId) -> Self {
        self.hardware = hardware;
        self
    }

    /// This Mac's `deviceId` for the service: the hashed hardware id, else a random id made once
    /// and kept in the Keychain (next to the licence). None only if neither can be had.
    pub fn device_id(&self) -> Option<String> {
        self.device
            .get_or_init(|| {
                if let Some(hw) = (self.hardware)() {
                    return Some(hw);
                }
                match self.store.get(DEVICE_ENTRY) {
                    Ok(Some(id)) if id.len() >= 16 && id.bytes().all(|b| b.is_ascii_hexdigit()) => return Some(id),
                    Ok(_) => {}
                    Err(e) => {
                        log::warn!("couldn't read this Mac's device id from the Keychain: {e}");
                        return None;
                    }
                }
                let mut bytes = [0u8; 16];
                getrandom::fill(&mut bytes).ok()?;
                let id: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
                if let Err(e) = self.store.set(DEVICE_ENTRY, &id) {
                    log::warn!("couldn't keep this Mac's device id in the Keychain: {e}");
                }
                Some(id)
            })
            .clone()
    }

    /// Sends these usage counts with each refresh.
    pub fn with_usage(mut self, usage: Arc<UsageStore>) -> Self {
        self.usage = Some(usage);
        self
    }

    #[cfg(test)]
    fn with_clock(mut self, now: Clock) -> Self {
        self.now = now;
        self
    }

    /// The workspace selected now.
    pub fn selected(&self) -> Option<String> {
        self.selected.lock().unwrap().clone()
    }

    /// Works on this workspace's licence from now on (None: none, nothing unlocked). `project` is
    /// the Team workspace's project id, when the connection is one: the licence of earlier
    /// versions (one entry for the Mac) moves here if it was activated for that project.
    /// Returns the status for the newly selected workspace. (The command uses
    /// [`Licensing::select_with`]; this is the tests' shorthand.)
    #[cfg(test)]
    pub fn select(&self, ws_key: Option<&str>, project: Option<&str>) -> Result<Status, String> {
        self.select_with(ws_key, project, true)
    }

    /// [`Licensing::select`]; `adopt`: whether this connection may take the licence of earlier
    /// versions. The UI says no when this Mac has other workspaces in the same project and this one
    /// isn't in the default `breakpatch` database, since the old entry doesn't say which it was.
    pub fn select_with(&self, ws_key: Option<&str>, project: Option<&str>, adopt: bool) -> Result<Status, String> {
        let ws = match ws_key.map(str::trim).filter(|k| !k.is_empty()) {
            Some(k) if valid_ws_key(k) => Some(k.to_string()),
            Some(_) => return Err("That isn't a workspace key.".into()),
            None => None,
        };
        *self.selected.lock().unwrap() = ws.clone();
        *self.cache.lock().unwrap() = None;
        if let (Some(ws), Some(project), true, false) = (&ws, project, adopt, self.keys.is_empty()) {
            self.adopt_legacy(ws, project);
        }
        Ok(self.status(project))
    }

    /// Moves the single `licence` entry of earlier versions to `ws` when it was activated for
    /// `project` and `ws` is a workspace in that project (`team:<project>/<database>`): copied
    /// first, then removed, so a crash in between only leaves a copy that the next select removes.
    /// An entry for another project stays for that workspace.
    ///
    /// When `ws` has an entry of its own that differs (an older version activated again after a
    /// downgrade), the newer token is kept. The other one's seat is given back
    /// ([`Licensing::release_stale`]) when it's another seat: another key, person, machine or
    /// project. The same holder with the same key is the same seat, so it's only forgotten.
    fn adopt_legacy(&self, ws: &str, project: &str) {
        if ws_project(ws) != Some(project) {
            return;
        }
        let text = match self.store.get(LEGACY_ENTRY) {
            Ok(Some(t)) => t,
            Ok(None) => {
                self.legacy_gone.store(true, std::sync::atomic::Ordering::Relaxed);
                return;
            }
            Err(e) => {
                log::warn!("couldn't read the earlier licence from the Keychain: {e}");
                return;
            }
        };
        let Ok(old) = serde_json::from_str::<Stored>(&text) else {
            log::warn!("the earlier licence entry is unreadable; it stays where it is");
            return;
        };
        if old.workspace_project_id != project {
            return;
        }
        let entry = entry_for(ws);
        let mine = match self.store.get(&entry) {
            Ok(v) => v,
            Err(e) => {
                log::warn!("couldn't read the workspace's licence from the Keychain: {e}");
                return;
            }
        };
        let keep_old = match mine.as_deref() {
            None => true,
            Some(t) if t == text => false,
            Some(t) => match serde_json::from_str::<Stored>(t) {
                // The workspace's own entry is unreadable: the earlier one is all there is.
                Err(_) => true,
                Ok(cur) => {
                    let old_newer = self.newness(&old) > self.newness(&cur);
                    let (kept, dropped) = if old_newer { (&old, &cur) } else { (&cur, &old) };
                    let same_seat = kept.key == dropped.key
                        && kept.same_holder(&dropped.subject, dropped.kind, &dropped.workspace_project_id);
                    if let (Some(token), false) = (&dropped.token, same_seat) {
                        self.stale.lock().unwrap().push(token.clone());
                    }
                    old_newer
                }
            },
        };
        if keep_old {
            if let Err(e) = self.store.set(&entry, &text) {
                log::warn!("couldn't move the licence to its workspace: {e}");
                return;
            }
            if let Some(u) = &self.usage {
                u.adopt_legacy(ws);
            }
            log::info!("the licence moved to its workspace's own Keychain entry");
        }
        match self.store.delete(LEGACY_ENTRY) {
            Ok(()) => self.legacy_gone.store(true, std::sync::atomic::Ordering::Relaxed),
            Err(e) => log::warn!("couldn't remove the earlier licence entry: {e}"),
        }
        *self.cache.lock().unwrap() = None;
    }

    /// How recent an entry is: when its token was issued, else the latest time it was seen.
    fn newness(&self, s: &Stored) -> (i64, i64) {
        let issued = s.token.as_deref().and_then(|t| verify(t, &self.keys).ok()).map_or(i64::MIN, |c| c.iat);
        (issued, s.seen_at.unwrap_or(i64::MIN))
    }

    /// Gives back the seats [`Licensing::adopt_legacy`] left behind. Best effort, like release.
    pub async fn release_stale(&self) {
        let tokens = std::mem::take(&mut *self.stale.lock().unwrap());
        for t in tokens {
            self.release_token(&t).await;
        }
    }

    /// Whether an entry of an earlier version is still waiting to move to its workspace. Once it's
    /// gone, the Keychain isn't asked again.
    fn legacy_waiting(&self) -> bool {
        if self.legacy_gone.load(std::sync::atomic::Ordering::Relaxed) {
            return false;
        }
        match self.store.get(LEGACY_ENTRY) {
            Ok(Some(_)) => true,
            Ok(None) => {
                self.legacy_gone.store(true, std::sync::atomic::Ordering::Relaxed);
                false
            }
            Err(_) => false,
        }
    }

    fn load(&self) -> Option<Stored> {
        let ws = self.selected()?;
        self.load_for(&ws)
    }

    fn load_for(&self, ws: &str) -> Option<Stored> {
        let mut cache = self.cache.lock().unwrap();
        if let Some((k, s)) = cache.as_ref() {
            if k == ws {
                return s.clone();
            }
        }
        let s = match self.store.get(&entry_for(ws)) {
            Ok(Some(text)) => serde_json::from_str::<Stored>(&text).ok().or_else(|| {
                log::warn!("the stored licence is unreadable; starting without one");
                None
            }),
            Ok(None) => None,
            Err(e) => {
                log::warn!("couldn't read the licence from the Keychain: {e}");
                None
            }
        };
        if self.selected().as_deref() == Some(ws) {
            *cache = Some((ws.to_string(), s.clone()));
        }
        s
    }

    /// Saves one workspace's entry. The workspace is named by the caller, taken when its call
    /// began, so a switch while a refresh is out never writes one workspace's licence into another's.
    fn save_for(&self, ws: &str, s: Option<Stored>) {
        let entry = entry_for(ws);
        let res = match &s {
            Some(v) => serde_json::to_string(v).map_err(|e| e.to_string()).and_then(|t| self.store.set(&entry, &t)),
            None => self.store.delete(&entry),
        };
        if let Err(e) = res {
            log::warn!("couldn't save the licence in the Keychain: {e}");
        }
        let mut cache = self.cache.lock().unwrap();
        if self.selected().as_deref() == Some(ws) {
            *cache = Some((ws.to_string(), s));
        } else if cache.as_ref().is_some_and(|(k, _)| k == ws) {
            *cache = None;
        }
    }

    pub fn status(&self, workspace: Option<&str>) -> Status {
        self.status_for(None, workspace)
    }

    /// The status of `ws_key`'s licence (None: the selected one). The UI names the connection it
    /// asks about, so an answer never describes a workspace switched to while it was on its way.
    pub fn status_for(&self, ws_key: Option<&str>, workspace: Option<&str>) -> Status {
        if self.keys.is_empty() {
            return evaluate(None, &self.keys, 0, None, None);
        }
        let now = (self.now)();
        let stored = self.target(ws_key).and_then(|ws| self.observe_clock(&ws, now));
        evaluate(stored.as_ref(), &self.keys, now, workspace, self.device_id().as_deref())
    }

    /// The connection a call works on: the one it names (when that's a valid key), else the selected one.
    fn target(&self, ws_key: Option<&str>) -> Option<String> {
        match ws_key.map(str::trim).filter(|k| !k.is_empty()) {
            Some(k) if valid_ws_key(k) => Some(k.to_string()),
            Some(_) => None,
            None => self.selected(),
        }
    }

    /// Keeps the latest time seen with the licence (R7), and marks the clock as set back when
    /// `now` is more than [`CLOCK_SLACK`] behind it or behind when the token was issued. Only a
    /// successful online refresh or activation clears that. Returns what's stored now.
    fn observe_clock(&self, ws: &str, now: i64) -> Option<Stored> {
        let mut s = self.load_for(ws)?;
        let issued = s.token.as_deref().and_then(|t| verify(t, &self.keys).ok()).map(|c| c.iat);
        let latest = s.seen_at.into_iter().chain(issued).max();
        let changed = if latest.is_some_and(|l| now + CLOCK_SLACK < l) {
            if !s.clock_back {
                log::warn!("this Mac's clock is more than a day behind the latest time seen; the licence is invalid until it refreshes online");
            }
            !std::mem::replace(&mut s.clock_back, true)
        } else if match s.seen_at {
            None => true,
            Some(seen) => now >= seen + SEEN_EVERY,
        } {
            s.seen_at = Some(now.max(s.seen_at.unwrap_or(now)));
            true
        } else {
            false
        };
        if changed {
            self.save_for(ws, Some(s.clone()));
        }
        Some(s)
    }

    /// Whether this Mac holds a licence token (Team usage is counted only then).
    pub fn holds_token(&self) -> bool {
        !self.keys.is_empty() && self.load().is_some_and(|s| s.token.is_some())
    }

    /// The stored token, for the engine sidecar (`licence.set`, engine/PROTOCOL.md). The Team engine
    /// checks it again itself with the same keys, so this is only a hand-over, never a decision.
    /// None without built-in keys or without a token.
    pub fn engine_token(&self) -> Option<String> {
        if self.keys.is_empty() {
            return None;
        }
        // Not while the clock is set back or the token is another Mac's: the engine can't tell.
        let st = self.status(None);
        if matches!(st.code.as_deref(), Some("clock_back" | "other_device")) {
            return None;
        }
        self.load().and_then(|s| s.token)
    }

    pub async fn activate(&self, req: ActivateRequest) -> Result<Status, Failure> {
        if self.keys.is_empty() {
            return Err(Failure::new("unavailable", None));
        }
        let kind = Kind::parse(&req.kind).ok_or_else(|| Failure::new("bad_request", None))?;
        let (subject, machine_name) = match (kind, req.subject.as_deref().map(str::trim)) {
            (Kind::Machine, None | Some("")) => (self.machine)(),
            (Kind::Machine, Some(s)) => (s.to_string(), (self.machine)().1),
            (Kind::Person, Some(s)) if !s.is_empty() => (s.to_string(), None),
            (Kind::Person, _) => return Err(Failure { code: "bad_request".into(), message: "Sign in first.".into() }),
        };
        let ws = req.workspace_project_id.trim().to_string();
        let Some(ws_key) = self.target(req.ws_key.as_deref()) else {
            return Err(Failure { code: "bad_request".into(), message: "Open a workspace first.".into() });
        };
        // No workspace (Solo on a tests folder): the seat is tied to this Mac, so the service
        // needs its deviceId.
        if ws.is_empty() && self.device_id().is_none() {
            return Err(Failure::new("no_device", None));
        }
        let _g = self.busy.lock().await;
        let prev = self.load_for(&ws_key);
        let key = match req.key.trim() {
            "" => {
                let from = match req.key_from.as_deref().map(str::trim).filter(|k| !k.is_empty()) {
                    Some(k) if valid_ws_key(k) => Some(k.to_string()),
                    Some(_) => None,
                    None => Some(ws_key.clone()),
                };
                let stored = from.and_then(|f| if f == ws_key { prev.clone() } else { self.load_for(&f) });
                match stored.map(|s| s.key).filter(|k| !k.is_empty()) {
                    Some(k) => k,
                    None => return Err(Failure { code: "bad_request".into(), message: "Enter the licence key.".into() }),
                }
            }
            k => k.to_string(),
        };
        // Moving to another person, machine or workspace: give the old seat back first.
        if let Some(p) = &prev {
            if let (Some(token), false) = (&p.token, p.same_holder(&subject, kind, &ws)) {
                self.release_token(token).await;
            }
        }
        let next = Stored {
            key,
            subject,
            kind,
            workspace_project_id: ws,
            machine_name,
            token: None,
            seats_used: None,
            machines_used: None,
            customer_name: None,
            error: None,
            seen_at: prev.as_ref().and_then(|p| p.seen_at),
            clock_back: prev.as_ref().is_some_and(|p| p.clock_back),
            tier: None,
        };
        let swapped = prev
            .as_ref()
            .filter(|p| p.key != next.key && p.same_holder(&next.subject, next.kind, &next.workspace_project_id))
            .and_then(|p| p.token.clone());
        let st = self.activate_as(&ws_key, next, prev).await?;
        // Another key took this connection's seat (Solo to Team, say): the old licence's seat,
        // when it's another licence's, goes back. The same licence with a new key is the same seat.
        if let Some(old) = swapped {
            let old_licence = verify(&old, &self.keys).ok().map(|c| c.licence_id);
            if old_licence.is_some() && old_licence != st.licence_id {
                self.release_token(&old).await;
            }
        }
        Ok(st)
    }

    async fn activate_as(&self, ws_key: &str, mut next: Stored, prev: Option<Stored>) -> Result<Status, Failure> {
        let mut body = json!({
            "key": next.key, "workspaceProjectId": next.workspace_project_id, "subject": next.subject,
            "kind": next.kind, "appVersion": self.app_version,
        });
        if let Some(n) = &next.machine_name {
            body["machineName"] = json!(n);
        }
        if let Some(d) = self.device_id() {
            body["deviceId"] = json!(d);
        }
        match self.service.post("activate", &body).await {
            Ok(v) => {
                self.take_answer(&mut next, &v)?;
                self.save_for(ws_key, Some(next));
                Ok(self.status_for(Some(ws_key), None))
            }
            Err(CallError::Refused { code, message }) => {
                let solo = names_solo(message.as_deref()) || prev.as_ref().and_then(|p| p.tier.as_deref()) == Some(SOLO);
                // A Team or Business key on a tests folder: it belongs in a workspace. Nothing
                // is kept for the folder.
                if next.workspace_project_id.is_empty()
                    && code == "bad_request"
                    && message.as_deref().is_some_and(|m| m.contains("workspaceProjectId"))
                {
                    return Err(Failure::new("needs_workspace", None));
                }
                if solo {
                    next.tier = Some(SOLO.into());
                }
                // A licence that still works here stays when someone tries another key.
                let now = (self.now)();
                let device = self.device_id();
                let keeps = prev.as_ref().is_some_and(|p| {
                    p.key != next.key
                        && p.same_holder(&next.subject, next.kind, &next.workspace_project_id)
                        && matches!(
                            evaluate(Some(p), &self.keys, now, None, device.as_deref()).state,
                            State::Active | State::Grace
                        )
                });
                if !keeps {
                    next.error = Some(code.clone());
                    self.save_for(ws_key, Some(next));
                }
                Err(Failure::for_tier(&code, message.as_deref(), solo))
            }
            Err(CallError::Unreachable) => Err(Failure::new("offline", None)),
        }
    }

    /// Takes a good answer's token and counts. A token this app can't check, or one bound to
    /// another device, is refused. The service answered, so the clock is trusted again.
    fn take_answer(&self, s: &mut Stored, v: &Value) -> Result<(), Failure> {
        let token = v.get("token").and_then(Value::as_str).unwrap_or_default();
        let Ok(claims) = verify(token, &self.keys) else {
            log::warn!("the licence service answered with a token this app can't check");
            return Err(Failure::new("invalid_token", None));
        };
        if !dev_matches(&claims, self.device_id().as_deref()) {
            log::warn!("the licence service answered with a token for another device");
            return Err(Failure::new("invalid_token", None));
        }
        s.clock_back = false;
        s.seen_at = Some((self.now)());
        s.tier = Some(claims.tier.clone());
        let lic = v.get("licence");
        let num = |k: &str| lic.and_then(|l| l.get(k)).and_then(Value::as_u64).map(|n| n as u32);
        s.token = Some(token.to_string());
        s.seats_used = num("seatsUsed");
        s.machines_used = num("machinesUsed");
        s.customer_name = lic.and_then(|l| l.get("customerName")).and_then(Value::as_str).map(str::to_string);
        s.error = None;
        Ok(())
    }

    /// A new token for the seat this Mac holds. Offline or while the service has trouble, the
    /// stored token stays (grace). A freed seat or a token the service no longer accepts is taken
    /// again with the stored key.
    #[cfg(test)]
    pub async fn refresh(&self) -> Status {
        self.refresh_for(None).await
    }

    /// [`Licensing::refresh`] for `ws_key`'s licence (None: the selected one): what the command calls.
    pub async fn refresh_for(&self, ws_key: Option<&str>) -> Status {
        if self.keys.is_empty() {
            return self.status(None);
        }
        let Some(ws_key) = self.target(ws_key) else { return self.status(None) };
        let _g = self.busy.lock().await;
        let Some(mut s) = self.load_for(&ws_key) else { return self.status_for(Some(&ws_key), None) };
        let Some(token) = s.token.clone() else { return self.status_for(Some(&ws_key), None) };
        // Counts kept before usage was per workspace go with the first refresh once no licence of
        // an earlier version waits to move (it takes them to its own workspace when it does).
        if let (Some(u), false) = (&self.usage, self.legacy_waiting()) {
            u.adopt_legacy(&ws_key);
        }
        // This workspace's usage counts since the last report the service took (usage.rs): numbers only.
        let usage = self.usage.as_ref().and_then(|u| u.pending_team(&ws_key));
        let mut body = json!({ "token": token });
        if let Some(d) = self.device_id() {
            body["deviceId"] = json!(d);
        }
        if let Some(c) = &usage {
            body["usage"] = c.team_payload();
        }
        match self.service.post("refresh", &body).await {
            Ok(v) => match self.take_answer(&mut s, &v) {
                Ok(()) => {
                    if let (Some(u), Some(sent)) = (&self.usage, &usage) {
                        if v.get("usageAccepted").and_then(Value::as_bool) == Some(true) {
                            u.reported(&ws_key, sent, (self.now)());
                        }
                    }
                    self.save_for(&ws_key, Some(s));
                    self.status_for(Some(&ws_key), None)
                }
                Err(_) => self.status_for(Some(&ws_key), None),
            },
            Err(CallError::Refused { code, .. }) if code == "released" || code == "invalid_token" => {
                s.token = None;
                match self.activate_as(&ws_key, s.clone(), None).await {
                    Ok(st) => st,
                    Err(f) => {
                        if f.code == "offline" {
                            // Couldn't ask again: the seat is gone either way.
                            s.error = Some(code);
                            self.save_for(&ws_key, Some(s));
                        }
                        self.status_for(Some(&ws_key), None)
                    }
                }
            }
            Err(CallError::Refused { code, .. }) => {
                s.token = None;
                s.error = Some(code);
                self.save_for(&ws_key, Some(s));
                self.status_for(Some(&ws_key), None)
            }
            Err(CallError::Unreachable) => {
                let mut st = self.status_for(Some(&ws_key), None);
                if st.state == State::Active {
                    st.code = Some("offline".into());
                    st.message = Some(message_for("offline", None));
                }
                st
            }
        }
    }

    /// Gives this Mac's seat back and forgets the licence here: the selected workspace's, or
    /// `ws_key`'s (a workspace being removed while another is open). Other workspaces keep theirs.
    pub async fn release(&self, ws_key: Option<&str>) -> Status {
        if self.keys.is_empty() {
            return self.status(None);
        }
        let ws = match ws_key.map(str::to_string).or_else(|| self.selected()) {
            Some(k) if valid_ws_key(&k) => k,
            _ => return self.status(None),
        };
        let _g = self.busy.lock().await;
        if let Some(token) = self.load_for(&ws).and_then(|s| s.token) {
            self.release_token(&token).await;
        }
        self.save_for(&ws, None);
        self.status(None)
    }

    /// Best effort: offline, the seat frees itself after 30 days unseen.
    async fn release_token(&self, token: &str) {
        match self.service.post("release", &json!({ "token": token })).await {
            Ok(_) => {}
            Err(CallError::Refused { code, .. }) => log::info!("licence release refused: {code}"),
            Err(CallError::Unreachable) => {
                log::info!("licence release: service unreachable; the seat frees itself later")
            }
        }
    }
}

// ---- This Mac's id, for the local runner's machine licence -------------------------------------

/// A stable id for this machine and its name. On macOS the hardware UUID, hashed (the raw id
/// never leaves the Mac); elsewhere a random id kept in the app data folder.
pub fn machine_identity(data_dir: &Path) -> (String, Option<String>) {
    let id = platform_uuid().map(|u| hash_id(&u)).unwrap_or_else(|| stored_id(data_dir));
    (id, machine_name())
}

fn hash_id(raw: &str) -> String {
    use sha2::{Digest, Sha256};
    let d = Sha256::digest(format!("breakpatch-machine-v1:{}", raw.trim()).as_bytes());
    d.iter().take(16).map(|b| format!("{b:02x}")).collect()
}

#[cfg(target_os = "macos")]
fn platform_uuid() -> Option<String> {
    let out =
        std::process::Command::new("/usr/sbin/ioreg").args(["-rd1", "-c", "IOPlatformExpertDevice"]).output().ok()?;
    parse_ioreg_uuid(&String::from_utf8_lossy(&out.stdout))
}

#[cfg(not(target_os = "macos"))]
fn platform_uuid() -> Option<String> {
    None
}

#[cfg_attr(not(any(test, target_os = "macos")), allow(dead_code))]
fn parse_ioreg_uuid(text: &str) -> Option<String> {
    let line = text.lines().find(|l| l.contains("\"IOPlatformUUID\""))?;
    let v = line.split('=').nth(1)?.trim().trim_matches('"');
    (!v.is_empty()).then(|| v.to_string())
}

fn stored_id(data_dir: &Path) -> String {
    let path = data_dir.join("machine-id");
    if let Ok(s) = std::fs::read_to_string(&path) {
        let s = s.trim();
        if s.len() >= 16 && s.chars().all(|c| c.is_ascii_hexdigit()) {
            return s.to_string();
        }
    }
    let mut bytes = [0u8; 16];
    if getrandom::fill(&mut bytes).is_err() {
        // No OS randomness: still unique enough for a seat id.
        let seed = format!("{:?}{}", std::time::SystemTime::now(), std::process::id());
        return hash_id(&seed);
    }
    let id: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    let _ = std::fs::create_dir_all(data_dir);
    if let Err(e) = std::fs::write(&path, &id) {
        log::warn!("couldn't save this machine's id: {e}");
    }
    id
}

fn machine_name() -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        let out = std::process::Command::new("/usr/sbin/scutil").args(["--get", "ComputerName"]).output().ok()?;
        let n = String::from_utf8_lossy(&out.stdout).trim().to_string();
        (!n.is_empty()).then(|| n.chars().take(80).collect())
    }
    #[cfg(not(target_os = "macos"))]
    {
        std::env::var("HOSTNAME").ok().filter(|n| !n.is_empty()).map(|n| n.chars().take(80).collect())
    }
}

#[cfg(test)]
#[path = "licence_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "licence_e2e.rs"]
mod e2e;
