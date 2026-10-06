"""Linux: finding the system libraries Chromium lacks, and saying so plainly (plan
docs/linux-windows-plan.md P1.5; breakpatch-ci setup and run use it)."""
import subprocess
import sys
import types

import pytest

from breakpatch_engine import browser, install
from breakpatch_engine.protocol import EngineError

LDD = """\
\tlinux-vdso.so.1 (0x00007ffd)
\tlibdl.so.2 => /lib/x86_64-linux-gnu/libdl.so.2 (0x00007f)
\tlibnss3.so => not found
\tlibgbm.so.1 => not found
\tlibnss3.so => not found
\tlibEGL.so => /opt/chrome/libEGL.so (0x00007f)
\tlibc.so.6 => /lib/x86_64-linux-gnu/libc.so.6 (0x00007f)
"""


def fake_ldd(out=LDD, calls=None):
    def run(cmd, **kw):
        if calls is not None:
            calls.append((cmd, kw["env"]["LD_LIBRARY_PATH"]))
        return types.SimpleNamespace(stdout=out, returncode=0)
    return run


@pytest.fixture
def chrome(tmp_path, monkeypatch):
    for v in ("BP_CHROMIUM", "BP_BROWSERS_PATH", "LD_LIBRARY_PATH"):
        monkeypatch.delenv(v, raising=False)
    monkeypatch.setenv("PLAYWRIGHT_BROWSERS_PATH", str(tmp_path))
    monkeypatch.setattr(install, "pinned_browser", lambda: {"revision": "1243", "version": "153.0.1"})
    monkeypatch.setattr(install.sys, "platform", "linux")
    monkeypatch.setattr(install.shutil, "which", lambda name: "/usr/bin/ldd" if name == "ldd" else None)
    exe = tmp_path / "chromium-1243" / "chrome-linux64" / "chrome"
    exe.parent.mkdir(parents=True)
    exe.write_text("")
    return exe


def test_the_pinned_chromium_is_found_in_its_folder(chrome):
    assert install.chromium_path() == chrome


def test_arm64_and_older_folders_are_found_too(chrome):
    arm = chrome.parent.parent / "chrome-linux-arm64" / "chrome"
    chrome.unlink()
    arm.parent.mkdir()
    arm.write_text("")
    assert install.chromium_path() == arm


def test_bp_chromium_wins(chrome, tmp_path, monkeypatch):
    own = tmp_path / "own-chrome"
    own.write_text("")
    monkeypatch.setenv("BP_CHROMIUM", str(own))
    assert install.chromium_path() == own
    monkeypatch.setenv("BP_CHROMIUM", str(tmp_path / "gone"))
    assert install.chromium_path() is None


def test_missing_libraries_are_what_ldd_cannot_find(chrome):
    calls = []
    assert install.missing_libraries(run=fake_ldd(calls=calls)) == ["libgbm.so.1", "libnss3.so"]
    # Chromium's own folder is on the library path, as when it starts.
    assert calls == [(["/usr/bin/ldd", str(chrome)], str(chrome.parent))]


def test_nothing_is_missing_when_ldd_finds_everything(chrome):
    assert install.missing_libraries(run=fake_ldd("\tlibc.so.6 => /lib/libc.so.6 (0x1)\n")) == []


def test_it_cannot_tell_without_chromium_ldd_or_linux(chrome, monkeypatch):
    def broken(*a, **kw):
        raise OSError("no")
    assert install.missing_libraries(run=broken) == []
    monkeypatch.setattr(install.shutil, "which", lambda name: None)
    assert install.missing_libraries(run=fake_ldd()) == []
    monkeypatch.setattr(install.shutil, "which", lambda name: "/usr/bin/ldd")
    chrome.unlink()
    assert install.missing_libraries(run=fake_ldd()) == []
    monkeypatch.setattr(install.sys, "platform", "darwin")
    assert install.missing_libraries(chrome, run=fake_ldd()) == []


def test_the_message_names_the_libraries_and_the_command(monkeypatch):
    monkeypatch.setattr(install.os, "geteuid", lambda: 1000, raising=False)
    msg = install.libraries_message(["libgbm.so.1", "libnss3.so"], python="/home/ci/.breakpatch-ci/current/bin/python")
    assert msg == ("The browser can't start: this machine is missing system libraries it needs (libgbm.so.1, libnss3.so). "
                   "Install them once, as an administrator: sudo /home/ci/.breakpatch-ci/current/bin/python -m playwright "
                   "install-deps chromium. That works on Ubuntu and Debian. On another Linux, install the packages that "
                   "have those libraries.")
    many = install.libraries_message([f"lib{i}.so" for i in range(8)], python="py")
    assert "(lib0.so, lib1.so, lib2.so, lib3.so, lib4.so and 3 more)" in many
    # As root (a CI container) there's no sudo to add.
    monkeypatch.setattr(install.os, "geteuid", lambda: 0, raising=False)
    assert "administrator: py -m playwright install-deps chromium" in install.libraries_message([], python="py")


@pytest.mark.parametrize("text", [
    "Browser logs: /x/chrome: error while loading shared libraries: libnss3.so: cannot open shared object file",
    "╔══╗\n║ Host system is missing dependencies to run browsers. ║\n║ Missing libraries: ║",
])
def test_a_launch_that_lacks_libraries_says_so(text, monkeypatch):
    monkeypatch.setattr(install, "missing_libraries", lambda: ["libnss3.so"])
    err = browser.launch_error(Exception(text))
    assert isinstance(err, EngineError) and err.code == "not_ready"
    assert err.message.startswith("The browser can't start: this machine is missing system libraries it needs (libnss3.so).")


def test_other_launch_errors_are_unchanged():
    assert browser.launch_error(Exception("Executable doesn't exist at /x/chrome")).message == \
        "The browser isn't installed yet. Finish setup to install it."
    err = browser.launch_error(Exception("Target closed"))
    assert (err.code, err.message) == ("internal", "The browser couldn't start.")


@pytest.mark.skipif(not sys.platform.startswith("linux"), reason="ldd is Linux's")
def test_the_real_ldd_reads_a_real_program():
    # /bin/sh needs only libc, which every Linux has.
    assert install.missing_libraries(install.Path("/bin/sh"), run=subprocess.run) == []


# ---------------------------------------------------------------- system_libraries: breakpatch-ci's surface

def test_system_libraries_checks_on_linux_with_chromium_and_ldd(chrome, monkeypatch):
    from breakpatch_engine import system_libraries
    monkeypatch.setattr(install, "missing_libraries", lambda: ["libgbm.so.1"])
    assert system_libraries.check() == (True, ["libgbm.so.1"])
    assert system_libraries.message(["libgbm.so.1"], "/py") == install.libraries_message(["libgbm.so.1"], "/py")


def test_system_libraries_cant_tell_without_linux_chromium_or_ldd(chrome, monkeypatch):
    from breakpatch_engine import system_libraries
    monkeypatch.setattr(install, "missing_libraries", lambda: pytest.fail("nothing to look at"))
    monkeypatch.setattr(install.shutil, "which", lambda name: None)              # no ldd
    assert system_libraries.check() == (False, [])
    monkeypatch.setattr(install.shutil, "which", lambda name: "/usr/bin/ldd")
    chrome.unlink()                                                              # no Chromium
    assert system_libraries.check() == (False, [])
    monkeypatch.setattr(install.sys, "platform", "darwin")
    assert system_libraries.check() == (False, [])


def test_system_libraries_never_raises(chrome, monkeypatch):
    from breakpatch_engine import system_libraries

    def boom():
        raise OSError("ldd went away")
    monkeypatch.setattr(install, "missing_libraries", boom)
    assert system_libraries.check() == (False, [])
    assert system_libraries.__all__ == ["check", "message"]
