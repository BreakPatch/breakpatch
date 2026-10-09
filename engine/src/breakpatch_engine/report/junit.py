"""JUnit XML from the report's view (view.py): one <testcase> per test, as GitHub, GitLab and
Jenkins read it, with each earlier try of a retried test (flakyFailure, rerunFailure). The app writes the same bytes (app/src/lib/report/junit.ts): both are checked
against tests/fixtures/report/report.junit.xml."""
from __future__ import annotations

import re

_BAD = re.compile("[\x00-\x08\x0b\x0c\x0e-\x1f￾￿]")
_ESC = {"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;"}


def esc(v) -> str:
    """Text or an attribute value, with what XML 1.0 can't hold left out."""
    return "".join(_ESC.get(c, c) for c in _BAD.sub("", str(v)))


def junit_xml(view: dict) -> str:
    j = view["junit"]
    name = esc(j["name"])
    stamp = f' timestamp="{esc(j["timestamp"])}"' if j["timestamp"] else ""
    counts = f'tests="{j["tests"]}" failures="{j["failures"]}" errors="0" skipped="{j["skipped"]}" time="{esc(j["seconds"])}"'
    out = ['<?xml version="1.0" encoding="UTF-8"?>',
           f'<testsuites name="{name}" {counts}>',
           f'  <testsuite name="{name}" {counts}{stamp}>']
    for t in view["tests"]:
        c = t["junit"]
        head = f'    <testcase name="{esc(t["name"])}" classname="{esc(t["appName"] or j["name"])}" time="{esc(c["seconds"])}"'
        retries = c.get("retries") or []
        if c["status"] == "passed" and not retries:
            out.append(head + "/>")
            continue
        out.append(head + ">")
        if c["status"] == "skipped":
            out.append(f'      <skipped message="{esc(c["message"])}"/>')
        elif c["status"] != "passed":
            out.append(f'      <failure message="{esc(c["message"])}" type="{esc(c["type"])}">{esc(c["text"])}</failure>')
        # Earlier tries (engine/PROTOCOL.md "Retries"), as Maven Surefire writes reruns: <flakyFailure>
        # in a test that passed in the end (Jenkins and others show it as flaky), <rerunFailure> in
        # one that didn't. Readers that don't know them see the test's own result.
        tag = "flakyFailure" if c["status"] == "passed" else "rerunFailure"
        for r in retries:
            out.append(f'      <{tag} message="{esc(r["message"])}" type="{esc(r["type"])}">{esc(r["text"])}</{tag}>')
        out.append("    </testcase>")
    out += ["  </testsuite>", "</testsuites>", ""]
    return "\n".join(out)
