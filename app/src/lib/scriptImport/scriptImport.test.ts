// Importing Playwright and Cypress scripts (roadmap #16): the tokenizer, the locator words, and
// whole real-world-like files (Playwright codegen output, a hand-written spec, a Cypress spec) to
// the steps they map to and the lines they list.
import { describe, expect, it } from 'vitest';
import { frameworkOf, importScript, nameFromFile, toWalk, withBase, withSecrets, type ImportedTest } from '.';
import { Parser } from './parse';
import { tokenize } from './tokens';
import { idWords, regexWords, selectorLoc, targetWords } from './locators';
import { planSentence } from '../../screens/recorder/plan';
import codegenTodo from './fixtures/codegen-todo.spec.ts.txt?raw';
import codegenLibrary from './fixtures/codegen-library.js.txt?raw';
import checkout from './fixtures/checkout.spec.ts.txt?raw';
import cypressLogin from './fixtures/login.cy.ts.txt?raw';

/** The steps as the recorder says them, with the line they came from. */
const said = (t: ImportedTest) => t.steps.map(s => `${s.line}: ${planSentence(s)}${s.guessed ? ' (check)' : ''}`);
const skippedLines = (t: ImportedTest, notNeeded = false) => t.skipped.filter(s => !!s.notNeeded === notNeeded).map(s => s.line);

describe('tokenize', () => {
  it('reads strings with their escapes, and never code inside strings or comments', () => {
    const t = tokenize(`// page.goto('a')\nconst s = 'it\\'s "x"\\n'; /* cy.visit('/') */ const d = "a\\u0041\\x42";`);
    expect(t.filter(k => k.kind === 'str').map(k => k.value)).toEqual(['it\'s "x"\n', 'aAB']);
    expect(t.some(k => k.value === 'goto' || k.value === 'visit')).toBe(false);
  });
  it('tells a regular expression from a division', () => {
    const t = tokenize('expect(page).toHaveURL(/\\/cart\\/?$/i); const half = total / 2 / 1;');
    const re = t.find(k => k.kind === 'regex')!;
    expect(re.value).toBe('\\/cart\\/?$');
    expect(re.flags).toBe('i');
    expect(t.filter(k => k.kind === 'regex')).toHaveLength(1);
  });
  it('marks template literals with ${…} as worked out at run time', () => {
    const [plain, dyn] = tokenize('`/login` `/users/${id}/edit`');
    expect(plain).toMatchObject({ kind: 'tmpl', value: '/login' });
    expect(plain.dynamic).toBeUndefined();
    expect(dyn).toMatchObject({ kind: 'tmpl', dynamic: true, value: '/users/${id}/edit' });
  });
  it('counts lines, also through comments and templates', () => {
    const t = tokenize('a\n/* one\ntwo */\nb `x\ny` c');
    expect(t.map(k => [k.value.replace(/\n/g, '|'), k.line])).toEqual([['a', 1], ['b', 4], ['x|y', 4], ['c', 5]]);
    expect(t[1].nl).toBe(true);
  });
  it('reads a big file quickly', () => {
    const one = "test('t', async ({ page }) => {\n  await page.goto('/a');\n  await page.getByRole('button', { name: 'Save' }).click();\n  await expect(page.getByText('Saved')).toBeVisible();\n});\n";
    const t0 = performance.now();
    const r = importScript(one.repeat(3000), 'big.spec.ts');
    expect(r.tests).toHaveLength(3000);
    expect(performance.now() - t0).toBeLessThan(3000);
  });
  it('stops reading nesting that goes too deep, without failing', () => {
    for (const src of ['test("a", async ({ page }) => { const x = ' + '['.repeat(50000) + ' })', '('.repeat(50000), 'if (a) '.repeat(20000) + 'b()', '{'.repeat(50000)]) {
      expect(() => importScript(src, 'a.spec.ts')).not.toThrow();
    }
    const deepThenStep = "test('a', async ({ page }) => { const x = " + '['.repeat(500) + ']'.repeat(500) + "; await page.getByText('Go').click() })";
    expect(importScript(deepThenStep, 'a.spec.ts').tests[0].steps).toEqual([expect.objectContaining({ action: 'click', target: '"Go"' })]);
  });
  it("never throws on text that isn't JavaScript", () => {
    for (const junk of ['', '"unterminated', '/* open', '`${', '\u0000\u0001￿', '{{{{((((', ')))]]]}}}', '\\u']) {
      expect(() => tokenize(junk)).not.toThrow();
      expect(() => importScript(junk, 'x.spec.ts')).not.toThrow();
    }
  });
});

describe('parse', () => {
  it('reads a chain across lines, with its calls and literal arguments', () => {
    const p = new Parser("cy.get('#a')\n  .type('x', { delay: 0 })\n  .should('have.value', 'x')\ncy.reload()");
    const st = p.statements(0, p.t.length);
    expect(st).toHaveLength(2);
    expect(st[0].kind).toBe('expr');
    if (st[0].kind !== 'expr') return;
    expect(st[0].chain.links.map(l => l.name)).toEqual(['cy', 'get', 'type', 'should']);
    expect(st[0].chain.links[2].args).toEqual([{ kind: 'str', v: 'x' }, { kind: 'obj', props: { delay: { kind: 'num', v: 0 } } }]);
    expect(st[0].endLine).toBe(3);
  });
  it('keeps arithmetic, ternaries and type assertions as "other", never evaluated', () => {
    const p = new Parser("const a = b + 'c'; const d = x ? 'y' : 'z'; const e = 'f' as const;");
    const [a, d, e] = p.statements(0, p.t.length);
    expect(a.kind === 'decl' && a.init?.kind).toBe('other');
    expect(d.kind === 'decl' && d.init?.kind).toBe('other');
    expect(e.kind === 'decl' && e.init).toEqual({ kind: 'str', v: 'f' });
    // A ternary's `:` after an object in it, and nested ternaries: one value each, up to the `;`.
    const q = new Parser("const g = x ? { a: 1 } : 2; const h = a ? b ? 1 : 2 : 3; i()");
    const [g, h, i] = q.statements(0, q.t.length);
    expect(g.kind === 'decl' && g.init).toEqual({ kind: 'other', text: 'x ? { a: 1 } : 2' });
    expect(h.kind === 'decl' && h.init).toEqual({ kind: 'other', text: 'a ? b ? 1 : 2 : 3' });
    expect(i.kind).toBe('expr');
  });
  it('puts a statement over several lines on one, keeping the spaces within a line', () => {
    const p = new Parser("foo('a  b',\n   \n\t  c)");
    expect(p.statements(0, p.t.length)[0].src).toBe("foo('a  b', c)");
  });
  it('steps over if, for and try blocks as one statement each', () => {
    const p = new Parser('if (a) { b() } else if (c) d(); else { e() }\nfor (const x of y) { z(x) }\ntry { f() } catch (err) { g() } finally { h() }\ndone()');
    expect(p.statements(0, p.t.length).map(s => s.kind)).toEqual(['block', 'block', 'block', 'expr']);
  });
  it('steps over a chain of thousands of else ifs without running out of stack', () => {
    for (const branch of ['else if (a) { b() } ', 'else if (a) b(); ']) {
      const p = new Parser(`if (a) { b() } ${branch.repeat(30_000)}else { c() }\ndone()`);
      expect(p.statements(0, p.t.length).map(s => s.kind)).toEqual(['block', 'expr']);
    }
  });
});

describe('hostile scripts', () => {
  // Each of these took seconds to minutes at this size when the parser looked back over what it
  // had read (the dialog froze meanwhile). Now each is read in one pass.
  const K = 160_000;
  const shapes: Record<string, string> = {
    'a long run of spaces in a statement': "test('a', () => { a" + ' '.repeat(K) + 'b })',
    'nested ternaries': "test('a', async () => { const x = " + 'a?'.repeat(K / 4) + 'a:'.repeat(K / 4) + 'a })',
    'ternaries in a list': '[' + 'a?a:'.repeat(K / 4) + ']',
    'slashes that never close a regular expression': '/['.repeat(K / 2),
    'arrow-like return types in a list': '[' + '(0):a,'.repeat(K / 6) + ']',
    'a Cypress type() with braces that never close': "it('a', () => { cy.get('#a').type('" + '{'.repeat(K) + "') })",
    'a template with spaces in ${…}': "test('a', async ({ page }) => { await page.getByLabel('a').fill(`${a" + ' '.repeat(K) + 'b}`) })',
    'an else if chain': 'if (a) {} ' + 'else if (a) {} '.repeat(K / 16),
  };
  for (const [name, src] of Object.entries(shapes)) {
    it(`reads ${name} quickly`, () => {
      const t0 = performance.now();
      expect(() => importScript(src, 'a.spec.ts')).not.toThrow();
      expect(performance.now() - t0).toBeLessThan(1000);
    });
  }
  it('still reads a regular expression after a slash that started none', () => {
    // From the first `/` the look ends inside [/x/]; from the second it closes after `x`.
    expect(tokenize('a = /[/x/').map(k => `${k.kind}:${k.value}`)).toEqual(['id:a', 'punct:=', 'punct:/', 'punct:[', 'regex:x']);
  });
  it('reads Cypress keys and template values as before', () => {
    const cy = importScript("it('a', () => { cy.visit('/a'); cy.get('#q').type('{{}x}{enter}') })", 'a.cy.ts').tests[0];
    expect(cy.steps.map(s => s.text)).toEqual(['{x}\n']);
    const pw = importScript("const id = 'u1';\ntest('a', async ({ page }) => { await page.goto('/a'); await page.getByLabel('n').fill(`n-${ id }-${Date.now()}`) })", 'a.spec.ts').tests[0];
    expect(pw.steps.map(s => s.text)).toEqual(['n-u1-{timestamp}']);
  });
});

describe('locators in words', () => {
  it('says what a selector names, from its text, label or test attributes', () => {
    expect(selectorLoc('text=Sign in')).toEqual({ name: 'Sign in', text: true });
    expect(selectorLoc('text="Orders"i')).toEqual({ name: 'Orders', text: true });
    expect(selectorLoc('role=button[name="Save"]')).toEqual({ name: 'Save', role: 'button' });
    expect(selectorLoc('button:has-text("Save draft")')).toEqual({ name: 'Save draft', role: 'button' });
    expect(selectorLoc('input[placeholder="Search"]')).toEqual({ name: 'Search', role: 'field' });
    expect(selectorLoc('[aria-label="Close dialog"]')).toEqual({ name: 'Close dialog' });
    expect(selectorLoc('[data-testid="cart-total"]')).toEqual({ name: 'cart total', code: true });
    expect(selectorLoc('[data-cy=submitButton]')).toEqual({ name: 'submit button', code: true, guessed: true });
    expect(selectorLoc('form #user_email')).toEqual({ name: 'user email', code: true, guessed: true });
    expect(selectorLoc('input[type=checkbox]#terms')).toEqual({ name: 'terms', role: 'checkbox', code: true, guessed: true });
    expect(selectorLoc('h2')).toEqual({ role: 'heading', guessed: true });
  });
  it("refuses CSS classes, structure and XPath, saying why", () => {
    for (const sel of ['.btn-primary', 'div > span:nth-child(2)', '//button[1]', 'xpath=//a', 'a, b']) {
      const l = selectorLoc(sel);
      expect('why' in l && l.why).toMatch(/Breakpatch doesn't use/);
    }
  });
  it('reads the words the fast locator understands', () => {
    expect(targetWords({ name: 'Sign in', role: 'button' })).toBe('the "Sign in" button');
    expect(targetWords({ name: 'Delete', role: 'button', ordinal: 2 })).toBe('the second "Delete" button');
    expect(targetWords({ name: 'Item', text: true, ordinal: -1 })).toBe('the last "Item"');
    expect(targetWords({ name: 'Welcome back', text: true })).toBe('"Welcome back"');
    expect(targetWords({ name: 'submit button', role: 'button', code: true })).toBe('the submit button');
    expect(targetWords({ name: 'email', role: 'field', code: true })).toBe('the email field');
  });
  it('takes plain-word regular expressions only', () => {
    expect(regexWords('sign in')).toBe('sign in');
    expect(regexWords('^Save$')).toBe('Save');
    expect(regexWords('Order\\s+placed')).toBe('Order placed');
    expect(regexWords('item-\\d+')).toBeUndefined();
    expect(regexWords('(a|b)')).toBeUndefined();
  });
  it('splits code names into words', () => {
    expect(idWords('submitBtn')).toBe('submit btn');
    expect(idWords('user_email-field')).toBe('user email field');
  });
});

describe('Playwright codegen output', () => {
  it('maps a recorded test, with typing and Enter as one step and the popup as a tab switch', () => {
    const r = importScript(codegenTodo, 'todo.spec.ts');
    expect(r.framework).toBe('playwright');
    expect(r.tests).toHaveLength(1);
    const [t] = r.tests;
    expect(t.name).toBe('Todo');                      // codegen calls every test "test": the file's name instead
    expect(t.startUrl).toBe('https://demo.playwright.dev/todomvc/#/');
    expect(said(t)).toEqual([
      // The click into the field is left out: typing clicks it first.
      '6: Type "Buy milk" into the "What needs to be done?" field and press Enter',
      '8: Click the "Toggle Todo" checkbox',
      '9: Click the "Completed" link',
      '10: Check that "Buy milk" shows',
      '11: Check that the "Completed" link shows',
      '13: Click the "real TodoMVC app" link',
      '14: Switch to the new tab',
      '15: Click the "Docs" link',
    ]);
    expect(t.skipped).toEqual([]);
  });

  it('reads the library form (a script with no test blocks) as one test', () => {
    const [t] = importScript(codegenLibrary, 'example.js').tests;
    expect(t.name).toBe('Example');
    expect(t.startUrl).toBe('https://example.com/');
    expect(t.viewport).toEqual({ width: 1280, height: 720 });
    expect(said(t)).toEqual(['10: Click the "More information..." link', '11: Double-click "Example Domains"']);
    // Opening and closing the browser: listed as not needed, not as missing.
    expect(skippedLines(t, true)).toEqual([4, 7, 8, 14, 15]);
    expect(skippedLines(t)).toEqual([]);
  });
});

describe('a hand-written Playwright spec', () => {
  const r = importScript(checkout, 'checkout.spec.ts');
  const [pay, refunds] = r.tests;

  it('finds each test in its describe block, with the hooks and test.use() that apply to it', () => {
    expect(r.tests.map(t => t.name)).toEqual(['pays with a card', 'refunds']);
    for (const t of r.tests) {
      expect(t.startUrl).toBe('/shop');
      expect(t.viewport).toEqual({ width: 1280, height: 800 });
      expect(said(t).slice(0, 3)).toEqual([
        '13: Type "ada@example.com" into the "Email" field',
        '14: Type into the "Password" field',
        '15: Click the "sign in" button',
      ]);
      expect(t.steps[1]).toMatchObject({ needs: 'secret', secretHint: 'SHOP_PASSWORD' });
    }
  });

  it('maps locators, values from names, drop-downs, waits, steps and checks', () => {
    expect(said(pay).slice(3)).toEqual([
      '21: Click the "Add to cart" button (check)',      // inside a list item: Breakpatch looks on the whole page
      '22: Click the "Cart" link',                       // a locator kept in a name
      '24: Type "Ada Lovelace" into the full name field (check)',   // an id, and a value from an object
      '25: Type "4242 4242 4242 4242" into the card number field',  // a test id the fast locator reads
      '26: Click the "Country" dropdown',
      '26: Click the "Sweden" option (check)',
      '27: Click the "I accept the terms" checkbox',
      '28: Type "SAVE-{timestamp}" into the "Discount code" field (check)',
      '34: Click the "Pay now" button',                  // inside test.step()
      '35: Wait 2 seconds',
      '38: Check that the "Thank you" heading shows',
      '39: Check that the "Order placed" heading shows',
      '42: Click the "Details" button (check)',
      '46: Go to /account (check)',                       // `${BASE}/account`: the path on the app's address
      '47: Go back',
    ]);
  });

  it('lists every line it left out, with a plain reason', () => {
    const why = (line: number) => pay.skipped.find(s => s.line === line)!.why;
    expect(skippedLines(pay)).toEqual([23, 29, 30, 40, 41, 43, 44, 45]);
    expect(why(23)).toMatch(/not the page's address or title/);
    expect(why(29)).toMatch(/Pressing Tab isn't a step/);
    expect(why(30)).toMatch(/Conditions and loops aren't imported/);
    expect(why(40)).toMatch(/isn't there isn't a step/);
    expect(why(41)).toMatch(/whether it is ticked/);
    expect(why(43)).toMatch(/CSS classes/);
    expect(why(44)).toMatch(/Uploads are added by hand/);
    expect(why(45)).toMatch(/login\(\) is your own code/);
    expect(pay.skipped.find(s => s.line === 43)!.code).toBe("await page.locator('.receipt > div:nth-child(2)').click();");
    expect(skippedLines(pay, true)).toEqual([37, 48]);    // waitForLoadState, toHaveScreenshot
  });

  it('reads the older page.click(selector) form', () => {
    expect(said(refunds).slice(3)).toEqual([
      '52: Click "Orders"',
      '53: Type "A-1001" into the search field and press Enter (check)',
      '55: Wait until the "A-1001" row shows',
    ]);
  });
});

describe('a Cypress spec', () => {
  const r = importScript(cypressLogin, 'login.cy.ts');
  const [signIn, wrong] = r.tests;

  it('maps visit, get and contains with click, type, check, select and should', () => {
    expect(r.framework).toBe('cypress');
    expect(signIn.name).toBe('signs in and sees the dashboard');
    expect(signIn.startUrl).toBe('/login');
    expect(signIn.viewport).toEqual({ width: 1366, height: 768 });
    expect(said(signIn)).toEqual([
      '10: Type "ada@example.com" into the email field (check)',
      '11: Type into the password field (check)',
      '12: Click the "Sign in" button',
      '14: Check that "Welcome back" shows',
      '15: Check that the "Dashboard" heading shows',
      '18: Click "Orders"',
      '22: Type "shoes" into the search field and press Enter (check)',
      '23: Click the country dropdown (check)',
      '23: Click the "Sweden" option (check)',
      '24: Click the terms checkbox (check)',
      '31: Wait 1 seconds',
    ]);
    expect(signIn.steps[1]).toMatchObject({ needs: 'secret', secretHint: 'PASSWORD' });
  });

  it("lists what it can't map: the address, absence, the network, classes, callbacks, custom commands, keys", () => {
    expect(skippedLines(signIn)).toEqual([13, 16, 17, 25, 26, 27, 30, 32, 32]);
    const why = (line: number) => signIn.skipped.filter(s => s.line === line).map(s => s.why).join(' ');
    expect(why(30)).toMatch(/cy\.login\(\) is a custom command/);
    expect(why(27)).toMatch(/inside \.within\(\)/);
    expect(why(32)).toMatch(/Emptying a field.*\{selectall\}/s);
    expect(skippedLines(signIn, true)).toEqual([5, 21]);     // cy.viewport (used), cy.wait('@orders')
  });

  it('runs the beforeEach for every test', () => {
    expect(wrong.startUrl).toBe('/login');
    expect(said(wrong)).toEqual([
      '36: Type "ada@example.com" into the email field (check)',
      '37: Type "wrong" into the password field and press Enter (check)',
      '38: Check that "wrong password" shows',
    ]);
  });
});

describe('small cases', () => {
  const one = (src: string, file = 'a.spec.ts') => importScript(src, file).tests[0];

  it('takes the first address as the start and later ones as Go to steps', () => {
    const t = one("test('a', async ({ page }) => { await page.goto('/a'); await page.getByText('B').click(); await page.goto('/c'); await page.reload(); await page.goForward() })");
    expect(t.startUrl).toBe('/a');
    expect(said(t)).toEqual(['1: Click "B"', '1: Go to /c', '1: Reload the page', '1: Go forward']);
  });
  it('clicks with the right button, twice, or ticks a labelled checkbox', () => {
    const t = one(`test('a', async ({ page }) => {
      await page.getByText('Row').click({ button: 'right' });
      await page.getByText('Row').click({ clickCount: 2 });
      await page.getByLabel('Remember me').check();
      await page.getByRole('menuitem', { name: 'Rename' }).hover();
      await page.getByText('x').click({ modifiers: ['Shift'] });
    })`);
    expect(said(t)).toEqual(['2: Right-click "Row"', '3: Double-click "Row"', '4: Click the "Remember me" checkbox', '5: Hover over the "Rename" menu item']);
    expect(t.skipped[0].why).toMatch(/keys held down/);
  });
  it('types from consts, the environment and keyboard calls (into the focused field)', () => {
    const t = one(`const EMAIL = 'qa@example.com';
test('a', async ({ page }) => {
  const password = process.env.APP_PASSWORD;
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password').fill(password);
  await page.keyboard.type('hello');
  await page.keyboard.press('Enter');
  await page.getByLabel('Name').fill(makeName());
})`);
    expect(said(t)).toEqual([
      '4: Type "qa@example.com" into the "Email" field',
      '5: Type into the "Password" field',
      '6: Type "hello" into the field that has the focus and press Enter',
      '8: Type into the "Name" field',
    ]);
    expect(t.steps[1]).toMatchObject({ needs: 'secret', secretHint: 'APP_PASSWORD' });
    expect(t.steps[3]).toMatchObject({ needs: 'text' });
  });
  it('keeps nth(), first() and last() as words the fast locator reads', () => {
    const t = one(`test('a', async ({ page }) => {
      await page.getByRole('button', { name: 'Delete' }).nth(1).click();
      await page.getByRole('link', { name: 'Next' }).first().click();
      await page.getByText('Item').last().click();
      await page.getByRole('button').first().click();
    })`);
    expect(said(t)).toEqual(['2: Click the second "Delete" button', '3: Click the first "Next" link', '4: Click the last "Item"']);
    expect(t.skipped[0].why).toMatch(/doesn't say which one/);
  });
  it('caps waits at a minute and rounds up to whole seconds', () => {
    const t = one("test('a', async ({ page }) => { await page.waitForTimeout(250); await page.waitForTimeout(90000) })");
    expect(said(t)).toEqual(['1: Wait 1 seconds', '1: Wait 60 seconds']);
  });
  it('never makes a Call step: calls to an API are listed, with Call your API to add one by hand', () => {
    const pw = one(`test('a', async ({ page, request }) => {
      await page.goto('/a');
      await request.post('https://api.acme.com/orders/42/pay', { data: { paid: true } });
      await page.getByText('Paid').click();
    })`);
    const cy = one(`it('a', () => { cy.visit('/a'); cy.request('POST', '/api/orders/42/pay'); cy.contains('Paid').click() })`, 'a.cy.ts');
    for (const t of [pw, cy]) {
      expect(t.steps.map(s => s.action)).toEqual(['click']);
      expect(t.skipped.map(s => s.why)).toEqual([expect.stringMatching(/add a Call step by hand \(Call your API\)/)]);
    }
  });
  it('lists a test with nothing to import as empty, never invents steps', () => {
    const t = one("test('a', async ({ page }) => { await doEverything(page) })");
    expect(t.steps).toEqual([]);
    expect(t.skipped.map(s => s.why)).toEqual([expect.stringMatching(/doEverything\(\) is your own code/)]);
  });
  it('reads a Cypress file without the .cy name by its cy. calls', () => {
    const r = importScript("it('a', () => { cy.visit('https://example.com'); cy.contains('More').click() })", 'smoke.js');
    expect(r.framework).toBe('cypress');
    expect(said(r.tests[0])).toEqual(['1: Click "More"']);
  });
  it('turns Cypress hover and go back', () => {
    const t = importScript("it('a', () => { cy.contains('Menu').trigger('mouseover'); cy.go('back'); cy.reload() })", 'a.cy.js').tests[0];
    expect(said(t)).toEqual(['1: Hover over "Menu"', '1: Go back', '1: Reload the page']);
  });
});

describe('before learning', () => {
  it('makes the addresses full against the app address', () => {
    const t = withBase({ name: 'a', startUrl: '/login', steps: [{ action: 'navigate', url: '/account', line: 1, code: '' }, { action: 'navigate', url: 'https://other.example/x', line: 2, code: '' }], skipped: [] }, 'https://app.example.com/base/');
    expect(t.startUrl).toBe('https://app.example.com/login');
    expect(t.steps.map(s => s.url)).toEqual(['https://app.example.com/account', 'https://other.example/x']);
  });
  it('leaves out a Go to step that isn\'t a web address, and says why', () => {
    const t = withBase({ name: 'a', startUrl: '/', steps: [{ action: 'navigate', url: 'javascript:alert(1)', line: 4, code: "await page.goto('javascript:alert(1)')" }, { action: 'click', target: '"A"', line: 5, code: '' }],
      skipped: [{ line: 2, code: 'x', why: 'y' }, { line: 9, code: 'x', why: 'y' }] }, 'https://app.example.com');
    expect(t.steps.map(s => s.action)).toEqual(['click']);
    expect(t.skipped.map(s => s.line)).toEqual([2, 4, 9]);
    expect(t.skipped[1].why).toMatch(/only opens web addresses/);
  });
  it('uses a saved secret named like the environment variable, whatever its case', () => {
    const steps = withSecrets([
      { action: 'write', target: 'the "Password" field', needs: 'secret', secretHint: 'shop-password', line: 1, code: '' },
      { action: 'write', target: 'the "Token" field', needs: 'secret', secretHint: 'API_TOKEN', line: 2, code: '' },
    ], ['SHOP_PASSWORD', 'OTHER']);
    expect(steps[0]).toMatchObject({ secretRef: 'SHOP_PASSWORD' });
    expect(steps[0].needs).toBeUndefined();
    expect(steps[1]).toMatchObject({ needs: 'secret' });
  });
  it('hands the recorder the steps without where they came from, marking the guessed ones to check', () => {
    expect(toWalk({ action: 'click', target: 'the submit button', guessed: true, line: 3, code: "cy.get('#submit').click()" })).toEqual({ action: 'click', target: 'the submit button', check: true });
    expect(toWalk({ action: 'write', target: 'the "Password" field', needs: 'secret', secretHint: 'PW', line: 4, code: '' })).toEqual({ action: 'write', target: 'the "Password" field', needs: 'secret' });
  });
  it('names a test after its file', () => {
    expect(nameFromFile('/x/checkout-flow.spec.ts')).toBe('Checkout flow');
    expect(nameFromFile('signUp.cy.js')).toBe('Sign up');
    expect(nameFromFile('')).toBe('Imported test');
  });
  it('tells Playwright from Cypress', () => {
    expect(frameworkOf(new Parser('await page.goto("/")'), 'x.ts')).toBe('playwright');
    expect(frameworkOf(new Parser(''), 'x.cy.ts')).toBe('cypress');
  });
});
