"""Setup: system info, browser status, and the model download (pause, resume, checksum) against a fake Hub."""
import asyncio
import sys
import hashlib
from pathlib import Path

import pytest

from fakehub import FakeHub
from breakpatch_engine import install, models
from breakpatch_engine.protocol import EngineError


def allow(monkeypatch, hub, revision="main", files=None):
    """Puts the fake Hub's repo in the model table, with the SHA-256 of each of its files."""
    if files is None:
        files = {n: hashlib.sha256(b).hexdigest() for n, b in hub.files.items()}
    monkeypatch.setitem(models.ALLOWED, hub.repo, {"revision": revision, "files": files})


@pytest.fixture
def hub(monkeypatch):
    h = FakeHub(big_bytes=4 * 2**20, chunk=32 * 1024, delay=0.02)
    allow(monkeypatch, h)
    monkeypatch.setenv("HF_ENDPOINT", h.url)
    monkeypatch.setenv("NO_PROXY", "127.0.0.1,localhost")
    monkeypatch.setenv("no_proxy", "127.0.0.1,localhost")
    yield h
    h.close()


def test_system_info_shape():
    info = install.system_info()
    assert set(info) == {"memoryGb", "chip", "os", "engineVersion", "edition", "licence", "browser", "model", "system"}
    assert info["edition"] in ("community", "team")
    assert isinstance(info["memoryGb"], (int, float)) and info["memoryGb"] > 0
    assert info["model"] == {"installed": False}
    assert isinstance(info["browser"]["installed"], bool)


def test_parse_install_progress_lines():
    assert install.parse_install_line("|■■■■      |  40% of 162.3 MiB") == (int(162.3 * 2**20 * 0.4), int(162.3 * 2**20))
    assert install.parse_install_line("Downloading Chromium 131") is None


def test_explicit_chromium_counts_as_installed(monkeypatch, tmp_path):
    exe = tmp_path / "chrome"
    monkeypatch.setenv("BP_CHROMIUM", str(exe))
    assert install.browser_status()["installed"] is False
    exe.write_text("")
    assert install.browser_status() == {"installed": True, "version": "custom"}


async def test_download_pause_resume_and_remove(hub):
    events = []
    setup = install.Setup(events.append)
    task = asyncio.create_task(setup.download_model(hub.repo, "main"))
    # Wait until part of the big file is on disk, then pause.
    for _ in range(200):
        busy = [e for e in events if e["state"] == "busy" and (e.get("doneBytes") or 0) > 256 * 1024]
        if busy:
            break
        await asyncio.sleep(0.05)
    assert busy, events
    assert busy[-1]["totalBytes"] == sum(len(b) for b in hub.files.values())
    await setup.pause("model")
    with pytest.raises(EngineError) as e:
        await task
    assert e.value.code == "stopped"
    assert events[-1]["state"] == "paused"
    partial = list(install.model_path(hub.repo).rglob("*.part"))
    assert partial and 0 < partial[0].stat().st_size < len(hub.files["model.safetensors"])
    assert install.installed_model() == {"installed": False}

    # Calling it again resumes from the partial file (an HTTP Range request).
    got = await setup.download_model(hub.repo, "main")
    assert any(name == "model.safetensors" and rng.startswith("bytes=") and rng != "bytes=0-"
               for name, rng in hub.ranges), hub.ranges
    assert got["sizeBytes"] == sum(len(b) for b in hub.files.values())
    weights = Path(got["path"]) / "model.safetensors"
    assert hashlib.sha256(weights.read_bytes()).digest() == hashlib.sha256(hub.files["model.safetensors"]).digest()
    assert events[-1]["state"] == "done"
    info = install.system_info()["model"]
    assert info["installed"] and info["repo"] == hub.repo and info["revision"] == "main"
    assert info["sizeBytes"] == got["sizeBytes"] and info["path"] == got["path"]

    await setup.remove_model()
    assert install.installed_model() == {"installed": False}
    assert not install.model_path(hub.repo).exists()


async def test_download_unknown_repo_fails_plainly(hub, monkeypatch):
    monkeypatch.setitem(models.ALLOWED, "Org/Missing", {"revision": "main", "files": {"config.json": "0" * 64}})
    events = []
    setup = install.Setup(events.append)
    with pytest.raises(EngineError) as e:
        await setup.download_model("Org/Missing", "main")
    assert e.value.code == "not_found"
    assert e.value.message == "That AI assistant version couldn't be found."
    assert events[-1]["state"] == "failed"


async def test_download_rejects_a_corrupt_file(hub):
    real = hub.files["model.safetensors"]
    hub.served_override = {"model.safetensors": real[:-1] + bytes([real[-1] ^ 0xFF])}
    setup = install.Setup(lambda e: None)
    with pytest.raises(EngineError) as e:
        await setup.download_model(hub.repo, "main")
    assert "didn't check out" in e.value.message
    assert not (install.model_path(hub.repo) / "model.safetensors").exists()   # the damaged file is removed


# ---------------------------------------------------------------- model safety (security review A3)

async def test_only_models_in_the_table_are_downloaded(hub):
    setup = install.Setup(lambda e: None)
    with pytest.raises(EngineError) as e:
        await setup.download_model("Someone/Else", "main")
    assert e.value.code == "bad_request" and e.value.message == "This AI assistant isn't one Breakpatch can use."
    with pytest.raises(EngineError) as e:
        await setup.download_model(hub.repo, "a-branch")
    assert e.value.code == "bad_request" and "version" in e.value.message
    assert hub.gets == []                                   # nothing was asked of the Hub


async def test_only_the_listed_files_are_fetched(hub, monkeypatch):
    listed = {n: hashlib.sha256(b).hexdigest() for n, b in hub.files.items()}
    allow(monkeypatch, hub, files=listed)
    hub.files["modeling_evil.py"] = b"import os; os.system('touch /tmp/pwned')\n"
    hub.files["notes.txt"] = b"not in the list\n"
    got = await install.Setup(lambda e: None).download_model(hub.repo, "main")
    assert sorted(set(hub.gets)) == ["config.json", "model.safetensors"]
    assert not (Path(got["path"]) / "modeling_evil.py").exists()


async def test_files_are_checked_against_the_shipped_hashes_not_the_hubs(hub, monkeypatch):
    real = hub.files["model.safetensors"]
    allow(monkeypatch, hub)                                          # hashes of the real files
    hub.files["model.safetensors"] = real[:-1] + bytes([real[-1] ^ 0xFF])   # the Hub's metadata agrees with it
    with pytest.raises(EngineError) as e:
        await install.Setup(lambda e: None).download_model(hub.repo, "main")
    assert "didn't check out" in e.value.message
    assert not (install.model_path(hub.repo) / "model.safetensors").exists()
    assert install.installed_model() == {"installed": False}


async def test_a_pinned_commit_is_what_gets_downloaded(hub, monkeypatch):
    from fakehub import COMMIT
    allow(monkeypatch, hub, revision=COMMIT)
    assert models.table()[hub.repo].pinned
    got = await install.Setup(lambda e: None).download_model(hub.repo, COMMIT)
    assert got["sizeBytes"] == sum(len(b) for b in hub.files.values())
    assert install.installed_model()["revision"] == COMMIT
    allow(monkeypatch, hub, revision="f" * 40)                         # the Hub answers another commit
    install.Setup(lambda e: None)
    with pytest.raises(EngineError) as e:
        await install.Setup(lambda e: None).download_model(hub.repo, "f" * 40)
    assert "didn't check out" in e.value.message


async def test_a_placeholder_without_hashes_downloads_in_development_without_code(hub, monkeypatch, caplog):
    allow(monkeypatch, hub, files={})
    hub.files["modeling_evil.py"] = b"import os\n"
    got = await install.Setup(lambda e: None).download_model(hub.repo, "main")
    assert (Path(got["path"]) / "model.safetensors").is_file()
    assert "modeling_evil.py" not in hub.gets and not (Path(got["path"]) / "modeling_evil.py").exists()
    assert "isn't pinned" in caplog.text


@pytest.mark.parametrize("key", ["model_file", "auto_map"])
async def test_a_config_that_names_code_is_refused(hub, monkeypatch, key):
    hub.files["config.json"] = ('{"model_type": "fake", "%s": {"AutoModel": "evil.Model"}}\n' % key).encode()
    allow(monkeypatch, hub)
    with pytest.raises(EngineError) as e:
        await install.Setup(lambda e: None).download_model(hub.repo, "main")
    assert e.value.code == "bad_request" and "won't use" in e.value.message and key in (e.value.details or "")
    assert not install.model_path(hub.repo).exists() and install.installed_model() == {"installed": False}


@pytest.mark.parametrize("name", ["../escape.json", "/etc/evil.json", "a/../../b.json", "a\\b.json", "./x.json"])
async def test_hub_file_names_must_stay_in_the_model_folder(hub, monkeypatch, name, tmp_path):
    allow(monkeypatch, hub, files={})
    hub.files[name] = b"{}"
    with pytest.raises(EngineError) as e:
        await install.Setup(lambda e: None).download_model(hub.repo, "main")
    assert e.value.code == "bad_request"
    assert not (tmp_path / "home" / "escape.json").exists()


def test_release_builds_ignore_the_hub_address_and_token(monkeypatch):
    base = {"HF_ENDPOINT": "https://evil.example", "HF_TOKEN": "hf_x", "HUGGING_FACE_HUB_TOKEN": "hf_y", "PATH": "/bin"}
    dev = install.hub_env(base)
    assert dev["HF_ENDPOINT"] == "https://evil.example" and dev["HF_TOKEN"] == "hf_x"
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    rel = install.hub_env(base)
    assert "HF_ENDPOINT" not in rel and "HF_TOKEN" not in rel and "HUGGING_FACE_HUB_TOKEN" not in rel
    assert rel["HF_HUB_DISABLE_IMPLICIT_TOKEN"] == "1" and rel["PATH"] == "/bin"
    assert rel["HF_HOME"].endswith(".hf")
