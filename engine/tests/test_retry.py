"""Retrying a failed test (roadmap #14, retry.py): the decision for every failure reason and
distance, and the runner's tries (a scripted runner: no browser needed). test_e2e.py has a real one."""
import asyncio

import pytest

from breakpatch_engine import config, retry
from breakpatch_engine.runner import MESSAGES, Runner, StepFailed

ALL_REASONS = ["targetNotFound", "unexpectedScreen", "noChange", "timeout", "healFailed", "healingUnavailable",
               "secretMissing", "setUpFailed", "stopped", "fileMissing", "callFailed",
               "actionUnavailable", "emailFailed"]
CLICK = {"id": "s1", "action": "click", "pre": {"region": [0, 0, 10, 10], "hash": "0" * 16, "tolerance": 6},
         "post": {"region": [0, 0, 10, 10], "hash": "0" * 16, "tolerance": 10}}
CHECKPOINT = {"id": "c1", "action": "checkpoint", "region": [0, 0, 10, 10], "hash": "0" * 16, "tolerance": 8}


def failed(reason, **kw):
    return {"stepId": "s1", "result": "failed", "reason": reason, **kw}


# ---------------------------------------------------------------- the decision

def test_every_reason_the_engine_knows_is_decided():
    assert set(MESSAGES) == set(ALL_REASONS)
    assert retry.NEVER | retry.RETRIED == set(ALL_REASONS) and not retry.NEVER & retry.RETRIED


@pytest.mark.parametrize("reason", sorted(retry.NEVER))
def test_reasons_another_try_cant_fix_are_never_retried(reason):
    for extra in ({}, {"preDistance": 0, "postDistance": 0}, {"preDistance": 7}):
        assert retry.why_retry(failed(reason, **extra), CLICK) is None


@pytest.mark.parametrize("reason", ["timeout", "noChange"])
def test_slow_or_not_ready_is_always_retried(reason):
    assert retry.why_retry(failed(reason), CLICK) == retry.WHY[reason]
    assert retry.why_retry(failed(reason, preDistance=60, postDistance=60), CLICK) == retry.WHY[reason]


@pytest.mark.parametrize("dist,want", [(7, True), (10, True), (11, False), (40, False), (None, False)])
def test_target_not_found_only_when_the_pre_check_was_close(dist, want):
    rec = failed("targetNotFound", **({} if dist is None else {"preDistance": dist}))
    assert (retry.why_retry(rec, CLICK) is not None) is want


@pytest.mark.parametrize("dist,want", [(11, True), (14, True), (15, False), (30, False), (None, False)])
def test_unexpected_screen_only_when_the_post_check_was_close(dist, want):
    rec = failed("unexpectedScreen", **({} if dist is None else {"postDistance": dist}))
    assert (retry.why_retry(rec, CLICK) is not None) is want


def test_a_checkpoint_is_judged_by_its_own_tolerance():
    assert retry.why_retry(failed("unexpectedScreen", postDistance=12), CHECKPOINT) is not None   # 8 + 4
    assert retry.why_retry(failed("unexpectedScreen", postDistance=13), CHECKPOINT) is None


def test_relaxed_checks_allow_their_extra_bits_too():
    rec = failed("targetNotFound", preDistance=6 + retry.NEAR + config.RELAXED_EXTRA)
    assert retry.why_retry(rec, CLICK) is None
    assert retry.why_retry(rec, CLICK, relaxed=True) is not None


def test_defaults_when_the_step_has_no_tolerance():
    bare = {"id": "s1", "action": "click"}
    assert retry.why_retry(failed("targetNotFound", preDistance=config.PRE_TOLERANCE + retry.NEAR), bare)
    assert retry.why_retry(failed("unexpectedScreen", postDistance=config.POST_TOLERANCE + retry.NEAR + 1), bare) is None
    assert retry.why_retry(failed("unexpectedScreen", postDistance=5), None)


def test_a_crash_inside_the_engine_is_not_retried():
    crash = failed("unexpectedScreen", details="RuntimeError: boom")    # no distance: nothing was compared
    assert retry.why_retry(crash, CLICK) is None


def test_only_failed_steps_are_retried():
    assert retry.why_retry({"stepId": "s1", "result": "passed", "reason": "timeout"}, CLICK) is None
    assert retry.why_retry(None, CLICK) is None


@pytest.mark.parametrize("value,want", [(0, 0), (1, 1), (2, 2), (3, 2), (-1, 0), (1.9, 1), (None, 0), ("2", 0),
                                        (True, 0), (float("nan"), 0)])
def test_the_retries_setting(value, want):
    assert retry.retries_setting(value) == want


# ---------------------------------------------------------------- the runner's tries

STEPS = [{"id": "a", "action": "click", "label": "Click A"},
         {"id": "g", "action": "group", "steps": [{"id": "b", "action": "click", "label": "Click B"}]},
         {"id": "c", "action": "click", "label": "Click C"}]


class FakeBrowser:
    is_open = False

    def __init__(self):
        self.closed = 0

    async def close(self):
        self.closed += 1


class Scripted(Runner):
    """A runner whose tries are scripted: each is {stepId: StepFailed} for the step that fails, or {}."""

    def __init__(self, tries, timings=None, **kw):
        self.events = []
        super().__init__(FakeBrowser(), lambda: None, timings or config.Timings.fast(), lambda e, d: self.events.append((e, d)), **kw)
        self.tries = list(tries)
        self.ran = 0

    async def _execute(self, req, steps, order, secrets, stop):
        self.ran += 1
        self.reached_set_up = True
        fails = self.tries.pop(0) if self.tries else {}
        return await self._list(steps, fails)

    async def _list(self, steps, fails):
        for s in steps:
            if s.get("steps"):
                if not await self._list(s["steps"], fails):
                    return self._container_failed(s, s["steps"], None)
                self.results[self.index[id(s)]] = {"stepId": s["id"], "result": "passed"}
                continue
            if s["id"] in fails:
                self._fail(s, fails[s["id"]])
                return False
            self.results[self.index[id(s)]] = {"stepId": s["id"], "result": "passed"}
            self._event(s, "passed", None)
        return True


def run(r, retries=1, **req):
    return asyncio.run(r.run({"runId": "r1", "steps": STEPS, "settings": {"retries": retries}, **req}, asyncio.Event()))


def test_a_timeout_then_a_pass_is_a_pass_on_the_second_try():
    r = Scripted([{"c": StepFailed("timeout")}, {}])
    ended = run(r)
    assert ended["result"] == "pass" and ended["attempts"] == 2 and r.ran == 2
    c = next(s for s in ended["steps"] if s["stepId"] == "c")
    assert c["result"] == "passed"
    assert c["retried"] == [{"attempt": 1, "reason": "timeout", "message": MESSAGES["timeout"], "durationMs": c["retried"][0]["durationMs"]}]
    assert "message" not in ended
    retries = [d for e, d in r.events if e == "run.retry"]
    assert retries == [{"runId": "r1", "attempt": 2, "of": 2, "stepId": "c", "reason": "timeout", "why": retry.WHY["timeout"],
                        "message": MESSAGES["timeout"]}]
    assert r.b.closed == 2                       # a new browser for each try


def test_a_failure_inside_shared_steps_is_kept_on_the_step_not_the_card():
    ended = run(Scripted([{"b": StepFailed("noChange")}, {}]))
    by = {s["stepId"]: s for s in ended["steps"]}
    assert by["b"]["retried"][0]["reason"] == "noChange" and "retried" not in by["g"]


def test_no_retry_without_the_setting_and_nothing_new_in_the_result():
    r = Scripted([{"c": StepFailed("timeout")}, {}])
    ended = run(r, retries=0)
    assert ended["result"] == "fail" and r.ran == 1 and "attempts" not in ended
    assert not any("retried" in s for s in ended["steps"])
    assert not [e for e, _ in r.events if e == "run.retry"]


def test_a_pass_on_the_first_try_looks_as_before():
    ended = run(Scripted([{}]), retries=2)
    assert ended["result"] == "pass" and "attempts" not in ended and not any("retried" in s for s in ended["steps"])


@pytest.mark.parametrize("reason", sorted(retry.NEVER))
def test_never_retried_reasons_fail_at_once(reason):
    r = Scripted([{"a": StepFailed(reason)}, {}])
    ended = run(r, retries=2)
    assert ended["result"] == "fail" and r.ran == 1 and "attempts" not in ended


def test_a_far_off_screen_is_not_retried_but_a_close_one_is():
    far = Scripted([{"a": StepFailed("targetNotFound", preDistance=30)}, {}])
    assert run(far)["result"] == "fail" and far.ran == 1
    near = Scripted([{"a": StepFailed("targetNotFound", preDistance=8)}, {}])
    ended = run(near)
    assert ended["result"] == "pass" and near.ran == 2
    assert ended["steps"][0]["retried"][0]["preDistance"] == 8


def test_at_most_the_retries_asked_for_and_at_most_two():
    r = Scripted([{"c": StepFailed("timeout")}] * 5)
    ended = run(r, retries=5)
    assert ended["result"] == "fail" and r.ran == 3
    c = next(s for s in ended["steps"] if s["stepId"] == "c")
    assert [t["attempt"] for t in c["retried"]] == [1, 2]   # the last try's failure is the step's own
    assert c["result"] == "failed" and c["reason"] == "timeout" and ended["attempts"] == 3


def test_a_real_failure_after_a_retry_is_the_result():
    r = Scripted([{"c": StepFailed("timeout")}, {"a": StepFailed("unexpectedScreen", postDistance=40)}])
    ended = run(r, retries=2)
    assert ended["result"] == "fail" and r.ran == 2 and ended["attempts"] == 2
    by = {s["stepId"]: s for s in ended["steps"]}
    assert by["a"]["result"] == "failed" and by["c"]["result"] == "notRun" and by["c"]["retried"][0]["reason"] == "timeout"
    assert ended["message"] == MESSAGES["unexpectedScreen"]


def test_no_retry_once_the_run_took_its_time_budget():
    r = Scripted([{"c": StepFailed("timeout")}, {}], timings=config.Timings.fast().with_(retry_budget=0.0))
    ended = run(r)
    assert ended["result"] == "fail" and r.ran == 1


def test_the_time_budget_follows_the_slow_machine_scale():
    assert config.Timings().scaled(3).retry_budget == 900.0
    assert config.Timings().scaled(3).retry_pause == config.Timings().retry_pause


def test_stopping_during_the_pause_ends_the_run_failed():
    r = Scripted([{"c": StepFailed("timeout")}, {}], timings=config.Timings.fast().with_(retry_pause=5.0))

    async def go():
        stop = asyncio.Event()
        task = asyncio.create_task(r.run({"runId": "r1", "steps": STEPS, "settings": {"retries": 1}}, stop))
        while not any(e == "run.retry" for e, _ in r.events):
            await asyncio.sleep(0.01)
        stop.set()
        return await asyncio.wait_for(task, 2)
    ended = asyncio.run(go())
    assert ended["result"] == "fail" and r.ran == 1


@pytest.mark.parametrize("extra", [{"keepOpen": True}, {"fromStepId": "a"}])
def test_the_recorder_s_runs_are_never_retried(extra):
    r = Scripted([{"c": StepFailed("timeout")}, {}])
    ended = run(r, retries=2, **extra)
    assert ended["result"] == "fail" and r.ran == 1


def test_a_start_page_that_did_not_load_is_retried_even_on_a_card():
    steps = [{"id": "g", "action": "group", "steps": [{"id": "b", "action": "click"}]}]
    r = Scripted([{}])

    async def no_start_page(req, steps_, order, secrets, stop):
        r.ran += 1
        if r.ran == 1:
            r._fail(order[0], StepFailed("timeout", "The start page didn't load."))
            return False
        return await Scripted._list(r, steps_, {})
    r._execute = no_start_page
    ended = asyncio.run(r.run({"runId": "r1", "steps": steps, "settings": {"retries": 1}}, asyncio.Event()))
    assert ended["result"] == "pass" and ended["attempts"] == 2
    assert ended["steps"][0]["retried"][0]["message"] == "The start page didn't load."


def test_fail_on_fix_is_not_a_failure_to_retry():
    class Healing(Scripted):
        async def _list(self, steps, fails):
            ok = await super()._list(steps, fails)
            self.results[0] = {"stepId": "a", "result": "healed"}
            return ok
    r = Healing([{}, {}])
    ended = asyncio.run(r.run({"runId": "r1", "steps": STEPS, "settings": {"retries": 2, "failOnFix": True}}, asyncio.Event()))
    assert ended["result"] == "fail" and r.ran == 1


def test_screenshots_of_later_tries_dont_overwrite_the_first(tmp_path):
    r = Scripted([])
    r.screenshots = tmp_path
    r.run_id = "r1"
    r.index = {id(STEPS[0]): 0}

    class Live:
        async def screenshot(self, path, type):
            open(path, "wb").write(b"png")

    class Open(FakeBrowser):
        is_open = True

        async def live(self):
            return Live()
    r.b = Open()
    r.attempt = 1
    one = asyncio.run(r._keep_screenshot(STEPS[0]))
    r.attempt = 2
    two = asyncio.run(r._keep_screenshot(STEPS[0]))
    assert one.endswith("001-a.png") and two.endswith("001-a-try2.png")
