"""The engine's Windows and Raspberry Pi code paths, tested on Linux with `sys.platform`
monkeypatched and fakes for kernel32, the registry and /proc.
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
    monkeypatch.setattr(systems, "_kernel32", lambda: k32)
    assert install.memory_gb() == 16
    assert k32.lengths == [64]             # dwLength = sizeof(MEMORYSTATUSEX), as Windows requires


def test_memory_on_windows_when_the_call_fails(monkeypatch):
    monkeypatch.setattr(sys, "platform", "win32")
    monkeypatch.setattr(systems, "_kernel32", lambda: FakeKernel32(8 * 2**30, ok=False))
    monkeypatch.setattr(os, "sysconf", lambda name: (_ for _ in ()).throw(AttributeError(name)), raising=False)
    assert install.memory_gb() == 0


def test_kernel32_is_none_off_windows():
    assert not hasattr(ctypes, "windll")
    assert systems._kernel32() is None
    assert systems.windows_memory_bytes() == 0


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
    monkeypatch.setattr(systems.platform, "processor", lambda: "Intel64 Family 6 Model 154 Stepping 3, GenuineIntel")
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
    monkeypatch.setattr(systems, "CPUINFO", tmp_path / "cpuinfo")
    monkeypatch.setattr(systems, "DEVICE_TREE_MODEL", tmp_path / "model")
    assert install.chip() == "Raspberry Pi 4 Model B Rev 1.4"


def test_chip_on_a_pi_without_a_device_tree_uses_cpuinfo_model(monkeypatch, tmp_path):
    (tmp_path / "cpuinfo").write_text(PI4_CPUINFO)
    monkeypatch.setattr(sys, "platform", "linux")
    monkeypatch.setattr(systems, "CPUINFO", tmp_path / "cpuinfo")
    monkeypatch.setattr(systems, "DEVICE_TREE_MODEL", tmp_path / "no-such-file")
    assert install.chip() == "Raspberry Pi 4 Model B Rev 1.4"


def test_chip_on_x86_linux_prefers_model_name(monkeypatch, tmp_path):
    (tmp_path / "cpuinfo").write_text("processor\t: 0\nmodel\t\t: 85\nmodel name\t: Intel(R) N100\n")
    (tmp_path / "model").write_bytes(b"Some Board\x00")
    monkeypatch.setattr(sys, "platform", "linux")
    monkeypatch.setattr(systems, "CPUINFO", tmp_path / "cpuinfo")
    monkeypatch.setattr(systems, "DEVICE_TREE_MODEL", tmp_path / "model")
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


# ---------------------------------------------------------------- runner tiers (docs/manual.md "Runner tiers")

def test_a_4_gb_raspberry_pi_4_is_the_simple_runner():
    t = systems.pick_tier(4, 1.0)
    assert t.name == "simple" and t.simple and not t.overridden
    assert t.timings_scale == 2.0
    assert t.summary() == "Simple runner: 4 GB of memory, under the 6 GB the full tier needs"
    assert t.to_json() == {"tier": "simple", "reason": t.reason, "memoryGb": 4, "timingsScale": 2.0, "cpuSpeed": 1.0}


def test_only_memory_makes_a_runner_simple_the_processor_sets_the_waits():
    # An 8 GB Pi 4: the speed estimate isn't measured on a real Pi yet, so it mustn't turn --auto-fix
    # off. It's a full runner with a Pi's waits.
    t = systems.pick_tier(8, 1.1)
    assert t.name == "full" and t.timings_scale == 2.0
    assert t.reason == "8 GB of memory and a processor 1.1× as fast as a Raspberry Pi 4"
    assert systems.pick_tier(8, 0.4).timings_scale == 3.0
    assert systems.pick_tier(8, 0.4).name == "full"


def test_a_fast_machine_with_little_memory_is_simple_with_a_shorter_scale():
    t = systems.pick_tier(4, 5.0)
    assert t.name == "simple" and t.timings_scale == 1.5
    assert t.reason == "4 GB of memory, under the 6 GB the full tier needs"


def test_slower_than_a_pi_4_waits_longer_still():
    assert systems.pick_tier(2, 0.4).timings_scale == 3.0


@pytest.mark.parametrize("memory,speed", [(6, 1.6), (8, 2.4), (16, 4.0), (7, 9.9)])
def test_6_gb_and_a_fast_processor_is_the_full_tier_with_waits_as_set(memory, speed):
    t = systems.pick_tier(memory, speed)
    assert t.name == "full" and not t.simple and t.timings_scale == 1.0
    assert t.summary().startswith(f"Full runner: {memory:g} GB of memory and a processor")


def test_unknown_values_never_make_a_machine_simple_on_their_own():
    assert systems.pick_tier(0, 3.0).name == "full"                # memory couldn't be read
    assert systems.pick_tier(0, 0.5).name == "full"                # nor with a slow processor
    assert systems.pick_tier(16, None).name == "full"              # processor not measured
    t = systems.pick_tier(0, None)
    assert t.name == "full" and t.reason == "this machine's memory and processor couldn't be measured"
    assert t.timings_scale == 1.0
    assert systems.pick_tier(4, None).timings_scale == 2.0         # simple, speed unknown: a Pi's scale


def test_the_tier_can_be_set():
    t = systems.pick_tier(16, 5.0, "simple")
    assert t.name == "simple" and t.overridden and t.reason == "set by BREAKPATCH_TIER=simple"
    assert t.timings_scale == 1.5
    assert systems.pick_tier(4, 1.0, "full").name == "full"
    assert systems.pick_tier(4, 1.0, "full").timings_scale == 2.0   # the speed still sets the waits
    assert systems.pick_tier(4, 3.0, "full").timings_scale == 1.0


@pytest.mark.parametrize("raw,want,warned", [("", None, False), (None, None, False), ("simple", "simple", False),
                                             (" FULL ", "full", False), ("fast", None, True)])
def test_tier_override_values(raw, want, warned):
    got, problem = systems.tier_override(raw)
    assert got == want and bool(problem) == warned
    if warned:
        assert problem == "BREAKPATCH_TIER='fast' ignored: it's simple or full"


def test_runner_tier_measures_memory_and_the_processor():
    calls = []
    t, warnings = systems.runner_tier({}, memory=lambda: 4, benchmark=lambda: calls.append(1) or 0.97)
    assert (t.name, t.memory_gb, t.cpu_speed, warnings, calls) == ("simple", 4.0, 1.0, [], [1])
    t, _ = systems.runner_tier({}, memory=lambda: 8, benchmark=lambda: 0.97)
    assert (t.name, t.timings_scale) == ("full", 2.0)


def test_runner_tier_flag_wins_over_the_variable_and_bad_values_are_said():
    t, warnings = systems.runner_tier({"BREAKPATCH_TIER": "simple"}, override="full", memory=lambda: 4, benchmark=lambda: 1.0)
    assert t.name == "full" and t.reason == "set by --tier full" and t.overridden and warnings == []
    t, warnings = systems.runner_tier({"BREAKPATCH_TIER": "huge"}, memory=lambda: 16, benchmark=lambda: 4.0)
    assert t.name == "full" and not t.overridden and warnings == ["BREAKPATCH_TIER='huge' ignored: it's simple or full"]
    t, warnings = systems.runner_tier({}, override="tiny", memory=lambda: 16, benchmark=lambda: 4.0)
    assert warnings == ["--tier='tiny' ignored: it's simple or full"]


def test_runner_tier_skips_the_benchmark_when_nothing_would_use_it():
    def no(): raise AssertionError("measured")
    t, _ = systems.runner_tier({"BREAKPATCH_TIER": "simple", "BP_TIMINGS_SCALE": "3"}, memory=lambda: 4, benchmark=no)
    assert t.name == "simple" and t.cpu_speed is None
    # An invalid scale is ignored by config.timings_scale, so the tier's default is needed.
    t, _ = systems.runner_tier({"BREAKPATCH_TIER": "simple", "BP_TIMINGS_SCALE": "99"}, memory=lambda: 4, benchmark=lambda: 1.0)
    assert t.cpu_speed == 1.0


def test_a_failing_benchmark_doesnt_stop_a_run():
    def boom(): raise OSError("no")
    t, _ = systems.runner_tier({}, memory=lambda: 16, benchmark=boom)
    assert t.name == "full" and t.cpu_speed is None


def test_cpu_benchmark_keeps_the_best_window_in_pi_4_units():
    now = [0.0]
    # Three windows of 0.5 s: 2 rounds (4/s), 4 rounds (8/s), 1 round (2/s). Binary fractions, so exact.
    durations = iter([0.25, 0.25, 0.125, 0.125, 0.125, 0.125, 0.5])

    def work(_data):
        now[0] += next(durations)
    speed = systems.cpu_benchmark(window=0.5, windows=3, clock=lambda: now[0], work=work)
    assert speed == 8 / systems.PI4_ROUNDS_PER_SECOND


def test_cpu_benchmark_is_quick():
    # About 0.4 s of work; a loaded CI runner can stretch that, so the bound is loose. What matters
    # is that it stops by its windows, not by the amount of work.
    import time
    start = time.perf_counter()
    assert systems.cpu_benchmark() > 0
    assert time.perf_counter() - start < 5.0
    calls = []
    systems.cpu_benchmark(window=0.01, windows=2, work=lambda _d: calls.append(1))
    assert calls


# ---------------------------------------------------------------- the memory a cgroup allows

def _cgroups(tmp_path, proc: str, files: dict[str, str]):
    root = tmp_path / "cgroup"
    for rel, text in files.items():
        (root / rel).parent.mkdir(parents=True, exist_ok=True)
        (root / rel).write_text(text)
    (tmp_path / "self-cgroup").write_text(proc)
    return root, tmp_path / "self-cgroup"


def test_cgroup_v2_limit_is_the_smallest_on_the_way_up(tmp_path):
    root, proc = _cgroups(tmp_path, "0::/system.slice/breakpatch-suite@smoke.service\n", {
        "memory.max": "max\n", "system.slice/memory.max": str(6 * 2**30),
        "system.slice/breakpatch-suite@smoke.service/memory.max": str(3 * 2**30)})
    assert systems.cgroup_memory_bytes(root, proc) == 3 * 2**30
    root, proc = _cgroups(tmp_path / "b", "0::/\n", {"memory.max": "max\n"})
    assert systems.cgroup_memory_bytes(root, proc) == 0


def test_cgroup_v1_limit_and_its_no_limit_value(tmp_path):
    root, proc = _cgroups(tmp_path, "4:memory:/docker/abc\n0::/\n", {
        "memory/memory.limit_in_bytes": "9223372036854771712", "memory/docker/abc/memory.limit_in_bytes": str(2 * 2**30)})
    assert systems.cgroup_memory_bytes(root, proc) == 2 * 2**30
    root, proc = _cgroups(tmp_path / "b", "4:cpu,memory:/\n", {"memory/memory.limit_in_bytes": "9223372036854771712"})
    assert systems.cgroup_memory_bytes(root, proc) == 0
    # No /proc/self/cgroup: the root's files.
    root, _ = _cgroups(tmp_path / "c", "", {"memory.max": str(5 * 2**30)})
    assert systems.cgroup_memory_bytes(root, tmp_path / "nothing") == 5 * 2**30


def test_memory_on_linux_is_the_smaller_of_the_machine_and_its_cgroup(tmp_path, monkeypatch):
    root, proc = _cgroups(tmp_path, "0::/\n", {"memory.max": str(4 * 2**30)})
    monkeypatch.setattr(sys, "platform", "linux")
    monkeypatch.setattr(systems, "CGROUP_ROOT", root)
    monkeypatch.setattr(systems, "PROC_SELF_CGROUP", proc)
    monkeypatch.setattr(os, "sysconf", lambda name: {"SC_PAGE_SIZE": 4096, "SC_PHYS_PAGES": 16 * 2**30 // 4096}[name], raising=False)
    assert systems.memory_gb() == 4
    (root / "memory.max").write_text("max\n")
    assert systems.memory_gb() == 16
    (root / "memory.max").write_text(str(64 * 2**30))
    assert systems.memory_gb() == 16
