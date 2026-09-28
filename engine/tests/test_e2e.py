"""Record and replay against a local page with real headless Chromium."""
import asyncio
import copy
import functools
import http.server
import threading
from pathlib import Path

import pytest

from conftest import needs_browser
from breakpatch_engine.config import Timings
from breakpatch_engine.locator import NoLocator
from breakpatch_engine.protocol import EngineError
from breakpatch_engine.service import Engine

SITE = Path(__file__).parent / "site"
VIEWPORT = {"width": 800, "height": 600}
BUTTON_AT = [170, 222]                 # centre of "Create project"
MOVED_BOX = [420, 200, 560, 244]       # where it is with ?moved=1
NOISE = [[0, 0, 800, 40]]              # the random ID and the ticking clock, for hand-written steps

pytestmark = needs_browser


class Handler(http.server.SimpleHTTPRequestHandler):
    calls: list = []

    def log_message(self, *a):
        pass

    def do_POST(self):
        Handler.calls.append(("POST", self.path))
        self.send_response(500 if self.path.startswith("/api/fail") else 200)
        self.send_header("Content-Length", "2")
        self.end_headers()
        self.wfile.write(b"{}")


@pytest.fixture(scope="module")
def site():
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Handler, directory=str(SITE)))
    th = threading.Thread(target=srv.serve_forever, daemon=True)
    th.start()
    yield f"http://127.0.0.1:{srv.server_address[1]}"
    srv.shutdown()


class FakeLocator:
    def __init__(self, box):
        self.box = box
        self.calls = []

    def available(self):
        return True

    async def locate(self, image, description):
        self.calls.append(description)
        return self.box

    async def describe(self, image, at):
        return {"name": "Create project button", "target": "Create project button, left of the page"}


_PLUGINS = object()


class Harness:
    def __init__(self, locator=None, healer=_PLUGINS):
        self.events = []
        self.locator = locator or NoLocator()
        kw = {} if healer is _PLUGINS else {"healer": healer}
        self.engine = Engine(self.emit, timings=Timings.fast(), locator_fn=lambda: self.locator, **kw)
        self.h = self.engine.handlers()
        self.ended = asyncio.Event()

    def emit(self, event, data):
        self.events.append((event, data))
        if event == "run.ended":
            self.ended.set()

    def of(self, name):
        return [d for e, d in self.events if e == name]

    async def call(self, method, params=None):
        return await self.h[method](params or {})

    async def run(self, steps, url, **kw):
        self.ended.clear()
        params = {"runId": kw.pop("runId", "r1"), "startUrl": url, "viewport": VIEWPORT, "steps": steps,
                  "settings": {"autoFix": kw.pop("autoFix", False), "failOnFix": kw.pop("failOnFix", False)},
                  "secrets": kw.pop("secrets", {}), **kw}
        await self.call("run.start", params)
        await asyncio.wait_for(self.ended.wait(), 60)
        return self.of("run.ended")[-1]


@pytest.fixture(scope="module")
def recorded(site):
    """Record a small test once: click Create, write a name, add a checkpoint on the message."""
    async def go():
        hx = Harness(FakeLocator(None))
        await hx.call("browser.open", {"url": site + "/index.html", "viewport": VIEWPORT})
        click = (await hx.call("record.point", {"action": "click", "at": BUTTON_AT}))["step"]
        write = (await hx.call("record.point", {"action": "write", "at": [150, 314], "text": "Alpha"}))["step"]
        check = (await hx.call("record.checkpoint", {"region": [300, 420, 620, 460]}))["step"]
        await asyncio.sleep(0.3)
        frames = hx.of("frame")
        phases = [d["phase"] for d in hx.of("record.checking")]
        await hx.call("browser.close")
        return {"steps": [click, write, check], "frames": frames, "phases": phases}
    return asyncio.run(go())


def test_recorded_click_step_shape(recorded):
    click = recorded["steps"][0]
    assert click["action"] == "click" and click["id"].startswith("s")
    assert click["at"] == BUTTON_AT
    assert click["label"] == "Click Create project button"
    assert click["target"].startswith("Create project button")
    assert click["pre"]["region"] == [138, 190, 202, 254]
    assert len(click["pre"]["hash"]) == 16 and click["pre"]["tolerance"] == 6
    post = click["post"]
    assert post["expectChange"] is True and post["tolerance"] == 10
    x1, y1, x2, y2 = post["region"]
    assert x1 <= 300 and y1 <= 420 and x2 >= 620 and y2 >= 460     # the message that appeared
    assert x1 >= 250 and y1 >= 380                                  # ... and not the whole page
    ignore = click["ignore"]
    assert any(b[0] >= 500 and b[1] < 40 for b in ignore), ignore   # the clock (noise watch)
    assert any(b[0] < 150 and b[1] < 40 for b in ignore), ignore    # the random ID (reload diff)


def test_recording_emits_phases_and_frames(recorded):
    assert recorded["phases"][:4] == ["watching", "acting", "settling", "reloading"]
    frames = recorded["frames"]
    assert frames, "no live view frames"
    f = frames[-1]
    assert f["width"] == 800 and f["height"] == 600 and f["jpeg"].startswith("/9j/")   # JPEG base64
    seqs = [x["seq"] for x in frames]
    assert seqs == sorted(seqs)


def test_recorded_write_and_checkpoint(recorded):
    _, write, check = recorded["steps"]
    assert write["label"] == 'Write "Alpha"' and write["text"] == "Alpha"
    assert write["post"]["expectChange"] is True
    assert check["action"] == "checkpoint" and check["region"] == [300, 420, 620, 460]
    assert len(check["hash"]) == 16


async def test_replay_passes(site, recorded):
    hx = Harness()
    ended = await hx.run(recorded["steps"], site + "/index.html")
    assert ended["result"] == "pass", ended
    assert [s["result"] for s in ended["steps"]] == ["passed"] * 3
    assert ended["steps"][0]["preDistance"] <= 6
    states = [(d["index"], d["state"]) for d in hx.of("run.step")]
    assert states == [(0, "running"), (0, "passed"), (1, "running"), (1, "passed"), (2, "running"), (2, "passed")]


async def test_moved_button_without_healing_fails_target_not_found(site, recorded):
    hx = Harness()
    ended = await hx.run(recorded["steps"], site + "/index.html?moved=1", autoFix=False)
    assert ended["result"] == "fail"
    first, *rest = ended["steps"]
    assert first["result"] == "failed" and first["reason"] == "targetNotFound"
    assert first["preDistance"] > 6
    assert Path(first["screenshotPath"]).is_file()
    assert [r["result"] for r in rest] == ["notRun", "notRun"]      # first failure stops the run
    failed = [d for d in hx.of("run.step") if d["state"] == "failed"][0]
    assert failed["reason"] == "targetNotFound" and failed["screenshot"] == first["screenshotPath"]


async def test_moved_target_without_a_healer_fails_target_not_found(site, recorded):
    """Community: no healer registered, so even with autoFix and a model that would find the
    button, a moved target fails the step with targetNotFound (healing is Breakpatch Team)."""
    loc = FakeLocator(MOVED_BOX)
    hx = Harness(loc, healer=None)
    ended = await hx.run(recorded["steps"][:1], site + "/index.html?moved=1", autoFix=True)
    assert ended["result"] == "fail"
    step = ended["steps"][0]
    assert step["result"] == "failed" and step["reason"] == "targetNotFound"
    assert step["preDistance"] > 6 and "newAt" not in step
    assert loc.calls == []                                           # the model was never asked
    assert "looking" not in [d["state"] for d in hx.of("run.step")]


async def test_run_reports_where_it_ran_and_no_mismatch_on_the_same_system(site, recorded):
    from breakpatch_engine import systems
    hx = Harness()
    ended = await hx.run(recorded["steps"][:1], site + "/index.html")      # an older test: no recordedOn
    assert ended["result"] == "pass" and "systemMismatch" not in ended
    here = ended["ranOn"]                                                   # the running Chromium's version
    assert here["os"] == systems.os_family() and systems.major(here["chromium"])
    ended = await hx.run(recorded["steps"][:1], site + "/index.html", recordedOn=dict(here, osVersion="0.1"))
    assert ended["result"] == "pass", ended
    assert "systemMismatch" not in ended


async def test_recorded_on_another_system_is_explained_and_real_changes_still_fail(site, recorded):
    hx = Harness()
    other = {"os": "Windows", "osVersion": "11", "arch": "x86_64", "chromium": "120.0.6099.5"}
    ended = await hx.run(recorded["steps"], site + "/index.html", recordedOn=other)
    assert ended["result"] == "pass", ended
    m = ended["systemMismatch"]
    assert m["relaxed"] is True and m["differences"][0] == "os" and m["recordedOn"]["os"] == "Windows"
    assert m["message"].startswith("This test was recorded on Windows and ran on ")
    # A moved button is still a moved button with the checks relaxed.
    ended = await hx.run(recorded["steps"][:1], site + "/index.html?moved=1", recordedOn=other)
    assert ended["result"] == "fail" and ended["steps"][0]["reason"] == "targetNotFound"
    assert ended["systemMismatch"]["relaxed"] is True
    # "Allow for small differences between systems" off: still explained, checks strict.
    hx.ended.clear()
    await hx.call("run.start", {"runId": "r2", "startUrl": site + "/index.html", "viewport": VIEWPORT,
                                "steps": recorded["steps"][:1], "recordedOn": other, "secrets": {},
                                "settings": {"autoFix": False, "failOnFix": False, "allowSystemDifferences": False}})
    await asyncio.wait_for(hx.ended.wait(), 60)
    ended = hx.of("run.ended")[-1]
    assert ended["result"] == "pass" and ended["systemMismatch"]["relaxed"] is False


def test_community_engine_has_no_healer():
    from breakpatch_engine import plugins
    try:
        import breakpatch_team_engine  # noqa: F401
    except ModuleNotFoundError:
        assert plugins.healer() is None
    else:
        pytest.skip("the Team engine is installed in this environment")


async def test_no_change_after_click(site, recorded):
    hx = Harness()
    ended = await hx.run(recorded["steps"][:1], site + "/index.html?broken=1")
    assert ended["steps"][0]["reason"] == "noChange"


async def test_missing_secret_fails_before_any_action(site, recorded):
    hx = Harness()
    Handler.calls.clear()
    steps = copy.deepcopy(recorded["steps"])
    steps[1] = {**steps[1], "text": None, "secretRef": "TEST_PASSWORD"}
    ended = await hx.run(steps, site + "/index.html", setUp={"method": "POST", "url": site + "/api/seed"})
    assert ended["result"] == "fail"
    assert [s["result"] for s in ended["steps"]] == ["notRun", "failed", "notRun"]
    assert ended["steps"][1]["reason"] == "secretMissing"
    assert Handler.calls == []            # not even the set-up call ran
    ok = await hx.run(steps, site + "/index.html", secrets={"TEST_PASSWORD": "Alpha"})
    assert ok["result"] == "pass", ok


async def test_set_up_failure_stops_before_step_one_and_clean_up_runs(site, recorded):
    hx = Harness()
    Handler.calls.clear()
    ended = await hx.run(recorded["steps"], site + "/index.html",
                         setUp={"method": "POST", "url": site + "/api/fail"},
                         cleanUp={"method": "POST", "url": site + "/api/cleanup", "alsoOnFailure": True})
    assert ended["result"] == "fail"
    assert ended["steps"][0]["reason"] == "setUpFailed"
    assert Handler.calls == [("POST", "/api/fail"), ("POST", "/api/cleanup")]


async def test_set_up_and_clean_up_around_a_passing_run(site, recorded):
    hx = Harness()
    Handler.calls.clear()
    ended = await hx.run(recorded["steps"][:1], site + "/index.html",
                         setUp={"method": "POST", "url": site + "/api/seed"},
                         cleanUp={"method": "DELETE", "url": site + "/api/cleanup"})
    assert ended["result"] == "pass"
    assert Handler.calls == [("POST", "/api/seed")]   # DELETE isn't handled by the fixture: logged, not fatal
    assert ended.get("cleanUpFailed") is True


async def test_loop_group_and_repeat_number(site):
    hx = Harness()
    add = {"id": "add", "ignore": NOISE, "action": "click", "label": "Click Add row", "at": [90, 556]}
    typ = {"id": "typ", "ignore": NOISE, "action": "write", "label": "Write", "at": [150, 314], "text": "row {i};"}
    wait = {"id": "w", "ignore": NOISE, "action": "waitFor", "label": "Wait", "durationMs": 50}
    loop = {"id": "loop", "action": "loop", "label": "Repeat 3 times", "count": 3, "steps": [add, typ]}
    group = {"id": "g", "action": "group", "label": "Shared", "groupId": "grp", "groupVersion": 1, "steps": [wait]}
    check_steps = [loop, group]
    ended = await hx.run(check_steps, site + "/index.html")
    assert ended["result"] == "pass", ended
    assert [s["stepId"] for s in ended["steps"]] == ["loop", "add", "typ", "g", "w"]
    assert all(s["result"] == "passed" for s in ended["steps"])
    iters = [d.get("iteration") for d in hx.of("run.step") if d["stepId"] == "typ" and d["state"] == "passed"]
    assert iters == [1, 2, 3]


async def test_typed_repeat_numbers_reach_the_page(site):
    hx = Harness()
    await hx.call("browser.open", {"url": site + "/index.html", "viewport": VIEWPORT})
    try:
        loop = {"id": "loop", "action": "loop", "count": 2, "steps": [
            {"id": "typ", "ignore": NOISE, "action": "write", "at": [150, 314], "text": "{i}-"}]}
        from breakpatch_engine.actions import Context
        from breakpatch_engine.runner import Runner
        r = Runner(hx.engine.browser, lambda: NoLocator(), Timings.fast(), hx.emit)
        r.index = {id(loop): 0, id(loop["steps"][0]): 1}
        r.results = [{"stepId": "loop", "result": "notRun"}, {"stepId": "typ", "result": "notRun"}]
        r.run_id, r.auto_fix, r.message = "x", False, None
        assert await r._run_list([loop], Context(Timings.fast()), asyncio.Event(), None)
        value = await hx.engine.browser.page.input_value("#name")   # test-only peek at the DOM
        assert value == "1-2-"
    finally:
        await hx.call("browser.close")


async def test_stop_after_current_step(site):
    hx = Harness()
    steps = [{"id": f"w{i}", "action": "waitFor", "label": "Wait", "durationMs": 400} for i in range(5)]
    await hx.call("run.start", {"runId": "stopme", "startUrl": site + "/index.html", "viewport": VIEWPORT,
                                "steps": steps, "settings": {"autoFix": False, "failOnFix": False}, "secrets": {}})
    while not [d for d in hx.of("run.step") if d["state"] == "running"]:
        await asyncio.sleep(0.02)
    with pytest.raises(EngineError) as e:
        await hx.call("run.start", {"runId": "other", "startUrl": "", "viewport": VIEWPORT, "steps": [],
                                    "settings": {}, "secrets": {}})
    assert e.value.code == "busy"
    await hx.call("run.stop", {"runId": "stopme"})
    await asyncio.wait_for(hx.ended.wait(), 30)
    ended = hx.of("run.ended")[-1]
    assert ended["result"] == "fail"
    results = [s["result"] for s in ended["steps"]]
    assert "stopped" in [s.get("reason") for s in ended["steps"]]
    assert results.count("passed") <= 2 and results[-1] == "notRun"


async def test_popup_upload_and_download(site):
    hx = Harness()
    steps = [
        {"id": "up", "ignore": NOISE, "action": "upload", "label": "Upload CSV", "at": [680, 218], "sample": "csv",
         "post": None},
        {"id": "dl", "ignore": NOISE, "action": "downloadCheck", "label": "Check download", "at": [640, 328], "fileType": "csv",
         "minBytes": 5},
        {"id": "pop", "ignore": NOISE, "action": "click", "label": "Open popup", "at": [670, 138]},
        {"id": "tab", "ignore": NOISE, "action": "switchTab", "label": "Switch"},
        {"id": "done", "ignore": NOISE, "action": "click", "label": "Close popup", "at": [100, 118]},
    ]
    ended = await hx.run(steps, site + "/index.html")
    assert ended["result"] == "pass", ended

    bad = [{"id": "dl", "ignore": NOISE, "action": "downloadCheck", "at": [640, 328], "fileType": "pdf"}]
    ended = await hx.run(bad, site + "/index.html")
    assert ended["steps"][0]["reason"] == "unexpectedScreen"
    none = [{"id": "tab", "ignore": NOISE, "action": "switchTab"}]
    ended = await hx.run(none, site + "/index.html")
    assert ended["steps"][0]["reason"] == "timeout"


async def test_record_upload_shows_file_name(site):
    hx = Harness()
    await hx.call("browser.open", {"url": site + "/index.html", "viewport": VIEWPORT})
    try:
        step = (await hx.call("record.point", {"action": "upload", "at": [680, 218], "sample": "pdf"}))["step"]
        assert step["label"] == "Upload PDF" and step["sample"] == "pdf"
        x1, y1, x2, y2 = step["post"]["region"]
        assert y1 <= 250 <= y2 and x1 <= 600          # the file name appeared under the button
        assert await hx.engine.browser.page.text_content("#filename") == "sample.pdf"
    finally:
        await hx.call("browser.close")


async def test_locate_maps_box_and_handles_not_found(site):
    hx = Harness(FakeLocator(MOVED_BOX))
    await hx.call("browser.open", {"url": site + "/index.html", "viewport": VIEWPORT})
    try:
        got = await hx.call("record.locate", {"description": "the Create project button"})
        assert got == {"box": MOVED_BOX, "at": [490.0, 222.0], "target": "the Create project button"}
        hx.locator.box = None
        from breakpatch_engine.protocol import NULL
        assert await hx.call("record.locate", {"description": "a unicorn"}) is NULL
        hx.locator = NoLocator()
        with pytest.raises(EngineError) as e:
            await hx.call("record.locate", {"description": "x"})
        assert e.value.code == "not_ready"
    finally:
        await hx.call("browser.close")


async def test_record_wait_until_and_download_check_after_a_click(site):
    hx = Harness()
    await hx.call("browser.open", {"url": site + "/index.html", "viewport": VIEWPORT})
    try:
        wait = (await hx.call("record.point", {"action": "waitUntil", "region": [230, 55, 400, 95],
                                                "timeoutMs": 4000}))["step"]
        assert wait["region"] == [230, 55, 400, 95] and len(wait["hash"]) == 16 and wait["timeoutMs"] == 4000
        assert "pre" not in wait and "post" not in wait
        click = (await hx.call("record.point", {"action": "click", "at": [640, 328]}))["step"]
        check = (await hx.call("record.point", {"action": "downloadCheck", "fileType": "csv"}))["step"]
        assert check["label"] == "Check a csv file was downloaded"
        # A second check with no new download fails plainly.
        with pytest.raises(EngineError) as e:
            await hx.call("record.point", {"action": "downloadCheck"})
        assert "No file was downloaded" in e.value.message
        secret = {"action": "write", "at": [150, 314], "secretRef": "PW"}
        with pytest.raises(EngineError) as e:
            await hx.call("record.point", secret)
        assert e.value.code == "not_found" and "PW" in e.value.message
        typed = (await hx.call("record.point", {**secret, "secrets": {"PW": "hunter2"}}))["step"]
        assert typed["secretRef"] == "PW" and "secrets" not in typed and "hunter2" not in str(typed)
    finally:
        await hx.call("browser.close")
    ended = await hx.run([wait, click, check], site + "/index.html")
    assert ended["result"] == "pass", ended


async def test_nested_loops_use_the_innermost_repeat_number(site):
    hx = Harness()
    inner = {"id": "in", "action": "loop", "count": 2, "steps": [
        {"id": "w", "action": "waitFor", "durationMs": 10, "ignore": NOISE}]}
    outer = {"id": "out", "action": "loop", "count": 3, "steps": [inner]}
    ended = await hx.run([outer], site + "/index.html")
    assert ended["result"] == "pass", ended
    assert [s["stepId"] for s in ended["steps"]] == ["out", "in", "w"]
    iters = [d.get("iteration") for d in hx.of("run.step") if d["stepId"] == "w" and d["state"] == "passed"]
    assert iters == [1, 2, 1, 2, 1, 2]


async def test_frames_only_on_change_and_at_most_about_10_per_second(site):
    import time
    hx = Harness()
    stamps = []
    hx.engine.browser.on_frame = lambda d: stamps.append(time.monotonic())
    await hx.call("browser.open", {"url": site + "/index.html", "viewport": VIEWPORT})   # clock ticks 20x/s
    try:
        await asyncio.sleep(1.2)
        t = time.monotonic()
        await asyncio.sleep(1.0)
        busy = [s for s in stamps if s >= t]
        assert 3 <= len(busy) <= 11, len(busy)
        await hx.call("browser.navigate", {"nav": "url", "url": site + "/popup.html"})        # a still page
        await asyncio.sleep(0.8)
        t = time.monotonic()
        await asyncio.sleep(1.0)
        assert len([s for s in stamps if s >= t]) <= 1
    finally:
        await hx.call("browser.close")
