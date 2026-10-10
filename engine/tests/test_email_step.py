"""Wait for an email (issue #12) in the open engine: `{email}`, `{emailCode}` and `{emailLink}`, the
`register_action` hook the Team engine adds the step through, and what happens without it (Community:
`actionUnavailable`, never a pass). Reading an inbox is the Team engine's (its tests use a fake
Mailpit and a fake IMAP server); here a stand-in action keeps a code and a link."""
import asyncio
import http.server
import json
import logging
import threading
from pathlib import Path

import pytest

from conftest import needs_browser
from breakpatch_engine import labels, plugins, retry
from breakpatch_engine.actions import (ActionFailed, Context, EmailSession, email_address, fill_email, kept_address,
                                       new_email_tag, resolve_text, uses_kept)
from breakpatch_engine.config import Timings
from breakpatch_engine.locator import NoLocator
from breakpatch_engine.protocol import EngineError
from breakpatch_engine.recorder import varies_each_run
from breakpatch_engine.service import Engine

SITE = Path(__file__).parent / "site"
VIEWPORT = {"width": 800, "height": 600}
FIELD_AT = [150, 314]            # the name field on index.html
INBOX = {"kind": "mailpit", "server": "http://127.0.0.1:9", "address": "qa@acme.test"}
CODE = "731905"


@pytest.fixture
def no_actions(monkeypatch):
    """No Team engine actions, whatever is installed (Community)."""
    monkeypatch.setattr(plugins, "_actions", {})
    monkeypatch.setattr(plugins, "_loaded", True)


@pytest.fixture
def fake_wait(monkeypatch):
    """A stand-in for the Team engine's emailWait: keeps CODE and a link to the app's page, and
    records what each call saw (its `{email}`, when its emails count from, the emails used)."""
    seen = []

    async def wait(step, ctx):
        seen.append({"email": ctx.email, "since": ctx.email_since, "used": set(ctx.email_used),
                     "values": dict(ctx.values), "inbox": ctx.inbox})
        if step.get("email", {}).get("fail") == "timeout":
            raise ActionFailed("timeout", f"No email to {ctx.email} arrived within 5 s.")
        ctx.email_used.add(f"m{len(seen)}")
        ctx.values["emailCode"] = (CODE, None)
        ctx.values["emailLink"] = (step.get("email", {}).get("link") or ctx.app_url.rstrip("/") + "/index.html?t=tok-secret", None)
        return {"email": {"got": "code", "chars": 6, "digits": True, "ms": 12}, "value": CODE}

    async def check(params):
        return {"ok": True, "message": "Connected. The inbox has 0 emails."}
    wait.check = check
    monkeypatch.setattr(plugins, "_actions", {"emailWait": wait})
    monkeypatch.setattr(plugins, "_loaded", True)
    return seen


# ---------------------------------------------------------------- {email} and friends, without a browser

def test_email_is_the_inbox_address_with_a_tag_of_its_own():
    assert email_address("qa@acme.com", "k3j9x2ma") == "qa+bp-k3j9x2ma@acme.com"
    assert email_address("QA+old@Acme.COM", "abc") == "QA+bp-abc@acme.com"        # a +tag already there is replaced
    assert email_address("test@localhost", "abc") == "test+bp-abc@localhost"
    for bad in ("", None, "qa", "qa@", "@acme.com", "a b@acme.com", "qa@acme"):
        assert email_address(bad, "abc") is None, bad
    assert email_address("qa@acme.com", "Bad Tag") is None
    tags = {new_email_tag() for _ in range(50)}
    assert len(tags) == 50 and all(len(t) == 8 and t.isalnum() and t.islower() or t.isdigit() for t in tags)


def test_email_tokens_are_filled_next_to_the_other_run_values(fake_wait):
    import datetime as dt
    ctx = Context(Timings.fast(), i=2, email="qa+bp-abc@acme.com")
    now = dt.datetime(2026, 10, 10, 9, 15)
    assert resolve_text({"text": "{email}"}, ctx, now) == "qa+bp-abc@acme.com"
    assert resolve_text({"text": "user {i} <{email}> {date}"}, ctx, now) == "user 2 <qa+bp-abc@acme.com> 2026-10-10"
    assert fill_email("no token", Context(Timings.fast())) == "no token"
    # {emailCode} and {emailLink} aren't filled into plain text: a Write step types them under a guard.
    assert resolve_text({"text": "{emailCode}"}, ctx, now) == "{emailCode}"
    assert uses_kept("Code: {emailCode}") and uses_kept("{emailLink}") and not uses_kept("{email}")
    for text in ("{email}", "{emailCode}", "x {emailLink}"):
        assert varies_each_run({"action": "write", "text": text}), text


def test_email_without_an_inbox_or_the_team_engine_fails_plainly(no_actions, monkeypatch):
    with pytest.raises(ActionFailed) as e:
        fill_email("{email}", Context(Timings.fast()))
    assert e.value.reason == "actionUnavailable" and e.value.message == "{email} needs Breakpatch Team."
    monkeypatch.setattr(plugins, "_actions", {"emailWait": object()})
    with pytest.raises(ActionFailed) as e:
        fill_email("{email}", Context(Timings.fast()))
    assert e.value.reason == "emailFailed" and "Settings, Test inbox" in e.value.message


def test_a_link_from_an_email_opens_only_on_the_apps_site():
    ctx = Context(Timings.fast(), app_url="https://app.acme.com/login",
                  values={"emailLink": ("https://app.acme.com/verify?token=t0k3n", None)})
    assert kept_address("{emailLink}", ctx) == "https://app.acme.com/verify?token=t0k3n"
    ctx.values["emailLink"] = ("https://click.mailer.example/l/abc?u=t0k3n", None)
    with pytest.raises(ActionFailed) as e:
        kept_address("{emailLink}", ctx)
    assert e.value.reason == "emailFailed" and "mailer.example" in e.value.message and "t0k3n" not in e.value.message
    with pytest.raises(ActionFailed) as e:
        kept_address("{emailLink}", Context(Timings.fast(), app_url="https://app.acme.com/"))
    assert e.value.reason == "emailFailed" and "picked out a link" in e.value.message


def test_labels_and_the_retry_policy():
    assert labels.default_label("emailWait", {"email": {"pick": "code"}}) == "Wait for an email with a code"
    assert labels.default_label("emailWait", {"email": {"pick": "link"}}) == "Wait for an email with a link"
    assert labels.default_label("emailWait", {}) == "Wait for an email"
    for reason in ("actionUnavailable", "emailFailed"):
        assert retry.why_retry({"result": "failed", "reason": reason}) is None, reason
    assert retry.why_retry({"result": "failed", "reason": "timeout"}) is not None       # no email in time: another try


def test_the_team_engine_cannot_take_over_a_built_in_action(fresh=None):
    before = dict(plugins._actions)
    try:
        plugins.register_action("click", lambda *a: None)
        plugins.register_action("write", lambda *a: None)
        assert "click" not in plugins._actions and "write" not in plugins._actions
        plugins.register_action("emailWait", None)
        assert "emailWait" not in plugins._actions
    finally:
        plugins._actions.clear()
        plugins._actions.update(before)


# ---------------------------------------------------------------- in a run and while recording

class Site(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass


@pytest.fixture(scope="module")
def site():
    import functools
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Site, directory=str(SITE)))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{srv.server_address[1]}"
    srv.shutdown()


class Harness:
    def __init__(self):
        self.events = []
        self.engine = Engine(self.emit, timings=Timings.fast(), locator_fn=lambda: NoLocator(), healer=None)
        self.h = self.engine.handlers()
        self.ended = asyncio.Event()

    def emit(self, event, data):
        self.events.append((event, data))
        if event == "run.ended":
            self.ended.set()

    def of(self, name):
        return [d for e, d in self.events if e == name]

    async def run(self, steps, url, **kw):
        self.ended.clear()
        await self.h["run.start"]({"runId": kw.pop("runId", "r1"), "startUrl": url, "viewport": VIEWPORT, "steps": steps,
                                   "settings": kw.pop("settings", {}), "secrets": kw.pop("secrets", {}), **kw})
        await asyncio.wait_for(self.ended.wait(), 60)
        return self.of("run.ended")[-1]


WAIT = {"id": "e1", "action": "emailWait", "label": "Wait for an email with a code", "email": {"to": "{email}", "pick": "code"}}


@needs_browser
async def test_without_the_team_engine_the_step_fails_and_never_passes(site, no_actions):
    hx = Harness()
    ended = await hx.run([WAIT, {"id": "w", "action": "waitFor", "durationMs": 10}], site + "/index.html",
                         inbox=INBOX, settings={"retries": 2})
    assert ended["result"] == "fail" and "attempts" not in ended          # never retried
    assert ended["steps"][0]["result"] == "failed" and ended["steps"][0]["reason"] == "actionUnavailable"
    assert ended["message"] == "Waiting for an email needs Breakpatch Team."
    assert "screenshotPath" not in ended["steps"][0] and ended["steps"][1]["result"] == "notRun"
    # {email} in a Write step fails the same way, and nothing is typed.
    write = {"id": "w1", "action": "write", "at": FIELD_AT, "text": "{email}"}
    ended = await hx.run([write], site + "/index.html", inbox=INBOX)
    assert ended["steps"][0]["reason"] == "actionUnavailable" and ended["message"] == "{email} needs Breakpatch Team."
    # Recording one, or checking an inbox, says it needs Team.
    await hx.h["browser.open"]({"url": site + "/index.html", "viewport": VIEWPORT})
    try:
        with pytest.raises(EngineError) as e:
            await hx.h["record.point"]({"action": "emailWait", "email": {"pick": "code"}, "inbox": INBOX})
        assert e.value.code == "not_ready" and "needs Breakpatch Team" in e.value.message
    finally:
        await hx.h["browser.close"]({})
    with pytest.raises(EngineError) as e:
        await hx.h["email.check"]({"inbox": INBOX})
    assert e.value.code == "not_ready"


@needs_browser
async def test_a_run_types_its_address_and_then_the_code_from_the_email(site, fake_wait, caplog):
    caplog.set_level(logging.DEBUG)
    hx = Harness()
    await hx.h["browser.open"]({"url": site + "/index.html", "viewport": VIEWPORT})
    try:
        sign_up = {"id": "w1", "action": "write", "at": FIELD_AT, "text": "{email}"}
        ended = await hx.run([sign_up], site + "/index.html", inbox=INBOX, keepOpen=True)
        assert ended["result"] == "pass", ended
        typed = await hx.engine.browser.page.input_value("#name")
        assert typed.startswith("qa+bp-") and typed.endswith("@acme.test") and len(typed) == len("qa+bp-12345678@acme.test")
        await hx.engine.browser.page.fill("#name", "")
        code = {"id": "w2", "action": "write", "at": FIELD_AT, "text": "Code {emailCode}"}
        ended = await hx.run([sign_up | {"id": "w0"}, WAIT, code], site + "/index.html", inbox=INBOX, keepOpen=True)
        assert ended["result"] == "pass", ended
        assert "Code " + CODE in await hx.engine.browser.page.input_value("#name")      # typed where the click put the caret
        by = {s["stepId"]: s for s in ended["steps"]}
        assert by["e1"]["email"] == {"got": "code", "chars": 6, "digits": True, "ms": 12}
        assert "value" not in by["e1"]                                          # only `email` is taken from the action
        assert fake_wait[-1]["inbox"] == INBOX and fake_wait[-1]["email"].startswith("qa+bp-")
        assert fake_wait[-1]["email"] != typed                                   # each run its own address
        passed = [d for d in hx.of("run.step") if d["stepId"] == "e1" and d["state"] == "passed"]
        assert passed[0]["email"]["got"] == "code"
        assert CODE not in json.dumps(hx.events) and CODE not in caplog.text and "tok-secret" not in caplog.text
    finally:
        await hx.h["browser.close"]({})


@needs_browser
async def test_the_code_lands_in_the_field_and_the_link_opens_the_apps_page(site, fake_wait):
    hx = Harness()
    await hx.h["browser.open"]({"url": site + "/index.html", "viewport": VIEWPORT})
    try:
        code = {"id": "w2", "action": "write", "at": FIELD_AT, "valueRef": "emailCode"}
        go = {"id": "g", "action": "navigate", "nav": "url", "url": "{emailLink}"}
        ended = await hx.run([WAIT, code], site + "/index.html", inbox=INBOX, keepOpen=True)
        assert ended["result"] == "pass", ended
        assert await hx.engine.browser.page.input_value("#name") == CODE
        ended = await hx.run([WAIT, go], site + "/signin.html", inbox=INBOX, keepOpen=True)
        assert ended["result"] == "pass", ended
        assert hx.engine.browser.url.endswith("/index.html?t=tok-secret")
        # A link to another site isn't opened, and its address isn't in the message.
        far = WAIT | {"email": {"pick": "link", "link": "https://evil.example/verify?t=tok-secret"}}
        ended = await hx.run([far, go], site + "/signin.html", inbox=INBOX)
        assert ended["steps"][1]["reason"] == "emailFailed" and "evil.example" in ended["message"]
        assert "tok-secret" not in json.dumps(ended)
    finally:
        await hx.h["browser.close"]({})


@needs_browser
async def test_without_a_wait_step_before_it_a_code_is_not_typed(site, fake_wait):
    hx = Harness()
    ended = await hx.run([{"id": "w2", "action": "write", "at": FIELD_AT, "text": "{emailCode}"}], site + "/index.html",
                         inbox=INBOX)
    assert ended["steps"][0]["reason"] == "emailFailed"
    assert ended["message"] == "No Wait for an email step before this one picked out a code."
    # {email} with the Team engine but no inbox sent: an admin sets one up.
    ended = await hx.run([{"id": "w1", "action": "write", "at": FIELD_AT, "text": "{email}"}], site + "/index.html")
    assert ended["steps"][0]["reason"] == "emailFailed" and "Test inbox" in ended["message"]


@needs_browser
async def test_a_retry_waits_for_a_new_email_at_a_new_address(site, fake_wait, monkeypatch):
    """A try that fails like timing after the email came runs again from the start: a new `{email}`
    address, emails only from the new try on, no kept code, and the emails the first try used stay used."""
    from breakpatch_engine import runner as runner_mod
    real = runner_mod.Runner._run_step

    async def run_step(self, step, ctx, iteration):
        if step["id"] == "slow" and self.attempt == 1:
            raise runner_mod.StepFailed("timeout", "The screen didn't settle in time.")
        return await real(self, step, ctx, iteration)
    monkeypatch.setattr(runner_mod.Runner, "_run_step", run_step)
    hx = Harness()
    slow = {"id": "slow", "action": "waitFor", "durationMs": 10}
    ended = await hx.run([WAIT, slow], site + "/index.html", inbox=INBOX, settings={"retries": 1})
    assert ended["result"] == "pass" and ended["attempts"] == 2, ended
    first, second = fake_wait
    assert first["email"] != second["email"] and second["since"] > first["since"]
    assert second["values"] == {} and first["values"] == {}
    assert second["used"] == {"m1"}                                  # the first try's email stays used

    # No email in time is a timeout: tried again, with a new address.
    fake_wait.clear()
    ended = await hx.run([WAIT | {"email": {"fail": "timeout"}}], site + "/index.html", inbox=INBOX, settings={"retries": 1})
    assert ended["result"] == "fail" and ended["attempts"] == 2
    assert ended["steps"][0]["reason"] == "timeout" and ended["steps"][0]["retried"][0]["reason"] == "timeout"
    assert len({c["email"] for c in fake_wait}) == 2


@needs_browser
async def test_recording_waits_for_the_email_and_later_steps_type_what_it_kept(site, fake_wait):
    hx = Harness()
    await hx.h["browser.open"]({"url": site + "/index.html", "viewport": VIEWPORT})
    try:
        before = hx.engine.recorder.email
        typed = (await hx.h["record.point"]({"action": "write", "at": FIELD_AT, "text": "{email}", "inbox": INBOX}))["step"]
        assert typed["text"] == "{email}" and "post" not in typed
        address = await hx.engine.browser.page.input_value("#name")
        assert address == email_address("qa@acme.test", before.tag)
        await hx.engine.browser.page.fill("#name", "")
        with pytest.raises(EngineError) as e:
            await hx.h["record.point"]({"action": "write", "at": FIELD_AT, "text": "{emailCode}", "inbox": INBOX})
        assert e.value.code == "not_found" and "Play the Wait for an email step" in e.value.message
        step = (await hx.h["record.point"]({"action": "emailWait", "email": {"to": "{email}", "pick": "code"},
                                             "timeoutMs": 30000, "inbox": INBOX, "secrets": {}}))["step"]
        assert step["action"] == "emailWait" and step["label"] == "Wait for an email with a code"
        assert step["email"] == {"to": "{email}", "pick": "code"} and step["timeoutMs"] == 30000
        assert "pre" not in step and "post" not in step and "inbox" not in step
        assert fake_wait[-1]["email"] == address and fake_wait[-1]["since"] == before.since
        got = (await hx.h["record.point"]({"action": "write", "at": FIELD_AT, "text": "{emailCode}", "inbox": INBOX}))["step"]
        assert got["text"] == "{emailCode}" and "post" not in got
        assert await hx.engine.browser.page.input_value("#name") == CODE
        # A Run in the recorder hands over its own address; opening the browser again starts a new one.
        await hx.run([WAIT], site + "/index.html", inbox=INBOX, keepOpen=True)
        assert hx.engine.recorder.email is not before and fake_wait[-1]["email"] != address
    finally:
        await hx.h["browser.close"]({})
    await hx.h["browser.open"]({"url": site + "/index.html", "viewport": VIEWPORT})
    try:
        assert isinstance(hx.engine.recorder.email, EmailSession) and hx.engine.recorder.email.tag != before.tag
        assert (await hx.h["email.check"]({"inbox": INBOX}))["ok"] is True
    finally:
        await hx.h["browser.close"]({})


def test_the_report_says_what_came_never_the_value():
    from breakpatch_engine.report import view
    assert view.email_note({"got": "code", "chars": 6, "digits": True, "ms": 4210}) == "Got a 6-digit code in 4.2 s"
    assert view.email_note({"got": "code", "chars": 8, "digits": False, "ms": 80}) == "Got a code in 80 ms"
    assert view.email_note({"got": "link", "site": "app.acme.com", "ms": 3100}) == "Got a link to app.acme.com in 3.1 s"
    assert view.email_note({"got": "email"}) == "The email came"
    assert view.email_note(None) == "" and view.email_note({"got": "body"}) == ""
    assert view.pass_note({"email": {"got": "code", "chars": 6, "digits": True}}) == "Got a 6-digit code"
    wait = {"action": "emailWait"}
    assert view.reason_title("timeout", wait) == "No email came in time"
    assert view.reason_title("actionUnavailable", wait) == "This step needs Breakpatch Team"
    assert view.reason_title("emailFailed", wait) == "The test inbox couldn't be read"
    assert view.reason_title("emailFailed", {"action": "write"}) == "What the email had couldn't be used"
    assert "never passes without it" in view.reason_text("actionUnavailable", wait)
    assert "Test inbox" in view.reason_advice("emailFailed", wait)
    assert "sends the email" in view.reason_advice("timeout", wait)
    assert "slow" in view.reason_advice("timeout", {"action": "click"})
