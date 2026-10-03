const { chromium } = require('playwright-core');
const fs = require('fs'), path = require('path');
const FPS = 30; const args = process.argv.slice(2);
(async () => {
  const browser = await chromium.launch({ ...(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {}), args: ['--no-sandbox','--disable-gpu'] });
  const url = 'file://' + path.resolve(__dirname, 'index.html');
  async function mkPage(rec) {
    const p = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
    p.on('pageerror', e => console.error('PAGEERR', e.message));
    await p.goto(url); await p.evaluate(() => window.ready); await p.evaluate(r => window.setCut(r), rec); return p;
  }
  const rec = JSON.parse(fs.readFileSync(args[1], 'utf8'));
  if (args[0] === 'stills') {
    const outDir = args[2]; fs.mkdirSync(outDir, { recursive: true });
    const p = await mkPage(rec);
    for (const t of args.slice(3).map(Number)) {
      await p.evaluate(t => draw(t), t);
      await p.screenshot({ path: path.join(outDir, `t${t.toFixed(2).padStart(5,'0')}.png`) });
    }
  } else if (args[0] === 'dur') {
    const p = await mkPage(rec); console.log(await p.evaluate(() => getDur()));
  } else {
    const outDir = args[2], workers = +args[3] || 4;
    fs.mkdirSync(outDir, { recursive: true });
    const pages = await Promise.all([...Array(workers)].map(() => mkPage(rec)));
    const dur = await pages[0].evaluate(() => getDur()); const total = Math.round(dur * FPS);
    console.log('duration', dur, 'frames', total);
    let next = 0; const t0 = Date.now();
    await Promise.all(pages.map(async p => {
      while (true) {
        const f = next++; if (f >= total) break;
        await p.evaluate(([f, fps]) => draw(f / fps), [f, FPS]);
        await p.screenshot({ path: path.join(outDir, `f${String(f).padStart(4,'0')}.png`) });
        if (f % 60 === 0) console.log('frame', f, ((Date.now()-t0)/1000).toFixed(0)+'s');
      }
    }));
  }
  await browser.close();
})();
