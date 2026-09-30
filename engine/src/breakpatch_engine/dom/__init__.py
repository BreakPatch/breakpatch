"""The fast locator: finds a described element from the page's own structure, without a model.

- `extract.py` lists the visible controls of the current viewport (DevTools DOMSnapshot and the
  accessibility tree, through shadow roots and iframes).
- `s0.py` scores that list against a description (text, role and position words) and answers,
  or says it's unsure.
- `router.py` decides per page whether the list can be trusted (Fast) or the page is drawn
  pixels, like Flutter or a canvas (Visual).
- `flow.py` puts them in front of the AI assistant: Fast pages try S0 first and ask the model
  only when S0 is unsure; Visual pages use the model alone.

Page structure only helps find a target. Nothing is clicked by selector: the answer is a point on
the screen, and every step is still checked on the screen. Ported from the System 1 experiment's
harness (`scripts/harness/extract.py`, `s0.py`), where S0 found 88.7% of targets on DOM-rich pages
in 12 ms, against 80% for the vision model alone (click-only scoring).
"""
