"""The fast locator's control list (dom/extract.py) on the experiment's fixture pages, in the
engine's own browser at 1440 x 900. Ported from the harness's tests/test_extract.py (11 tests),
plus a check that the lists are the harness's own, name for name."""
import asyncio
import json
import statistics

import pytest

import domsite
from conftest import needs_browser
from breakpatch_engine.browser import BrowserSession
from breakpatch_engine.config import Timings
from breakpatch_engine.dom.extract import ID_REF_ATTRS, Extractor, list_hash

pytestmark = needs_browser
MODES = ("auto", "full", "partial")


@pytest.fixture(scope="module")
def lists():
    """Every fixture state, extracted once per AX mode (and 5 more times on the dense page)."""
    async def go():
        base, stop = domsite.serve()
        b = BrowserSession(Timings.fast())
        out, ms = {}, []
        try:
            await b.open("about:blank", domsite.VIEWPORT)
            for sid, state in domsite.states().items():
                await domsite.load_state(b.page, base, state)
                for mode in MODES:
                    ex = await Extractor(b.page, (1440, 900), track="data-gt-id", ax_mode=mode).open()
                    try:
                        out[(sid, mode)] = await ex.extract()
                        if sid == "fx05-s0" and mode == "auto":
                            ms = [(await ex.extract()).extract_ms for _ in range(5)]
                    finally:
                        await ex.close()
        finally:
            await b.close()
            stop()
        return out, ms
    return asyncio.run(go())


def get(lists, sid, mode="auto"):
    return lists[0][(sid, mode)]


def by_name(ex, name):
    return [c for c in ex.candidates if c["name"] == name]


def idx(ex, gt):
    return ex.tracked[gt]["index"]


def test_schema_and_no_tracking_attribute_in_the_list(lists):
    ex = get(lists, "fx01-s0")
    assert "gt-id" not in json.dumps(ex.candidates)
    for i, c in enumerate(ex.candidates):
        assert c["index"] == i
        assert set(c) == {"index", "role", "name", "label", "text", "box", "landmark", "disabled", "attrs"}
        assert len(c["text"]) <= 80
        assert all(k == "data-testid" or k.startswith("aria-") for k in c["attrs"])
    assert ex.list_hash == list_hash((1440, 900), ex.candidates)


def test_lists_are_the_harness_lists(lists):
    """Name for name, role for role, in the same order as the experiment's extractor gave on its
    Mac (boxes differ with the fonts, so they're left out)."""
    with open(domsite.DOM / "reference_lists.json") as f:
        ref = json.load(f)["lists"]
    for sid in domsite.states():
        got = [{k: v for k, v in c.items() if k != "box"} for c in get(lists, sid).candidates]
        assert got == ref[sid], sid


def test_plain_form_and_dialog(lists):
    ex = get(lists, "fx01-s0")
    save = by_name(ex, "Save")[0]
    assert save["landmark"] == "dialog: Edit profile"
    assert save["attrs"].get("data-testid") == "save-profile"
    assert idx(ex, "dlg-save") == save["index"]
    assert by_name(ex, "Email")[0]["label"] == "you@example.com"
    assert by_name(ex, "Sign in")[0]["landmark"] == "form: Sign in"
    assert by_name(ex, "Home")[0]["landmark"] == "navigation: Primary"


def test_duplicate_labels_keep_document_order(lists):
    ex = get(lists, "fx01-s0")
    edits = by_name(ex, "Edit")
    assert len(edits) == 3
    assert [idx(ex, f"edit-{k}") for k in (1, 2, 3)] == [c["index"] for c in edits]
    assert [c["box"][1] for c in edits] == sorted(c["box"][1] for c in edits)   # one under the other


def test_disabled_hidden_and_off_screen(lists):
    ex = get(lists, "fx01-s0")
    sso = by_name(ex, "Sign in with SSO")
    assert len(sso) == 1 and sso[0]["disabled"]          # a disabled control with a name is listed, marked
    names = {c["name"] for c in ex.candidates}
    assert "Ghost" not in names and "Hidden" not in names  # opacity 0, visibility hidden
    assert "Load more" not in names                       # below the fold
    assert ex.tracked["load-more"]["index"] is None
    assert ex.tracked["load-more"]["box"] is not None     # measured all the same


def test_scrolled_state(lists):
    ex = get(lists, "fx01-s1")
    more = by_name(ex, "Load more")[0]
    assert idx(ex, "load-more") == more["index"]
    assert more["box"][1] < 900


def test_wrappers_merge_and_labels_name_their_controls(lists):
    ex = get(lists, "fx01-s0")
    export = [c for c in ex.candidates if "Export" in c["text"]]
    assert len(export) == 1 and export[0]["text"] == "Export CSV"
    assert not any(c["role"] in ("LabelText", "label") for c in ex.candidates)
    assert not any(c["role"] == "cell" and c["name"].startswith("Edit") for c in ex.candidates)
    remember = by_name(ex, "Remember me")
    assert [c["role"] for c in remember] == ["checkbox"] and remember[0]["text"] == ""


def test_open_and_closed_shadow_dom(lists):
    ex = get(lists, "fx02-s0")
    assert len(by_name(ex, "Add to cart")) == 2
    assert len(by_name(ex, "Details")) == 2                # nested open shadow roots
    for g in ("buy-closed", "gift-switch", "search-closed"):   # a closed shadow root
        assert ex.tracked[g]["index"] is not None, g
    sw = ex.candidates[idx(ex, "gift-switch")]
    assert (sw["role"], sw["name"]) == ("switch", "Gift wrap")
    assert ex.candidates[idx(ex, "search-closed")]["text"] == ""
    order = [c["name"] for c in ex.candidates]
    assert order.index("Buy now") < order.index("Add to wishlist")    # document order


def test_same_and_cross_origin_iframes(lists):
    ex = get(lists, "fx03-s0")
    assert ex.n_procs == 2                                 # the cross-origin iframe is its own process
    pay = ex.candidates[idx(ex, "pay")]
    # body margin 20 + iframe margin 120 + border 5 + padding 7 + inner body margin 17 = 169
    assert pay["box"][0] == pytest.approx(169.0, abs=0.5)
    assert pay["landmark"] == "form: Card"
    sub = ex.candidates[idx(ex, "subscribe")]
    assert sub["box"][0] > 20 + 60 + 5 + 7 + 13
    assert ex.tracked["below-iframe-fold"]["index"] is None     # clipped by the iframe's own viewport
    names = [c["name"] for c in ex.candidates]
    assert names.index("Back") + 1 == names.index("Newsletter email")
    assert names[-1] == "Done"
    assert by_name(ex, "Pay later")[0]["disabled"]


def test_hover_only_and_opened_controls(lists):
    base, hover = get(lists, "fx04-s0"), get(lists, "fx04-s1")
    assert base.tracked["mi-logout"]["index"] is None
    assert hover.candidates[idx(hover, "mi-logout")]["role"] == "menuitem"
    card = get(lists, "fx04-s2")
    assert base.tracked["quick-view"]["index"] is None and idx(card, "quick-view") is not None
    opened = get(lists, "fx04-s3")
    assert opened.candidates[idx(opened, "opt-archive")]["role"] == "option"
    soup = base.candidates[idx(base, "soup-a")]              # div soup, found by cursor:pointer
    assert (soup["role"], soup["text"]) == ("generic", "Approve")


def test_accessibility_tree_modes_give_the_same_list(lists):
    for sid in domsite.states():
        h = get(lists, sid).list_hash
        assert all(get(lists, sid, m).list_hash == h for m in MODES), sid


def test_dense_page_count_and_speed(lists):
    ex = get(lists, "fx05-s0")
    assert ex.count == 400
    p50 = statistics.median(lists[1])
    print(f"\n[fx05 dense, 400 candidates] extract p50 = {p50:.1f} ms")
    # Through Playwright's driver this is slower than the harness's direct DevTools port (40 ms on
    # an M-series Mac); a loose bound for slow CI machines.
    assert p50 < 3000


def test_volatile_id_references_dont_change_a_list_s_identity():
    a = [{"index": 0, "role": "button", "name": "Save", "label": "", "text": "Save", "box": [0, 0, 10, 10],
          "landmark": "", "disabled": False, "attrs": {"aria-controls": ":r1:", "aria-expanded": "false"}}]
    b = [{**a[0], "attrs": {"aria-controls": ":r7:", "aria-expanded": "false"}}]
    assert "aria-controls" in ID_REF_ATTRS
    assert list_hash((1440, 900), a) == list_hash((1440, 900), b)
    c = [{**a[0], "attrs": {"aria-controls": ":r1:", "aria-expanded": "true"}}]
    assert list_hash((1440, 900), a) != list_hash((1440, 900), c)
