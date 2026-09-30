"""What the page calls the element under a click, and its box, after the page has scrolled."""
import asyncio

from conftest import needs_browser
from breakpatch_engine.browser import BrowserSession
from breakpatch_engine.config import Timings

pytestmark = needs_browser

PAGE = ("<body style='margin:0'>"
        + "".join(f"<button style='display:block;height:100px;width:200px'>Row {i}</button>" for i in range(30))
        + "</body>")


def test_the_element_under_a_click_is_found_after_a_scroll():
    async def go():
        b = BrowserSession(Timings.fast())
        try:
            await b.open("about:blank", {"width": 800, "height": 600})
            await b.page.set_content(PAGE)
            before = await b.element_name((50, 250)), await b.element_box((50, 250))
            await b.page.evaluate("window.scrollTo(0, 336)")
            after = await b.element_name((50, 250)), await b.element_box((50, 250))
            return before, after
        finally:
            await b.close()

    (name0, box0), (name1, box1) = asyncio.run(go())
    assert name0 == {"name": "Row 2", "role": "button"} and box0 == [0, 200, 200, 300]
    # 250 + 336 = page y 586: Row 5, which sits at viewport y 164 to 264 once scrolled.
    assert name1 == {"name": "Row 5", "role": "button"}
    assert box1 == [0, 164, 200, 264]
