"""The model table and the load-time checks (security review A3)."""
import hashlib
import json
import re
from pathlib import Path

import pytest

from breakpatch_engine import models
from breakpatch_engine.locator import MlxLocator
from breakpatch_engine.protocol import EngineError

REPO = Path(__file__).resolve().parents[2]


def test_the_app_and_the_engine_name_the_same_models():
    ts = (REPO / "app" / "src" / "engine" / "engine.ts").read_text()
    app = dict(re.findall(r"repo: '([^']+)', revision: '([^']+)'", ts))
    assert app, "MODELS not found in engine.ts"
    assert app == {repo: m.revision for repo, m in models.table().items()}


def test_the_shipped_table_is_pinned():
    # The Mac's MLX models are; the llama.cpp ones wait for the owner (models.py TODO).
    assert models.release_problems(("mlx",)) == []
    assert models.main(["--check-release", "--format", "mlx"]) == 0
    assert {m.format for m in models.table().values()} == {"mlx", "gguf"}


def test_gguf_placeholders_are_only_refused_for_a_gguf_release(monkeypatch):
    problems = models.release_problems(("gguf",))
    gguf = [r for r, m in models.table().items() if m.format == "gguf"]
    assert gguf and all(any(p.startswith(r) for r in gguf) for p in problems)
    assert models.main(["--check-release", "--format", "gguf"]) == (1 if problems else 0)
    from breakpatch_engine import runtimes
    monkeypatch.setattr(runtimes, "runtime_name", lambda: "mlx")
    assert models.default_format() == "mlx" and models.main(["--check-release"]) == 0
    monkeypatch.setattr(runtimes, "runtime_name", lambda: "llamacpp")
    assert models.default_format() == "gguf"
    assert models.main(["--check-release", "--format", "onnx"]) == 2


def test_placeholders_cant_ship_in_a_release(monkeypatch):
    monkeypatch.setattr(models, "ALLOWED", {"Org/M": {"revision": "main", "files": {}}})
    problems = models.release_problems(("mlx",))
    assert any("isn't a commit SHA" in p for p in problems)
    assert any("no files with SHA-256" in p for p in problems)
    assert models.main(["--check-release", "--format", "mlx"]) == 1


def test_a_pinned_table_can(monkeypatch):
    monkeypatch.setattr(models, "ALLOWED", {"Org/M": {"revision": "a" * 40, "files": {"config.json": "b" * 64}}})
    assert models.release_problems(("mlx",)) == [] and models.main(["--check-release", "--format", "mlx"]) == 0
    monkeypatch.setattr(models, "ALLOWED", {"Org/M": {"revision": "a" * 40, "files": {"x.py": "b" * 64, "y.json": ""}}})
    assert len(models.release_problems(("mlx",))) == 2


def test_the_pins_are_exact():
    text = (REPO / "engine" / "pyproject.toml").read_text()
    assert 'mlx = ["mlx-vlm==0.7.3", "transformers==5.17.0"]' in text
    # transformers 5.x needs huggingface_hub below 2.0: the pinned hub has to install next to it.
    assert '"huggingface_hub==1.9.2"' in text


def installed(tmp_path, files: dict[str, bytes], repo="Org/M", revision="main") -> Path:
    d = tmp_path / "model"
    d.mkdir()
    for name, body in files.items():
        (d / name).parent.mkdir(parents=True, exist_ok=True)
        (d / name).write_bytes(body)
    (d / models.MARKER).write_text(json.dumps({"repo": repo, "revision": revision}))
    return d


@pytest.fixture
def table(monkeypatch):
    good = {"config.json": b'{"model_type": "qwen3_vl"}', "model.safetensors": b"weights"}
    monkeypatch.setattr(models, "ALLOWED", {"Org/M": {"revision": "main", "files": {
        n: hashlib.sha256(b).hexdigest() for n, b in good.items()}}})
    return good


def test_a_good_model_passes_the_load_check(tmp_path, table):
    models.check_model_dir(installed(tmp_path, table))


@pytest.mark.parametrize("extra,why", [
    ({"custom.py": b"import os"}, "code file"),
    ({"sub/weights.pkl": b"x"}, "code file"),
    ({"preprocessor_config.json": b'{"auto_map": {"AutoProcessor": "p.P"}}'}, "auto_map"),
    ({"config.json": b'{"model_type": "x", "model_file": "custom.py"}'}, "model_file"),
    ({"model.safetensors": b"changed"}, "checksum"),
])
def test_the_load_check_refuses_code_and_changed_files(tmp_path, table, extra, why):
    with pytest.raises(models.Refused) as e:
        models.check_model_dir(installed(tmp_path, {**table, **extra}))
    assert why in str(e.value)


def test_the_load_check_refuses_a_model_not_in_the_table(tmp_path, table):
    with pytest.raises(models.Refused):
        models.check_model_dir(installed(tmp_path, table, repo="Someone/Else"))
    (tmp_path / "b").mkdir()
    with pytest.raises(models.Refused):
        models.check_model_dir(installed(tmp_path / "b", table, revision="other"))


def test_the_locator_wont_load_a_refused_model(tmp_path, table, monkeypatch):
    d = installed(tmp_path, {**table, "custom.py": b"import os"})
    import sys
    import types
    fake = types.ModuleType("mlx_vlm")
    fake.load = lambda *a, **k: pytest.fail("the model must not be loaded")
    utils = types.ModuleType("mlx_vlm.utils")
    utils.load_config = lambda *a, **k: {}
    monkeypatch.setitem(sys.modules, "mlx_vlm", fake)
    monkeypatch.setitem(sys.modules, "mlx_vlm.utils", utils)
    with pytest.raises(EngineError) as e:
        MlxLocator(d)._load()
    assert e.value.code == "not_ready" and "didn't check out" in e.value.message


def test_hash_dir_prints_the_files_entry(tmp_path, table):
    d = installed(tmp_path, table)
    assert models.hash_dir(d) == models.table()["Org/M"].files


# ---------------------------------------------------------------- GGUF (llama.cpp, plan P2.4)

def gguf(kv: dict, version: int = 3, prefix: dict | None = None) -> bytes:
    """A tiny GGUF file: the header and string metadata (and `prefix`'s other values first)."""
    import struct

    def s(b: str) -> bytes:
        raw = b.encode()
        return struct.pack("<Q", len(raw)) + raw
    out = b"GGUF" + struct.pack("<I", version)
    items = []
    for k, (vtype, payload) in (prefix or {}).items():
        items.append(s(k) + struct.pack("<I", vtype) + payload)
    for k, v in kv.items():
        items.append(s(k) + struct.pack("<I", 8) + s(v))
    return out + struct.pack("<QQ", 0, len(items)) + b"".join(items) + b"\0" * 32


@pytest.fixture
def gtable(monkeypatch):
    good = {"m.gguf": gguf({"general.architecture": "qwen3vl"}), "mm.gguf": gguf({"general.architecture": "clip"})}
    monkeypatch.setattr(models, "ALLOWED", {"Org/G": {"format": "gguf", "revision": "main", "gguf": {
        "model": "m.gguf", "mmproj": "mm.gguf"}, "files": {n: hashlib.sha256(b).hexdigest() for n, b in good.items()}}})
    return good


def ginstalled(tmp_path, files, fmt="gguf", repo="Org/G"):
    d = installed(tmp_path, files, repo=repo)
    (d / models.MARKER).write_text(json.dumps({"repo": repo, "revision": "main", "format": fmt}))
    return d


def test_a_good_gguf_model_passes(tmp_path, gtable):
    models.check_model_dir(ginstalled(tmp_path, gtable))
    assert models.gguf_files("Org/G") == ("m.gguf", "mm.gguf")
    assert models.gguf_files("Someone/Else") is None


@pytest.mark.parametrize("change,why", [
    ({"notes.txt": b"hi"}, "not a GGUF file"),
    ({"sub/tokenizer.json": b"{}"}, "not a GGUF file"),
    ({"evil.py": b"x"}, "code file"),
    ({"m.gguf": b"GGML" + b"\0" * 40}, "isn't a GGUF file"),
    ({"m.gguf": gguf({"general.architecture": "llama"})}, "not 'qwen3vl'"),
    ({"mm.gguf": gguf({"general.architecture": "qwen3vl"})}, "not 'clip'"),
    ({"m.gguf": gguf({"general.name": "x"})}, "doesn't name its architecture"),
    ({"m.gguf": gguf({"general.architecture": "qwen3vl"}, version=1)}, "version 1"),
    ({"m.gguf": b"GGUF\x03\0\0\0"}, "ends too early"),
])
def test_the_gguf_check_refuses_other_files(tmp_path, gtable, monkeypatch, change, why):
    # The hashes would catch a changed file too; this is the format check underneath them.
    files = {**gtable, **change}
    monkeypatch.setitem(models.ALLOWED["Org/G"], "files", {n: hashlib.sha256(b).hexdigest() for n, b in files.items()
                                                           if n in ("m.gguf", "mm.gguf")})
    with pytest.raises(models.Refused) as e:
        models.check_model_dir(ginstalled(tmp_path, files))
    assert why in str(e.value)


def test_gguf_hashes_are_remembered_until_a_file_changes(tmp_path, gtable, monkeypatch):
    """llama-server starts again after every idle stop: an unchanged ~3 GB model isn't hashed again."""
    import os
    monkeypatch.setattr(models, "_HASHED", {})
    d = ginstalled(tmp_path, gtable)
    hashed = []
    real = models.sha256_of
    monkeypatch.setattr(models, "sha256_of", lambda p: (hashed.append(Path(p).name), real(p))[1])
    models.check_model_dir(d)
    assert sorted(hashed) == ["m.gguf", "mm.gguf"]
    hashed.clear()
    models.check_model_dir(d)
    assert hashed == []                                        # same size and mtime: not read again
    # Changed in place, same size: the new mtime means it's hashed, and refused.
    body = bytearray((d / "m.gguf").read_bytes())
    body[-1] ^= 1
    (d / "m.gguf").write_bytes(bytes(body))
    st = (d / "m.gguf").stat()
    os.utime(d / "m.gguf", ns=(st.st_atime_ns, st.st_mtime_ns + 10**9))
    with pytest.raises(models.Refused):
        models.check_model_dir(d)
    assert hashed == ["m.gguf"]


def test_mlx_hashes_are_checked_every_time_as_before(tmp_path, table, monkeypatch):
    monkeypatch.setattr(models, "_HASHED", {})
    d = installed(tmp_path, table)
    hashed = []
    real = models.sha256_of
    monkeypatch.setattr(models, "sha256_of", lambda p: (hashed.append(1), real(p))[1])
    models.check_model_dir(d)
    first = len(hashed)
    models.check_model_dir(d)
    assert first and len(hashed) == 2 * first and models._HASHED == {}


def test_the_architecture_is_found_after_other_metadata(tmp_path):
    import struct
    arr = struct.pack("<IQ", 8, 2) + b"".join(struct.pack("<Q", len(w)) + w for w in (b"a", b"bc"))
    prefix = {"general.alignment": (4, struct.pack("<I", 32)), "tokenizer.ggml.tokens": (9, arr),
              "x.scores": (9, struct.pack("<IQ", 6, 3) + b"\0" * 12), "general.flag": (7, b"\1")}
    p = tmp_path / "x.gguf"
    p.write_bytes(gguf({"general.architecture": "qwen3vl"}, prefix=prefix))
    assert models.gguf_architecture(p) == "qwen3vl"


def test_the_marker_format_must_match_the_table(tmp_path, gtable):
    with pytest.raises(models.Refused) as e:
        models.check_model_dir(ginstalled(tmp_path, gtable, fmt="mlx"))
    assert "installed as mlx" in str(e.value)


def test_an_unhashed_development_entry_still_needs_its_files(tmp_path, gtable, monkeypatch):
    monkeypatch.setitem(models.ALLOWED["Org/G"], "files", {"m.gguf": "", "mm.gguf": ""})
    d = ginstalled(tmp_path, gtable)
    models.check_model_dir(d)
    (d / "mm.gguf").unlink()
    with pytest.raises(models.Refused) as e:
        models.check_model_dir(d)
    assert "missing" in str(e.value)


def test_entry_refuses_a_model_this_machine_cant_run(gtable, monkeypatch):
    from breakpatch_engine import runtimes
    monkeypatch.setitem(models.ALLOWED, "Org/M", {"format": "mlx", "revision": "a" * 40, "files": {"config.json": "b" * 64}})
    monkeypatch.setattr(runtimes, "runtime_name", lambda: "llamacpp")      # Linux, Windows, an Intel Mac
    with pytest.raises(EngineError) as e:
        models.entry("Org/M", "a" * 40)
    assert e.value.code == "bad_request" and "doesn't run on this computer" in e.value.message
    assert models.entry("Org/G", "main").format == "gguf"
    monkeypatch.setattr(runtimes, "runtime_name", lambda: "mlx")           # Apple Silicon, as before
    assert models.entry("Org/M", "a" * 40).format == "mlx"
    with pytest.raises(EngineError):
        models.entry("Org/G", "main")


def test_a_release_build_refuses_an_unpinned_model(gtable, monkeypatch):
    import sys
    from breakpatch_engine import runtimes
    monkeypatch.setattr(runtimes, "runtime_name", lambda: "llamacpp")
    assert models.entry("Org/G", "main").format == "gguf"
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    with pytest.raises(EngineError) as e:
        models.entry("Org/G", "main")
    assert e.value.code == "bad_request"
    monkeypatch.setattr(models, "ALLOWED", {"Org/M": {"format": "gguf", "revision": "a" * 40, "files": {"m.gguf": "b" * 64}}})
    assert models.entry("Org/M", "a" * 40).pinned                 # a pinned one is fine
