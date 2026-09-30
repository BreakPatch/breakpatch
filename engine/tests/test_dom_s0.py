"""S0 (dom/s0.py): scoring a description against a candidate list. No browser."""
import pytest

from breakpatch_engine.dom import s0


def cand(i, role, name, box, label="", text=None, landmark="", attrs=None, disabled=False):
    return {"index": i, "role": role, "name": name, "label": label, "text": name if text is None else text,
            "box": box, "landmark": landmark, "disabled": disabled, "attrs": attrs or {}}


FORM = [
    cand(0, "link", "Home", [20, 10, 70, 30], landmark="navigation: Primary"),
    cand(1, "textbox", "Email", [20, 100, 320, 130], label="you@example.com", text=""),
    cand(2, "textbox", "Password", [20, 160, 320, 190], text="", attrs={"data-testid": "password-input"}),
    cand(3, "checkbox", "Remember me", [20, 200, 36, 216], text=""),
    cand(4, "button", "Sign in", [20, 230, 120, 260], landmark="form: Sign in"),
    cand(5, "link", "Forgot password?", [20, 280, 160, 300]),
    cand(6, "button", "Save", [900, 300, 960, 330], landmark="dialog: Edit profile"),
    cand(7, "button", "Save", [20, 600, 80, 630], landmark="main"),
]


def pick(description, cands=FORM):
    return s0.locate(description, cands).choice


def test_the_thresholds_are_the_frozen_ones():
    # results/S0_tuned_thresholds.json of the System 1 experiment: T = 0.65, M = 0.00
    assert (s0.ACCEPT_SCORE, s0.ACCEPT_LEAD) == (0.65, 0.0)
    assert (s0.W_TEXT, s0.W_ROLE, s0.W_POS) == (0.6, 0.2, 0.2)
    assert s0.accepts(0.65, 0.65)           # a tie at the top still answers (lead 0 >= M)
    assert not s0.accepts(0.6499, 0.0)


def test_plain_descriptions_find_their_control():
    assert pick("the Sign in button") == 4
    assert pick("Remember me checkbox") == 3
    assert pick("the password field") == 2
    ans = s0.locate("the Sign in button", FORM)
    assert ans.found and ans.score >= s0.ACCEPT_SCORE and ans.top == 4


def test_unrelated_descriptions_abstain():
    for d in ("the purple elephant", "Delete all rows", "the Create account button"):
        ans = s0.locate(d, FORM)
        assert ans.choice is None, (d, ans)
        assert ans.top is not None and ans.score < s0.ACCEPT_SCORE


def test_an_empty_list_abstains_and_isn_t_an_answer():
    ans = s0.locate("the Sign in button", [])
    assert ans.choice is None and ans.top is None and ans.score == 0.0


def test_a_score_just_under_the_threshold_abstains(monkeypatch):
    monkeypatch.setattr(s0, "scores", lambda d, c, v=None: [0.6499, 0.2])
    assert s0.locate("x", FORM[:2]).choice is None
    monkeypatch.setattr(s0, "scores", lambda d, c, v=None: [0.2, 0.65])
    assert s0.locate("x", FORM[:2]).choice == 1


def test_typos_and_accents_are_forgiven():
    assert pick("the emial field") == 1
    assert pick("Sing in button") == 4
    accented = FORM + [cand(8, "link", "Contraseña olvidada", [400, 400, 560, 420])]
    assert pick("contrasena olvidada", accented) == 8
    assert pick("CONTRASEÑA OLVIDADA", accented) == 8


def test_spanish_role_words():
    cands = [cand(0, "link", "Guardar", [20, 20, 90, 40]), cand(1, "button", "Guardar", [20, 80, 90, 110]),
             cand(2, "tab", "Ajustes", [200, 20, 280, 40]), cand(3, "checkbox", "Acepto", [20, 200, 36, 216], text="")]
    assert pick("el botón Guardar", cands) == 1
    assert pick("el enlace Guardar", cands) == 0
    assert pick("la pestaña Ajustes", cands) == 2
    assert pick("la casilla Acepto", cands) == 3


def test_ordinals_count_in_visual_reading_order():
    # Document order isn't reading order here: the list starts with the bottom row (a table drawn
    # with CSS order, say). "Second" means the second one down the screen.
    edits = [cand(0, "button", "Edit", [400, 300, 440, 320]),
             cand(1, "button", "Edit", [400, 100, 440, 120]),
             cand(2, "button", "Edit", [400, 200, 440, 220]),
             cand(3, "button", "Delete", [460, 100, 500, 120])]
    assert pick("the first Edit button", edits) == 1
    assert pick("the second Edit button", edits) == 2
    assert pick("the third Edit button", edits) == 0
    assert pick("the last Edit button", edits) == 0
    assert pick("el segundo botón Edit", edits) == 2
    # the same row: left to right
    row = [cand(0, "button", "Edit", [300, 100, 340, 120]), cand(1, "button", "Edit", [100, 100, 140, 120])]
    assert pick("the first Edit button", row) == 1
    assert pick("the 2nd Edit button", row) == 0


def test_regions_and_position_words():
    assert pick("Save button in the Edit profile dialog") == 6
    assert pick("the Save button at the bottom") == 7
    assert pick("the Save button on the right") == 6


def test_testid_and_label_count_as_text():
    assert pick("password input") == 2                     # data-testid "password-input"
    assert pick("you@example.com") == 1                     # the placeholder (label)


@pytest.mark.parametrize("box,visible", [([10, 20, 110, 60], [10, 20, 110, 60]),
                                         ([-40, 880, 60, 940], [0.0, 880, 60, 900.0])])
def test_the_click_point_is_the_centre_of_the_box_on_screen(box, visible):
    assert s0.visible_box(box, (1440, 900)) == visible
