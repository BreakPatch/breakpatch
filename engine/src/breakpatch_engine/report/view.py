"""The report's view: everything the template shows, in plain words, from a run (or a suite's runs)
as the app stores them. The app builds the same view in app/src/lib/report/view.ts, and both are
checked against tests/fixtures/report/view.json, built from tests/fixtures/report/input.json. The
words are the app's (screens/run/reasons.ts, lib/explain.ts, screens/report/reportData.ts), so
change them together.

The input:

    { kind: "run"|"suite", name, appVersion, generatedAt (ms), tzOffsetMinutes, screenshots: bool,
      suite?: { result, counts, requestedBy, startedAt, finishedAt, note? },
      tests: [{ appName, name, steps: Step[], run: Run | None, note? }] }

`run` is a stored Run (engine run.ended plus who, where and when); a StepRun may carry `image`
`{ src, width, height }`, the screenshot as a WebP data: URI (images.py).
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

MONTHS = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")
WHERE = {"desktop": "This Mac", "ci": "CI", "runner": "Local runner"}
RESULT_TEXT = {"passed": "Passed", "fixed": "Fixed automatically", "failed": "Failed", "stopped": "Stopped", "notRun": "Not run"}
RUN_TEXT = {"passed": "Passed", "fixed": "Passed with fixes", "failed": "Failed", "notRun": "Not run", "stopped": "Stopped"}
SUITE_RESULT = {"passed": "passed", "passed_with_fixes": "fixed", "failed": "failed", "replaced": "notRun"}
SUITE_TEXT = {"passed": "Passed", "passed_with_fixes": "Passed with fixes", "failed": "Failed", "replaced": "Replaced by a newer request"}
UNCHECKED_NOTE = "This step's check covers nothing. Re-record it."
CAUSE_TEXT = {
    "moved": "It moved", "textChanged": "Its text changed", "pageChanged": "The page changed",
    "slowLoad": "The page was slow to load", "errorPage": "The page shows an error", "realBug": "Looks like a real bug",
}
SUGGESTION_TEXT = {
    "rerecord": "Re-record this step.",
    "acceptChange": "If this change is expected, re-record this step to accept it.",
    "raiseWait": "Give the page longer: add a wait before this step.",
    "reportBug": "Report it as a bug. Copy details has what the developers need.",
}
_VERB = {"click": "click", "doubleClick": "double-click", "longClick": "press", "rightClick": "right-click", "hover": "point at",
         "write": "write in", "drag": "drag", "swipe": "swipe", "scroll": "scroll", "upload": "upload to"}
_NO_SCREENS = ("secretMissing", "setUpFailed", "stopped", "healingUnavailable")
_SCREEN_CHECKS = ("targetNotFound", "unexpectedScreen", "healFailed", "timeout")


# ---------------------------------------------------------------- words (screens/run/reasons.ts)

def target_name(step: dict) -> str:
    import re
    raw = re.sub(r"^(the|a|an)\s+", "", str(step.get("target") or "").split(",")[0].strip(), flags=re.I)
    if raw and not re.fullmatch(r"spot you clicked|area you picked|focused field", raw, flags=re.I):
        return f"the {raw}"
    return "the field to write in" if step.get("action") == "write" else "what to click"


def reason_title(reason, step: dict) -> str:
    if reason in ("targetNotFound", "healFailed"):
        return f"Couldn't find {target_name(step)}"
    if reason == "unexpectedScreen":
        return "The screen didn't look as expected" if step.get("action") == "checkpoint" \
            else "The screen didn't look as expected after this step"
    return {
        "noChange": "Nothing happened after this step",
        "timeout": "Waited too long for the page",
        "healingUnavailable": "The AI assistant isn't downloaded, so this couldn't be fixed automatically",
        "secretMissing": "Saved secret is missing on this Mac",
        "setUpFailed": "The set-up call didn't work",
        "stopped": "You stopped the run",
        "fileMissing": "The file to upload isn't in the tests folder",
    }.get(reason or "", "This step failed")


def reason_text(reason, step: dict) -> str:
    verb = _VERB.get(step.get("action"), "use")
    action = step.get("action")
    if reason == "targetNotFound":
        return f"It wasn't where it was when this step was recorded, so there was nothing to {verb}. The run stopped here."
    if reason == "healFailed":
        return "The AI assistant looked for it, but what it found didn't match the recording. The run stopped here."
    if reason == "unexpectedScreen":
        if action == "checkpoint":
            return "The area this step checks looked different from when it was recorded. The run stopped here."
        if action == "downloadCheck":
            return "The downloaded file wasn't the type or size this step expects. The run stopped here."
        return "The page looked different from when it was recorded once the step was done. The run stopped here."
    if reason == "noChange":
        return "The step was done, but nothing changed on the page the way it did when it was recorded. The run stopped here."
    if reason == "timeout":
        if action == "waitUntil":
            return "What this step waits for never appeared. The run stopped here."
        return "The page didn't finish loading or settle in time. The run stopped here."
    if reason == "healingUnavailable":
        return "Download it in Settings → AI assistant, then run again."
    if reason == "secretMissing":
        return f"Add {step.get('secretRef') or 'the saved secret'} in Settings → Saved secrets, then run again."
    if reason == "setUpFailed":
        return "The call before the test didn't answer with success, so no steps ran."
    if reason == "stopped":
        return "The steps from here on didn't run."
    if reason == "fileMissing":
        return f"{step.get('file') or 'The file'} isn't in the tests folder. Put it back in the files folder, or re-record the step."
    return "The run stopped here."


def reason_advice(reason) -> str:
    return {
        "secretMissing": "Saved secrets stay on each Mac. Add it here once and every test that uses it can run.",
        "healingUnavailable": "Without the AI assistant, a moved button fails the run. Re-record the step, or download the assistant.",
        "setUpFailed": "Check that the set-up address works and that the app is running, then run again.",
        "timeout": "If the app was slow this time, run again. If it always takes longer now, re-record this step.",
        "stopped": "Run again to go through every step.",
    }.get(reason or "", "If the app changed on purpose, re-record this step. If it looks like a bug in the app, send the report to a developer.")


def pass_note(r: dict) -> str:
    if r.get("passedBy") == "gone":
        return "Passed: the dialog closed. The page behind it looked different from when it was recorded."
    if r.get("passedBy") == "note":
        return r["why"] if r.get("why") is not None else "Passed: the step did what its note says."
    return ""


# ---------------------------------------------------------------- numbers and times

def _int(v) -> int:
    import math
    return math.floor(v) if isinstance(v, (int, float)) and not isinstance(v, bool) and v > 0 else 0


def short_time(ms) -> str:
    """"38 ms" under a second, else "1.2 s" (rounded half up from whole milliseconds)."""
    n = _int(ms)
    if n < 1000:
        return f"{n} ms"
    t = (n + 50) // 100
    return f"{t // 10}.{t % 10} s"


def took_text(ms) -> str:
    """"51 s", "1 min 8 s", "12 min" (reportData.ts tookText)."""
    total = (_int(ms) + 500) // 1000
    if total < 60:
        return f"{total} s"
    m, s = divmod(total, 60)
    return f"{m} min {s} s" if s else f"{m} min"


def seconds(ms) -> str:
    """"68.250": JUnit's seconds, from whole milliseconds."""
    n = _int(ms)
    return f"{n // 1000}.{n % 1000:03d}"


def _at(ms, offset_min: int = 0) -> datetime:
    return datetime(1970, 1, 1, tzinfo=timezone.utc) + timedelta(milliseconds=_int(ms) + offset_min * 60_000)


def when_text(ms, offset_min: int = 0) -> str:
    """"24 Sep 2026, 14:10 UTC", or "UTC+1", "UTC+5:30", "UTC-3" away from UTC."""
    d = _at(ms, offset_min)
    sign = "+" if offset_min > 0 else "-"
    h, m = divmod(abs(offset_min), 60)
    zone = "UTC" if not offset_min else f"UTC{sign}{h}" + (f":{m:02d}" if m else "")
    return f"{d.day} {MONTHS[d.month - 1]} {d.year}, {d.hour:02d}:{d.minute:02d} {zone}"


def iso_text(ms) -> str:
    """"2026-09-24T14:10:00": JUnit's timestamp, in UTC."""
    return _at(ms).strftime("%Y-%m-%dT%H:%M:%S")


def plural(n: int, one: str, many: str | None = None) -> str:
    return f"{n} {one if n == 1 else (many or one + 's')}"


# ---------------------------------------------------------------- steps

def rows(steps: list[dict]) -> list[tuple[dict, str, int]]:
    """Every step in the order the report lists them, with its number and depth: loop children are
    rows of their own (as the steps list numbers them), a shared-steps card's steps are "2.1", "2.2"."""
    out: list[tuple[dict, str, int]] = []
    count = [0]

    def walk(ss, depth):
        for s in ss:
            count[0] += 1
            out.append((s, str(count[0]), depth))
            if s.get("action") == "loop" and s.get("steps"):
                walk(s["steps"], depth + 1)
            elif s.get("action") == "group" and s.get("steps"):
                inner(s["steps"], str(count[0]), depth + 1)

    def inner(ss, prefix, depth):
        for i, c in enumerate(ss, 1):
            n = f"{prefix}.{i}"
            out.append((c, n, depth))
            if c.get("action") in ("loop", "group") and c.get("steps"):
                inner(c["steps"], n, depth + 1)
    walk(steps, 0)
    return out


def step_state(r: dict | None) -> str:
    if not r:
        return "notRun"
    if r.get("result") == "failed":
        return "stopped" if r.get("reason") == "stopped" else "failed"
    return {"healed": "fixed", "passed": "passed"}.get(r.get("result"), "notRun")


def _descendant_failed(step: dict, by_id: dict) -> bool:
    for c in step.get("steps") or []:
        r = by_id.get(str(c.get("id")))
        if (r and r.get("result") == "failed") or _descendant_failed(c, by_id):
            return True
    return False


def explanation(e) -> dict | None:
    if not isinstance(e, dict) or not isinstance(e.get("summary"), str) or not e["summary"].strip():
        return None
    return {"summary": e["summary"].strip(), "cause": CAUSE_TEXT.get(e.get("cause"), ""),
            "suggestion": SUGGESTION_TEXT.get(e.get("suggestion"), "")}


def phases(t) -> tuple[str, str]:
    """(the step's time, where it went) from its `timings`."""
    if not isinstance(t, dict):
        return "", ""
    parts = [(t.get("preMs"), "check before"), (t.get("actionMs"), "doing the step"),
             (t.get("settleMs"), "waiting for the page to settle" if t.get("settled") is not False else "waiting for the page, which never settled"),
             (t.get("postMs"), "check after")]
    have = [(ms, what) for ms, what in parts if _int(ms) > 0]
    if not have:
        return "", ""
    total = sum(_int(ms) for ms, _ in have)
    return short_time(total), " · ".join(f"{what} {short_time(ms)}" for ms, what in have)


def system_note(run: dict, r: dict | None) -> str:
    m = run.get("systemMismatch") if isinstance(run.get("systemMismatch"), dict) else None
    if not m or not m.get("message") or not r or r.get("result") != "failed" or r.get("reason") not in _SCREEN_CHECKS:
        return ""
    return str(m["message"])


def step_view(step: dict, number: str, depth: int, r: dict | None, run: dict, by_id: dict, screenshots: bool) -> dict:
    state = step_state(r)
    container = bool(step.get("steps")) and step.get("action") in ("loop", "group")
    quiet = container and state in ("failed", "stopped", "fixed") and (_descendant_failed(step, by_id) or state == "fixed")
    headline = body = advice = ""
    reason = (r or {}).get("reason")
    if not quiet:
        if state == "failed":
            headline, body, advice = reason_title(reason, step), reason_text(reason, step), reason_advice(reason)
        elif state == "stopped":
            headline, body = reason_title("stopped", step), reason_text("stopped", step)
        elif state == "fixed":
            name = target_name(step)
            headline = f"{name[0].upper()}{name[1:]} had moved. The AI assistant found it."
            body = "It was used in the new position and the screen afterwards looked right."
    note = ""
    if r and state == "passed":
        note = UNCHECKED_NOTE if r.get("unchecked") else pass_note(r)
    took, where = phases((r or {}).get("timings"))
    image = None
    img = (r or {}).get("image") if screenshots and not container else None
    if isinstance(img, dict) and isinstance(img.get("src"), str) and img["src"].startswith("data:image/"):
        if not (state == "failed" and reason in _NO_SCREENS):
            image = {"src": img["src"], "width": _int(img.get("width")), "height": _int(img.get("height")),
                     "size": "full" if state == "failed" else "small",
                     "alt": f"Screenshot: step {number}, {step.get('label') or ''}".rstrip(", "),
                     "caption": "What was on screen when the step failed" if state == "failed"
                     else "Where the AI assistant found it" if state == "fixed" else "The screen at this step"}
    ex = explanation((r or {}).get("explanation")) if state == "failed" and not quiet else None
    system = system_note(run, r) if not quiet else ""
    v = {"number": number, "depth": depth, "label": str(step.get("label") or ""), "result": state,
         "resultText": RESULT_TEXT[state], "headline": headline, "body": body, "stepNote": note, "system": system,
         "explanation": ex, "advice": advice, "took": took, "phases": where, "image": image, "open": False, "hasDetail": False}
    v["open"] = state == "failed" and not quiet
    v["_reason"] = str(reason or "") if state == "failed" and headline else ""   # JUnit's failure type; not in the view
    v["hasDetail"] = bool(headline or body or note or system or ex or advice or where or image)
    return v


# ---------------------------------------------------------------- a test's run

def run_state(run: dict | None, steps_view: list[dict]) -> str:
    if not run:
        return "failed"
    if run.get("result") == "fail":
        stopped = any(s["result"] == "stopped" for s in steps_view) and not any(s["result"] == "failed" for s in steps_view)
        return "stopped" if stopped else "failed"
    return "fixed" if _int(run.get("healedCount")) > 0 else "passed"


def run_by(run: dict) -> str:
    by = run.get("startedBy") or {}
    return str(by.get("name") or by.get("serviceAccount") or "")


def run_meta(run: dict, offset: int) -> list[dict]:
    meta = [{"k": "Took", "v": took_text(run.get("durationMs"))}, {"k": "Run by", "v": run_by(run)},
            {"k": "Where", "v": WHERE.get(run.get("source"), str(run.get("source") or ""))},
            {"k": "Machine", "v": str(run.get("machine") or "")}, {"k": "When", "v": when_text(run.get("startedAt"), offset)}]
    if run.get("testVersion") is not None:
        meta.append({"k": "Version", "v": str(run.get("testVersion"))})
    if run.get("id"):
        meta.append({"k": "Run ID", "v": str(run["id"])})
    return [m for m in meta if m["v"]]


def test_view(t: dict, index: int, offset: int, screenshots: bool, multi: bool) -> dict:
    run = t.get("run") if isinstance(t.get("run"), dict) else None
    steps = t.get("steps") or []
    by_id = {str(r.get("stepId")): r for r in (run or {}).get("steps") or [] if isinstance(r, dict)}
    views = [step_view(s, n, d, by_id.get(str(s.get("id"))), run or {}, by_id, screenshots) for s, n, d in rows(steps)] if run else []
    state = run_state(run, views)
    name = str(t.get("name") or (run or {}).get("testName") or "Test")
    j = _junit(state, views, t, run)
    for v in views:
        v.pop("_reason", None)
    return {
        "anchor": f"test-{index + 1}", "name": name, "appName": str(t.get("appName") or ""), "multi": multi,
        "result": state, "resultText": RUN_TEXT[state] if run else "Couldn't run", "meta": run_meta(run, offset) if run else [],
        "testNote": "" if run else str(t.get("note") or "It couldn't run."),
        "stepsText": plural(len(views), "step"), "steps": views, "junit": j,
        # In a suite, a test that passed starts closed: what didn't pass is what's read first.
        "stepsOpen": state not in ("passed", "fixed"),
    }


def _junit(state: str, views: list[dict], t: dict, run: dict | None) -> dict:
    base = {"seconds": seconds((run or {}).get("durationMs")), "timestamp": iso_text((run or {}).get("startedAt")) if run else ""}
    if state in ("passed", "fixed"):
        return {**base, "status": "passed", "type": "", "message": "", "text": ""}
    if state == "stopped":
        return {**base, "status": "skipped", "type": "stopped", "message": "You stopped the run", "text": ""}
    failed = [v for v in views if v["result"] == "failed" and v["headline"]]
    if not failed:
        note = str(t.get("note") or "It couldn't run.") if not run else "The run failed."
        return {**base, "status": "failed", "type": "notRun" if not run else "failed", "message": note, "text": note}
    s = failed[-1]
    lines = [f"Step {s['number']}: {s['label']}", s["headline"], s["body"]]
    e = s["explanation"]
    if e:
        lines.append(f"AI assistant: {e['summary']}")
        if e["cause"]:
            lines.append(f"Likely cause: {e['cause']}.")
        if e["suggestion"]:
            lines.append(f"Suggested: {e['suggestion']}")
    if s["system"]:
        lines.append(s["system"])
    lines.append(f"What to try: {s['advice']}")
    return {**base, "status": "failed", "type": s["_reason"] or "failed",
            "message": f"Step {s['number']}: {s['label']}: {s['headline']}", "text": "\n".join(x for x in lines if x)}


# ---------------------------------------------------------------- the whole report

def counts_text(c: dict) -> str:
    total, passed, fixed, failed, not_run = (_int(c.get(k)) for k in ("total", "passed", "fixed", "failed", "notRun"))
    if not failed and not not_run:
        return f"{passed + fixed} of {plural(total, 'test')} passed" + (f", {fixed} fixed automatically" if fixed else "")
    out = f"{passed + fixed} of {plural(total, 'test')} passed"
    if failed:
        out += f", {failed} failed"
    if not_run:
        out += f", {not_run} not run"
    return out


def build(inp: dict) -> dict:
    offset = _int(abs(inp.get("tzOffsetMinutes") or 0)) * (-1 if (inp.get("tzOffsetMinutes") or 0) < 0 else 1)
    shots = inp.get("screenshots") is not False
    suite = inp.get("kind") == "suite"
    tests = [test_view(t, i, offset, shots, suite) for i, t in enumerate(inp.get("tests") or [])]
    version = str(inp.get("appVersion") or "")
    footer = f"Made with Breakpatch{' ' + version if version else ''} on {when_text(inp.get('generatedAt'), offset)}."
    if suite:
        s = inp.get("suite") or {}
        result = SUITE_RESULT.get(s.get("result"), "failed")
        result_text = SUITE_TEXT.get(s.get("result"), "Failed")
        started, finished = s.get("startedAt"), s.get("finishedAt")
        summary = [{"k": "Tests", "v": plural(len(tests), "test")},
                   {"k": "Took", "v": took_text(_int(finished) - _int(started))},
                   {"k": "Asked by", "v": str(s.get("requestedBy") or "")},
                   {"k": "When", "v": when_text(started, offset)}]
        heading, kind, counts = str(inp.get("name") or "Suite"), "Suite report", counts_text(s.get("counts") or {})
        note = str(s.get("note") or "")
        total_ms = _int(finished) - _int(started)
        stamp = iso_text(started)
    else:
        t = tests[0] if tests else None
        result = t["result"] if t else "notRun"
        result_text = t["resultText"] if t else "Not run"
        summary = ([{"k": "App", "v": t["appName"]}] if t and t["appName"] else []) + (t["meta"] if t else [])
        heading, kind, counts, note = (t["name"] if t else str(inp.get("name") or "Test")), "Run report", "", ""
        run = (inp.get("tests") or [{}])[0].get("run") or {}
        total_ms, stamp = _int(run.get("durationMs")), iso_text(run.get("startedAt")) if run else ""
    # A suite leads with what didn't pass, each linking to its test.
    not_passed = [t for t in tests if t["result"] not in ("passed", "fixed")] if suite else []
    failed = {"label": f"{plural(len(not_passed), 'test')} didn't pass:",
              "items": [{"anchor": t["anchor"], "name": t["name"], "resultText": t["resultText"]} for t in not_passed]} if not_passed else None
    junit = {"name": heading, "tests": len(tests), "failures": sum(1 for t in tests if t["junit"]["status"] == "failed"),
             "skipped": sum(1 for t in tests if t["junit"]["status"] == "skipped"), "seconds": seconds(total_ms), "timestamp": stamp}
    return {
        "title": f"{heading} · {result_text} · Breakpatch", "generator": f"Breakpatch{' ' + version if version else ''}",
        "kindLabel": kind, "heading": heading, "result": result, "resultText": result_text, "countsText": counts,
        "summary": [m for m in summary if m["v"]], "note": note, "screenshotsLeftOut": not shots, "multi": suite, "failed": failed,
        "tests": tests, "footer": footer, "junit": junit,
    }


def all_open(view: dict) -> dict:
    """The same view with every step open: for printing, where a closed step would print closed."""
    return {**view, "tests": [{**t, "stepsOpen": True, "steps": [{**s, "open": s["hasDetail"]} for s in t["steps"]]} for t in view["tests"]]}
