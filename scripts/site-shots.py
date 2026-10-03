#!/usr/bin/env python3
"""Regenerates the website's app screenshots (site/assets/shots/) from the app's demo preview.

    scripts/site-shots.py            all shots, dark and light, 1x and 2x
    scripts/site-shots.py names      only the shots whose names are given

It needs Python with Playwright and Pillow (the engine's .venv has both) and the app's
node_modules. Each shot is of one edition. The Community ones (the recorder, the AI settings) show
what the free app does, so they're taken with the Team module unlinked (scripts/unlink-team.sh);
the Team ones (Fixed automatically, the local runner) with it linked (scripts/link-team.sh). A run
takes the shots of the edition that's linked and says which it left for the other, so a full set
is two runs, one each way. The demo's describe box follows DESCRIBE_STEPS (off), as the app does.

The script starts the preview (npm run dev, on PORT, 1420 unless set) unless one is already
running, opens http://localhost:PORT/?demo&ready&signedin, and takes each shot at 1280 x 800, at
device scale 1 (name.webp) and 2 (name@2x.webp), then crops it and saves WebP. The clock is fixed,
so times in the pictures stay the same from one run to the next.

After changing a crop's size, update the <img> width and height in site/index.html.
"""
import datetime
import glob
import os
import subprocess
import sys
import time
import urllib.request
from io import BytesIO

from PIL import Image
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'site', 'assets', 'shots')
PORT = os.environ.get('PORT', '1420')
URL = f'http://localhost:{PORT}/'
QUERY = '?demo&ready&signedin&theme='
# 24 September 2026, 15:52 local time: the demo's "Today, 14:52" runs and "Test project 15:52".
NOW = datetime.datetime(2026, 9, 24, 15, 52)
QUALITY = 82


def rest(pg):
    """Moves the pointer out of the way, so nothing shows a hover, and waits for the page to settle."""
    pg.mouse.move(2, 2)   # top left, clear of the steps list (its + between steps shows on hover)
    pg.evaluate('document.activeElement && document.activeElement.blur && document.activeElement.blur()')
    pg.wait_for_timeout(700)


def open_app(pg, name):
    pg.get_by_text('Web app', exact=True).first.click()
    pg.wait_for_timeout(600)
    if name:
        pg.get_by_text(name, exact=True).first.click()
        pg.wait_for_timeout(1200)


def clicked(pg):
    """The recorder after a click on the page's New project button: the AI names it and asks."""
    open_app(pg, 'Create a project')
    # The page view takes the clicks (a layer over the page), so click where the button is.
    box = pg.get_by_text('New project', exact=True).first.bounding_box()
    pg.mouse.click(box['x'] + box['width'] / 2, box['y'] + box['height'] / 2)
    pg.get_by_role('button', name='Confirm').wait_for()
    pg.wait_for_timeout(600)


def confirmed(pg):
    """The clicked step confirmed: the AI named it and it's the newest step."""
    clicked(pg)
    pg.get_by_role('button', name='Confirm').click()
    pg.wait_for_timeout(1500)


def names(pg):
    open_app(pg, 'Create a project')
    pg.get_by_text('Click Done', exact=True).first.click()
    pg.wait_for_timeout(800)


def run_report(pg, row_text):
    open_app(pg, None)
    pg.get_by_role('tab', name='Runs').first.click()
    pg.wait_for_timeout(800)
    pg.get_by_text(row_text).first.click()
    pg.wait_for_timeout(1500)


def tests(pg):
    open_app(pg, None)


def suites(pg):
    pg.get_by_text('Suites', exact=True).first.click()
    pg.wait_for_timeout(1200)


def ai(pg):
    pg.get_by_role('button', name='Settings').first.click()
    pg.wait_for_timeout(800)
    pg.get_by_text('AI assistant').first.click()
    pg.wait_for_timeout(800)


# name: (edition, how to get there, crop box in CSS pixels on the 1280 x 800 window: left, top, right, bottom)
SHOTS = {
    'recorder': ('community', clicked, (0, 0, 1280, 800)),
    'recorder-phone': ('community', confirmed, (900, 52, 1280, 800)),  # the home hero on a phone: the steps panel
    'names': ('team', names, (470, 222, 1280, 728)),  # 16:10, the card's picture frame
    'fixed-detail': ('team', lambda pg: run_report(pg, 'Passed with fixes'), (0, 62, 1280, 748)),
    'report-detail': ('team', lambda pg: run_report(pg, 'Yesterday, 06:00'), (360, 130, 1280, 724)),
    'tests': ('team', tests, (0, 0, 1280, 538)),
    'suites': ('team', suites, (0, 0, 1280, 400)),
    'ai': ('community', ai, (0, 0, 1040, 480)),
}


def preview_running():
    try:
        urllib.request.urlopen(URL, timeout=2)
        return True
    except Exception:
        return False


def start_preview():
    if preview_running():
        return None
    proc = subprocess.Popen(['npm', 'run', 'dev', '--', '--port', PORT, '--strictPort'], cwd=os.path.join(ROOT, 'app'),
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(60):
        if preview_running():
            return proc
        time.sleep(0.5)
    proc.terminate()
    sys.exit(f'The app preview did not start on port {PORT} (cd app && npm run dev).')


def chromium(p):
    # Playwright's own browser if it's installed, or one under PLAYWRIGHT_BROWSERS_PATH.
    try:
        return p.chromium.launch()
    except Exception:
        base = os.environ.get('PLAYWRIGHT_BROWSERS_PATH', '/opt/pw-browsers')
        found = sorted(glob.glob(os.path.join(base, 'chromium-*', 'chrome-linux*', 'chrome')))
        if not found:
            raise
        return p.chromium.launch(executable_path=found[-1])


def main(wanted):
    linked = 'team' if os.path.exists(os.path.join(ROOT, 'app', 'src', 'edition', 'team', 'index.ts')) else 'community'
    left = [n for n, (ed, _, _) in SHOTS.items() if ed != linked and (not wanted or n in wanted)]
    proc = start_preview()
    try:
        with sync_playwright() as p:
            browser = chromium(p)
            for name, (edition, go, box) in SHOTS.items():
                if (wanted and name not in wanted) or edition != linked:
                    continue
                for theme in ('dark', 'light'):
                    for scale, suffix in ((1, ''), (2, '@2x')):
                        ctx = browser.new_context(viewport={'width': 1280, 'height': 800}, device_scale_factor=scale,
                                                  color_scheme=theme)
                        pg = ctx.new_page()
                        pg.clock.install(time=NOW)
                        pg.goto(URL + QUERY + theme)
                        pg.wait_for_timeout(1200)
                        # The first-launch usage notice, if it shows.
                        ok = pg.get_by_role('button', name='OK')
                        if ok.count():
                            ok.first.click()
                        go(pg)
                        rest(pg)
                        png = pg.screenshot()
                        ctx.close()
                        im = Image.open(BytesIO(png)).convert('RGB').crop(tuple(v * scale for v in box))
                        path = os.path.join(OUT, f'{name}-{theme}{suffix}.webp')
                        im.save(path, 'WEBP', quality=QUALITY, method=6)
                        print(f'{os.path.relpath(path, ROOT)}  {im.width} x {im.height}  {os.path.getsize(path) // 1024} KB')
            browser.close()
    finally:
        if proc:
            proc.terminate()
    if left:
        how = 'scripts/link-team.sh' if linked == 'community' else 'scripts/unlink-team.sh'
        print(f'Not taken, they show the {"Team" if linked == "community" else "Community"} edition: {", ".join(left)}. '
              f'Run {how}, stop the preview if it was already running, and run this again.')


if __name__ == '__main__':
    main(set(sys.argv[1:]))
