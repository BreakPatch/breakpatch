#!/usr/bin/env node
// Builds the Documentation page, site/docs/index.html, from docs/manual.md. Node built-ins only,
// no install. The old address, /manual/, redirects to /docs/ (firebase.json), anchors included.
//
//   node site/build-manual.mjs          write the page
//   node site/build-manual.mjs --check  exit 1 if the page is out of date
//
// It understands the Markdown the documentation uses: "# " parts, "## " sections, "### " subsections,
// paragraphs, lists (nested by indent), tables, fenced code, `code`, **bold**, *italic*, [links](…).
// A fence marked ```output is something a program printed, not something to type: no Copy button,
// and its lines wrap on a phone instead of hiding under the button.
// A table right after a <!-- stack --> line becomes one card per row on a phone (site.css table.stack),
// each cell named by its column, two side by side, like the home page's comparison.
// A paragraph that starts with <!-- prelaunch --> becomes the "Public release coming soon" note,
// shown only while <html> has data-prelaunch (GitHub hides the comment and shows the text).
// One that starts with <!-- solo-soon --> becomes a Solo "Coming later" note, in the same style,
// shown only while Solo isn't on sale (no <html data-solo>: assets/paddle-config.js asks the back office).
// One that starts with <!-- soon --> is a note in the same style that always shows (Team and
// Business aren't on sale yet, Hosted by Breakpatch is coming later): delete it when that changes.
// Everything before the first "---" is the intro: its paragraphs become the lead, and its
// contents list is skipped (the page builds its own). Ids match GitHub's heading anchors, so
// links like docs/#run-requests work on both.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, '..', 'docs', 'manual.md');
const OUT = join(here, 'docs', 'index.html');

const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** GitHub's heading anchors: lower case, drop punctuation, spaces to hyphens. */
export function slug(text) {
  return text.toLowerCase().replace(/[`*_]/g, '').replace(/[^\p{L}\p{N}\s-]/gu, '').trim().replace(/\s/g, '-');
}

/** GitHub links get data-gh, so site.js can point them all at one address (GITHUB there). */
const GH = /^https:\/\/github\.com\/breakpatch\/breakpatch(\/[^\s]*)?$/i;
const ghPath = u => { const m = u.match(GH); return m ? ` data-gh="${m[1] || ''}"` : ''; };

function inline(s) {
  const codes = [];
  s = s.replace(/`([^`]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`);
  s = esc(s)
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, u) => `<a href="${u}"${ghPath(u)}>${t}</a>`)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^\w*])\*([^*\s][^*]*?)\*(?!\w)/g, '$1<em>$2</em>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${esc(codes[+i])}</code>`);
}

const PRELAUNCH = /^<!--\s*prelaunch\s*-->\s*(.*)$/;
const SOLO_SOON = /^<!--\s*solo-soon\s*-->\s*(.*)$/;
const SOON = /^<!--\s*soon\s*-->\s*(.*)$/;
const STACK = /^\s*<!--\s*stack\s*-->\s*$/;
const LIST = /^(\s*)(\d+\.|[-*])\s+(.*)$/;
const indentOf = l => l.match(/^\s*/)[0].length;

/** Markdown lines → HTML blocks. */
function blocks(lines) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

    const fence = line.match(/^(\s*)```(\w*)\s*$/);
    if (fence) {
      const pad = fence[1].length, body = [];
      for (i++; i < lines.length && !/^\s*```\s*$/.test(lines[i]); i++) body.push(lines[i].slice(Math.min(pad, indentOf(lines[i]))));
      i++;
      if (fence[2] === 'output') { out.push(`<div class="code output"><pre><code>${esc(body.join('\n'))}</code></pre></div>`); continue; }
      const lang = fence[2] ? ` data-lang="${fence[2]}"` : '';
      out.push(`<div class="code"><button class="copy" type="button">Copy</button><pre><code${lang}>${esc(body.join('\n'))}</code></pre></div>`);
      continue;
    }

    const stack = STACK.test(line) && /^\s*\|/.test(lines[i + 1] ?? '');
    if (stack) i++;

    const h = line.match(/^(#{3,4})\s+(.*)$/);
    if (h) { out.push(`<h${h[1].length} id="${slug(h[2])}">${inline(h[2])}</h${h[1].length}>`); i++; continue; }

    if (stack || /^\s*\|/.test(line)) {
      const rows = [];
      for (; i < lines.length && /^\s*\|/.test(lines[i]); i++) rows.push(lines[i].trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim()));
      const [head, , ...body] = rows;
      // Stacked: every cell after the first names its column (data-label), as the cards on a phone show it.
      const label = j => (stack && j > 0 && head[j] ? ` data-label="${esc(head[j].replace(/[`*_]/g, ''))}"` : '');
      out.push(`<div class="table"><table${stack ? ' class="stack"' : ''}><thead><tr>${head.map(c => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${
        body.map(r => `<tr>${r.map((c, j) => `<td${label(j)}>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }

    const li = line.match(LIST);
    if (li) {
      const base = li[1].length, ordered = /\d/.test(li[2]), items = [];
      const start = ordered ? parseInt(li[2], 10) : 1;
      while (i < lines.length) {
        const m = lines[i].match(LIST);
        if (!m || m[1].length !== base || /\d/.test(m[2]) !== ordered) break;
        const width = base + m[2].length + 1, body = [m[3]];
        for (i++; i < lines.length; i++) {
          const l = lines[i];
          if (!l.trim()) { if (lines[i + 1] && indentOf(lines[i + 1]) >= width) { body.push(''); continue; } break; }
          if (indentOf(l) >= width) { body.push(l.slice(width)); continue; }
          if (indentOf(l) > base && !LIST.test(l)) { body.push(l.trim()); continue; }
          break;
        }
        items.push(body);
      }
      const html = items.map(b => {
        const inner = blocks(b);
        return `<li>${inner.map(x => x.replace(/^<p>([\s\S]*)<\/p>$/, '$1')).join('')}</li>`;
      }).join('');
      out.push(ordered ? `<ol${start !== 1 ? ` start="${start}"` : ''}>${html}</ol>` : `<ul>${html}</ul>`);
      continue;
    }

    const para = [];
    for (; i < lines.length && lines[i].trim() && !LIST.test(lines[i]) && !/^\s*(```|\||#)/.test(lines[i]); i++) para.push(lines[i].trim());
    const pre = para.join(' ').match(PRELAUNCH);
    const soloSoon = para.join(' ').match(SOLO_SOON);
    const soon = para.join(' ').match(SOON);
    if (pre) out.push(`<p class="prelaunch" role="note"><span class="dot" aria-hidden="true"></span><span>${inline(pre[1])}</span></p>`);
    else if (soloSoon) out.push(`<p class="solo-soon" role="note"><span class="dot" aria-hidden="true"></span><span>${inline(soloSoon[1])}</span></p>`);
    else if (soon) out.push(`<p class="soon" role="note"><span class="dot" aria-hidden="true"></span><span>${inline(soon[1])}</span></p>`);
    else if (/^<!--/.test(para[0])) throw new Error(`Unknown note: ${para[0].slice(0, 40)} (prelaunch, solo-soon or soon)`);
    else out.push(`<p>${inline(para.join(' '))}</p>`);
  }
  return out;
}

export function build(md) {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const rule = lines.findIndex(l => l.trim() === '---');
  const intro = lines.slice(1, rule);
  const body = lines.slice(rule + 1);

  // Intro: plain paragraphs only (not the contents list or its bold group names).
  const lead = [];
  let buf = [];
  const flush = () => { if (buf.length) lead.push(buf.join(' ')); buf = []; };
  for (const l of intro) {
    if (!l.trim() || LIST.test(l) || /^\*\*[^*]+\*\*$/.test(l.trim())) flush();
    else buf.push(l.trim());
  }
  flush();

  // Parts (#) hold sections (##); anything else belongs to the current section or part intro.
  const parts = [];
  let part = null, sec = null, inCode = false;
  for (const l of body) {
    if (/^\s*```/.test(l)) inCode = !inCode;
    if (!inCode && l.trim() === '---') continue;
    if (!part && !l.trim()) continue;
    const p = !inCode && l.match(/^#\s+(.*)$/), s = !inCode && l.match(/^##\s+(.*)$/);
    if (p) { part = { title: p[1], id: slug(p[1]), intro: [], sections: [] }; parts.push(part); sec = null; continue; }
    if (s) { sec = { title: s[1], id: slug(s[1]), lines: [] }; part.sections.push(sec); continue; }
    (sec ? sec.lines : part.intro).push(l);
  }

  const ids = new Set();
  for (const p of parts) for (const id of [p.id, ...p.sections.map(s => s.id)]) {
    if (ids.has(id)) throw new Error(`Two headings make the id #${id}`);
    ids.add(id);
  }

  const isTeam = p => p.id === 'team';
  const tag = p => (isTeam(p) ? ' <span class="tag">Team</span>' : '');
  const tocLinks = parts.map(p => `<div class="toc-title">${esc(p.title)}</div>${p.sections.map(s => `<a href="#${s.id}">${inline(s.title)}</a>`).join('')}`).join('');
  const mobileToc = `<details class="toc-mobile"><summary>Contents<span class="toc-now"></span></summary>${parts.map(p =>
    `<div class="toc-title">${esc(p.title)}</div>${p.sections.map(s => `<a href="#${s.id}">${inline(s.title)}</a>`).join('')}`).join('')}</details>`;

  const content = parts.map(p => {
    const head = `<header class="part" id="${p.id}"><div class="part-title">${esc(p.title)}</div>${blocks(p.intro).join('\n')}</header>`;
    const secs = p.sections.map(s => `<section id="${s.id}"${isTeam(p) ? ' class="team"' : ''}><h2>${inline(s.title)}${tag(p)}</h2>\n${blocks(s.lines).join('\n')}\n</section>`);
    return [head, ...secs].join('\n');
  }).join('\n');

  const leadHtml = lead.map((t, i) => `<p${i === 0 ? ' class="lead"' : ''}>${inline(t)}</p>`).join('\n');

  return `<!DOCTYPE html>
<!-- data-prelaunch shows the pre-launch notes. Remove it on launch day (site/README.md, "Launch day"). -->
<html lang="en-GB" data-prelaunch>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Breakpatch documentation</title>
<meta name="description" content="The Breakpatch documentation: install, the tests folder, recording and running tests, suites, and the Team edition's workspace, local runner and run requests.">
<link rel="canonical" href="https://breakpatch.dev/docs/">
<meta name="theme-color" content="#171412" media="(prefers-color-scheme: dark)">
<meta name="theme-color" content="#FBF7F3" media="(prefers-color-scheme: light)">
<meta property="og:type" content="article">
<meta property="og:site_name" content="Breakpatch">
<meta property="og:url" content="https://breakpatch.dev/docs/">
<meta property="og:title" content="Breakpatch documentation">
<meta property="og:description" content="Everything about Breakpatch on one page: install, recording, the report, suites, and the Team edition.">
<meta property="og:image" content="https://breakpatch.dev/assets/og.png">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="/favicon.ico" sizes="32x32">
<link rel="icon" href="/assets/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,400;12..96,500;12..96,600;12..96,700&family=JetBrains+Mono:wght@400;500&display=swap">
<link rel="stylesheet" href="/assets/site.css">
<!-- In <head>: it sets <html data-solo> while Solo is on sale (the back office says so), which hides the Solo "Coming later" note. -->
<script src="/assets/paddle-config.js"></script>
<!-- Built from docs/manual.md by site/build-manual.mjs. Edit the Markdown, then run: node site/build-manual.mjs -->
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="top"><a class="brand" href="/" aria-label="Breakpatch home"><span class="ear" aria-hidden="true"></span><span><b>break</b>patch</span></a><nav aria-label="Main"><a href="/#ai">AI</a><a class="wide" href="/#how">How it works</a><a class="wide" href="/#features">Features</a><a href="/pricing/">Pricing</a><a href="/docs/" aria-current="page">Docs</a><a class="wide" href="https://github.com/BreakPatch/breakpatch" data-gh="">GitHub</a></nav><a class="btn" href="/#install">Install</a></header>
<div class="docs">
<aside class="toc" aria-label="Contents">${tocLinks}</aside>
<main class="content" id="main"><h1>Documentation</h1>
${leadHtml}
${mobileToc}
${content}
<footer class="foot">Found a mistake? <a href="https://github.com/BreakPatch/breakpatch/edit/main/docs/manual.md" data-gh="/edit/main/docs/manual.md">Edit this page on GitHub</a>, or write to <a href="mailto:support@breakpatch.dev">support@breakpatch.dev</a>.</footer>
</main>
</div>
<footer class="site-foot rich">
  <div class="wrap">
    <div class="foot-brand">
      <a class="brand" href="/"><span class="ear" aria-hidden="true"></span><span><b>break</b>patch</span></a>
      <p>Here to find what breaks.</p>
      <p><a href="mailto:support@breakpatch.dev">support@breakpatch.dev</a></p>
    </div>
    <nav class="foot-links" aria-label="Footer">
      <a href="/docs/">Docs</a>
      <a href="/pricing/">Pricing</a>
      <a href="https://github.com/BreakPatch/breakpatch" data-gh="">GitHub</a>
      <a href="https://github.com/BreakPatch/breakpatch/releases" data-gh="/releases">Releases</a>
      <a href="/terms">Terms</a>
      <a href="/privacy">Privacy</a>
      <a href="/refunds">Refunds</a>
      <a href="mailto:support@breakpatch.dev">Support</a>
    </nav>
    <p class="foot-small">© 2026 Breakpatch. The Community edition is open source under Apache 2.0.</p>
  </div>
</footer>
<a class="to-top" href="#main" aria-label="Back to the top">↑</a>
<script src="/assets/site.js"></script>
</body>
</html>
`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const html = build(readFileSync(SRC, 'utf8'));
  if (process.argv.includes('--check')) {
    let now = '';
    try { now = readFileSync(OUT, 'utf8'); } catch {}
    if (now !== html) { console.error('site/docs/index.html is out of date. Run: node site/build-manual.mjs'); process.exit(1); }
    console.log('site/docs/index.html is up to date.');
  } else {
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, html);
    console.log(`Wrote ${OUT}`);
  }
}
