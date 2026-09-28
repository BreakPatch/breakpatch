#!/usr/bin/env python3
"""Writes breakpatch-ci's requirements file for one platform (scripts/build-ci.sh runs it):

    python scripts/ci-requirements.py --lock engine/locks/linux-x86_64.dev.txt \\
        --wheel dist/breakpatch_engine-….whl --wheel dist/breakpatch_team_engine-….whl \\
        --out dist/breakpatch-ci-requirements-linux-x86_64.txt

The install command (https://breakpatch.dev/install-ci) installs from it with
`pip install --require-hashes --only-binary=:all:`. It holds:

- every package the open engine needs to run (its dependencies, and theirs; on macOS with the
  `mlx` extra, the AI assistant's, so `--auto-fix` works on a self-hosted Mac where the app's
  AI assistant is downloaded) for this platform, pinned and hashed exactly as in the engine's
  lock (security review S3), and
- the two wheels by file name (`./name.whl`, next to the file once downloaded) with their SHA-256.

Run it with the build venv's Python: the engine's dependencies are read from what's installed
there, which the lock installed. A dependency missing from the lock fails the build.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.metadata as md
import re
from pathlib import Path

try:
    from packaging.markers import default_environment
    from packaging.requirements import Requirement
except ImportError:                     # pip always carries a copy
    from pip._vendor.packaging.markers import default_environment
    from pip._vendor.packaging.requirements import Requirement

ENGINE = "breakpatch-engine"
TEAM = "breakpatch-team-engine"


def norm(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


def runtime_closure(root: str = ENGINE, extras: tuple[str, ...] = ()) -> list[str]:
    """The distributions `root` (with `extras`) needs to run, in this environment. Only the root's
    extras count: its dependencies' own extras aren't asked for."""
    env = default_environment()
    seen: set[str] = set()
    todo = [(root, ("",) + tuple(extras))]
    while todo:
        raw_name, wanted = todo.pop()
        name = norm(raw_name)
        if name in seen:
            continue
        seen.add(name)
        try:
            reqs = md.requires(name) or []
        except md.PackageNotFoundError:
            raise SystemExit(f"ci-requirements: {name} isn't installed in this Python; install the engine from its lock first")
        for raw in reqs:
            r = Requirement(raw)
            if r.marker is not None and not any(r.marker.evaluate({**env, "extra": e}) for e in wanted):
                continue
            todo.append((r.name, ("",) + tuple(r.extras)))
    seen.discard(norm(root))
    return sorted(seen)


def lock_entries(lock: Path) -> dict[str, str]:
    """name → its pinned block (`name==version \\` and its --hash lines) from a uv/pip-compile lock."""
    out: dict[str, str] = {}
    name, block = None, []
    for line in lock.read_text().splitlines():
        m = re.match(r"^([A-Za-z0-9][A-Za-z0-9._-]*)==\S+", line)
        if m:
            if name:
                out[name] = "\n".join(block)
            name, block = norm(m[1]), [line.rstrip()]
        elif name and line.strip().startswith("--hash="):
            block.append(line.rstrip())
        elif name and not line.strip().startswith("--hash="):
            out[name] = "\n".join(block)
            name, block = None, []
    if name:
        out[name] = "\n".join(block)
    return {k: v.rstrip(" \\") for k, v in out.items()}


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def wheel_name(path: Path) -> str:
    return norm(path.name.split("-", 1)[0])


def build(lock: Path, wheels: list[Path], platform: str, extras: tuple[str, ...] = ()) -> str:
    names = {wheel_name(w) for w in wheels}
    if names != {ENGINE, TEAM}:
        raise SystemExit(f"ci-requirements: needs the {ENGINE} and {TEAM} wheels, got {sorted(names)}")
    pinned = lock_entries(lock)
    need = runtime_closure(ENGINE, extras)
    missing = [n for n in need if n not in pinned]
    if missing:
        raise SystemExit(f"ci-requirements: {lock.name} has no pinned hashes for {', '.join(missing)}. Run scripts/lock-python.sh")
    lines = [
        f"# breakpatch-ci on {platform}: written by scripts/ci-requirements.py for the release.",
        "# Installed by https://breakpatch.dev/install-ci with:",
        "#   pip install --require-hashes --only-binary=:all: -r THIS_FILE   (from the folder holding the wheels)",
        f"# The open engine's dependencies, pinned and hashed as in engine/locks/{lock.name}:",
    ]
    lines += [pinned[n] for n in need]
    lines.append("# The engine and the Team engine of this release:")
    for w in sorted(wheels, key=lambda p: p.name):
        lines.append(f"./{w.name} --hash=sha256:{sha256(w)}")
    return "\n".join(lines) + "\n"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--lock", type=Path, required=True)
    ap.add_argument("--wheel", type=Path, action="append", required=True)
    ap.add_argument("--platform", required=True, help="macos-arm64 or linux-x86_64")
    ap.add_argument("--extra", action="append", default=[], help="the engine's extras to include (macOS: mlx)")
    ap.add_argument("--out", type=Path, required=True)
    a = ap.parse_args()
    a.out.write_text(build(a.lock, a.wheel, a.platform, tuple(a.extra)))
    print(f"ci-requirements: wrote {a.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
