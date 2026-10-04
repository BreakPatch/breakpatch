"""The exported report (issue #43, breakpatch_engine/report/): the same view, HTML and JUnit XML as
the app (app/src/lib/report/report.test.ts checks the same golden files), the template's rules,
the screenshots as WebP, the size of a 30-step run, and `report.images`.

Write the golden files again after a deliberate change: BP_WRITE_GOLDEN=1 python -m pytest tests/test_report.py
"""
import asyncio
import base64
import copy
import importlib
import json
import os
import random
import re
import xml.etree.ElementTree as ET
from pathlib import Path

import pytest
from PIL import Image, ImageDraw

from breakpatch_engine import config, report
from breakpatch_engine.report import images
from breakpatch_engine.report import view as report_view

tpl = importlib.import_module("breakpatch_engine.report.render")
from breakpatch_engine.service import Engine

FIXTURES = Path(__file__).parent / "fixtures" / "report"
INPUT = json.loads((FIXTURES / "input.json").read_text(encoding="utf-8"))
WRITE = os.environ.get("BP_WRITE_GOLDEN") == "1"


def golden(name: str, text: str) -> None:
    path = FIXTURES / name
    if WRITE:
        path.write_text(text, encoding="utf-8")
    assert text == path.read_text(encoding="utf-8")


# ---------------------------------------------------------------- the same files as the app

@pytest.mark.parametrize("case", sorted(INPUT))
def test_the_view_is_the_golden_one(case):
    view = report.build(INPUT[case])
    golden(f"view-{case}.json", json.dumps(view, indent=2, ensure_ascii=False) + "\n")


@pytest.mark.parametrize("case", sorted(INPUT))
def test_the_html_is_the_golden_one(case):
    golden(f"report-{case}.html", report.html(report.build(INPUT[case])))


@pytest.mark.parametrize("case", sorted(INPUT))
def test_the_junit_xml_is_the_golden_one(case):
    golden(f"report-{case}.junit.xml", report.junit_xml(report.build(INPUT[case])))


# ---------------------------------------------------------------- what the report says

@pytest.mark.parametrize("case", json.loads((FIXTURES / "where.json").read_text(encoding="utf-8")))
def test_where_names_the_run_s_own_machine_as_the_app_does(case):
    """The same cases as the app's report.test.ts: a desktop run's machine by its recorded system."""
    assert report_view.where_text(case["run"]) == case["where"]


def test_a_failed_step_has_its_reason_the_ai_assistant_and_its_screenshot():
    view = report.build(INPUT["run"])
    done = next(s for s in view["tests"][0]["steps"] if s["label"] == "Click Done")
    assert done["number"] == "7" and done["open"] and done["result"] == "failed"
    assert done["headline"] == "Couldn't find the Done button"
    assert done["explanation"] == {"summary": "The Done button moved into a menu after the redesign.", "cause": "It moved",
                                   "suggestion": "Re-record this step."}
    assert done["image"]["size"] == "full" and done["system"].startswith("This test was recorded on macOS 15")
    fixed = next(s for s in view["tests"][0]["steps"] if s["number"] == "2.2")
    assert fixed["image"]["size"] == "small" and fixed["headline"] == "The Next button had moved. The AI assistant found it."
    assert [s["number"] for s in view["tests"][0]["steps"]] == ["1", "2", "2.1", "2.2", "3", "4", "5", "6", "7", "8"]
    assert view["tests"][0]["steps"][-1]["resultText"] == "Not run"


def test_screenshots_can_be_left_out():
    inp = copy.deepcopy(INPUT["run"])
    inp["screenshots"] = False
    view = report.build(inp)
    assert view["screenshotsLeftOut"] and all(s["image"] is None for s in view["tests"][0]["steps"])
    html = report.html(view)
    assert "data:image/" not in html and "Screenshots were left out" in html


def test_no_external_requests():
    html = report.html(report.build(INPUT["run"]))
    assert "default-src 'none'; img-src data:" in html
    assert not re.search(r"""(src|href|action)\s*=\s*["']?(https?:|//)""", html, re.I)
    assert "url(" not in html and "@import" not in html
    assert all(src.startswith("data:image/webp;base64,") for src in re.findall(r'src="([^"]*)"', html))


def test_values_are_escaped():
    html = report.html(report.build(INPUT["run"]))
    assert "Write &lt;Q4&gt; &amp; friends" in html and "<Q4>" not in html
    assert "Click &quot;New project&quot;" in html


def test_the_junit_xml_is_well_formed_and_counts_right():
    root = ET.fromstring(report.junit_xml(report.build(INPUT["suite"])))
    assert root.tag == "testsuites" and root.get("tests") == "4" and root.get("failures") == "2"
    cases = root.findall("./testsuite/testcase")
    assert [c.get("name") for c in cases] == ["Sign in", "Invite a teammate", "Pay an invoice", "Refund"]
    assert cases[2].find("failure").get("type") == "timeout"
    assert cases[3].find("failure").get("message") == "Couldn't run: it was deleted"
    stopped = copy.deepcopy(INPUT["run"])
    stopped["tests"][0]["run"]["steps"][-1]["reason"] = "stopped"
    root = ET.fromstring(report.junit_xml(report.build(stopped)))
    assert root.get("skipped") == "1" and root.find("./testsuite/testcase/skipped") is not None
    assert report.junit.esc("a\x00b\x1fc") == "abc"


def test_every_step_opens_for_printing():
    view = report.all_open(report.build(INPUT["run"]))
    assert all(s["open"] == s["hasDetail"] for s in view["tests"][0]["steps"])


# ---------------------------------------------------------------- the template language

def test_render_sections_and_lookups():
    t = "{{#items}}[{{name}}{{#flag}}!{{/flag}}{{^flag}}?{{/flag}}{{top}}]{{/items}}{{^items}}none{{/items}}{{a.b}}{{! gone }}"
    assert tpl.render(t, {"items": [{"name": "x", "flag": True}, {"name": "<y>", "flag": False}], "top": "T", "a": {"b": 1}}) \
        == "[x!T][&lt;y&gt;?T]1"
    assert tpl.render(t, {"items": [], "a": {}}) == "none"
    # A key on the inner object stops the lookup even when it isn't set.
    assert tpl.render("{{#o}}{{v}}{{/o}}", {"o": {"v": ""}, "v": "outer"}) == ""
    assert tpl.render("{{#o}}{{k}}{{/o}}", {"o": {"k": "in"}}) == "in"
    assert tpl.render("{{v}}", {"v": "a&b'\""}) == "a&amp;b&#39;&quot;"
    for bad in ("{{#a}}", "{{/a}}", "{{&a}}", "{{>a}}", "{{#a}}{{/b}}"):
        with pytest.raises(tpl.TemplateError):
            tpl.parse(bad)


def test_the_template_has_the_parts_the_app_prints():
    t = report.template()
    assert t.count("<!--bpr-body-->") == 1 and t.count("<!--/bpr-body-->") == 1
    assert "@media print" in t and "prefers-color-scheme: dark" in t and "<details" in t
    tpl.parse(t)


# ---------------------------------------------------------------- screenshots and size

def screen(path: Path, seed: int, size=(2880, 1800)) -> Path:
    """Something like a web app on a Retina screen: bars, text, cards and a photo."""
    rnd = random.Random(seed)
    im = Image.new("RGB", size, (250, 248, 245))
    d = ImageDraw.Draw(im)
    w, h = size
    d.rectangle([0, 0, w, 120], fill=(34, 26, 21))
    d.rectangle([0, 120, 440, h], fill=(240, 234, 228))
    for y in range(200, h - 100, 70):
        d.rectangle([60, y, 60 + rnd.randint(160, 320), y + 26], fill=(120, 110, 100))
    for i in range(12):
        x, y = 520 + (i % 3) * 760, 200 + (i // 3) * 400
        d.rounded_rectangle([x, y, x + 700, y + 340], 18, fill=(255, 255, 255), outline=(220, 210, 200), width=3)
        for k in range(6):
            d.text((x + 30, y + 30 + k * 44), " ".join(rnd.choice(("Project", "Invoice", "Team", "Status", "Due", "Q4")) for _ in range(6)),
                   fill=(40, 30, 25), font_size=30)
    photo = Image.effect_noise((600, 400), 60).convert("RGB").resize((1200, 800))
    im.paste(photo, (w - 1300, h - 900))
    im.save(path)
    return path


def test_screenshots_are_webp_small_or_full(tmp_path):
    p = screen(tmp_path / "a.png", 1)
    full = images.webp_data_uri(p, "full", 1440)
    small = images.webp_data_uri(p, "small", 1440)
    assert full["src"].startswith("data:image/webp;base64,") and (full["width"], full["height"]) == (1440, 900)
    assert (small["width"], small["height"]) == (480, 300) and small["bytes"] < full["bytes"]
    assert base64.b64decode(full["src"].split(",", 1)[1])[8:12] == b"WEBP"


def test_a_30_step_run_is_about_5_mb_at_most(tmp_path):
    """The worst case: every step has a Retina screenshot (in a real run only failed and fixed ones do)."""
    steps = [{"id": f"s{i}", "action": "click", "label": f"Click button {i}", "target": f"Button {i}"} for i in range(30)]
    results = [{"stepId": f"s{i}", "result": "healed", "oldAt": [1, 1], "newAt": [2, 2],
                "screenshotPath": str(screen(tmp_path / f"{i}.png", i)), "timings": {"preMs": 100, "actionMs": 80}}
               for i in range(29)]
    results.append({"stepId": "s29", "result": "failed", "reason": "targetNotFound", "screenshotPath": str(screen(tmp_path / "f.png", 99))})
    run = {"id": "r", "testName": "Big", "testVersion": 1, "startedBy": {"name": "A"}, "machine": "M", "source": "ci",
           "startedAt": 0, "durationMs": 90_000, "result": "fail", "healedCount": 29, "steps": results}
    test = images.attach_images({"appName": "App", "name": "Big", "steps": steps, "run": run}, 1440)
    view = report.build({"kind": "run", "name": "Big", "appVersion": "1", "generatedAt": 0, "tzOffsetMinutes": 0,
                         "screenshots": True, "tests": [test]})
    html = report.html(view)
    shots = [s["image"] for s in view["tests"][0]["steps"] if s["image"]]
    assert len(shots) == 30 and [s["size"] for s in shots].count("full") == 1
    print(f"30 steps: {len(html.encode()) / 1e6:.2f} MB")
    assert len(html.encode()) < 5_000_000, f"{len(html.encode()) / 1e6:.2f} MB"
    without = report.html(report.build({**{"kind": "run", "name": "Big", "appVersion": "1", "generatedAt": 0,
                                           "tzOffsetMinutes": 0, "screenshots": False, "tests": [test]}}))
    assert len(without.encode()) < 120_000


def test_a_missing_screenshot_is_left_out(tmp_path):
    t = images.attach_images({"run": {"steps": [{"stepId": "a", "result": "failed", "screenshotPath": str(tmp_path / "gone.png")}]}})
    assert "image" not in t["run"]["steps"][0]


# ---------------------------------------------------------------- report.images (the app asks for them)

def test_report_images_only_from_the_screenshots_folder(tmp_path):
    inside = config.screenshots_dir() / "r9" / "001-a.png"
    inside.parent.mkdir(parents=True, exist_ok=True)
    screen(inside, 3, (1440, 900))
    outside = screen(tmp_path / "elsewhere.png", 4, (1440, 900))
    e = Engine(lambda *_: None, healer=None, explainer=None)
    got = asyncio.run(e.report_images({"items": [{"path": str(inside), "size": "small"}, {"path": str(inside)},
                                                 {"path": str(outside)}, {"path": "/etc/passwd"}, "x"], "viewportWidth": 1440}))
    one, two, *rest = got["images"]
    assert one["width"] == 480 and two["width"] == 1440 and rest == [None, None, None]
    assert "report.images" in e.handlers()
    from breakpatch_engine.protocol import EngineError
    with pytest.raises(EngineError):
        asyncio.run(e.report_images({"items": "nope"}))


def test_words_and_numbers_as_view_ts_writes_them():
    v = report.view
    assert [v.short_time(38), v.short_time(999), v.short_time(1050), v.short_time(12_349)] == ["38 ms", "999 ms", "1.1 s", "12.3 s"]
    assert v.seconds(68_250) == "68.250"
    assert v.when_text(1790258400000, 0) == "24 Sep 2026, 14:00 UTC"
    assert v.when_text(1790258400000, 330) == "24 Sep 2026, 19:30 UTC+5:30"
    assert v.when_text(1790258400000, -180) == "24 Sep 2026, 11:00 UTC-3"
    assert v.iso_text(1790258400000) == "2026-09-24T14:00:00"
    assert v.counts_text({"total": 6, "passed": 5, "fixed": 1}) == "6 of 6 tests passed, 1 fixed automatically"
    assert v.counts_text({"total": 6, "passed": 3, "failed": 2, "notRun": 1}) == "3 of 6 tests passed, 2 failed, 1 not run"
    assert [(n, d) for _, n, d in v.rows([{"id": "l", "action": "loop", "label": "L", "steps": [{"id": "c", "action": "click", "label": "C"}]}])] \
        == [("1", 0), ("2", 1)]
