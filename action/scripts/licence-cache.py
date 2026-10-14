"""The machine licence file in the Actions cache, sealed with the licence key (action.yml).

    python licence-cache.py open CACHE_DIR LICENCE_FILE
    python licence-cache.py seal LICENCE_FILE CACHE_DIR

The Actions cache isn't private to the jobs that have the licence key: a pull request from a fork
can restore this repository's caches, with a workflow of its own, and the cache's name gives
nothing away that's secret (machine-id is the repository's ID by default, which is public). So the
cache only ever holds CACHE_DIR/licence.sealed: the licence file encrypted with AES-256-GCM, under
a key derived (HKDF-SHA256) from the licence key, which a fork's run never gets, and bound to the
machine ID. The action also doesn't restore or save it on a fork's pull request.

open   CACHE_DIR/licence.sealed -> LICENCE_FILE (0600). Without the licence key, or when it doesn't
       open (another key or machine ID, or changed), nothing is written, and breakpatch-ci checks
       online as on a first run. It always exits 0: a missing cache is never an error.
seal   LICENCE_FILE -> CACHE_DIR/licence.sealed (replaced), then LICENCE_FILE is deleted. Without
       the licence key or the file, CACHE_DIR is emptied and nothing is sealed.

Environment: BREAKPATCH_LICENCE_KEY, BREAKPATCH_MACHINE_ID. Uses `cryptography`, which every
breakpatch-ci environment has (the engine's `ci` extra): run it with breakpatch-ci's Python.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

MAGIC = b"BPLC1"                 # the format: MAGIC, a 12-byte nonce, then the AES-GCM ciphertext
SEALED = "licence.sealed"
INFO = b"breakpatch-action licence cache v1"


def _key(licence_key: str, machine_id: str) -> bytes:
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.kdf.hkdf import HKDF
    return HKDF(algorithm=hashes.SHA256(), length=32, salt=machine_id.encode(), info=INFO).derive(licence_key.encode())


def _aad(machine_id: str) -> bytes:
    return MAGIC + b"\0" + machine_id.encode()


def seal(data: bytes, licence_key: str, machine_id: str) -> bytes:
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    nonce = os.urandom(12)
    return MAGIC + nonce + AESGCM(_key(licence_key, machine_id)).encrypt(nonce, data, _aad(machine_id))


def unseal(blob: bytes, licence_key: str, machine_id: str) -> bytes | None:
    from cryptography.exceptions import InvalidTag
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    if not blob.startswith(MAGIC) or len(blob) < len(MAGIC) + 12 + 16:
        return None
    nonce, body = blob[len(MAGIC):len(MAGIC) + 12], blob[len(MAGIC) + 12:]
    try:
        return AESGCM(_key(licence_key, machine_id)).decrypt(nonce, body, _aad(machine_id))
    except InvalidTag:
        return None


def _write_private(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".new")
    tmp.unlink(missing_ok=True)
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as f:
        f.write(data)
    os.replace(tmp, path)


def do_open(cache_dir: Path, licence_file: Path, key: str, machine_id: str) -> str:
    sealed = cache_dir / SEALED
    if not sealed.is_file():
        return "No machine licence in the cache: breakpatch-ci checks online."
    if not key:
        return "No licence key: the cached machine licence stays sealed."
    data = unseal(sealed.read_bytes(), key, machine_id)
    if data is None:
        return "The cached machine licence doesn't open with this licence key and machine ID: breakpatch-ci checks online."
    _write_private(licence_file, data)
    return "Restored the machine licence from the cache."


def do_seal(licence_file: Path, cache_dir: Path, key: str, machine_id: str) -> str:
    cache_dir.mkdir(parents=True, exist_ok=True)
    for f in cache_dir.iterdir():                # only ever the sealed file in what's cached
        if f.is_file() or f.is_symlink():
            f.unlink()
    if not licence_file.is_file():
        return "No machine licence to keep."
    try:
        if not key:
            return "No licence key: the machine licence isn't kept."
        _write_private(cache_dir / SEALED, seal(licence_file.read_bytes(), key, machine_id))
        return "Sealed the machine licence for the cache."
    finally:
        licence_file.unlink(missing_ok=True)     # never left in the clear on the runner


def main(argv: list[str]) -> int:
    if len(argv) != 3 or argv[0] not in ("open", "seal"):
        print(__doc__, file=sys.stderr)
        return 2
    key = os.environ.get("BREAKPATCH_LICENCE_KEY", "")
    machine_id = os.environ.get("BREAKPATCH_MACHINE_ID", "")
    if argv[0] == "open":
        try:
            print(do_open(Path(argv[1]), Path(argv[2]), key, machine_id))
        except ImportError as e:                # never stops the tests: they check online instead
            print(f"::warning::The cached machine licence can't be opened here ({e}): breakpatch-ci checks online.")
    else:
        print(do_seal(Path(argv[1]), Path(argv[2]), key, machine_id))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
