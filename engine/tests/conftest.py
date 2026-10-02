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


def pytest_terminal_summary(terminalreporter):
    """On GitHub Actions, each failure is also an annotation (`::error`), so it can be read from the
    run's annotations without downloading the log."""
    import os
    if os.environ.get("GITHUB_ACTIONS") != "true":
        return
    esc = lambda t: str(t).replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")
    for rep in terminalreporter.stats.get("failed", []) + terminalreporter.stats.get("error", []):
        lines = [l for l in str(rep.longrepr).splitlines() if l.strip()]
        last = next((l for l in reversed(lines) if l.startswith("E ")), lines[-1] if lines else "")
        terminalreporter.write_line(f"::error title={esc(rep.nodeid)}::{esc(last.strip()[:400])}")
