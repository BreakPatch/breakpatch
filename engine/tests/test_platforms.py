"""The engine's Windows and Raspberry Pi code paths, tested on Linux with `sys.platform`
monkeypatched and fakes for kernel32, the registry and /proc (plan docs/linux-windows-plan.md P1.1).
Real Windows and Pi machines still need a check by hand (engine/README.md "Needs real hardware")."""
import asyncio
import ctypes
import os
import sys
import types
from pathlib import Path

import pytest

from breakpatch_engine import config, install, systems
from breakpatch_engine.protocol import Server, Writer, open_reader


# ---------------------------------------------------------------- data folder

def test_app_home_on_windows_is_local_appdata(monkeypatch):
    monkeypatch.delenv("BP_HOME", raising=False)
    monkeypatch.delenv("BP_MODELS_DIR", raising=False)
    monkeypatch.setattr(sys, "platform", "win32")
    monkeypatch.setenv("LOCALAPPDATA", "/Users/you/AppData/Local")
    monkeypatch.setenv("APPDATA", "/Users/you/AppData/Roaming")
    assert config.app_home() == Path("/Users/you/AppData/Local/Breakpatch")
    assert config.models_dir() == Path("/Users/you/AppData/Local/Breakpatch/models")
    assert "Roaming" not in str(config.browsers_dir())


def test_app_home_on_windows_without_localappdata(monkeypatch):
    monkeypatch.delenv("BP_HOME", raising=False)
    monkeypatch.delenv("LOCALAPPDATA", raising=False)
    monkeypatch.setattr(sys, "platform", "win32")
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: Path("/Users/you")))
    assert config.app_home() == Path("/Users/you/AppData/Local/Breakpatch")


def test_bp_home_still_wins_on_windows(monkeypatch):
    monkeypatch.setattr(sys, "platform", "win32")
    monkeypatch.setenv("BP_HOME", "/somewhere/else")
    assert config.app_home() == Path("/somewhere/else")


# ---------------------------------------------------------------- memory

class FakeKernel32:
    """GlobalMemoryStatusEx as kernel32 has it: fills the MEMORYSTATUSEX it's given by reference."""

    def __init__(self, total: int, ok: bool = True):
        self.total, self.ok, self.lengths = total, ok, []

    def GlobalMemoryStatusEx(self, ref):   # noqa: N802 - the Win32 name
        stat = ref._obj
        self.lengths.append(stat.dwLength)
        stat.ullTotalPhys = self.total
        return 1 if self.ok else 0


def test_memory_on_windows_comes_from_global_memory_status_ex(monkeypatch):
    k32 = FakeKernel32(16 * 2**30)
    monkeypatch.setattr(sys, "platform", "win32")
    monkeypatch.setattr(install, "_kernel32", lambda: k32)
    assert install.memory_gb() == 16
    assert k32.lengths == [64]             # dwLength = sizeof(MEMORYSTATUSEX), as Windows requires


def test_memory_on_windows_when_the_call_fails(monkeypatch):
    monkeypatch.setattr(sys, "platform", "win32")
    monkeypatch.setattr(install, "_kernel32", lambda: FakeKernel32(8 * 2**30, ok=False))
    monkeypatch.setattr(os, "sysconf", lambda name: (_ for _ in ()).throw(AttributeError(name)), raising=False)
    assert install.memory_gb() == 0


def test_kernel32_is_none_off_windows():
    assert not hasattr(ctypes, "windll")
    assert install._kernel32() is None
    assert install.windows_memory_bytes() == 0


# ---------------------------------------------------------------- processor name

class FakeWinreg(types.ModuleType):
    HKEY_LOCAL_MACHINE = "HKLM"

    def __init__(self, values):
        super().__init__("winreg")
        self.values, self.opened = values, []

    def OpenKey(self, root, path):   # noqa: N802
        self.opened.append((root, path))
        if (root, path) not in self.values:
            raise FileNotFoundError(path)
        values = self.values[(root, path)]

        class Key:
            def __enter__(self):
                return values

            def __exit__(self, *a):
                return False
        return Key()

    def QueryValueEx(self, key, name):   # noqa: N802
        if name not in key:
            raise FileNotFoundError(name)
        return key[name], 1


def test_chip_on_windows_reads_processor_name_string(monkeypatch):
    reg = FakeWinreg({("HKLM", install.WINDOWS_CPU_KEY): {"ProcessorNameString": "AMD Ryzen 7 7700X 8-Core Processor   "}})
    monkeypatch.setitem(sys.modules, "winreg", reg)
    monkeypatch.setattr(sys, "platform", "win32")
    assert install.chip() == "AMD Ryzen 7 7700X 8-Core Processor"
    assert reg.opened == [("HKLM", r"HARDWARE\DESCRIPTION\System\CentralProcessor\0")]


def test_chip_on_windows_without_the_value_falls_back(monkeypatch):
    monkeypatch.setitem(sys.modules, "winreg", FakeWinreg({}))
    monkeypatch.setattr(sys, "platform", "win32")
    monkeypatch.setattr(install.platform, "processor", lambda: "Intel64 Family 6 Model 154 Stepping 3, GenuineIntel")
    assert install.chip() == "Intel64 Family 6 Model 154 Stepping 3, GenuineIntel"


def test_windows_cpu_name_without_winreg_is_empty(monkeypatch):
    monkeypatch.setitem(sys.modules, "winreg", None)     # import winreg raises ImportError
    assert install.windows_cpu_name() == ""


PI4_CPUINFO = """processor\t: 0
BogoMIPS\t: 108.00
Features\t: fp asimd evtstrm crc32 cpuid
CPU implementer\t: 0x41
CPU part\t: 0xd08

Hardware\t: BCM2835
Revision\t: d03114
Serial\t\t: 10000000abcdef01
Model\t\t: Raspberry Pi 4 Model B Rev 1.4
"""


def test_chip_on_a_raspberry_pi_reads_the_device_tree(monkeypatch, tmp_path):
    (tmp_path / "cpuinfo").write_text(PI4_CPUINFO)
    (tmp_path / "model").write_bytes(b"Raspberry Pi 4 Model B Rev 1.4\x00")
    monkeypatch.setattr(sys, "platform", "linux")
    monkeypatch.setattr(install, "CPUINFO", tmp_path / "cpuinfo")
    monkeypatch.setattr(install, "DEVICE_TREE_MODEL", tmp_path / "model")
    assert install.chip() == "Raspberry Pi 4 Model B Rev 1.4"


def test_chip_on_a_pi_without_a_device_tree_uses_cpuinfo_model(monkeypatch, tmp_path):
    (tmp_path / "cpuinfo").write_text(PI4_CPUINFO)
    monkeypatch.setattr(sys, "platform", "linux")
    monkeypatch.setattr(install, "CPUINFO", tmp_path / "cpuinfo")
    monkeypatch.setattr(install, "DEVICE_TREE_MODEL", tmp_path / "no-such-file")
    assert install.chip() == "Raspberry Pi 4 Model B Rev 1.4"


def test_chip_on_x86_linux_prefers_model_name(monkeypatch, tmp_path):
    (tmp_path / "cpuinfo").write_text("processor\t: 0\nmodel\t\t: 85\nmodel name\t: Intel(R) N100\n")
    (tmp_path / "model").write_bytes(b"Some Board\x00")
    monkeypatch.setattr(sys, "platform", "linux")
    monkeypatch.setattr(install, "CPUINFO", tmp_path / "cpuinfo")
    monkeypatch.setattr(install, "DEVICE_TREE_MODEL", tmp_path / "model")
    assert install.chip() == "Intel(R) N100"


# ---------------------------------------------------------------- Windows 11

def fake_windows(monkeypatch, build: int | None, version: str = "10.0.22631", release: str = "10"):
    monkeypatch.setattr(sys, "platform", "win32")
    monkeypatch.setattr(systems.platform, "release", lambda: release)
    monkeypatch.setattr(systems.platform, "version", lambda: version)
    if build is None:
        monkeypatch.delattr(sys, "getwindowsversion", raising=False)
    else:
        monkeypatch.setattr(sys, "getwindowsversion", lambda: types.SimpleNamespace(build=build), raising=False)


@pytest.mark.parametrize("build,release", [(22631, "11"), (22000, "11"), (26100, "11"), (19045, "10"), (21999, "10")])
def test_windows_11_is_build_22000_and_later(monkeypatch, build, release):
    fake_windows(monkeypatch, build)
    assert systems.windows_release() == (release, build)
    assert systems.os_version() == release
    assert install.os_name() == f"Windows {release} (build {build})"
    assert systems.current("140.0.1")["os"] == "Windows"


def test_windows_build_from_platform_version_without_getwindowsversion(monkeypatch):
    fake_windows(monkeypatch, None, version="10.0.22621")
    assert systems.windows_release() == ("11", 22621)


def test_windows_with_an_unreadable_version(monkeypatch):
    fake_windows(monkeypatch, None, version="", release="10")
    assert systems.windows_release() == ("10", 0)
    assert install.os_name() == "Windows 10"


def test_a_future_windows_release_is_kept(monkeypatch):
    fake_windows(monkeypatch, 30000, release="12")
    assert systems.windows_release() == ("12", 30000)


# ---------------------------------------------------------------- engine.quit

class Lines:
    def __init__(self):
        self.out: list[bytes] = []

    def write(self, b):
        self.out.append(b)

    def flush(self):
        pass


async def test_engine_quit_answers_then_stops_reading(tmp_path):
    import json
    r, w = os.pipe()
    stdin = os.fdopen(r, "rb", buffering=0)
    stream = Lines()
    server = Server({"slow.thing": lambda p: asyncio.sleep(30)}, Writer(stream), grace=0.2)
    os.write(w, b'{"id": 1, "method": "slow.thing"}\n{"id": 2, "method": "engine.quit"}\n')
    # stdin stays open: only engine.quit can end serve() here.
    await asyncio.wait_for(server.serve(stdin), timeout=5)
    replies = {m["id"]: m for m in (json.loads(b) for b in stream.out)}
    assert replies[2] == {"id": 2, "result": {}}
    assert replies[1]["error"]["code"] == "stopped"      # in flight past the grace: answered, not dropped
    os.close(w)
    stdin.close()


async def test_engine_quit_is_always_there():
    server = Server({"system.info": lambda p: asyncio.sleep(0)}, Writer(Lines()))
    assert "engine.quit" in server.handlers and "system.info" in server.handlers


async def test_stdin_is_read_in_a_thread_on_windows(monkeypatch):
    monkeypatch.setattr(sys, "platform", "win32")
    loop = asyncio.get_running_loop()
    monkeypatch.setattr(loop, "connect_read_pipe", lambda *a, **k: pytest.fail("the Proactor pipe reader was used"))
    r, w = os.pipe()
    stdin = os.fdopen(r, "rb")
    reader = await open_reader(stdin)
    os.write(w, b'{"id": 1}\n' + b"x" * 200_000 + b"\n")
    os.close(w)
    assert await asyncio.wait_for(reader.readline(), 5) == b'{"id": 1}\n'
    assert len(await asyncio.wait_for(reader.readline(), 5)) == 200_001
    assert await asyncio.wait_for(reader.readline(), 5) == b""      # EOF reaches the reader
    stdin.close()


async def test_stdin_falls_back_to_a_thread_when_the_pipe_reader_refuses(monkeypatch):
    loop = asyncio.get_running_loop()

    async def refuse(*a, **k):
        raise NotImplementedError("no pipes on this loop")
    monkeypatch.setattr(loop, "connect_read_pipe", refuse)
    r, w = os.pipe()
    stdin = os.fdopen(r, "rb")
    reader = await open_reader(stdin)
    os.write(w, b"hello\n")
    os.close(w)
    assert await asyncio.wait_for(reader.readline(), 5) == b"hello\n"
    stdin.close()


# ---------------------------------------------------------------- slow machines

def test_timings_scale_stretches_only_the_waits_a_slow_machine_needs(monkeypatch):
    monkeypatch.delenv("BP_FAST", raising=False)
    monkeypatch.setenv("BP_TIMINGS_SCALE", "2")
    base, t = config.Timings(), config.Timings.from_env()
    assert (t.settle_timeout, t.pre_wait, t.navigate_timeout, t.start_timeout) == (
        base.settle_timeout * 2, base.pre_wait * 2, base.navigate_timeout * 2, base.start_timeout * 2)
    # Sample counts and spacing stay: they'd only make every step slower.
    for name in ("noise_watch", "noise_interval", "settle_interval", "settle_frames", "pre_interval", "frame_min_gap"):
        assert getattr(t, name) == getattr(base, name), name


def test_timings_scale_applies_to_fast_timings_too(monkeypatch):
    monkeypatch.setenv("BP_FAST", "1")
    monkeypatch.setenv("BP_TIMINGS_SCALE", "1.5")
    assert config.Timings.from_env().settle_timeout == config.Timings.fast().settle_timeout * 1.5


@pytest.mark.parametrize("raw", ["", "1", "0.5", "0", "-2", "11", "abc", "nan", "inf"])
def test_timings_scale_outside_1_to_10_is_ignored(monkeypatch, raw, caplog):
    monkeypatch.delenv("BP_FAST", raising=False)
    monkeypatch.setenv("BP_TIMINGS_SCALE", raw)
    assert config.Timings.from_env() == config.Timings()
    if raw not in ("", "1"):
        assert "BP_TIMINGS_SCALE" in caplog.text


def test_timings_scale_values():
    assert config.timings_scale({}) == 1.0
    assert config.timings_scale({"BP_TIMINGS_SCALE": " 3 "}) == 3.0
    assert config.timings_scale({"BP_TIMINGS_SCALE": "10"}) == 10.0
