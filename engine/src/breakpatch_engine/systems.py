"""Where a test was recorded, and whether this run is on the same kind of system.

Screen checks compare how an area looks now with how it looked when the step was recorded. The
same page draws its text a little differently on another operating system (other fonts, other
antialiasing) or in another Chromium, so a test recorded on a Mac can fail its checks on Linux
although nothing changed. The app saves `recordedOn` with each recording (engine/PROTOCOL.md
"Where a test was recorded"); a run compares it with `current()`:

- a different OS family (macOS, Linux, Windows), or
- a different Chromium major version

is a mismatch. With "Allow for small differences between systems" on (the default), the run's
screen checks are then relaxed (imaging.region_distance) and the result explains the mismatch.
Tests without `recordedOn` (recorded before it existed) never mismatch.
"""
from __future__ import annotations

import hashlib
import os
import platform
import subprocess
import sys
import time
import zlib
from dataclasses import dataclass
from pathlib import Path

OS_NAMES = {"darwin": "macOS", "linux": "Linux", "win32": "Windows", "cygwin": "Windows"}
ARCHES = {"aarch64": "arm64", "arm64": "arm64", "amd64": "x86_64", "x86_64": "x86_64", "x64": "x86_64"}
FIELDS = ("os", "osVersion", "arch", "chromium")
MAX_LEN = 40


def os_family() -> str:
    for prefix, name in OS_NAMES.items():
        if sys.platform.startswith(prefix):
            return name
    return platform.system() or "Unknown"


WINDOWS_11_BUILD = 22000


def windows_release() -> tuple[str, int]:
    """("11", 22631) or ("10", 19045). Python 3.11's platform.release() says "10" on Windows 11
    too (both are version 10.0), so the build number decides: 22000 and later is Windows 11."""
    build = 0
    get = getattr(sys, "getwindowsversion", None)
    if get is not None:
        try:
            build = int(get().build)
        except Exception:  # noqa: BLE001
            build = 0
    if not build:
        parts = platform.version().split(".")
        if len(parts) >= 3 and parts[2].isdigit():
            build = int(parts[2])
    release = platform.release() or ""
    if release == "10" and build >= WINDOWS_11_BUILD:
        release = "11"
    return release, build


def os_version() -> str:
    """macOS 15.3 → "15.3"; Linux → the distribution's VERSION_ID ("24.04"), else the kernel;
    Windows → "11" or "10"."""
    if sys.platform == "darwin":
        return platform.mac_ver()[0] or ""
    if sys.platform == "win32":
        return windows_release()[0]
    if sys.platform.startswith("linux"):
        try:
            for line in Path("/etc/os-release").read_text().splitlines():
                if line.startswith("VERSION_ID="):
                    return line.split("=", 1)[1].strip().strip('"')
        except OSError:
            pass
    return platform.release()


def arch() -> str:
    m = platform.machine().lower()
    return ARCHES.get(m, m)


def pinned_chromium() -> str:
    """The Chromium version this engine's Playwright uses ("140.0.7339.16"), or ""."""
    from .install import pinned_browser
    return str(pinned_browser().get("version") or "")


def current(chromium: str | None = None) -> dict:
    """This system, in the shape of a test's `recordedOn`. `chromium` is the running browser's
    version when there is one (BrowserSession.chromium_version), else the pinned one."""
    return {"os": os_family(), "osVersion": os_version(), "arch": arch(),
            "chromium": clean_version(chromium) or pinned_chromium()}


def clean_version(v) -> str:
    """"Chromium 140.0.7339.16" or "HeadlessChrome/140.0…" → "140.0.7339.16"."""
    s = str(v or "").strip()
    for sep in ("/", " "):
        if sep in s:
            s = s.rsplit(sep, 1)[1]
    return s[:MAX_LEN]


def parse(raw) -> dict | None:
    """A test file's `recordedOn`, keeping only the known fields as short strings. None when it's
    missing or unreadable (an older test): such a test never mismatches."""
    if not isinstance(raw, dict):
        return None
    out = {k: str(raw[k])[:MAX_LEN] for k in FIELDS if isinstance(raw.get(k), (str, int, float)) and str(raw[k]).strip()}
    return out if out.get("os") else None


def major(version: str | None) -> str:
    return str(version or "").split(".", 1)[0].strip()


def differences(recorded: dict | None, ran: dict) -> list[str]:
    """What differs in a way that changes how pages look: "os" and/or "chromium"."""
    if not recorded:
        return []
    out = []
    if recorded.get("os", "").lower() != ran.get("os", "").lower():
        out.append("os")
    a, b = major(recorded.get("chromium")), major(ran.get("chromium"))
    if a and b and a != b:
        out.append("chromium")
    return out


def describe(s: dict) -> str:
    """"macOS 15" (the major version only), or "Linux"."""
    name = s.get("os") or "another system"
    if name == "macOS" and major(s.get("osVersion")):
        return f"macOS {major(s.get('osVersion'))}"
    return name


def run_it_on(s: dict) -> str:
    return "a Mac" if s.get("os") == "macOS" else (s.get("os") or "the system it was recorded on")


def explain(recorded: dict, ran: dict, diff: list[str]) -> str:
    """The plain explanation shown with a failed check on a mismatched system."""
    if "os" in diff:
        return (f"This test was recorded on {describe(recorded)} and ran on {describe(ran)}. Text can look slightly "
                "different on another system, which can fail screen checks. Re-record it on this system, or run it "
                f"on {run_it_on(recorded)}.")
    return (f"This test was recorded with Chromium {major(recorded.get('chromium'))} and ran with Chromium "
            f"{major(ran.get('chromium'))}. Pages can look slightly different in another version of the browser, "
            "which can fail screen checks. Re-record it on this system, or run it with the Breakpatch version it "
            "was recorded with.")


def mismatch(recorded_raw, ran: dict, relaxed: bool) -> dict | None:
    """`systemMismatch` for run.ended, or None when the systems match (or the test predates
    `recordedOn`). `relaxed` says whether the screen checks allowed for small differences."""
    recorded = parse(recorded_raw)
    diff = differences(recorded, ran)
    if not diff:
        return None
    return {"recordedOn": recorded, "ranOn": ran, "differences": diff, "relaxed": relaxed,
            "message": explain(recorded, ran, diff)}


# ---------------------------------------------------------------- this machine, in words
# (install.system_info and the app's setup screen). All OS detection is in this module.

CPUINFO = Path("/proc/cpuinfo")
DEVICE_TREE_MODEL = Path("/proc/device-tree/model")     # a Raspberry Pi says what it is here
WINDOWS_CPU_KEY = r"HARDWARE\DESCRIPTION\System\CentralProcessor\0"


def memory_gb() -> float:
    """The memory this process can have, in GB: the machine's, or on Linux its cgroup's limit when
    that's smaller (a container, a systemd unit with MemoryMax=)."""
    try:
        total = os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES")
    except (ValueError, OSError, AttributeError):    # Windows has no sysconf
        total = 0
    if sys.platform == "darwin":
        try:
            total = int(subprocess.run(["sysctl", "-n", "hw.memsize"], capture_output=True, text=True, timeout=5).stdout)
        except Exception:  # noqa: BLE001
            pass
    elif sys.platform == "win32":
        total = windows_memory_bytes() or total
    elif sys.platform.startswith("linux"):
        limit = cgroup_memory_bytes()
        if limit and (not total or limit < total):
            total = limit
    return round(total / 2**30)


CGROUP_ROOT = Path("/sys/fs/cgroup")
PROC_SELF_CGROUP = Path("/proc/self/cgroup")
# cgroup v1 writes "no limit" as the largest multiple of the page size that fits in 63 bits.
_NO_CGROUP_LIMIT = 2**62


def _cgroup_limit(path: Path) -> int:
    """A memory.max or memory.limit_in_bytes value, or 0 for none ("max", unreadable, or v1's no limit)."""
    try:
        v = path.read_text().strip()
    except OSError:
        return 0
    return int(v) if v.isdigit() and 0 < int(v) < _NO_CGROUP_LIMIT else 0


def cgroup_memory_bytes(root: Path | None = None, proc: Path | None = None) -> int:
    """The smallest memory limit on this process's cgroup and the ones above it (cgroup v2
    memory.max, v1 memory/memory.limit_in_bytes), or 0 when there's none."""
    root = CGROUP_ROOT if root is None else root
    proc = PROC_SELF_CGROUP if proc is None else proc
    places: list[Path] = []
    try:
        lines = proc.read_text().splitlines()
    except OSError:
        lines = []
    for line in lines:
        _, controllers, rel = (line.split(":", 2) + ["", ""])[:3]
        rel = rel.strip().lstrip("/")
        if controllers == "":                                      # v2: "0::/system.slice/…"
            places.append(root / rel / "memory.max" if rel else root / "memory.max")
        elif "memory" in controllers.split(","):                   # v1: "4:memory:/docker/…"
            places.append(root / "memory" / rel / "memory.limit_in_bytes" if rel else root / "memory" / "memory.limit_in_bytes")
    if not places:
        places = [root / "memory.max", root / "memory" / "memory.limit_in_bytes"]
    limits = []
    for f in places:
        # The limit on this cgroup and every one above it, up to the root.
        d = f.parent
        while True:
            limits.append(_cgroup_limit(d / f.name))
            if d == root or d == root / "memory" or root not in d.parents:
                break
            d = d.parent
    found = [n for n in limits if n]
    return min(found) if found else 0


def _kernel32():
    """kernel32 through ctypes, or None off Windows (tests put a fake one here)."""
    import ctypes
    windll = getattr(ctypes, "windll", None)
    return windll.kernel32 if windll is not None else None


def windows_memory_bytes() -> int:
    """Physical memory from GlobalMemoryStatusEx, or 0."""
    import ctypes

    class MEMORYSTATUSEX(ctypes.Structure):
        _fields_ = [("dwLength", ctypes.c_uint32), ("dwMemoryLoad", ctypes.c_uint32),
                    ("ullTotalPhys", ctypes.c_uint64), ("ullAvailPhys", ctypes.c_uint64),
                    ("ullTotalPageFile", ctypes.c_uint64), ("ullAvailPageFile", ctypes.c_uint64),
                    ("ullTotalVirtual", ctypes.c_uint64), ("ullAvailVirtual", ctypes.c_uint64),
                    ("ullAvailExtendedVirtual", ctypes.c_uint64)]

    try:
        k32 = _kernel32()
        if k32 is None:
            return 0
        stat = MEMORYSTATUSEX()
        stat.dwLength = ctypes.sizeof(MEMORYSTATUSEX)
        if not k32.GlobalMemoryStatusEx(ctypes.byref(stat)):
            return 0
        return int(stat.ullTotalPhys)
    except Exception:  # noqa: BLE001
        return 0


def windows_cpu_name() -> str:
    """The processor's name from the registry (ProcessorNameString), or ""."""
    try:
        import winreg  # type: ignore[import-not-found]  # Windows only
    except ImportError:
        return ""
    try:
        with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, WINDOWS_CPU_KEY) as key:
            value, _ = winreg.QueryValueEx(key, "ProcessorNameString")
        return " ".join(str(value).split())
    except OSError:
        return ""


def linux_cpu_name() -> str:
    """/proc/cpuinfo's "model name" (x86, most arm64); else the board's name (a Raspberry Pi has
    no "model name": /proc/device-tree/model says "Raspberry Pi 4 Model B Rev 1.4"), else cpuinfo's
    "Model" line, which the Pi kernel writes too."""
    model = ""
    try:
        for line in CPUINFO.read_text(errors="replace").splitlines():
            key, _, value = line.partition(":")
            key = key.strip().lower()
            if key == "model name" and value.strip():
                return value.strip()
            if key == "model" and value.strip() and not value.strip().isdigit():
                model = model or value.strip()
    except OSError:
        pass
    try:
        board = DEVICE_TREE_MODEL.read_bytes().rstrip(b"\0").decode(errors="replace").strip()
        if board:
            return board
    except OSError:
        pass
    return model


def chip() -> str:
    if sys.platform == "darwin":
        try:
            out = subprocess.run(["sysctl", "-n", "machdep.cpu.brand_string"], capture_output=True, text=True, timeout=5)
            if out.stdout.strip():
                return out.stdout.strip()
        except Exception:  # noqa: BLE001
            pass
    elif sys.platform == "win32":
        name = windows_cpu_name()
        if name:
            return name
    else:
        name = linux_cpu_name()
        if name:
            return name
    return platform.processor() or platform.machine()


def os_name() -> str:
    if sys.platform == "darwin":
        return f"macOS {platform.mac_ver()[0]}".strip()
    if sys.platform == "win32":
        release, build = windows_release()
        return f"Windows {release} (build {build})" if build else f"Windows {release}"
    return f"{platform.system()} {platform.release()}"


# ---------------------------------------------------------------- runner tiers
# (docs/manual.md "Runner tiers"). When breakpatch-ci starts a run it measures this machine's memory
# (its cgroup's limit, when smaller) and processor and picks a tier:
#
# - simple: under 6 GB of memory. Replay, screen checks and schedules only: no AI assistant, so no
#   fixing.
# - full: 6 GB or more. Everything breakpatch-ci does, as before tiers existed.
#
# The processor's speed only sets how long the waits are by default (default_timings_scale): until
# PI4_ROUNDS_PER_SECOND is measured on a real Pi 4, an estimate mustn't turn off a licensed
# --auto-fix. `pick_tier` is pure (tests give it made-up numbers); `runner_tier` measures and calls
# it. BREAKPATCH_TIER=simple|full (or breakpatch-ci's --tier) sets the tier, for testing.

TIER_SIMPLE, TIER_FULL = "simple", "full"
TIERS = (TIER_SIMPLE, TIER_FULL)
TIER_VAR = "BREAKPATCH_TIER"
FULL_MIN_MEMORY_GB = 6
# cpu_benchmark's speed, where 1 is a Raspberry Pi 4 (4 × Cortex-A72 at 1.8 GHz). The estimates: a
# Pi 5 is 2–3, an Intel N100 mini PC 3–4, an Apple Silicon Mac more. Under 1.6 (between the Pi 4 and
# the Pi 5, away from both) a processor is slow: its waits are longer.
SLOW_CPU_SPEED = 1.6
# Below this a machine is slower than a Pi 4 (a Pi 3, or a Pi 4 that's throttling when hot).
VERY_SLOW_CPU_SPEED = 0.6
# The timing scale (config.timings_scale) used when BP_TIMINGS_SCALE isn't set. The manual said 2
# for a Pi 4 with normal pages and 3 for Flutter before tiers existed: a Pi 4's speed gets 2,
# anything slower 3, whatever the tier; a fast processor with little memory 1.5 (Chromium has less
# room, so pages can be slower to settle), and a simple runner whose speed is unknown a Pi's 2. Only
# the longest waits grow (config.SCALED_TIMINGS), so a page that's ready on time costs nothing extra.
# A fast machine with the memory keeps 1: nothing changes there.
SCALE_VERY_SLOW, SCALE_SLOW, SCALE_LITTLE_MEMORY = 3.0, 2.0, 1.5

# The benchmark's work rate on a Pi 4, in rounds per second. Estimated, not measured yet: a 2.1 GHz
# Xeon cloud core did 300–340 while busy (so somewhat more when quiet), and single-core benchmarks
# put the Cortex-A72 at 4–5 times slower, with CPython on it slower still: about a fifth of ~470.
# Replace with what a Pi 4 does (`cpuSpeed` in breakpatch-ci's JSON × this) once measured.
PI4_ROUNDS_PER_SECOND = 95.0


@dataclass(frozen=True)
class Tier:
    """The tier a run uses, and why, in words for the log and the report."""
    name: str                      # "simple" or "full"
    reason: str                    # "4 GB of memory, under the 6 GB the full tier needs"
    memory_gb: float               # 0 when it couldn't be read
    cpu_speed: float | None        # 1 = a Raspberry Pi 4; None when not measured
    timings_scale: float           # the scale to use when BP_TIMINGS_SCALE isn't set
    overridden: bool = False       # set by BREAKPATCH_TIER or --tier

    @property
    def simple(self) -> bool:
        return self.name == TIER_SIMPLE

    @property
    def title(self) -> str:
        return "Simple runner" if self.simple else "Full runner"

    def summary(self) -> str:
        """One line: "Simple runner: 4 GB of memory, under the 6 GB the full tier needs"."""
        return f"{self.title}: {self.reason}"

    def to_json(self) -> dict:
        out = {"tier": self.name, "reason": self.reason, "memoryGb": self.memory_gb,
               "timingsScale": self.timings_scale}
        if self.cpu_speed is not None:
            out["cpuSpeed"] = self.cpu_speed
        if self.overridden:
            out["overridden"] = True
        return out


def _gb(memory: float) -> str:
    return f"{memory:g} GB of memory"


def _speed_words(speed: float) -> str:
    return f"a processor {speed:.1f}× as fast as a Raspberry Pi 4"


def default_timings_scale(tier: str, cpu_speed: float | None) -> float:
    """The waits' scale for a tier and processor speed (None = unknown): the speed decides it, on
    either tier."""
    if cpu_speed is not None and cpu_speed < VERY_SLOW_CPU_SPEED:
        return SCALE_VERY_SLOW
    if cpu_speed is not None and cpu_speed < SLOW_CPU_SPEED:
        return SCALE_SLOW
    if tier == TIER_FULL:
        return 1.0
    return SCALE_SLOW if cpu_speed is None else SCALE_LITTLE_MEMORY


def pick_tier(memory_gb: float, cpu_speed: float | None, override: str | None = None) -> Tier:
    """The tier for this much memory (GB, 0 = unknown) and this processor speed (1 = a Pi 4,
    None = unknown). `override` ("simple" or "full") wins. Only memory makes a machine simple; the
    speed sets the waits. Memory that can't be read never makes a machine simple."""
    speed = None if cpu_speed is None else round(cpu_speed, 1)
    if override in TIERS:
        return Tier(override, f"set by {TIER_VAR}={override}", memory_gb, speed,
                    default_timings_scale(override, speed), overridden=True)
    if 0 < memory_gb < FULL_MIN_MEMORY_GB:
        reason = f"{_gb(memory_gb)}, under the {FULL_MIN_MEMORY_GB} GB the full tier needs"
        return Tier(TIER_SIMPLE, reason, memory_gb, speed, default_timings_scale(TIER_SIMPLE, speed))
    have = [s for s in ((_gb(memory_gb) if memory_gb > 0 else ""), (_speed_words(speed) if speed is not None else "")) if s]
    reason = " and ".join(have) if have else "this machine's memory and processor couldn't be measured"
    return Tier(TIER_FULL, reason, memory_gb, speed, default_timings_scale(TIER_FULL, speed))


def tier_override(value: str | None) -> tuple[str | None, str | None]:
    """BREAKPATCH_TIER's (or --tier's) value: (the tier, None), (None, None) when it's not set, or
    (None, a sentence saying it's ignored) when it isn't simple or full."""
    v = (value or "").strip().lower()
    if not v:
        return None, None
    if v in TIERS:
        return v, None
    return None, f"{TIER_VAR}={value.strip()!r} ignored: it's simple or full"


def _bench_round(data: bytes) -> None:
    """One round of work like a run's: compressing (PNG screenshots are zlib) and plain Python."""
    zlib.compress(data, 6)
    s = 0
    for i in range(3000):
        s += (i * i) % 7
    hashlib.blake2b(data[:4096]).digest()


def _bench_data() -> bytes:
    """64 KB that compress like a screenshot's rows: mostly smooth, with a little noise."""
    out = bytearray(65536)
    seed = 12345
    for i in range(len(out)):
        seed = (seed * 1103515245 + 12345) & 0x7FFFFFFF
        out[i] = ((i % 1024) // 8 + (seed >> 16) % 6) & 0xFF
    return bytes(out)


def cpu_benchmark(window: float = 0.12, windows: int = 3, clock=time.perf_counter, work=_bench_round) -> float:
    """This processor's speed, where 1 is a Raspberry Pi 4 (PI4_ROUNDS_PER_SECOND). Counts rounds
    of `work` in `windows` short windows and keeps the best, so a busy moment or a processor still
    waking up doesn't count against it. Takes about window × windows seconds (0.4 s), under 1 s
    even on a slow machine, since a round takes a few milliseconds there."""
    data = _bench_data()
    best = 0.0
    for _ in range(windows):
        start = clock()
        rounds = 0
        while True:
            work(data)
            rounds += 1
            took = clock() - start
            if took >= window:
                break
        best = max(best, rounds / took if took > 0 else 0.0)
    return best / PI4_ROUNDS_PER_SECOND


def timings_scale_set(env) -> bool:
    """Whether BP_TIMINGS_SCALE holds a scale config.timings_scale takes (1 to 10). When it does,
    it wins over the tier's default."""
    from .config import MAX_TIMINGS_SCALE
    try:
        return 1.0 <= float((env.get("BP_TIMINGS_SCALE") or "").strip()) <= MAX_TIMINGS_SCALE
    except ValueError:
        return False


def runner_tier(env=None, override: str | None = None, memory=None, benchmark=None) -> tuple[Tier, list[str]]:
    """Measures this machine and picks its tier. `override` (breakpatch-ci's --tier) wins over
    BREAKPATCH_TIER. Returns the tier and any warnings (a value that isn't a tier). The processor
    isn't measured when the tier is set and BP_TIMINGS_SCALE is too: nothing would use the number."""
    env = os.environ if env is None else env
    warnings = []
    chosen, problem = tier_override(override)
    if problem:
        warnings.append(problem.replace(TIER_VAR, "--tier", 1))
    if chosen is None:
        chosen, problem = tier_override(env.get(TIER_VAR))
        if problem:
            warnings.append(problem)
    mem = float((memory or memory_gb)() or 0)
    speed = None
    if chosen is None or not timings_scale_set(env):
        try:
            speed = float((benchmark or cpu_benchmark)())
        except Exception:  # noqa: BLE001 - never stop a run over the measurement
            speed = None
    tier = pick_tier(mem, speed, chosen)
    if chosen and override and override.strip().lower() == chosen:
        tier = Tier(tier.name, f"set by --tier {chosen}", tier.memory_gb, tier.cpu_speed, tier.timings_scale, True)
    return tier, warnings
