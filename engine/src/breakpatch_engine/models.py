"""The AI assistant models Breakpatch may download and load (security review A3).

Loading a model runs code paths chosen by its files: mlx-vlm imports the Python file a config
names in `model_file`, and transformers runs remote code for configs with `auto_map`. So the engine
only takes a model that is in this table, at its revision, and only the files listed for it, each
checked against the SHA-256 shipped here (never the Hub's own answer). Python files, pickles and
native code are refused by name, and any JSON config naming `model_file` or `auto_map` is refused,
both after the download and again every time the model is loaded.

The app's table (app/src/engine/engine.ts, MODELS) names the same repos and revisions;
tests/test_models.py checks they agree.

Two formats (plan §2.3 item 4): `mlx` (a Hugging Face folder for mlx-vlm, the Mac) and `gguf`
(llama.cpp: one language model file and one vision projector, "mmproj", everywhere else). A GGUF
model folder may hold only `*.gguf` files and the marker; each file must start with the GGUF magic
and name the expected `general.architecture` (`qwen3vl` for the model, `clip` for the projector).
GGUF files hold no code: llama.cpp reads tensors and metadata, and runs the chat template in its
own template engine, not Python.

Which format a machine uses follows from its AI runtime, runtimes.runtime_name() (the one place
that decides): `mlx` with the "mlx" runtime (Apple Silicon), `gguf` with "llamacpp" (everywhere
else, an Intel Mac too). entry() refuses a model of the other format, so setup can't download one
this machine can't run.

`python -m breakpatch_engine.models --check-release [--format mlx|gguf]` exits 1 while a model of
that format (default: this machine's, default_format()) isn't pinned to a commit with a hash for
every file; scripts/build-release.sh runs it for --release builds.
"""
from __future__ import annotations

import hashlib
import json
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath

from . import config
from .protocol import EngineError

# Pinned 2026-09-28 from the owner's Hugging Face account (2FA on). To move to another repo or
# revision: put its commit SHA (40 hex characters) here and in app/src/engine/engine.ts (MODELS),
# and list every file with its SHA-256:
#   python -m breakpatch_engine.models --hash-dir <a downloaded copy of the model>
ALLOWED: dict[str, dict] = {
    "OscarShaitan/Qwen3-VL-4B-Instruct-4bit": {
        "format": "mlx",
        "revision": "4e992f95b3b3ae22b4f25201b1b9d960448a5a1a",
        "files": {
            ".gitattributes": "34448b82c17d60fec9b65b1f093c115ddbaadc04beb1b0140b6bfed2e012a930",
            "README.md": "d0761303276b99006238f4a2c88f153109025c796b5e929145985b05700d1042",
            "added_tokens.json": "c0284b582e14987fbd3d5a2cb2bd139084371ed9acbae488829a1c900833c680",
            "chat_template.jinja": "3636d0f0bd6bef02654cdffdc447b79cb2cef8ab02cc75267345946291a489e4",
            "chat_template.json": "6f8a6a55027e3da5160105556cda5dd69f6423f1c32645f6730d32de7773d0c4",
            "config.json": "07406d087dfb8a8849427a4da81bc9edd1dd942e518493629b5a983169b47820",
            "generation_config.json": "8469742d1fce0de951c8909b26a2c0c0d8490837ce476efb114da9e0cefc4d44",
            "merges.txt": "8831e4f1a044471340f7c0a83d7bd71306a5b867e95fd870f74d0c5308a904d5",
            "model.safetensors": "90eeb02604181dbcccd0a30a1f550a4a8928ca7dcbee4aee1449239306cfdfca",
            "model.safetensors.index.json": "58a7841d7bff2548dd91577d216274a83cf1b500bc6a534b809d6c1b1707cf2b",
            "preprocessor_config.json": "93585062a80db5e8ca038efc7726a3e6411d9db948472d81d63c6303993be8c5",
            "special_tokens_map.json": "76862e765266b85aa9459767e33cbaf13970f327a0e88d1c65846c2ddd3a1ecd",
            "tokenizer.json": "aeb13307a71acd8fe81861d94ad54ab689df773318809eed3cbe794b4492dae4",
            "tokenizer_config.json": "81ec7bb9530159b326c0bef1d0b6c33d392090524014ea3f0123a3c1eb9c2af5",
            "video_preprocessor_config.json": "59c5c9eb52182eb14c06ffb10ca9effd29adce5f238a95de23ca14a38dbd2cb1",
            "vocab.json": "ca10d7e9fb3ed18575dd1e277a2579c16d108e32f27439684afa0e10b1440910",
        },
    },
    "OscarShaitan/Qwen3-VL-8B-Instruct-4bit": {
        "format": "mlx",
        "revision": "5a5a1651d020507af5d6a4c5443a82b3775952e0",
        "files": {
            ".gitattributes": "34448b82c17d60fec9b65b1f093c115ddbaadc04beb1b0140b6bfed2e012a930",
            "README.md": "af4e4a42585233ce6337e04238e5529c5ed59eb532d3073e2aa4b2d73e92c180",
            "added_tokens.json": "c0284b582e14987fbd3d5a2cb2bd139084371ed9acbae488829a1c900833c680",
            "chat_template.jinja": "3636d0f0bd6bef02654cdffdc447b79cb2cef8ab02cc75267345946291a489e4",
            "chat_template.json": "5c72a170d2a4a1a3bc5adad2e689ae28138a9700e5b8c96c0266331e86c0acce",
            "config.json": "cb750ae5688f3df07b110381d3dd54a7f2bfa9ec5175ae11e41305b516f3059a",
            "generation_config.json": "8469742d1fce0de951c8909b26a2c0c0d8490837ce476efb114da9e0cefc4d44",
            "merges.txt": "8831e4f1a044471340f7c0a83d7bd71306a5b867e95fd870f74d0c5308a904d5",
            "model-00001-of-00002.safetensors": "7c637158b2203e321d83596d3661f33b7b98a72beddfaaaa0eddc512acbdd1fb",
            "model-00002-of-00002.safetensors": "77190cd1dcf244522869bf923558340112b26d7db2ef3692f88407dd9b33c25d",
            "model.safetensors.index.json": "520b2e05079402e9468a8701d03d1154d14b2599593afb6effa7fb60c1bff070",
            "preprocessor_config.json": "93585062a80db5e8ca038efc7726a3e6411d9db948472d81d63c6303993be8c5",
            "special_tokens_map.json": "76862e765266b85aa9459767e33cbaf13970f327a0e88d1c65846c2ddd3a1ecd",
            "tokenizer.json": "aeb13307a71acd8fe81861d94ad54ab689df773318809eed3cbe794b4492dae4",
            "tokenizer_config.json": "81ec7bb9530159b326c0bef1d0b6c33d392090524014ea3f0123a3c1eb9c2af5",
            "video_preprocessor_config.json": "59c5c9eb52182eb14c06ffb10ca9effd29adce5f238a95de23ca14a38dbd2cb1",
            "vocab.json": "ca10d7e9fb3ed18575dd1e277a2579c16d108e32f27439684afa0e10b1440910",
        },
    },
    # llama.cpp (Linux first, then Windows; plan §2.1): Q4_K_M language model plus F16 projector.
    # TODO(owner): mirror Qwen/Qwen3-VL-4B-Instruct-GGUF (or ggml-org's) into this repo, check the
    # files were converted by a llama.cpp that matches runtimes.BUILD, and put the commit SHA here,
    # the real file names in "files" and "gguf", and each file's SHA-256 (--hash-dir). Until then a
    # development build downloads these names from `main` with a warning; a release refuses them.
    # Phase 0 (P0.2) may change the quantisation (Q4_0 on Arm, Q8_0 projector) or the size (2B).
    "OscarShaitan/Qwen3-VL-4B-Instruct-GGUF": {
        "format": "gguf",
        "revision": "main",                                              # TODO(owner): commit SHA
        "files": {
            "Qwen3VL-4B-Instruct-Q4_K_M.gguf": "",                       # TODO(owner): SHA-256
            "mmproj-Qwen3VL-4B-Instruct-F16.gguf": "",                   # TODO(owner): SHA-256
        },
        "gguf": {"model": "Qwen3VL-4B-Instruct-Q4_K_M.gguf", "mmproj": "mmproj-Qwen3VL-4B-Instruct-F16.gguf"},
    },
}
FORMATS = ("mlx", "gguf")
# general.architecture in each GGUF file (llama.cpp's names for Qwen3-VL and its vision projector).
GGUF_ARCH = {"model": "qwen3vl", "mmproj": "clip"}
GGUF_MAGIC = b"GGUF"

# Files that are code, or can hold code (pickles), and never belong in an MLX model.
CODE_SUFFIXES = (".py", ".pyc", ".pyo", ".pyd", ".so", ".dylib", ".dll", ".exe", ".sh", ".bat",
                 ".pkl", ".pickle", ".pt", ".pth", ".ckpt", ".bin", ".npy", ".npz", ".joblib", ".whl", ".egg")
# Config keys that make mlx-vlm or transformers import code from the model folder or the Hub.
CODE_KEYS = ("model_file", "auto_map")
COMMIT = re.compile(r"^[0-9a-f]{40}$")
MARKER = ".breakpatch-model.json"


@dataclass(frozen=True)
class Model:
    repo: str
    revision: str
    files: dict[str, str] = field(default_factory=dict)     # file name -> SHA-256 (hex)
    format: str = "mlx"
    gguf: dict[str, str] = field(default_factory=dict)      # gguf only: {"model": file, "mmproj": file}

    @property
    def pinned(self) -> bool:
        return bool(COMMIT.match(self.revision)) and bool(self.files) and all(
            re.fullmatch(r"[0-9a-f]{64}", h or "") for h in self.files.values())


def table() -> dict[str, Model]:
    return {repo: Model(repo, e["revision"], dict(e.get("files") or {}), e.get("format") or "mlx",
                        dict(e.get("gguf") or {})) for repo, e in ALLOWED.items()}


# The model format each AI runtime (runtimes.runtime_name()) loads.
RUNTIME_FORMATS = {"mlx": "mlx", "llamacpp": "gguf"}


def format_for(runtime: str) -> str:
    return RUNTIME_FORMATS.get(runtime, "gguf")


def default_format() -> str:
    """The model format this machine uses: its runtime's (runtimes.runtime_name()), so MLX on
    Apple Silicon and GGUF (llama.cpp) everywhere else."""
    from . import runtimes
    return format_for(runtimes.runtime_name())


def gguf_files(repo: str | None) -> tuple[str, str] | None:
    """(model file, projector file) of a GGUF model in the table, or None."""
    m = table().get(repo or "")
    if m is None or m.format != "gguf" or not m.gguf.get("model") or not m.gguf.get("mmproj"):
        return None
    return m.gguf["model"], m.gguf["mmproj"]


def entry(repo: str | None, revision: str | None) -> Model:
    """The allowed model for `repo`, if `revision` is its revision. Else a plain `bad_request`."""
    m = table().get(repo or "")
    if m is None:
        raise EngineError("bad_request", "This AI assistant isn't one Breakpatch can use.", f"repo {repo!r}")
    if (revision or "main") != m.revision:
        raise EngineError("bad_request", "This version of the AI assistant isn't one Breakpatch can use.",
                          f"{repo} revision {revision!r}, allowed {m.revision!r}")
    if m.format != default_format():
        raise EngineError("bad_request", "This AI assistant doesn't run on this computer.",
                          f"{repo} is {m.format}; this computer's AI runtime uses {default_format()}")
    if config.is_release() and not m.pinned:
        raise EngineError("bad_request", "This AI assistant isn't ready for this version of Breakpatch yet.",
                          f"{repo} isn't pinned (models.py TODO)")
    return m


class Refused(Exception):
    """A model file or config that is never used."""


def check_name(name: str) -> str:
    """A Hub file name that is safe to write under the model folder, and isn't code."""
    if not isinstance(name, str) or not name or "\\" in name or "\x00" in name:
        raise Refused(f"unusable file name {name!r}")
    p = PurePosixPath(name)
    if p.is_absolute() or name.startswith("/") or any(part in ("", ".", "..") for part in name.split("/")):
        raise Refused(f"file name outside the model folder: {name!r}")
    if p.name.lower().endswith(CODE_SUFFIXES):
        raise Refused(f"code file in the model: {name}")
    return name


def _has_code_keys(v, depth: int = 0) -> str | None:
    if depth > 6:
        return None
    if isinstance(v, dict):
        for k, x in v.items():
            if k in CODE_KEYS:
                return k
            got = _has_code_keys(x, depth + 1)
            if got:
                return got
    elif isinstance(v, list):
        for x in v[:1000]:
            got = _has_code_keys(x, depth + 1)
            if got:
                return got
    return None


def check_configs(folder: Path) -> None:
    """Refuses a model folder whose JSON configs (config.json and the processor/tokenizer ones)
    name `model_file` or `auto_map`."""
    for f in sorted(Path(folder).rglob("*.json")):
        if f.name == MARKER or ".partial" in f.parts:
            continue
        try:
            data = json.loads(f.read_text(encoding="utf-8"))
        except (OSError, ValueError, UnicodeDecodeError):
            if f.name == "config.json":
                raise Refused("config.json can't be read") from None
            continue
        key = _has_code_keys(data)
        if key:
            raise Refused(f"{f.relative_to(folder)} names {key}, which would run code from the model")


def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _read_exact(f, n: int) -> bytes:
    b = f.read(n)
    if len(b) != n:
        raise Refused("the GGUF file ends too early")
    return b


GGUF_SIZES = {0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8}   # value type -> bytes
GGUF_STRING, GGUF_ARRAY = 8, 9
GGUF_MAX_KV = 4096
GGUF_MAX_STRING = 1 << 20


def gguf_architecture(path: Path) -> str:
    """`general.architecture` from a GGUF file's header (version 2 or 3). Raises Refused when the
    file isn't GGUF or doesn't say. Reads only the metadata before that key (it comes first)."""
    import struct

    def string(f) -> bytes:
        (n,) = struct.unpack("<Q", _read_exact(f, 8))
        if n > GGUF_MAX_STRING:
            raise Refused("a GGUF metadata string is too long")
        return _read_exact(f, n)

    def skip(f, vtype: int) -> None:
        if vtype in GGUF_SIZES:
            _read_exact(f, GGUF_SIZES[vtype])
        elif vtype == GGUF_STRING:
            string(f)
        elif vtype == GGUF_ARRAY:
            (etype,) = struct.unpack("<I", _read_exact(f, 4))
            (count,) = struct.unpack("<Q", _read_exact(f, 8))
            if etype in GGUF_SIZES:
                f.seek(GGUF_SIZES[etype] * count, 1)
            elif etype == GGUF_STRING:
                for _ in range(count):
                    string(f)
            else:
                raise Refused(f"unsupported GGUF array of type {etype}")
        else:
            raise Refused(f"unknown GGUF value type {vtype}")

    try:
        with open(path, "rb") as f:
            if _read_exact(f, 4) != GGUF_MAGIC:
                raise Refused(f"{path.name} isn't a GGUF file")
            (version,) = struct.unpack("<I", _read_exact(f, 4))
            if version not in (2, 3):
                raise Refused(f"{path.name} is GGUF version {version}, not 2 or 3")
            _tensors, kv_count = struct.unpack("<QQ", _read_exact(f, 16))
            for _ in range(min(kv_count, GGUF_MAX_KV)):
                key = string(f)
                (vtype,) = struct.unpack("<I", _read_exact(f, 4))
                if key == b"general.architecture":
                    if vtype != GGUF_STRING:
                        raise Refused(f"{path.name}: general.architecture isn't a string")
                    return string(f).decode("utf-8", "replace")
                skip(f, vtype)
    except OSError as e:
        raise Refused(f"{path.name} can't be read: {e}") from None
    raise Refused(f"{path.name} doesn't name its architecture")


def check_gguf_dir(folder: Path, m: Model) -> None:
    """A GGUF model folder: only `*.gguf` files and the marker, both named files present and of
    the expected architecture."""
    for f in folder.rglob("*"):
        rel = f.relative_to(folder)
        if f.is_dir() or f.name == MARKER and rel == Path(MARKER):
            continue
        if not f.name.lower().endswith(".gguf"):
            raise Refused(f"not a GGUF file: {rel}")
    for role, want in GGUF_ARCH.items():
        name = m.gguf.get(role)
        if not name:
            raise Refused(f"{m.repo} names no {role} file")
        path = folder / check_name(name)
        if not path.is_file():
            raise Refused(f"{name} is missing")
        got = gguf_architecture(path)
        if got != want:
            raise Refused(f"{name} is a {got!r} model, not {want!r}")


# GGUF files whose SHA-256 matched, by (path, device, inode, size, mtime): llama-server starts
# again after every idle stop, and rehashing ~3 GB at each start would make it slow. A file that
# changes gets a new mtime (or size), so it's hashed again. Successes only.
_HASHED: dict[tuple, str] = {}


def _file_key(path: Path) -> tuple | None:
    try:
        st = path.stat()
    except OSError:
        return None
    return (str(path.resolve()), st.st_dev, st.st_ino, st.st_size, st.st_mtime_ns)


def _matches(path: Path, want: str, cache: bool) -> bool:
    if not path.is_file():
        return False
    key = _file_key(path) if cache else None
    if key is not None and _HASHED.get(key) == want:
        return True
    if sha256_of(path) != want:
        return False
    if key is not None and _file_key(path) == key:       # unchanged while it was read
        _HASHED[key] = want
    return True


def check_model_dir(folder: Path) -> None:
    """Load-time check of an installed model: it's one from the table, has no code files, no config
    naming code, and (once pinned) every listed file matches its shipped SHA-256. GGUF models are
    also checked by check_gguf_dir, and their hashes are remembered by size and mtime (_HASHED);
    an MLX model is hashed every time, as before. Raises Refused."""
    folder = Path(folder)
    try:
        info = json.loads((folder / MARKER).read_text())
    except (OSError, ValueError):
        raise Refused("the model has no install record") from None
    m = table().get(info.get("repo") or "")
    if m is None or info.get("revision") != m.revision:
        raise Refused(f"{info.get('repo')} at {info.get('revision')} isn't an allowed model")
    if (info.get("format") or "mlx") != m.format:
        raise Refused(f"{m.repo} was installed as {info.get('format') or 'mlx'}, not {m.format}")
    for f in folder.rglob("*"):
        if f.is_file() and f.name.lower().endswith(CODE_SUFFIXES):
            raise Refused(f"code file in the model: {f.relative_to(folder)}")
    if m.format == "gguf":
        check_gguf_dir(folder, m)
    else:
        check_configs(folder)
    if m.files:
        for name, want in m.files.items():
            path = folder / check_name(name)
            # An empty hash is a development placeholder (models.py TODO): its file is still
            # required, and a release build never gets this far with one (entry() refuses it).
            if not want:
                if not path.is_file():
                    raise Refused(f"{name} is missing")
                continue
            if not _matches(path, want, cache=m.format == "gguf"):
                raise Refused(f"{name} doesn't match its checksum")


def release_problems(formats: tuple[str, ...] | None = None) -> list[str]:
    """Why this table can't ship in a release: every model of these formats (default: this
    platform's, default_format()) needs a commit and a hash per file."""
    formats = formats or (default_format(),)
    out = []
    for m in table().values():
        if m.format not in formats:
            continue
        if m.format not in FORMATS:
            out.append(f"{m.repo}: unknown format {m.format!r}")
        if m.format == "gguf" and not gguf_files(m.repo):
            out.append(f"{m.repo}: no model and mmproj files named")
        if not COMMIT.match(m.revision):
            out.append(f"{m.repo}: revision {m.revision!r} isn't a commit SHA")
        if not m.files:
            out.append(f"{m.repo}: no files with SHA-256 hashes")
        for name, h in m.files.items():
            try:
                check_name(name)
            except Refused as e:
                out.append(f"{m.repo}: {e}")
            if not re.fullmatch(r"[0-9a-f]{64}", h or ""):
                out.append(f"{m.repo}: {name} has no SHA-256")
    return out


def hash_dir(folder: Path) -> dict[str, str]:
    """`files` for a downloaded model folder (the owner pastes it into ALLOWED)."""
    folder = Path(folder)
    out = {}
    for f in sorted(folder.rglob("*")):
        rel = f.relative_to(folder).as_posix()
        if f.is_file() and f.name != MARKER and not rel.startswith((".partial/", ".cache/")):
            out[check_name(rel)] = sha256_of(f)
    return out


def main(argv: list[str]) -> int:
    if argv[:1] == ["--check-release"]:
        formats = None
        if argv[1:2] == ["--format"] and len(argv) == 3 and argv[2] in FORMATS:
            formats = (argv[2],)
        elif len(argv) != 1:
            print("usage: python -m breakpatch_engine.models --check-release [--format mlx|gguf]", file=sys.stderr)
            return 2
        problems = release_problems(formats)
        for p in problems:
            print(f"models: {p}", file=sys.stderr)
        if problems:
            print("models: pin every AI assistant model in engine/src/breakpatch_engine/models.py "
                  "(see the TODO there) before a release build.", file=sys.stderr)
        return 1 if problems else 0
    if argv[:1] == ["--hash-dir"] and len(argv) == 2:
        print(json.dumps(hash_dir(Path(argv[1])), indent=4))
        return 0
    print("usage: python -m breakpatch_engine.models --check-release [--format mlx|gguf] | --hash-dir FOLDER",
          file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
