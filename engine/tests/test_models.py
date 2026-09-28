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
    assert models.release_problems() == []
    assert models.main(["--check-release"]) == 0


def test_placeholders_cant_ship_in_a_release(monkeypatch):
    monkeypatch.setattr(models, "ALLOWED", {"Org/M": {"revision": "main", "files": {}}})
    problems = models.release_problems()
    assert any("isn't a commit SHA" in p for p in problems)
    assert any("no files with SHA-256" in p for p in problems)
    assert models.main(["--check-release"]) == 1


def test_a_pinned_table_can(monkeypatch):
    monkeypatch.setattr(models, "ALLOWED", {"Org/M": {"revision": "a" * 40, "files": {"config.json": "b" * 64}}})
    assert models.release_problems() == [] and models.main(["--check-release"]) == 0
    monkeypatch.setattr(models, "ALLOWED", {"Org/M": {"revision": "a" * 40, "files": {"x.py": "b" * 64, "y.json": ""}}})
    assert len(models.release_problems()) == 2


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
