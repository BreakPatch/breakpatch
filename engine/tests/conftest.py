import os
from pathlib import Path

import pytest

SANDBOX_CHROME = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome"


# Use an explicit Chromium when the one pinned by this Playwright isn't installed (sandboxes, CI images).
if not os.environ.get("BP_CHROMIUM") and Path(SANDBOX_CHROME).exists():
    os.environ["BP_CHROMIUM"] = SANDBOX_CHROME


@pytest.fixture(autouse=True)
def isolated_home(tmp_path, monkeypatch):
    monkeypatch.setenv("BP_HOME", str(tmp_path / "home"))
    monkeypatch.setenv("BP_MODELS_DIR", str(tmp_path / "home" / "models"))
    monkeypatch.setenv("BP_SCREENSHOTS_DIR", str(tmp_path / "home" / "shots"))
    return tmp_path


def browser_available() -> bool:
    from breakpatch_engine.install import browser_status
    return bool(browser_status().get("installed"))


needs_browser = pytest.mark.skipif(not browser_available(), reason="no Chromium available")
