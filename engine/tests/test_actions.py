"""Text substitution, secrets and labels (no browser)."""
import datetime as dt

import pytest

from breakpatch_engine import labels
from breakpatch_engine.actions import Context, SecretMissing, resolve_text, secret_refs, substitute
from breakpatch_engine.config import Timings
from breakpatch_engine.runner import walk

NOW = dt.datetime(2026, 9, 24, 7, 5, 9)


def test_tokens_are_replaced_at_run_time():
    assert substitute("Note {i} at {time} on {date}", 3, NOW) == "Note 3 at 07:05 on 2026-09-24"
    assert substitute("plain", 1, NOW) == "plain"
    # {email} is the run's own address (Breakpatch Team, test_email_step.py); {emailCode} and
    # {emailLink} are typed by the Write step itself, under a kept value's guard.
    ctx = Context(Timings.fast(), i=3, email="qa+bp-abc@acme.com")
    assert resolve_text({"text": "{email} {i} {date}"}, ctx, NOW) == "qa+bp-abc@acme.com 3 2026-09-24"
    assert substitute("{emailCode}", 1, NOW) == "{emailCode}"


def test_generated_values_and_secrets():
    ctx = Context(Timings.fast(), secrets={"PW": "hunter2"}, i=4)
    assert resolve_text({"generated": "repeatNumber"}, ctx, NOW) == "4"
    assert resolve_text({"generated": "timeNow"}, ctx, NOW) == "07:05"
    assert resolve_text({"generated": "today"}, ctx, NOW) == "2026-09-24"
    assert resolve_text({"generated": "uniqueName"}, ctx, NOW).startswith("BP 20260924-070509-")
    assert resolve_text({"secretRef": "PW", "text": "ignored"}, ctx, NOW) == "hunter2"
    with pytest.raises(SecretMissing) as e:
        resolve_text({"secretRef": "OTHER"}, ctx, NOW)
    assert e.value.reason == "secretMissing" and "OTHER" in e.value.message


def test_secret_refs_and_walk_cover_nested_steps():
    steps = [{"id": "a", "action": "write", "secretRef": "A"},
             {"id": "l", "action": "loop", "count": 2, "steps": [
                 {"id": "g", "action": "group", "steps": [{"id": "b", "action": "write", "secretRef": "B"}]}]}]
    assert [n for _s, n in secret_refs(steps)] == ["A", "B"]
    assert [s["id"] for s in walk(steps)] == ["a", "l", "g", "b"]


def test_default_labels():
    assert labels.default_label("click", {}, "Done button") == "Click Done button"
    assert labels.default_label("write", {"secretRef": "PW"}) == "Write saved secret PW"
    assert labels.default_label("upload", {"sample": "xlsx"}) == "Upload Excel sheet"
    assert labels.default_label("navigate", {"nav": "back"}) == "Go back"
    assert labels.spot_target([10, 10], 1280, 800) == "The spot you clicked, near the top left of the page"
