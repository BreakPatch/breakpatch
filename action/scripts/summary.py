"""The Breakpatch GitHub Action's summary (action.yml): reads run.sh's results, writes one JSON
file with every test's result, a table to the job summary and the step's outputs.

    python summary.py DIR        (DIR is BP_DIR; GITHUB_STEP_SUMMARY and GITHUB_OUTPUT from the runner)

Outputs: result (passed, failed or error), passed, failed, fixed, json (the file's path).
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path


def cell(text) -> str:
    """Text for a Markdown table cell: one line, no pipes, not too long."""
    s = " ".join(str(text or "").split()).replace("|", "\\|")
    return s if len(s) <= 200 else s[:197] + "…"


def labels(test_file: str) -> dict[str, str]:
    """Step id → label, from the test file (a suite's tests aren't files here)."""
    out: dict[str, str] = {}

    def walk(steps):
        for s in steps or []:
            if isinstance(s, dict):
                out.setdefault(str(s.get("id")), str(s.get("label") or s.get("id")))
                walk(s.get("steps"))
    try:
        walk(json.loads(Path(test_file).read_text()).get("steps"))
    except (OSError, ValueError, AttributeError):
        pass
    return out


def file_row(test: str, code: int, data: dict) -> dict:
    """One test file's run (run.ended, or an error)."""
    row = {"test": data.get("name") or Path(test).stem, "file": test, "exitCode": code}
    if code in (0, 1) and "steps" in data:
        healed = any(r.get("result") == "healed" for r in data["steps"])
        row["result"] = "failed" if data.get("result") != "pass" else "fixed" if healed else "passed"
        if row["result"] == "failed":
            names = labels(test)
            failed = [r for r in data["steps"] if r.get("result") == "failed" and r.get("reason") != "stopped"]
            if failed:
                row["failedStep"] = names.get(str(failed[-1].get("stepId")), str(failed[-1].get("stepId")))
            row["why"] = data.get("message") or (failed[-1].get("reason") if failed else "")
    else:
        row["result"] = "error"
        row["why"] = data.get("message") or f"breakpatch-ci ended with exit code {code}"
    return row


def suite_rows(code: int, data: dict) -> list[dict]:
    if code not in (0, 1) or "tests" not in data:
        return [{"test": "suite", "result": "error", "exitCode": code,
                 "why": data.get("message") or f"breakpatch-ci ended with exit code {code}"}]
    rows = []
    for t in data["tests"]:
        row = {"test": t.get("name"), "result": t.get("result") or "notRun", "exitCode": code}
        if t.get("failedStep"):
            row["failedStep"] = t["failedStep"].get("label")
            row["why"] = t["failedStep"].get("reason")
        if t.get("note"):
            row["why"] = t["note"]
        rows.append(row)
    return rows


def main(folder: str) -> int:
    results = Path(folder) / "results"
    rows: list[dict] = []
    runs = sorted((p for p in results.glob("*.code")), key=lambda p: int(p.stem))
    for p in runs:
        n = p.stem
        code = int(p.read_text().strip() or 2)
        test = (results / f"{n}.test").read_text().strip()
        try:
            data = json.loads((results / f"{n}.json").read_text() or "{}")
        except ValueError:
            data = {}
        if not isinstance(data, dict):
            data = {}
        rows.extend(suite_rows(code, data) if test.startswith("suite ") else [file_row(test, code, data)])
    count = {k: sum(r["result"] == k for r in rows) for k in ("passed", "fixed", "failed", "error", "notRun")}
    result = "error" if count["error"] or not rows else "failed" if count["failed"] else "passed"
    out = Path(folder) / "results.json"
    out.write_text(json.dumps({"result": result, "counts": count, "tests": rows}, indent=2) + "\n")

    icon = {"passed": "✅ passed", "fixed": "🛠️ fixed", "failed": "❌ failed", "error": "⚠️ didn't run", "notRun": "➖ not run"}
    words = ", ".join(f"{v} {k if k != 'notRun' else 'not run'}" for k, v in count.items() if v) or "nothing ran"
    lines = [f"### Breakpatch: {words}", "", "| Test | Result | Failed step | Why |", "|---|---|---|---|"]
    for r in rows:
        lines.append(f"| {cell(r.get('test'))} | {icon.get(r['result'], r['result'])} | {cell(r.get('failedStep'))} | {cell(r.get('why'))} |")
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as f:
            f.write("\n".join(lines) + "\n")
    print("\n".join(lines))
    outputs = os.environ.get("GITHUB_OUTPUT")
    if outputs:
        with open(outputs, "a", encoding="utf-8") as f:
            f.write(f"result={result}\npassed={count['passed']}\nfailed={count['failed'] + count['error']}\n"
                    f"fixed={count['fixed']}\njson={out}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
