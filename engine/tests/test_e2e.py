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
        frame = got.pop("frame")
        assert got == {"box": MOVED_BOX, "at": [490.0, 222.0], "target": "the Create project button"}
        assert isinstance(frame, int) and 0 < frame <= hx.engine.browser.last_seq   # the frame shown as the box was found
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


# ---------- a click acts on the frame the user saw ----------

STILL_ADD = [170, 222]      # centre of "Add" on still.html


async def _latest_frame(hx, timeout=5.0):
    end = asyncio.get_running_loop().time() + timeout
    while not hx.of("frame"):
        assert asyncio.get_running_loop().time() < end, "no live view frames"
        await asyncio.sleep(0.05)
    await asyncio.sleep(0.3)                 # let the first paint settle
    return hx.of("frame")[-1]["seq"]


async def test_a_click_on_a_frame_that_is_out_of_date_is_refused_and_not_sent(site):
    hx = Harness()
    await hx.call("browser.open", {"url": site + "/still.html", "viewport": VIEWPORT})
    try:
        seen = await _latest_frame(hx)
        page = hx.engine.browser.page
        # The page moves on (a dialog opens over the button) before the click reaches the engine.
        await page.evaluate("""() => { const d = document.createElement('div');
            d.style.cssText = 'position:absolute;left:60px;top:160px;width:260px;height:140px;background:#a33';
            document.body.appendChild(d); }""")
        await asyncio.sleep(0.3)
        with pytest.raises(EngineError) as e:
            await hx.call("record.point", {"action": "click", "at": STILL_ADD, "frame": seen})
        assert e.value.code == "stale" and "nothing was clicked" in e.value.message
        assert "acting" not in [d["phase"] for d in hx.of("record.checking")]
        assert await page.text_content("#n") == "Clicks: 0"
        # On the frame the page shows now, the same click records (it lands on the dialog).
        now = hx.of("frame")[-1]["seq"]
        assert now > seen
        step = (await hx.call("record.point", {"action": "click", "at": STILL_ADD, "frame": now}))["step"]
        assert step["at"] == STILL_ADD
    finally:
        await hx.call("browser.close")


async def test_a_box_drawn_on_an_out_of_date_frame_is_refused(site):
    hx = Harness()
    await hx.call("browser.open", {"url": site + "/still.html", "viewport": VIEWPORT})
    try:
        seen = await _latest_frame(hx)
        await hx.engine.browser.page.evaluate("document.getElementById('n').textContent = 'Something else entirely'")
        await asyncio.sleep(0.3)
        with pytest.raises(EngineError) as e:
            await hx.call("record.checkpoint", {"region": [90, 290, 330, 330], "frame": seen})
        assert e.value.code == "stale" and "Draw it again" in e.value.message
        check = (await hx.call("record.checkpoint", {"region": [90, 290, 330, 330], "frame": hx.of("frame")[-1]["seq"]}))["step"]
        assert check["region"] == [90, 290, 330, 330]
    finally:
        await hx.call("browser.close")


async def test_a_click_on_a_still_page_goes_at_once_and_is_named_after(site):
    import time

    class SlowNamer(FakeLocator):
        def __init__(self):
            super().__init__(None)
            self.phases_when_asked = None

        async def describe(self, image, at):
            self.phases_when_asked = [d["phase"] for d in hx.of("record.checking")]
            await asyncio.sleep(0.5)
            return {"name": "Add button", "target": "Add button, top left"}

    hx = Harness(SlowNamer())
    stamps = {}
    emit = hx.emit

    def stamp(event, data):
        if event == "record.checking":
            stamps.setdefault(data["phase"], time.monotonic())
        emit(event, data)
    hx.engine.emit = stamp
    await hx.call("browser.open", {"url": site + "/still.html", "viewport": VIEWPORT})
    try:
        seen = await _latest_frame(hx)
        await asyncio.sleep(hx.engine.timings.noise_watch + 0.2)      # the page has sat still for a whole watch
        t0 = time.monotonic()
        step = (await hx.call("record.point", {"action": "click", "at": STILL_ADD, "frame": seen}))["step"]
        assert stamps["acting"] - t0 < hx.engine.timings.noise_watch / 2, "the click waited for a noise watch"
        assert await hx.engine.browser.page.text_content("#n") == "Clicks: 1"
        # The page names its own button, so the AI assistant isn't asked at all.
        assert hx.locator.phases_when_asked is None
        assert step["label"] == "Click Add button" and step["target"].startswith("Add button, ")
        # Given a target (a step found with the AI assistant), it keeps it and still gets a name.
        step = (await hx.call("record.point", {"action": "click", "at": STILL_ADD, "target": "the add button"}))["step"]
        assert step["label"] == "Click Add button" and step["target"] == "the add button"
    finally:
        await hx.call("browser.close")


async def test_scrolling_waits_while_a_step_records(site):
    hx = Harness()
    await hx.call("browser.open", {"url": site + "/still.html", "viewport": VIEWPORT})
    try:
        hx.engine._activity = "recording"
        with pytest.raises(EngineError) as e:
            await hx.call("browser.pointer", {"kind": "scroll", "at": [10, 10], "dy": 100})
        assert e.value.code == "busy"
        hx.engine._activity = None
        assert await hx.call("browser.pointer", {"kind": "scroll", "at": [10, 10], "dy": 100}) == {}
    finally:
        await hx.call("browser.close")


async def test_a_step_saved_before_these_changes_still_replays(site):
    """Steps saved by the current release (no new fields): the file format is unchanged."""
    old = {"id": "s1a2b3c4", "action": "click", "label": "Click Add", "target": "The Add button", "at": [170, 222],
           "pre": None, "post": None, "ignore": []}
    hx = Harness()
    await hx.call("browser.open", {"url": site + "/still.html", "viewport": VIEWPORT})
    try:
        seen = await _latest_frame(hx)
        rec = (await hx.call("record.point", {"action": "click", "at": STILL_ADD, "frame": seen}))["step"]
    finally:
        await hx.call("browser.close")
    assert set(rec) <= {"id", "action", "label", "target", "at", "pre", "post", "ignore", "expect"}, set(rec)   # expect: optional
    old.update(pre=rec["pre"], post=rec["post"])
    ended = await hx.run([old], site + "/still.html")
    assert ended["result"] == "pass", ended


# ---------- a click that misses must not pass ----------

SIGNIN_NEXT = [400, 214]      # centre of Next on signin.html (the card starts at y 80)


async def test_a_click_that_misses_a_button_that_moves_on_fails(site):
    hx = Harness()
    await hx.call("browser.open", {"url": site + "/signin.html", "viewport": VIEWPORT})
    try:
        page = hx.engine.browser.page
        box = await page.eval_on_selector("#next", "e => { const r = e.getBoundingClientRect(); return [r.left, r.top, r.right, r.bottom]; }")
        at = [round((box[0] + box[2]) / 2), round((box[1] + box[3]) / 2)]
        step = (await hx.call("record.point", {"action": "click", "at": at}))["step"]
        assert await page.text_content("#h") == "Enter your password"
    finally:
        await hx.call("browser.close")
    post = step["post"]
    assert post["expectChange"] is True and 0 < post["change"] <= 1
    ok = await hx.run([step], site + "/signin.html")
    assert ok["result"] == "pass", ok
    # Next does nothing now; the pointer still changes its colour, which alone used to pass.
    missed = await hx.run([step], site + "/signin.html?dead=1")
    assert missed["result"] == "fail", missed
    assert missed["steps"][0]["reason"] == "noChange"
    # However fast the page moved on, and even if the recording saw more of it change (a
    # transition caught half way), a click that brought the recorded result passes.
    eager = {**step, "post": {**post, "change": 1.0}}
    assert (await hx.run([eager], site + "/signin.html"))["result"] == "pass"
    assert (await hx.run([eager], site + "/signin.html?dead=1"))["result"] == "fail"
    # A step saved before `change` existed keeps the old rule and still loads and runs.
    old = {**step, "post": {k: v for k, v in post.items() if k != "change"}}
    assert (await hx.run([old], site + "/signin.html"))["result"] == "pass"


# ---------- the live view is the page the engine clicks ----------

async def test_the_recording_browser_is_the_same_size_as_a_run_and_its_frames(site):
    hx = Harness()
    vp = {"width": 1440, "height": 900}
    where = "() => { const r = document.getElementById('next').getBoundingClientRect(); return [innerWidth, innerHeight, r.top]; }"
    await hx.call("browser.open", {"url": site + "/signin.html", "viewport": vp})
    try:
        await _latest_frame(hx)
        recording = await hx.engine.browser.page.evaluate(where)
        f = hx.of("frame")[-1]
        assert (f["width"], f["height"]) == (1440, 900)
        from breakpatch_engine.browser import frame_size
        assert frame_size(f["jpeg"]) == (1440, 900)
    finally:
        await hx.call("browser.close")
    # The same page during a run (read while its one step waits).
    hx.ended.clear()
    await hx.call("run.start", {"runId": "r-size", "startUrl": site + "/signin.html", "viewport": vp,
                                "steps": [{"id": "w", "action": "waitFor", "durationMs": 1500}],
                                "settings": {"autoFix": False, "failOnFix": False}, "secrets": {}})
    running = None
    for _ in range(100):
        await asyncio.sleep(0.05)
        page = hx.engine.browser.page
        if page is not None and page.url.endswith("/signin.html"):
            try:
                running = await page.evaluate(where)
                break
            except Exception:  # noqa: BLE001 - still loading
                pass
    await asyncio.wait_for(hx.ended.wait(), 30)
    assert recording == running == [1440, 900, recording[2]]


async def test_frames_cut_short_by_a_small_screen_switch_the_live_view_to_screenshots(site):
    import base64
    import io
    from PIL import Image
    hx = Harness()
    await hx.call("browser.open", {"url": site + "/signin.html", "viewport": {"width": 1440, "height": 900}})
    try:
        await _latest_frame(hx)
        stream = hx.engine.browser._stream
        buf = io.BytesIO()
        Image.new("RGB", (1440, 812)).save(buf, "JPEG")      # what a 900 px high Mac screen gave
        n = len(hx.of("frame"))
        stream._on_frame({"data": base64.b64encode(buf.getvalue()).decode(), "sessionId": 0,
                          "metadata": {"deviceWidth": 1440, "deviceHeight": 812}})
        await hx.engine.browser.page.evaluate("document.getElementById('h').textContent = 'Changed'")
        await asyncio.sleep(1.0)
        assert stream.poll_task is not None and stream.cdp is None
        later = hx.of("frame")[n:]
        assert later and all((f["width"], f["height"]) == (1440, 900) for f in later)
    finally:
        await hx.call("browser.close")


# ---------- Run and Play to here in the recorder ----------

async def test_play_to_here_and_run_in_the_recorder_keep_the_browser_open(site):
    hx = Harness()
    await hx.call("browser.open", {"url": site + "/still.html", "viewport": VIEWPORT})
    try:
        await _latest_frame(hx)
        steps = [(await hx.call("record.point", {"action": "click", "at": STILL_ADD}))["step"] for _ in range(3)]
    finally:
        await hx.call("browser.close")
    loop = {"id": "L", "action": "loop", "count": 1, "steps": [steps[1]]}
    plan = [steps[0], loop, steps[2]]
    Handler.calls.clear()
    clean_up = {"method": "POST", "url": site + "/api/clean"}
    # Play to here: steps 1 and 2 (inside a repeat), then stop, with the page left where they got it.
    ended = await hx.run(plan, site + "/still.html", keepOpen=True, upToStepId=steps[1]["id"], cleanUp=clean_up)
    assert ended["result"] == "pass", ended
    assert [r["result"] for r in ended["steps"]] == ["passed", "passed", "passed", "notRun"]
    page = hx.engine.browser.page
    assert page is not None and await page.text_content("#n") == "Clicks: 2"
    assert Handler.calls == []                                  # no clean-up: recording goes on from here
    # Recording carries on in the same browser.
    more = (await hx.call("record.point", {"action": "click", "at": STILL_ADD}))["step"]
    assert await page.text_content("#n") == "Clicks: 3" and more["post"]["expectChange"]
    # Run: every step from a fresh start, and the browser stays open at the end.
    ended = await hx.run(plan, site + "/still.html", keepOpen=True)
    assert ended["result"] == "pass", ended
    assert await hx.engine.browser.page.text_content("#n") == "Clicks: 3"
    with pytest.raises(EngineError) as e:
        await hx.call("run.start", {"runId": "x", "startUrl": site + "/still.html", "viewport": VIEWPORT, "steps": plan,
                                    "upToStepId": "nope", "settings": {}, "secrets": {}})
    assert e.value.code == "bad_request"
    await hx.call("browser.close")
    # A plain run still closes the browser.
    await hx.run(plan, site + "/still.html")
    assert hx.engine.browser.page is None


async def test_a_click_that_loads_a_new_page_at_once_passes(site):
    hx = Harness()
    await hx.call("browser.open", {"url": site + "/signin.html?nav=1", "viewport": VIEWPORT})
    try:
        page = hx.engine.browser.page
        box = await page.eval_on_selector("#next", "e => { const r = e.getBoundingClientRect(); return [r.left, r.top, r.right, r.bottom]; }")
        step = (await hx.call("record.point", {"action": "click", "at": [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2]}))["step"]
        assert "step=2" in page.url
    finally:
        await hx.call("browser.close")
    assert step["post"]["expectChange"] is True
    for _ in range(3):
        ok = await hx.run([step], site + "/signin.html?nav=1")
        assert ok["result"] == "pass", ok
    assert (await hx.run([step], site + "/signin.html?nav=1&dead=1"))["steps"][0]["reason"] == "noChange"


# ---------- typing: no blinking cursor, no long wait ----------

async def test_no_blinking_cursor_so_typing_settles_at_once(site):
    import time
    hx = Harness()
    stamps = []
    await hx.call("browser.open", {"url": site + "/field.html", "viewport": VIEWPORT})
    try:
        page = hx.engine.browser.page
        assert await page.evaluate("getComputedStyle(document.getElementById('f')).caretColor") == "rgba(0, 0, 0, 0)"
        hx.engine.browser.on_frame = lambda d: stamps.append(time.monotonic())
        hx.engine.browser._stream.sink = hx.engine.browser.on_frame
        await asyncio.sleep(0.8)
        t = time.monotonic()
        await asyncio.sleep(1.5)
        assert len([s for s in stamps if s >= t]) == 0            # a focused field sends no frames by itself
        t0 = time.monotonic()
        step = (await hx.call("record.point", {"action": "write", "text": "hunter2"}))["step"]
        assert time.monotonic() - t0 < 2.5
        assert "reloading" not in [d["phase"] for d in hx.of("record.checking")]
        assert await page.input_value("#f") == "hunter2"
    finally:
        await hx.call("browser.close")
    ended = await hx.run([step], site + "/field.html")
    assert ended["result"] == "pass", ended


# ---------- a click on the live view is only a proposal until confirmed ----------

async def test_propose_names_the_element_and_touches_nothing(site):
    hx = Harness(FakeLocator(None))
    await hx.call("browser.open", {"url": site + "/still.html", "viewport": VIEWPORT})
    try:
        await _latest_frame(hx)
        got = await hx.call("record.propose", {"at": STILL_ADD})
        assert got["box"] == [100, 200, 240, 244]                   # the Add button
        assert got["name"] == "Add button" and got["target"].startswith("Add button")        # the page's own name
        assert isinstance(got["frame"], int)
        assert await hx.engine.browser.page.text_content("#n") == "Clicks: 0"   # nothing was clicked
        quick = await hx.call("record.propose", {"at": [700, 580], "name": False})
        assert "name" not in quick and "box" not in quick           # the page itself: no box
    finally:
        await hx.call("browser.close")


# ---------- a click that opens the page's file picker ----------

async def _click_and_choose(hx, choice):
    n = len(hx.of("record.fileChooser"))
    rec = asyncio.ensure_future(hx.call("record.point", {"action": "click", "at": [190, 60]}))
    for _ in range(200):
        if len(hx.of("record.fileChooser")) > n or rec.done():
            break
        await asyncio.sleep(0.02)
    if rec.done():
        return (await rec)["step"]
    ev = hx.of("record.fileChooser")[-1]
    assert ev == {"accept": "image/*", "multiple": False}
    assert "choosing" in [d["phase"] for d in hx.of("record.checking")]
    await hx.call("record.chooseFile", choice)
    return (await rec)["step"]


async def test_a_page_file_picker_asks_the_app_and_records_an_upload(site, tmp_path):
    files = tmp_path / "files"
    files.mkdir()
    (files / "photo.jpg").write_bytes(b"\xff\xd8\xff" + b"0" * 100)
    hx = Harness()
    await hx.call("browser.open", {"url": site + "/upload.html", "viewport": VIEWPORT})
    try:
        page = hx.engine.browser.page
        own = await _click_and_choose(hx, {"file": "files/photo.jpg", "path": str(files / "photo.jpg")})
        assert own["action"] == "upload" and own["file"] == "files/photo.jpg" and "sample" not in own
        assert own["label"] == "Upload photo.jpg"
        assert await page.text_content("#names") == "photo.jpg 103"
        step = await _click_and_choose(hx, {"sample": "jpeg"})
        assert step["action"] == "upload" and step["sample"] == "jpeg" and step["label"] == "Upload JPEG image"
        assert (await page.text_content("#names")).startswith("sample.jpeg ")
        with pytest.raises(EngineError):                                          # outside files/
            await _click_and_choose(hx, {"file": "files/../x.jpg", "path": str(files / "photo.jpg")})
        plain = await _click_and_choose(hx, {"cancel": True})
        assert plain["action"] == "click"
        with pytest.raises(EngineError):
            await hx.call("record.chooseFile", {"cancel": True})                   # nothing waiting
    finally:
        await hx.call("browser.close")
    ok = await hx.run([own, step], site + "/upload.html", filesDir=str(files))
    assert ok["result"] == "pass", ok
    (files / "photo.jpg").unlink()
    gone = await hx.run([own], site + "/upload.html", filesDir=str(files))
    assert gone["steps"][0]["reason"] == "fileMissing"
    assert gone["message"] == "files/photo.jpg isn't in the tests folder."


# ---------- typing into a field that hides what's typed ----------

async def test_a_masked_field_is_flagged_and_left_out_of_the_checks(site):
    hx = Harness()
    await hx.call("browser.open", {"url": site + "/password.html", "viewport": VIEWPORT})
    try:
        step = (await hx.call("record.point", {"action": "write", "text": "hunter2"}))["step"]
        typed = (await hx.call("record.point", {"action": "write", "text": "x"}))["step"]     # later steps too
    finally:
        await hx.call("browser.close")
    assert step["masked"] is True and step["label"] == 'Write "' + "•" * 8 + '"'
    assert step["text"] == "hunter2"
    inside = [30, 30, 400, 55]                                     # well inside the field (left 20, top 20)
    covers = lambda boxes: any(b[0] <= inside[0] and b[1] <= inside[1] and b[2] >= inside[2] and b[3] >= inside[3] and b[1] >= 20 for b in boxes)  # noqa: E731
    assert covers(step["ignore"]) and covers(typed["ignore"]), step["ignore"]
    # The check around the field still covers the line under it.
    region = step["post"]["region"]
    assert region[1] <= 70 and region[3] >= 94, region
    assert (await hx.run([step], site + "/password.html"))["result"] == "pass"
    longer = {**step, "text": "a much longer secret value than before"}
    assert (await hx.run([longer], site + "/password.html"))["result"] == "pass"
    other = await hx.run([step], site + "/password.html?other=1")
    assert other["result"] == "fail", other


async def test_a_plain_field_is_not_masked(site):
    hx = Harness()
    await hx.call("browser.open", {"url": site + "/field.html", "viewport": VIEWPORT})
    try:
        step = (await hx.call("record.point", {"action": "write", "text": "hello"}))["step"]
    finally:
        await hx.call("browser.close")
    assert "masked" not in step and step["label"] == 'Write "hello"'


# ---------- closing a dialog over a page that looks different now ----------

async def test_closing_a_dialog_passes_when_it_is_gone_though_the_page_behind_differs(site):
    hx = Harness()
    await hx.call("browser.open", {"url": site + "/dialog.html", "viewport": VIEWPORT})
    try:
        step = (await hx.call("record.point", {"action": "click", "at": [572, 178]}))["step"]
        assert await hx.engine.browser.page.query_selector("#dlg") is None
    finally:
        await hx.call("browser.close")
    assert step["post"]["expectChange"] is True
    same = await hx.run([step], site + "/dialog.html")
    assert same["result"] == "pass" and "passedBy" not in same["steps"][0], same
    other = await hx.run([step], site + "/dialog.html?bg=2")
    assert other["result"] == "pass", other
    assert other["steps"][0]["passedBy"] == "gone"
    assert any(d.get("passedBy") == "gone" for d in hx.of("run.step"))
    faded = await hx.run([step], site + "/dialog.html?bg=2&fade=1")
    assert faded["result"] == "pass", faded
    for bad in ("stay=1", "partial=1"):
        failed = await hx.run([step], site + "/dialog.html?bg=2&" + bad)
        assert failed["result"] == "fail", (bad, failed)



# ---------- "What should happen" ----------

async def _record_one(site, url, params, locator=None):
    hx = Harness(locator)
    await hx.call("browser.open", {"url": site + url, "viewport": VIEWPORT})
    try:
        page = hx.engine.browser.page
        if "at" not in params and "sel" in params:
            b = await page.eval_on_selector(params.pop("sel"), "e => { const r = e.getBoundingClientRect(); return [(r.left + r.right) / 2, (r.top + r.bottom) / 2]; }")
            params["at"] = b
        step = (await hx.call("record.point", params))["step"]
    finally:
        await hx.call("browser.close")
    return hx, step


async def test_what_should_happen_is_suggested_from_the_screen(site):
    _, nav = await _record_one(site, "/signin.html?nav=1", {"action": "click", "sel": "#next"})
    _, gone = await _record_one(site, "/dialog.html", {"action": "click", "at": [572, 178]})
    _, shown = await _record_one(site, "/index.html", {"action": "click", "at": BUTTON_AT})
    _, count = await _record_one(site, "/still.html", {"action": "click", "at": STILL_ADD})
    _, still = await _record_one(site, "/still.html", {"action": "hover", "at": [150, 310]})
    assert (nav["expect"], gone["expect"], shown["expect"], count["expect"], still["expect"]) == \
        ("newPage", "closes", "appears", "changes", "noChange")


async def test_each_what_should_happen_passes_and_fails(site):
    hx, count = await _record_one(site, "/still.html", {"action": "click", "at": STILL_ADD})
    run = lambda steps, url: hx.run(steps, site + url)  # noqa: E731
    # Text or a value changes: another value than recorded still passes; no change fails.
    assert (await run([count], "/still.html?start=5"))["result"] == "pass"
    assert (await run([count], "/still.html?dead=1"))["steps"][0]["reason"] == "noChange"
    strict = {**count, "expect": "appears"}                  # must match the recorded result
    assert (await run([strict], "/still.html"))["result"] == "pass"
    # Nothing should change: a change fails, saying so.
    quiet = {**count, "expect": "noChange"}
    changed = await run([quiet], "/still.html")
    assert changed["result"] == "fail" and "expects nothing to change" in changed["message"]
    assert (await run([quiet], "/still.html?dead=1"))["result"] == "pass"
    # A new page opens.
    _, nav = await _record_one(site, "/signin.html?nav=1", {"action": "click", "sel": "#next"})
    assert (await run([nav], "/signin.html?nav=1"))["result"] == "pass"
    assert (await run([nav], "/signin.html?nav=1&dead=1"))["result"] == "fail"
    # Something appears.
    _, shown = await _record_one(site, "/index.html", {"action": "click", "at": BUTTON_AT})
    assert (await run([shown], "/index.html"))["result"] == "pass"
    assert (await run([shown], "/index.html?broken=1"))["result"] == "fail"
    # Something closes: gone over a page that differs passes; still there fails (the #29 case).
    _, gone = await _record_one(site, "/dialog.html", {"action": "click", "at": [572, 178]})
    assert (await run([gone], "/dialog.html?bg=2"))["steps"][0]["passedBy"] == "gone"
    assert (await run([gone], "/dialog.html?bg=2&stay=1"))["result"] == "fail"


async def test_the_note_is_read_only_when_a_check_fails(site):
    class Judge(FakeLocator):
        def __init__(self, happened):
            super().__init__(None)
            self.happened, self.asked = happened, []

        async def judge(self, image, note):
            self.asked.append(note)
            return {"happened": self.happened, "why": "it's still open"}

    _, gone = await _record_one(site, "/dialog.html", {"action": "click", "at": [572, 178]})
    step = {**gone, "expectNote": "Closes the What's new dialog"}
    yes = Harness(Judge(True))
    ok = await yes.run([step], site + "/dialog.html")
    assert ok["result"] == "pass" and yes.locator.asked == []            # passing runs never ask
    stayed = await yes.run([step], site + "/dialog.html?stay=1")
    assert stayed["result"] == "pass" and stayed["steps"][0]["passedBy"] == "note"
    assert stayed["steps"][0]["why"] == "The note says this closes the What's new dialog; it did, so this passed."
    no = Harness(Judge(False))
    failed = await no.run([step], site + "/dialog.html?stay=1")
    assert failed["result"] == "fail"
    assert failed["message"] == "The note says this closes the What's new dialog; it's still open."


async def test_play_this_step_runs_one_step_on_the_page_as_it_is(site):
    hx = Harness()
    await hx.call("browser.open", {"url": site + "/still.html", "viewport": VIEWPORT})
    try:
        await _latest_frame(hx)
        steps = [(await hx.call("record.point", {"action": "click", "at": STILL_ADD}))["step"] for _ in range(3)]
        page = hx.engine.browser.page
        assert await page.text_content("#n") == "Clicks: 3"
        loop = {"id": "L", "action": "loop", "count": 2, "steps": [steps[1]]}
        plan = [steps[0], loop, steps[2]]
        ended = await hx.run(plan, site + "/still.html", keepOpen=True, fromStepId=steps[1]["id"], upToStepId=steps[1]["id"])
        assert ended["result"] == "pass", ended
        assert [r["result"] for r in ended["steps"]] == ["notRun", "passed", "passed", "notRun"]
        assert hx.engine.browser.page is page and await page.text_content("#n") == "Clicks: 4"   # same page, once
    finally:
        await hx.call("browser.close")
    with pytest.raises(EngineError) as e:                          # needs the recorder's open browser
        await hx.call("run.start", {"runId": "x", "startUrl": site, "viewport": VIEWPORT, "steps": plan,
                                    "fromStepId": steps[1]["id"], "settings": {}, "secrets": {}})
    assert e.value.code == "not_ready"



# ---------- a crossfade after a click is paid for by that click, not the next step ----------

async def test_a_crossfade_is_waited_out_by_the_click_that_starts_it(site):
    hx = Harness()
    await hx.call("browser.open", {"url": site + "/crossfade.html", "viewport": VIEWPORT})
    try:
        await _latest_frame(hx)
        click = (await hx.call("record.point", {"action": "click", "at": [160, 260]}))["step"]
        write = (await hx.call("record.point", {"action": "write", "text": "oscar@example.com"}))["step"]
    finally:
        await hx.call("browser.close")
    ended = await hx.run([click, write], site + "/crossfade.html")
    assert ended["result"] == "pass", ended
    c, w = (s["timings"] for s in ended["steps"])
    assert c["settled"] and c["settleMs"] >= 1500, c        # the 2 s fade is the click's own wait
    waited = w["preMs"] + w["settleMs"] + w["postMs"]
    assert waited < 1000, w                                 # the Write doesn't pay for it
    timed = [d for d in hx.of("run.step") if d["state"] == "passed" and d.get("timings")]
    assert timed and all({"preMs", "actionMs", "settleMs", "postMs"} <= set(d["timings"]) for d in timed)
    # No false pass: Login that does nothing still fails.
    assert (await hx.run([click, write], site + "/crossfade.html?dead=1"))["result"] == "fail"


async def test_settle_waits_out_a_slow_fade_that_changes_little_per_frame():
    import numpy as np
    from breakpatch_engine import checks
    level = [0]

    async def shoot():                      # a fade 10 levels per frame: under the "changed" threshold each time
        level[0] = min(200, level[0] + 10)
        return np.full((100, 100, 3), level[0], np.uint8)
    last, settled = await checks.settle(shoot, None, 0.001, 3, 5.0)
    assert settled and int(last[0, 0, 0]) == 200


# ---------- Run and Play to here start from a clean browser, like any run ----------

async def test_run_in_the_recorder_starts_clean_and_play_this_step_keeps_the_page(site):
    hx = Harness()
    await hx.call("browser.open", {"url": site + "/storage.html", "viewport": VIEWPORT})
    try:
        page = hx.engine.browser.page
        await page.evaluate("document.cookie = 'who=oscar'; localStorage.setItem('dismissed', 'yes'); sessionStorage.setItem('s', '1')")
        await page.reload()
        assert await page.text_content("#seen") == "cookie=who=oscar local=yes session=1"
        wait = {"id": "w", "action": "waitFor", "durationMs": 10}
        ended = await hx.run([wait], site + "/storage.html", keepOpen=True)
        assert ended["result"] == "pass", ended
        fresh = hx.engine.browser.page
        assert await fresh.text_content("#seen") == "cookie=- local=- session=-"
        assert fresh.viewport_size == VIEWPORT
        # Recording goes on in that fresh browser, with live view frames of the viewport's size.
        n = len(hx.of("frame"))
        await fresh.evaluate("localStorage.setItem('dismissed', 'again'); document.body.style.background = '#eee'")
        await asyncio.sleep(0.5)
        later = hx.of("frame")[n:]
        assert later and (later[-1]["width"], later[-1]["height"]) == (VIEWPORT["width"], VIEWPORT["height"])
        # Play this step keeps the page as it is: what it stored stays.
        ended = await hx.run([wait], site + "/storage.html", keepOpen=True, fromStepId="w", upToStepId="w")
        assert ended["result"] == "pass"
        assert hx.engine.browser.page is fresh
        assert await fresh.evaluate("localStorage.getItem('dismissed')") == "again"
    finally:
        await hx.call("browser.close")


# ---------- Wait N seconds only waits ----------

async def test_a_seconds_wait_only_waits_and_records_no_checks(site):
    hx = Harness()
    await hx.call("browser.open", {"url": site + "/still.html", "viewport": VIEWPORT})
    try:
        step = (await hx.call("record.point", {"action": "waitFor", "durationMs": 300}))["step"]
    finally:
        await hx.call("browser.close")
    assert step["action"] == "waitFor" and step["durationMs"] == 300 and step["label"].startswith("Wait ")
    assert not {"pre", "post", "ignore", "expect"} & set(step), step
    # A file saved before this rule: a post that no longer matches, and an expect. It still just waits.
    old = {"id": "w", "action": "waitFor", "durationMs": 200, "label": "Wait 2 seconds", "ignore": [],
           "pre": {"region": [0, 0, 100, 100], "hash": "0" * 16, "tolerance": 6},
           "post": {"region": [0, 0, 800, 600], "hash": "f" * 16, "tolerance": 10, "expectChange": True, "change": 0.5},
           "expect": "changes"}
    ended = await hx.run([old], site + "/still.html")
    assert ended["result"] == "pass", ended



# ---------- "Use the page": the user's input goes to the page, nothing is recorded ----------

async def test_using_the_page_by_hand_reaches_it_and_records_nothing(site, caplog):
    import logging
    caplog.set_level(logging.DEBUG, logger="breakpatch")
    hx = Harness()
    await hx.call("browser.open", {"url": site + "/field.html", "viewport": VIEWPORT})
    try:
        page = hx.engine.browser.page
        with pytest.raises(EngineError):
            await hx.call("browser.input", {"kind": "text", "text": "x"})           # only while it's on
        await hx.call("browser.hand", {"on": True})
        await hx.call("browser.input", {"kind": "click", "at": [200, 40]})
        await hx.call("browser.input", {"kind": "text", "text": "hunter2-secret"})
        await hx.call("browser.input", {"kind": "key", "key": "Backspace"})
        await hx.call("browser.input", {"kind": "wheel", "at": [200, 40], "dx": 0, "dy": 50})
        assert await page.input_value("#f") == "hunter2-secre"
        with pytest.raises(EngineError) as e:
            await hx.call("record.point", {"action": "click", "at": [100, 120]})
        assert e.value.code == "busy"
        with pytest.raises(EngineError):
            await hx.call("record.propose", {"at": [100, 120]})
        assert hx.of("record.checking") == []                                        # nothing recorded
        assert "hunter2" not in caplog.text and "Backspace" not in caplog.text        # key values never logged
        await hx.call("browser.hand", {"on": False})
        with pytest.raises(EngineError):
            await hx.call("browser.input", {"kind": "text", "text": "x"})
        # A run afterwards starts in a brand-new browser: nothing typed by hand is there.
        await hx.call("browser.hand", {"on": True})
        ended = await hx.run([{"id": "w", "action": "waitFor", "durationMs": 10}], site + "/field.html", keepOpen=True)
        assert ended["result"] == "pass" and hx.engine._hand is False
        assert await hx.engine.browser.page.input_value("#f") == ""
    finally:
        await hx.call("browser.close")


async def test_a_file_picker_opened_by_hand_only_feeds_the_page(site):
    hx = Harness()
    await hx.call("browser.open", {"url": site + "/upload.html", "viewport": VIEWPORT})
    try:
        await hx.call("browser.hand", {"on": True})
        await hx.call("browser.input", {"kind": "click", "at": [190, 60]})
        for _ in range(250):
            if hx.of("browser.fileChooser"):
                break
            await asyncio.sleep(0.02)
        assert hx.of("browser.fileChooser") == [{"accept": "image/*", "multiple": False}]
        await hx.call("browser.chooseFile", {"sample": "jpeg"})
        await asyncio.sleep(0.2)
        assert (await hx.engine.browser.page.text_content("#names")).startswith("sample.jpeg ")
        assert hx.of("record.fileChooser") == [] and hx.of("record.checking") == []
    finally:
        await hx.call("browser.close")



# ---------- DESK-01: noise never grows over the whole screen ----------

async def test_a_step_that_changes_the_whole_screen_does_not_leave_everything_ignored(site):
    hx = Harness()
    await hx.call("browser.open", {"url": site + "/dialog.html?big=1", "viewport": VIEWPORT})
    try:
        await _latest_frame(hx)
        rec = hx.engine.recorder
        # What a reload of a page that shows a dialog now and then looked like: all of it "moving".
        rec.remember_noise([[0, 0, 800, 600]])
        close = (await hx.call("record.point", {"action": "click", "at": [572, 178]}))["step"]
        after = (await hx.call("record.checkpoint", {"region": [40, 60, 220, 180]}))["step"]
    finally:
        await hx.call("browser.close")
    for step in (close, after):
        assert all(imaging_area(b) < 0.25 * 800 * 600 for b in step["ignore"]), step["ignore"]
    assert after["hash"] != "8000000000000000"


def imaging_area(b):
    return max(0, b[2] - b[0]) * max(0, b[3] - b[1])


async def test_a_check_with_nothing_left_to_compare_is_flagged_not_passed(site):
    """Steps saved with a whole-screen ignore zone (the owner's Test2, steps 12-27)."""
    hx = Harness()
    blank = "8000000000000000"
    wait = {"id": "u", "action": "waitUntil", "region": [0, 0, 800, 600], "hash": blank, "tolerance": 8,
            "timeoutMs": 1000, "ignore": [[0, 0, 800, 600]]}
    check = {"id": "c", "action": "checkpoint", "region": [100, 100, 300, 200], "hash": blank, "tolerance": 8,
             "ignore": [[0, 0, 800, 600]]}
    click = {"id": "k", "action": "click", "at": [170, 222], "ignore": [[0, 0, 800, 600]],
             "pre": {"region": [138, 190, 202, 254], "hash": blank, "tolerance": 6},
             "post": {"region": [0, 0, 800, 600], "hash": blank, "tolerance": 10, "expectChange": False}}
    ended = await hx.run([wait, check, click], site + "/still.html")
    assert ended["result"] == "pass", ended
    assert [s.get("unchecked") for s in ended["steps"]] == [["waitUntil"], ["checkpoint"], ["pre", "post"]]
    assert all(d.get("unchecked") for d in hx.of("run.step") if d["state"] == "passed")


async def test_closing_a_big_dialog_whose_check_is_the_whole_screen_passes_when_gone(site):
    """DESK-05: Test2 step 9, a full-screen after-check with about 0.6 of it changing."""
    _, close = await _record_one(site, "/dialog.html?big=1", {"action": "click", "at": [572, 178]})
    post = close["post"]
    assert post["expectChange"] and close["expect"] == "closes"
    assert imaging_area(post["region"]) > 0.6 * 800 * 600 and 0.3 < post["change"] < 0.9, post
    hx = Harness()
    assert (await hx.run([close], site + "/dialog.html?big=1"))["result"] == "pass"
    other = await hx.run([close], site + "/dialog.html?big=1&bg=2")
    assert other["result"] == "pass" and other["steps"][0].get("passedBy") in (None, "gone"), other
    assert (await hx.run([close], site + "/dialog.html?big=1&bg=2&stay=1"))["result"] == "fail"


async def test_a_click_on_a_frame_too_old_to_be_kept_is_refused(site):
    """DESK-18: an evicted frame counts as stale, and nothing is clicked."""
    hx = Harness()
    await hx.call("browser.open", {"url": site + "/still.html", "viewport": VIEWPORT})
    try:
        seen = await _latest_frame(hx)
        b = hx.engine.browser
        for k in range(1, 205):                      # the page moved on long enough to push it out
            b.remember_frame(seen + 1000 + k, "x")
        with pytest.raises(EngineError) as e:
            await hx.call("record.point", {"action": "click", "at": STILL_ADD, "frame": seen})
        assert e.value.code == "stale"
        assert await b.page.text_content("#n") == "Clicks: 0"
    finally:
        await hx.call("browser.close")


# ---------- DESK-06: a caret the page draws itself doesn't stop the page settling ----------

async def test_a_caret_drawn_on_a_canvas_does_not_hold_up_a_write(site):
    import time
    hx = Harness()
    await hx.call("browser.open", {"url": site + "/canvas.html", "viewport": VIEWPORT})
    try:
        await asyncio.sleep(0.5)
        t0 = time.monotonic()
        step = (await hx.call("record.point", {"action": "write", "text": "oscar@example.com"}))["step"]
        recorded = time.monotonic() - t0
    finally:
        await hx.call("browser.close")
    assert recorded < 4, recorded
    ended = await hx.run([step], site + "/canvas.html")
    assert ended["result"] == "pass", ended
    t = ended["steps"][0]["timings"]
    assert t["settled"] and t["settleMs"] < 1500, t


async def test_settle_leaves_out_a_blinking_spot_but_not_a_real_change():
    import numpy as np
    from breakpatch_engine import checks
    n = [0]

    def frame(blink, big=False):
        a = np.full((100, 100, 3), 255, np.uint8)
        if blink:
            a[40:60, 50:52] = 0                   # the caret
        if big:
            a[0:30, 0:100] = 0                    # something that really changed
        return a

    async def caret():
        n[0] += 1
        return frame(n[0] % 2 == 0)
    last, settled = await checks.settle(caret, None, 0.001, 3, 2.0)
    assert settled

    m = [0]

    async def moving():                           # a caret blinking, and a big area changing every frame
        m[0] += 1
        return frame(m[0] % 2 == 0, big=m[0] % 3 == 0)
    _, settled = await checks.settle(moving, None, 0.001, 3, 0.3)
    assert not settled



async def test_a_file_picker_that_opens_a_second_after_the_click_is_still_caught(site):
    """DESK-07: the click is answered as soon as it settles; a picker that opens later turns it
    into an upload through record.stepChanged."""
    hx = Harness()
    await hx.call("browser.open", {"url": site + "/upload.html", "viewport": VIEWPORT})
    try:
        step = (await hx.call("record.point", {"action": "click", "at": [480, 60]}))["step"]
        assert step["action"] == "click" and not hx.of("record.fileChooser")      # answered before the picker
        for _ in range(300):
            if hx.of("record.fileChooser"):
                break
            await asyncio.sleep(0.02)
        ask = hx.of("record.fileChooser")[-1]
        assert ask["stepId"] == step["id"] and ask["accept"] == "image/*"
        await hx.call("record.chooseFile", {"sample": "jpeg"})
        for _ in range(100):
            if hx.of("record.stepChanged"):
                break
            await asyncio.sleep(0.02)
        changed = hx.of("record.stepChanged")[-1]["step"]
        assert changed["id"] == step["id"] and changed["action"] == "upload" and changed["sample"] == "jpeg"
        assert changed["pre"] == step["pre"]
        await asyncio.sleep(0.3)
        assert (await hx.engine.browser.page.text_content("#names")).startswith("sample.jpeg ")
    finally:
        await hx.call("browser.close")


async def test_a_click_without_a_picker_is_answered_without_the_picker_window(site):
    import time
    from breakpatch_engine.config import Timings
    hx = Harness()
    hx.engine.timings = hx.engine.recorder.t = Timings.fast().with_(chooser_window=4.0)
    await hx.call("browser.open", {"url": site + "/still.html", "viewport": VIEWPORT})
    try:
        await _latest_frame(hx)
        t0 = time.monotonic()
        step = (await hx.call("record.point", {"action": "click", "at": STILL_ADD}))["step"]
        took = time.monotonic() - t0
        assert step["action"] == "click" and took < 3.0, took       # not held for the 4 s window
    finally:
        await hx.call("browser.close")


async def test_a_start_address_that_never_answers_fails_soon_and_plainly():
    import socket
    import time
    srv = socket.socket()
    srv.bind(("127.0.0.1", 0))
    srv.listen(8)                                   # accepts, never answers
    url = f"http://127.0.0.1:{srv.getsockname()[1]}/"
    hx = Harness()
    t0 = time.monotonic()
    try:
        with pytest.raises(EngineError) as e:
            await hx.call("browser.open", {"url": url, "viewport": VIEWPORT})
        took = time.monotonic() - t0
        assert e.value.code == "network" and "didn't load in 3 seconds" in e.value.message, e.value.message
        assert took < hx.engine.timings.start_timeout + 5, took
        ended = await hx.run([{"id": "w", "action": "waitFor", "durationMs": 10}], url)
        assert ended["result"] == "fail" and "didn't load in 3 seconds" in ended["message"]
    finally:
        await hx.call("browser.close")
        srv.close()


async def test_locate_says_not_found_for_a_box_over_most_of_the_page(site):
    """DESK-04: "the purple elephant" came back as the whole screen and got clicked."""
    from breakpatch_engine.protocol import NULL
    hx = Harness(FakeLocator([0, 0, 800, 600]))
    await hx.call("browser.open", {"url": site + "/still.html", "viewport": VIEWPORT})
    try:
        assert await hx.call("record.locate", {"description": "the purple elephant"}) is NULL
        hx.locator.box = [100, 200, 240, 244]
        assert (await hx.call("record.locate", {"description": "the Add button"}))["box"] == [100, 200, 240, 244]
        # A propose box as big as a dialog round a small control isn't shown (DESK-09).
        await hx.engine.browser.page.evaluate("""() => { const d = document.createElement('div');
            d.style.cssText = 'position:absolute;left:20px;top:20px;width:700px;height:500px;background:#eee';
            document.body.appendChild(d); }""")
        got = await hx.call("record.propose", {"at": [400, 500], "name": False})
        assert "box" not in got
    finally:
        await hx.call("browser.close")


def test_the_naming_prompt_has_no_example_to_copy_and_echoes_count_as_unknown():
    """DESK-02."""
    from breakpatch_engine.locator import DESCRIBE_PROMPT, LOCATE_PROMPT, parse_bbox, parse_describe
    assert "Done button" not in DESCRIBE_PROMPT and "Create Project" not in DESCRIBE_PROMPT
    assert '"bbox_2d": null' in LOCATE_PROMPT
    assert parse_describe('{"name": "Done button", "target": "Done button, bottom right of the Create Project dialog"}') is None
    assert parse_describe('{"name": "<its name>", "target": "<its name>, <where it is>"}') is None
    assert parse_describe('{"name": null}') is None
    assert parse_describe('{"name": "Add photo card", "target": "Add photo card, top left"}') == {
        "name": "Add photo card", "target": "Add photo card, top left"}
    assert parse_bbox('{"bbox_2d": null}', 800, 600) is None


async def test_names_come_from_the_page_first_and_blank_space_says_so(site):
    """DESK-03: the page's own name wins over the model's; nothing to name says so plainly."""
    class Echo(FakeLocator):
        async def describe(self, image, at):
            return None                            # the model unsure (or it echoed the prompt)
    hx = Harness(Echo(None))
    await hx.call("browser.open", {"url": site + "/still.html", "viewport": VIEWPORT})
    try:
        named = (await hx.call("record.point", {"action": "click", "at": STILL_ADD}))["step"]
        blank = (await hx.call("record.point", {"action": "click", "at": [600, 500]}))["step"]
    finally:
        await hx.call("browser.close")
    assert named["label"] == "Click Add button"
    assert blank["label"] == "Click the spot you clicked" and blank["target"].startswith("The spot you clicked")
    hx = Harness(FakeLocator(None))                 # the model says "Create project button"
    await hx.call("browser.open", {"url": site + "/canvas.html", "viewport": VIEWPORT})
    try:                                            # a canvas: the page names nothing, the model is used
        drawn = (await hx.call("record.point", {"action": "click", "at": [400, 324]}))["step"]
    finally:
        await hx.call("browser.close")
    assert drawn["label"] == "Click Create project button"
