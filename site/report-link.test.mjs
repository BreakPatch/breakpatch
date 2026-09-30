// The run report bridge (report/index.html, assets/report-link.js): which links it passes on.
//   node --test site/report-link.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const ctx = { URLSearchParams };
vm.runInNewContext(read('./assets/report-link.js'), ctx);
const deep = ctx.bpReportDeepLink;

test('passes an app and run id on to the app', () => {
  assert.equal(deep('#r=web-app/rn-l8x2k-0'), 'breakpatch://report/web-app/rn-l8x2k-0');
  assert.equal(deep('r=abc_1/Run_2'), 'breakpatch://report/abc_1/Run_2');
});

test('refuses anything else', () => {
  for (const bad of ['', '#', '#r=', '#r=onlyone', '#r=a/b/c', '#r=a/..', '#r=a%2Fb/c', '#r=javascript:alert(1)/x', '#c=abc', `#r=${'a'.repeat(129)}/b`]) {
    assert.equal(deep(bad), null, bad);
  }
});

test('the page uses the script and never sends the link anywhere', () => {
  const page = read('./report/index.html');
  assert.match(page, /<script src="\/assets\/report-link.js"><\/script>/);
  assert.match(page, /<meta name="referrer" content="no-referrer">/);
  assert.doesNotMatch(page, /fetch\(/);
});
