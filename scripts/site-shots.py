#!/usr/bin/env python3
"""Regenerates the website's app screenshots (site/assets/shots/) from the app's demo preview.

    scripts/site-shots.py            all shots, dark and light, 1x and 2x
    scripts/site-shots.py names      only the shots whose names are given

It needs Python with Playwright and Pillow (the engine's .venv has both) and the app's
node_modules. The shots show Team features (Fixed automatically, the local runner), so link the
Team module first (scripts/link-team.sh). The script starts the preview (npm run dev, port 1420)
unless one is already running, opens http://localhost:1420/?demo&ready&signedin, and takes each
shot at 1280 x 800, at device scale 1 (name.webp) and 2 (name@2x.webp), then crops it and saves
WebP. The clock is fixed, so times in the pictures stay the same from one run to the next.

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
URL = 'http://localhost:1420/'
QUERY = '?demo&ready&signedin&theme='
# 24 September 2026, 15:52 local time: the demo's "Today, 14:52" runs and "Test project 15:52".
NOW = datetime.datetime(2026, 9, 24, 15, 52)
QUALITY = 82
DESCRIBE = 'Describe the next step, for example: click the Done button'


def rest(pg):
    """Moves the pointer out of the way, so nothing shows a hover, and waits for the page to settle."""
    pg.mouse.move(1279, 799)
    pg.evaluate('document.activeElement && document.activeElement.blur && document.activeElement.blur()')
    pg.wait_for_timeout(700)


def open_app(pg, name):
    pg.get_by_text('Web app', exact=True).first.click()
    pg.wait_for_timeout(600)
    if name:
        pg.get_by_text(name, exact=True).first.click()
        pg.wait_for_timeout(1200)


def describe(pg):
    """The recorder with the AI's proposal for a described step."""
    open_app(pg, 'Create a project')
    box = pg.get_by_placeholder(DESCRIBE)
    box.fill('click the New project button')
    box.press('Enter')
    pg.get_by_role('button', name='Confirm').wait_for()
    pg.wait_for_timeout(600)


def confirmed(pg):
    """The described step confirmed: the AI named it and it's the newest step."""
    describe(pg)
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


# name: (how to get there, crop box in CSS pixels on the 1280 x 800 window: left, top, right, bottom)
SHOTS = {
    'recorder': (describe, (0, 0, 1280, 800)),
    'recorder-phone': (confirmed, (900, 52, 1280, 800)),  # the home hero on a phone: the steps panel
    'describe': (describe, (0, 100, 1060, 800)),
    'names': (names, (470, 222, 1280, 728)),  # 16:10, the card's picture frame
    'fixed-detail': (lambda pg: run_report(pg, 'Passed with fixes'), (0, 62, 1280, 748)),
    'report-detail': (lambda pg: run_report(pg, 'Yesterday, 06:00'), (360, 130, 1280, 724)),
    'tests': (tests, (0, 0, 1280, 538)),
    'suites': (suites, (0, 0, 1280, 400)),
    'ai': (ai, (0, 0, 1040, 480)),
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
    proc = subprocess.Popen(['npm', 'run', 'dev', '--', '--port', '1420', '--strictPort'], cwd=os.path.join(ROOT, 'app'),
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(60):
        if preview_running():
            return proc
        time.sleep(0.5)
    proc.terminate()
    sys.exit('The app preview did not start on port 1420 (cd app && npm run dev).')


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
    if not os.path.exists(os.path.join(ROOT, 'app', 'src', 'edition', 'team', 'index.ts')):
        print('Warning: the Team module is not linked (scripts/link-team.sh). Team shots will be missing their Team parts.')
    proc = start_preview()
    try:
        with sync_playwright() as p:
            browser = chromium(p)
            for name, (go, box) in SHOTS.items():
                if wanted and name not in wanted:
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


if __name__ == '__main__':
    main(set(sys.argv[1:]))
