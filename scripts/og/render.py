"""Render scripts/og/og.html to site/assets/og.png (1200 × 630), the site's social preview.

    python scripts/og/render.py

Needs Playwright with Chromium (as scripts/site-shots.py does) and the network for Google Fonts (fetched here and inlined).
"""
import base64
import glob
import os
import re
import urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright

HERE = Path(__file__).resolve().parent
OUT = HERE.parents[1] / "site" / "assets" / "og.png"


def chromium(p):
    # Playwright's own browser if it's installed, or one under PLAYWRIGHT_BROWSERS_PATH (as site-shots.py).
    try:
        return p.chromium.launch()
    except Exception:
        base = os.environ.get("PLAYWRIGHT_BROWSERS_PATH", "/opt/pw-browsers")
        found = sorted(glob.glob(os.path.join(base, "chromium-*", "chrome-linux*", "chrome")))
        if not found:
            raise
        return p.chromium.launch(executable_path=found[-1])


FONTS = "https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,400;12..96,500;12..96,700&display=swap"


def get(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (Macintosh) Chrome/120 Safari/537.36"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read()


def inline_fonts() -> str:
    """The page's fonts as CSS with the files inlined, so the browser needs no network of its own."""
    css = get(FONTS).decode()
    return re.sub(r"url\((https://[^)]+)\)",
                  lambda m: "url(data:font/woff2;base64," + base64.b64encode(get(m.group(1))).decode() + ")", css)


def main() -> None:
    with sync_playwright() as p:
        browser = chromium(p)
        page = browser.new_page(viewport={"width": 1200, "height": 630}, device_scale_factor=1)
        page.goto((HERE / "og.html").as_uri())
        page.add_style_tag(content=inline_fonts())
        page.evaluate("document.fonts.ready")
        page.wait_for_load_state("networkidle")
        page.screenshot(path=str(OUT))
        browser.close()
    print(f"Wrote {OUT}")


if __name__ == "__main__":
    main()
