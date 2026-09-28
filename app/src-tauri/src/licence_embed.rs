// How the licence public keys are built into the app (security review R6). Shared by build.rs,
// which `include!`s this file to write `$OUT_DIR/licence_keys.rs`, and by licence.rs, which reads
// the keys back (and tests this). Deterrence only: it keeps the keys from being a plain string a
// patcher can find and swap in a minute. The signature check itself is what protects the licence.
//
// Each 32-byte key is stored as two arrays that look random: `masked = key XOR pad` (pad read
// backwards) and the pad. Neither the base64 key nor its raw bytes appear in the binary. What does
// appear is one digest per key, `bplk1:<hex>` (SHA-256 of "breakpatch-licence-key-v1:" + the
// base64url key), which scripts/build-release.sh greps for to check the binary has exactly the keys
// it asked for.

/// The mark build-release.sh looks for, for one base64url key.
#[allow(dead_code)]
pub fn key_digest(b64: &str) -> String {
    use sha2::{Digest, Sha256};
    let d = Sha256::digest(format!("breakpatch-licence-key-v1:{b64}").as_bytes());
    let hex: String = d.iter().map(|b| format!("{b:02x}")).collect();
    format!("bplk1:{hex}")
}

/// `key[i] ^ pad[31 - i]`; the same call turns a masked key back into the key.
pub fn mask(key: &[u8; 32], pad: &[u8; 32]) -> [u8; 32] {
    let mut out = [0u8; 32];
    for i in 0..32 {
        out[i] = key[i] ^ pad[31 - i];
    }
    out
}

/// The Rust source of `licence_keys.rs` for these (kid, key bytes, base64 key, pad) entries.
#[allow(dead_code)]
pub fn render(entries: &[(String, [u8; 32], String, [u8; 32])]) -> String {
    let arr = |b: &[u8; 32]| format!("[{}]", b.iter().map(|x| format!("0x{x:02x}")).collect::<Vec<_>>().join(", "));
    let n = entries.len();
    let kids: Vec<String> = entries.iter().map(|e| format!("{:?}", e.0)).collect();
    let masked: Vec<String> = entries.iter().map(|e| arr(&mask(&e.1, &e.3))).collect();
    let pads: Vec<String> = entries.iter().map(|e| arr(&e.3)).collect();
    let digests: Vec<String> = entries.iter().map(|e| key_digest(&e.2)).collect();
    format!(
        "// Written by build.rs from BREAKPATCH_LICENCE_PUBKEYS (src/licence_embed.rs). Don't edit.\n\
         pub static KIDS: [&str; {n}] = [{}];\n\
         pub static MASKED: [[u8; 32]; {n}] = [{}];\n\
         pub static PADS: [[u8; 32]; {n}] = [{}];\n\
         pub static DIGESTS: &str = {:?};\n",
        kids.join(", "),
        masked.join(", "),
        pads.join(", "),
        digests.join(";"),
    )
}
