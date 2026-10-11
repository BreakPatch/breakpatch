// breakpatch.dev: GitHub links, the phone menu, copy buttons, where-you-are highlighting. No framework.

// Every GitHub link on the site is <a data-gh="/path">. Change this one line to move them all.
const GITHUB = 'https://github.com/BreakPatch/breakpatch';
document.querySelectorAll('[data-gh]').forEach(a => { a.href = GITHUB + a.dataset.gh; });

// The header on phones (site.css, max-width 560px): the main links fold into a Menu button next to
// Install. The button is added here, so every page's header (the manual's too, from
// build-manual.mjs) gets it without markup of its own; without JavaScript the links stay in the bar
// and scroll sideways there instead. Esc closes the menu and puts focus back on the button, a link
// or a tap outside closes it, and so does focus leaving the header.
const topBar = document.querySelector('header.top');
const mainNav = topBar && topBar.querySelector('nav[aria-label="Main"]');
if (mainNav) {
  mainNav.id = mainNav.id || 'main-nav';
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'nav-toggle';
  toggle.setAttribute('aria-expanded', 'false');
  toggle.setAttribute('aria-controls', mainNav.id);
  toggle.setAttribute('aria-label', 'Menu');
  // Three lines for Menu, a cross while it's open (site.css swaps them).
  toggle.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path class="i-menu" d="M4 7h16M4 12h16M4 17h16"/><path class="i-close" d="M6 6l12 12M18 6L6 18"/></svg>';
  mainNav.before(toggle);
  topBar.classList.add('has-menu');
  // Dims the page under the open menu; a tap on it closes the menu without pressing what's under it.
  const scrim = document.createElement('div');
  scrim.className = 'nav-scrim';
  scrim.setAttribute('aria-hidden', 'true');
  topBar.after(scrim);
  const isOpen = () => topBar.classList.contains('open');
  // Closing fades the menu and the scrim out (.closing in site.css) before they go; opening again cuts it short.
  let closing;
  const endClosing = () => { clearTimeout(closing); topBar.classList.remove('closing'); };
  const setOpen = (open, focus) => {
    if (open === isOpen()) return;
    endClosing();
    if (!open && isOpen()) {
      topBar.classList.add('closing');
      closing = setTimeout(endClosing, matchMedia('(prefers-reduced-motion: reduce)').matches ? 120 : 160);
    }
    topBar.classList.toggle('open', open);
    // The page under the scrim stays where it is while the menu is open.
    document.documentElement.classList.toggle('menu-open', open);
    toggle.setAttribute('aria-expanded', String(open));
    toggle.setAttribute('aria-label', open ? 'Close menu' : 'Menu');
    if (open && focus) mainNav.querySelector('a')?.focus();
    if (!open && focus) toggle.focus();
  };
  // Opened from the keyboard (no pointer: detail 0), focus goes to the first link; a tap leaves it on the button.
  toggle.addEventListener('click', e => setOpen(!isOpen(), e.detail === 0));
  mainNav.addEventListener('click', e => { if (e.target.closest('a')) setOpen(false, false); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && isOpen()) { e.preventDefault(); setOpen(false, true); } });
  document.addEventListener('click', e => { if (isOpen() && !topBar.contains(e.target)) setOpen(false, false); });
  topBar.addEventListener('focusout', e => { if (isOpen() && e.relatedTarget && !topBar.contains(e.relatedTarget)) setOpen(false, false); });
  // Wider than a phone the links are back in the bar, so nothing stays open.
  const wide = matchMedia('(min-width: 561px)');
  if (wide.addEventListener) wide.addEventListener('change', m => { if (m.matches) setOpen(false, false); });
}

// Copy buttons. The label changes at once, and a polite live region says so for screen readers
// (the install buttons have an aria-label, so their text change alone isn't announced).
const said = document.createElement('p');
said.className = 'sr'; said.setAttribute('aria-live', 'polite');
document.body.append(said);
document.querySelectorAll('.copy').forEach(btn => {
  let timer;
  btn.addEventListener('click', async () => {
    const code = btn.parentElement.querySelector('code').innerText.trim();
    let ok = true;
    try { await navigator.clipboard.writeText(code); } catch { ok = false; }
    btn.textContent = ok ? 'Copied' : 'Select and copy';
    btn.toggleAttribute('data-done', ok);
    said.textContent = ok ? 'Copied to the clipboard' : 'Couldn’t copy. Select the text and copy it.';
    clearTimeout(timer);
    timer = setTimeout(() => { btn.textContent = 'Copy'; btn.removeAttribute('data-done'); said.textContent = ''; }, 1600);
  });
});

/** Calls pick(id) with the id of the section at the top of the window as the page scrolls. */
function spy(sections, pick) {
  if (!sections.length || !('IntersectionObserver' in window)) return;
  const io = new IntersectionObserver(entries => {
    entries.forEach(e => { if (e.isIntersecting) pick(e.target.id); });
  }, { rootMargin: '-80px 0px -70% 0px' });
  sections.forEach(s => io.observe(s));
  // The last sections can be too short to reach the top of the window: at the very bottom, pick the last one.
  addEventListener('scroll', () => {
    if (innerHeight + scrollY >= document.documentElement.scrollHeight - 4) pick(sections[sections.length - 1].id);
  }, { passive: true });
}

// The landing page: mark the header link for the section you're reading (AI, How it works, Features).
const navLinks = [...document.querySelectorAll('.top nav a[href^="#"]')];
if (navLinks.length) {
  const owner = { ai: 'ai', 'on-device': 'ai', how: 'how', features: 'features' };
  spy([...document.querySelectorAll('main > section[id]')], id => {
    const on = owner[id];
    navLinks.forEach(a => {
      if (a.getAttribute('href') === '#' + on) a.setAttribute('aria-current', 'location');
      else a.removeAttribute('aria-current');
    });
  });
  // Above the first section (the hero), nothing is current.
  addEventListener('scroll', () => {
    const first = document.getElementById('ai');
    if (first && first.getBoundingClientRect().top > 80) navLinks.forEach(a => a.removeAttribute('aria-current'));
  }, { passive: true });
}

// The documentation: highlight the section you're reading in the contents, on the side and in the
// small-screen menu, whose summary also names it ("Contents · Install").
// A part's introduction (header.part, such as Team) names the part, so the summary never shows
// the last section of the part before.
const links = [...document.querySelectorAll('.toc a, .toc-mobile a')];
if (links.length) {
  const side = document.querySelector('.toc');
  const now = document.querySelector('.toc-now');
  spy([...document.querySelectorAll('.content header.part[id], .content section[id]')], id => {
    links.forEach(l => {
      const on = l.getAttribute('href') === '#' + id;
      l.classList.toggle('active', on);
      if (on) l.setAttribute('aria-current', 'location'); else l.removeAttribute('aria-current');
    });
    const part = document.getElementById(id)?.matches('header.part') && document.querySelector(`#${CSS.escape(id)} .part-title`);
    if (now) now.textContent = part ? part.textContent : links.find(l => l.getAttribute('href') === '#' + id)?.textContent || '';
    const a = side && side.querySelector(`a[href="#${CSS.escape(id)}"]`);
    if (a && side.offsetParent) {
      const r = a.getBoundingClientRect(), box = side.getBoundingClientRect();
      if (r.top < box.top || r.bottom > box.bottom - 24) side.scrollBy({ top: r.top - box.top - side.clientHeight / 3 });
    }
  });
}

// Documentation on small screens: close the contents after picking a section.
document.querySelectorAll('.toc-mobile a').forEach(a => a.addEventListener('click', () => a.closest('details').removeAttribute('open')));

// Documentation on small screens: "Back to the top" once you've scrolled down.
const toTop = document.querySelector('.to-top');
if (toTop) {
  const onScroll = () => toTop.classList.toggle('show', scrollY > 900);
  addEventListener('scroll', onScroll, { passive: true }); onScroll();
}
