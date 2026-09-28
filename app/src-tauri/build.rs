// The key helpers (mask, digest, the generated source) are shared with src/licence.rs.
include!("src/licence_embed.rs");

fn main() {
    licence_keys();
    tauri_build::build()
}

/// src/licence.rs builds in `BREAKPATCH_LICENCE_PUBKEYS` (JSON map kid → base64url Ed25519
/// public key) and `BREAKPATCH_LICENCE_URL`. A malformed key table fails the build here rather
/// than shipping an app whose licence check can't work. The keys are written to
/// `$OUT_DIR/licence_keys.rs` split and masked (src/licence_embed.rs), never as a plain string;
/// without the variable the table is empty (Community and source builds).
fn licence_keys() {
    use base64::Engine as _;
    println!("cargo:rerun-if-env-changed=BREAKPATCH_LICENCE_PUBKEYS");
    println!("cargo:rerun-if-env-changed=BREAKPATCH_LICENCE_URL");
    println!("cargo:rerun-if-changed=src/licence_embed.rs");
    let text = std::env::var("BREAKPATCH_LICENCE_PUBKEYS").unwrap_or_default();
    let mut entries = Vec::new();
    if !text.trim().is_empty() {
        let map: std::collections::BTreeMap<String, String> = serde_json::from_str(&text)
            .unwrap_or_else(|e| panic!("BREAKPATCH_LICENCE_PUBKEYS isn't a JSON map of key id to key: {e}"));
        assert!(!map.is_empty(), "BREAKPATCH_LICENCE_PUBKEYS has no keys");
        for (i, (kid, key)) in map.into_iter().enumerate() {
            let ok = key.len() == 43 && key.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
            assert!(ok, "BREAKPATCH_LICENCE_PUBKEYS: key {kid} isn't a base64url 32-byte key");
            let raw: [u8; 32] = base64::engine::general_purpose::URL_SAFE_NO_PAD
                .decode(&key)
                .ok()
                .and_then(|b| b.try_into().ok())
                .unwrap_or_else(|| panic!("BREAKPATCH_LICENCE_PUBKEYS: key {kid} isn't a base64url 32-byte key"));
            entries.push((kid, raw, key, random_pad(i as u64)));
        }
    }
    let out = std::path::Path::new(&std::env::var("OUT_DIR").expect("OUT_DIR")).join("licence_keys.rs");
    std::fs::write(&out, render(&entries)).expect("couldn't write licence_keys.rs");
}

/// 32 bytes that differ on every build: std's per-process random hashing keys, no extra crate.
fn random_pad(salt: u64) -> [u8; 32] {
    use std::hash::{BuildHasher, Hasher};
    let state = std::collections::hash_map::RandomState::new();
    let mut pad = [0u8; 32];
    for (n, chunk) in pad.chunks_mut(8).enumerate() {
        let mut h = state.build_hasher();
        h.write_u64(salt);
        h.write_usize(n);
        h.write_u128(
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0),
        );
        chunk.copy_from_slice(&h.finish().to_le_bytes());
    }
    pad
}
