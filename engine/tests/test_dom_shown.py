"""Text that shows on the screen (dom/shown.py): what a checkpoint looks for, found among the short
text runs when it isn't a control, only for `record.locate` with `shows`."""
import pytest

from conftest import needs_browser
from breakpatch_engine.config import Timings
from breakpatch_engine.dom import shown
from breakpatch_engine.locator import NoLocator
from breakpatch_engine.protocol import EngineError
from breakpatch_engine.service import Engine
from test_e2e import VIEWPORT, site  # noqa: F401 - the module's page server


@pytest.mark.parametrize("description, q", [
    ("Account created", "account created"),
    ("the “Account created” message shows", "account created"),
    ("check that Account created appears", "account created"),
    ("a Saved toast is visible", "saved"),
    ("'Welcome back, Ada!'", "welcome back ada"),
])
def test_what_to_look_for(description, q):
    assert shown.query(description) == q


TEXTS = [
    {"text": "Your account was created. Check your email to finish.", "box": [10, 300, 600, 320]},
    {"text": "Account created", "box": [200, 120, 400, 150]},
    {"text": "Account created for ada@example.com", "box": [200, 160, 500, 180]},
    {"text": "Accounts", "box": [10, 10, 80, 30]},
]


def test_an_exact_text_wins_then_the_shortest_that_has_it():
    assert shown.find("Account created", TEXTS)["box"] == [200, 120, 400, 150]
    assert shown.find("Account created", TEXTS[2:])["box"] == [200, 160, 500, 180]
    assert shown.find("account", TEXTS[3:]) is None                 # "Accounts" isn't the word
    assert shown.find("Profile saved", TEXTS) is None
    assert shown.find("a", TEXTS) is None                            # too short to mean anything
    long = [{"text": "Account created " + "and more words " * 6, "box": [0, 0, 10, 10]}]
    assert shown.find("Account created", long) is None               # a paragraph, not a message


def test_ties_go_to_the_first_in_reading_order_and_boxes_must_be_real():
    two = [{"text": "Saved", "box": [300, 50, 340, 70]}, {"text": "Saved", "box": [10, 50, 50, 70]},
           {"text": "Saved", "box": [0, 0, 0, 0]}]
    assert shown.find("Saved", two)["box"] == [10, 50, 50, 70]


@needs_browser
async def test_a_checkpoint_on_plain_text_is_found_without_the_model(site):  # noqa: F811
    e = Engine(lambda ev, d: None, timings=Timings.fast(), locator_fn=NoLocator, healer=None, explainer=None, planner=None)
    h = e.handlers()
    await h["browser.open"]({"url": site + "/signup.html", "viewport": VIEWPORT})
    try:
        create = await h["record.locate"]({"description": "Create account button"})
        await h["record.point"]({"action": "click", "at": create["at"]})
        # Without `shows` nothing changes: S0 is unsure, so the AI assistant would be asked.
        with pytest.raises(EngineError) as err:
            await h["record.locate"]({"description": "Account created"})
        assert err.value.code == "not_ready"
        got = await h["record.locate"]({"description": "Account created", "shows": True})
    finally:
        await h["browser.close"]({})
    assert got["path"] == "fast"
    x1, y1, x2, y2 = got["box"]
    assert 190 <= x1 <= 230 and 110 <= y1 <= 150 and x2 > x1 and y2 > y1
