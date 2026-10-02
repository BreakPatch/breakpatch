// breakpatch.dev: GitHub links, copy buttons, where-you-are highlighting. No framework.

// Every GitHub link on the site is <a data-gh="/path">. Change this one line to move them all
// (the repository is private until the public release, so these 404 for visitors until then).
const GITHUB = 'https://github.com/BreakPatch/breakpatch';
document.querySelectorAll('[data-gh]').forEach(a => { a.href = GITHUB + a.dataset.gh; });

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
const links = [...document.querySelectorAll('.toc a, .toc-mobile a')];
if (links.length) {
  const side = document.querySelector('.toc');
  const now = document.querySelector('.toc-now');
  spy([...document.querySelectorAll('.content section[id]')], id => {
    links.forEach(l => {
      const on = l.getAttribute('href') === '#' + id;
      l.classList.toggle('active', on);
      if (on) l.setAttribute('aria-current', 'location'); else l.removeAttribute('aria-current');
    });
    if (now) now.textContent = links.find(l => l.getAttribute('href') === '#' + id)?.textContent || '';
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
