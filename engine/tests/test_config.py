"""Pins the app data folder name. Renaming it moves the AI model (about 3 GB) and every user
downloads it again, so a change here has to be on purpose (app/src/engine/paths.ts pins the same)."""
import sys
from pathlib import Path

from breakpatch_engine import config


def test_default_models_path_on_macos(monkeypatch):
    monkeypatch.delenv("BP_HOME", raising=False)
    monkeypatch.delenv("BP_MODELS_DIR", raising=False)
    monkeypatch.setattr(sys, "platform", "darwin")
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: Path("/Users/you")))
    assert config.models_dir() == Path("/Users/you/Library/Application Support/Breakpatch/models")
    assert config.models_dir().as_posix().endswith("Application Support/Breakpatch/models")


def test_default_models_path_elsewhere(monkeypatch):
    monkeypatch.delenv("BP_HOME", raising=False)
    monkeypatch.delenv("BP_MODELS_DIR", raising=False)
    monkeypatch.setattr(sys, "platform", "linux")
    monkeypatch.setenv("XDG_DATA_HOME", "/data")
    assert config.models_dir() == Path("/data/Breakpatch/models")
