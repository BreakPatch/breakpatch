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
the screen, and every step is still checked on the screen.

Why: in the System 1 experiment (pre-registered, 188 real pages, 6,604 trials, on an M5 Pro), S0
found 88.7% of described targets on pages with a usable DOM against 80% for the vision model alone
(click-only), and S0 then the model found 92.5%. S0 answered in 12 ms at the median against about
1 s, with no model and no download. On Flutter and canvas pages every DOM method found nothing,
hence the router. The experiment's extractor talked to Chromium on a DevTools port; the engine's
goes through Playwright's driver, so reading a page is slower here: 5 to 25 ms for small pages and
about 0.5 s for a 400-control one on a 4-core Linux machine (tools/fast-locator-bench measures it
on the Mac).
"""
