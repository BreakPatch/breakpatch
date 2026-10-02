#!/usr/bin/env python3
"""The site's header and pages at phone widths, in a real browser (Playwright, Chromium).

    python3 site/header-check.py            exits 1 and says what's wrong, if anything is
    BP_CHROMIUM=/path/to/chrome python3 site/header-check.py

Serves site/ itself on a free local port. On every page, at 360, 390 and 430 px wide, light and
dark: the page doesn't scroll sideways, everything in the header stays inside the bar without
overlapping (Install included), and the Menu button is at least 44 x 44. On Home it also opens the
menu with the button and with the keyboard, and checks Esc closes it and puts focus back.
header.test.mjs runs this when Python's Playwright and a Chromium are there.
"""
import functools
import http.server
import os
import sys
import threading

from playwright.sync_api import sync_playwright

SITE = os.path.dirname(os.path.abspath(__file__))
PAGES = ['/', '/pricing/', '/manual/', '/terms/', '/privacy/', '/refunds/', '/thanks/', '/404.html',
         '/connect/#c=eyJuYW1lIjoiQWNtZSJ9', '/report/#r=web-app/run1']
WIDTHS = [360, 390, 430]
CHROMIUM = os.environ.get('BP_CHROMIUM') or ('/opt/pw-browsers/chromium' if os.path.exists('/opt/pw-browsers/chromium') else None)

PROBE = r"""() => {
  const problems = [];
  const doc = document.documentElement;
  if (doc.scrollWidth > doc.clientWidth) problems.push(`the page scrolls sideways by ${doc.scrollWidth - doc.clientWidth} px`);
  const top = document.querySelector('header.top');
  if (!top) return problems;
  const bar = top.getBoundingClientRect();
  const shown = e => { const s = getComputedStyle(e), b = e.getBoundingClientRect(); return s.display !== 'none' && s.visibility !== 'hidden' && b.width > 0 && b.height > 0; };
  // What's in the bar itself (not the open menu's panel, which hangs below it).
  const items = [...top.querySelectorAll(':scope > a, :scope > button, :scope > nav > a')].filter(shown)
    .filter(e => !(top.classList.contains('open') && e.closest('nav')));
  const name = e => (e.textContent || e.getAttribute('aria-label') || '').trim();
  for (const e of items) {
    const b = e.getBoundingClientRect();
    if (b.left < bar.left - 0.5 || b.right > bar.right + 0.5 || b.top < bar.top - 0.5 || b.bottom > bar.bottom + 0.5) problems.push(`"${name(e)}" sticks out of the header`);
  }
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
    const a = items[i].getBoundingClientRect(), b = items[j].getBoundingClientRect();
    if (a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5) problems.push(`"${name(items[i])}" overlaps "${name(items[j])}"`);
  }
  const install = top.querySelector(':scope > .btn');
  if (install && !shown(install)) problems.push('Install is hidden');
  const nav = top.querySelector('nav[aria-label="Main"]');
  const toggle = top.querySelector('.nav-toggle');
  if (nav && innerWidth <= 560) {
    if (!toggle || !shown(toggle)) problems.push('no Menu button');
    else { const b = toggle.getBoundingClientRect(); if (b.width < 44 || b.height < 44) problems.push(`the Menu button is ${Math.round(b.width)} x ${Math.round(b.height)}`); }
  }
  return problems;
}"""


def serve():
    class Quiet(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *args):
            pass
    handler = functools.partial(Quiet, directory=SITE)
    httpd = http.server.ThreadingHTTPServer(('127.0.0.1', 0), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, f'http://127.0.0.1:{httpd.server_address[1]}'


def menu(pg, problems, where):
    """Home at a phone width: the menu opens and closes as it should."""
    t = pg.locator('.nav-toggle')
    links = pg.locator('header.top nav a')
    if not t.count() or not t.is_visible():
        return  # already reported: no Menu button
    t.click()
    if t.get_attribute('aria-expanded') != 'true' or not links.first.is_visible():
        problems.append(f'{where}: the Menu button doesn\'t open the menu')
    for i in range(links.count()):
        b = links.nth(i).bounding_box()
        if b and b['height'] < 44:
            problems.append(f'{where}: the menu link "{links.nth(i).inner_text()}" is {round(b["height"])} px tall')
    pg.keyboard.press('Escape')
    if t.get_attribute('aria-expanded') != 'false' or links.first.is_visible():
        problems.append(f'{where}: Esc doesn\'t close the menu')
    if not pg.evaluate("document.activeElement === document.querySelector('.nav-toggle')"):
        problems.append(f'{where}: after Esc, focus isn\'t back on the Menu button')
    # From the keyboard: Enter opens it with focus on the first link.
    t.focus()
    pg.keyboard.press('Enter')
    if not pg.evaluate("document.activeElement === document.querySelector('header.top nav a')"):
        problems.append(f'{where}: opened from the keyboard, focus isn\'t on the first link')
    pg.keyboard.press('Escape')


def main():
    httpd, base = serve()
    problems = []
    with sync_playwright() as p:
        browser = p.chromium.launch(**({'executable_path': CHROMIUM} if CHROMIUM else {}))
        for scheme in ('dark', 'light'):
            for width in WIDTHS:
                ctx = browser.new_context(viewport={'width': width, 'height': 800}, color_scheme=scheme, has_touch=True)
                # Nothing leaves this machine: fonts fall back (wider than the real ones, so a stricter test).
                ctx.route('**/*', lambda r: r.continue_() if r.request.url.startswith(base) else r.abort())
                pg = ctx.new_page()
                for path in PAGES:
                    pg.goto(base + path, wait_until='load')
                    for msg in pg.evaluate(PROBE):
                        problems.append(f'{path} at {width} px ({scheme}): {msg}')
                    if path == '/' and scheme == 'dark':
                        menu(pg, problems, f'/ at {width} px')
                ctx.close()
        browser.close()
    httpd.shutdown()
    for msg in problems:
        print(msg)
    if problems:
        sys.exit(1)
    print(f'ok: {len(PAGES)} pages at {", ".join(map(str, WIDTHS))} px, light and dark')


if __name__ == '__main__':
    main()
