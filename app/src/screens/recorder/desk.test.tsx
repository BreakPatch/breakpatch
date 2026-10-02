// QA findings from the owner's Mac (DESK-01, 08, 12-17).
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { Run, Step, Suite, SuiteRun, Test } from '../../data/types';
import { StepsPanel } from '../../components/steps';
import { checksNothing, UNCHECKED_NOTE } from '../run/reasons';
import { INITIAL_RUN, runReducer } from '../run/runState';
import { communityDemo } from '../../data/demo/seed';

afterEach(cleanup);
Element.prototype.scrollIntoView ??= () => undefined;
const fsModule = 'node:fs', pathModule = 'node:path', urlModule = 'node:url';
const fs = (await import(/* @vite-ignore */ fsModule)) as { readFileSync(p: string, e: 'utf8'): string };
const { dirname, join } = (await import(/* @vite-ignore */ pathModule)) as { dirname(p: string): string; join(...p: string[]): string };
const { fileURLToPath } = (await import(/* @vite-ignore */ urlModule)) as { fileURLToPath(u: string): string };
const src = join(dirname(fileURLToPath(import.meta.url)), '../..');
const css = (p: string) => fs.readFileSync(join(src, p), 'utf8');

describe('DESK-01: a check that covers nothing is said, never passed silently', () => {
  const full = [[0, 0, 1440, 900]] as [number, number, number, number][];
  const saved: Step[] = [
    { id: 'w', action: 'waitUntil', label: 'Wait until the area looks right', region: [100, 100, 400, 300], hash: '8000000000000000', ignore: full },
    { id: 'k', action: 'click', label: 'Click Next button', at: [700, 500], ignore: full,
      pre: { region: [668, 468, 732, 532], hash: '8000000000000000', tolerance: 6 }, post: { region: [0, 0, 1440, 900], hash: '8000000000000000', tolerance: 10 } },
    { id: 'ok', action: 'click', label: 'Click Save', at: [700, 500], ignore: [[0, 0, 200, 40]],
      pre: { region: [668, 468, 732, 532], hash: 'abcdabcdabcdabcd', tolerance: 6 } },
  ];
  it('finds saved steps whose ignore zone covers their checks', () => {
    expect(saved.map(s => checksNothing(s))).toEqual([true, true, false]);
  });
  it('shows it on the step, in amber', () => {
    render(<StepsPanel steps={saved} mode="edit" notes={{ w: UNCHECKED_NOTE }} onChange={() => undefined} onSelect={() => undefined} />);
    // Closed, it's a short line with the whole sentence on hover (DES-04).
    const note = screen.getByText('Check covers nothing');
    expect(note.className).toContain('tone-fixed');
    expect(note).toHaveAttribute('title', UNCHECKED_NOTE);
  });
  it('keeps what a run said was unchecked', () => {
    let v = runReducer(runReducer(INITIAL_RUN, { type: 'prepare' }), { type: 'start', runId: 'r', ids: ['w'], at: 0 });
    v = runReducer(v, { type: 'step', ev: { runId: 'r', index: 0, stepId: 'w', state: 'passed', unchecked: ['waitUntil'] } });
    expect(v.unchecked.w).toEqual(['waitUntil']);
  });
});

describe('DESK-17: the Community demo shows no Team-only results', () => {
  it('turns fixed into passed and the runner, CI and schedules into this Mac', () => {
    const st = communityDemo({
      tests: [{ id: 't', lastRun: { result: 'healed', at: 1, by: 'Nightly suite' } } as unknown as Test],
      runs: [{ id: 'r', source: 'runner', healedCount: 1, steps: [{ stepId: 'a', result: 'healed', oldAt: [1, 1], newAt: [2, 2] }] } as unknown as Run],
      suites: [{ id: 's', schedule: { days: ['mon'], time: '02:00' }, resultUrl: 'https://hooks.example.com' } as unknown as Suite],
      suiteRuns: [{ id: 'x', result: 'passed_with_fixes', counts: { total: 3, passed: 2, fixed: 1, failed: 0, notRun: 0 } } as unknown as SuiteRun,
        { id: 'y', result: 'replaced', counts: { total: 1, passed: 0, fixed: 0, failed: 0, notRun: 1 } } as unknown as SuiteRun],
      runner: { name: 'QA Mac mini' }, queue: [{}],
    });
    expect(st.tests[0].lastRun?.result).toBe('pass');
    expect(st.runs[0]).toMatchObject({ source: 'desktop', healedCount: 0, steps: [{ stepId: 'a', result: 'passed' }] });
    expect(st.suites[0].schedule).toBeNull();
    expect(st.suiteRuns.map(r => [r.result, r.counts.fixed])).toEqual([['passed', 0]]);
    expect(st.runner).toBeNull();
    expect(st.queue).toEqual([]);
  });
});

describe('small layout and wording', () => {
  it("DESK-12 shows a shared step's full name", () => {
    const g: Step = { id: 'g', action: 'group', label: 'Sign in', groupId: 'x' };
    render(<StepsPanel steps={[g]} mode="edit" selectedId="g" groupSteps={() => [{ id: 'c', action: 'write', label: 'Write saved secret ACME_TEST_EMAIL_ADDRESS', secretRef: 'ACME_TEST_EMAIL_ADDRESS' }]}
      onChange={() => undefined} onSelect={() => undefined} />);
    const name = screen.getByText('Write saved secret ACME_TEST_EMAIL_ADDRESS');
    expect(name.className).toBe('gc-label');
    expect(name.getAttribute('title')).toBe(name.textContent);
    expect(css('components/steps/steps.css')).toMatch(/\.group-child \.gc-label \{ white-space: normal;/);
  });
  it('DESK-13/14 keeps rows one height and "+ note" on one line', () => {
    const c = css('components/steps/steps.css');
    expect(c).toMatch(/\.step-card:not\(\.sel\) \.step-head:not\(:has\(\.step-note\.full\)\) \{ height: 52px;/);
    expect(c).toMatch(/\.expect-add-note \{[^}]*white-space: nowrap;/);
    expect(c).toMatch(/\.step-status, \.group-toggle \{ white-space: nowrap;/);
  });
  it('DESK-15 anchors the setup list at the top', () => {
    // Its content keeps to the top (auto margins centre the other gate pages).
    expect(css('components/shell/gate.css')).toMatch(/\.gi-main\.top \.gi-content \{ margin-top: 0; \}/);
    expect(css('screens/setup/SetupScreen.tsx')).toMatch(/<GateSplit width=\{500\} brand=\{brand\} top>/);
  });
  it('DESK-08/16 words the AI assistant by edition and About in plain words', () => {
    const ai = css('screens/settings/sections/AiSection.tsx'), about = css('screens/settings/sections/AboutSection.tsx');
    expect(ai).toContain("'Names each step you record.'");
    expect(ai).toContain("hasFeature('autoFix')");
    expect(about).not.toMatch(/pinned|Shared library|'Connected'/);
  });
});
