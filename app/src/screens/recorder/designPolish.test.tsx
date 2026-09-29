// Design polish (DES-01 to DES-17): the open card folds shut, notes fit their row, "Not played"
// is said once, one "Next step goes here" slot, Play to here leaves later steps quiet, blocked
// notifications say how to fix it, and the Community suite editor has no empty side column.
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Step } from '../../data/types';
import { shortNote, StepsPanel, UNCHECKED_NOTE } from '../../components/steps';
import { EXIT_MS } from '../../components/ui/presence';
import { INITIAL_RUN, runReducer } from '../run/runState';
import { slowNote } from '../run/reasons';
import { editorStatuses } from './editorRun';
import runSource from '../run/RunScreen.tsx?raw';
import suiteSource from '../suites/SuiteEditorScreen.tsx?raw';
import tauriConf from '../../../src-tauri/tauri.conf.json?raw';

const fsModule = 'node:fs', urlModule = 'node:url', pathModule = 'node:path';
const fs = (await import(/* @vite-ignore */ fsModule)) as { readFileSync(path: string, enc: 'utf8'): string };
const { fileURLToPath } = (await import(/* @vite-ignore */ urlModule)) as { fileURLToPath(url: string): string };
const { dirname, join } = (await import(/* @vite-ignore */ pathModule)) as { dirname(p: string): string; join(...p: string[]): string };
const here = dirname(fileURLToPath(import.meta.url));
const css = (p: string) => fs.readFileSync(join(here, p), 'utf8');

const notify = vi.hoisted(() => ({ perm: 'granted' as 'granted' | 'denied' | 'prompt' }));
vi.mock('../../lib/notify', async orig => ({ ...(await orig<typeof import('../../lib/notify')>()), notifyPermission: async () => notify.perm }));
const opened = vi.hoisted(() => [] as string[]);
vi.mock('../../platform', async orig => ({ ...(await orig<typeof import('../../platform')>()), openExternal: async (u: string) => { opened.push(u); } }));
const { NotificationsSection, NOTIFICATION_SETTINGS_URL } = await import('../settings/sections/NotificationsSection');

Element.prototype.scrollIntoView ??= () => undefined;
afterEach(() => { cleanup(); vi.useRealTimers(); });

const steps: Step[] = [
  { id: 'a', action: 'click', label: 'Click Sign in', at: [10, 10] },
  { id: 'b', action: 'click', label: 'Click Next', at: [20, 20] },
  { id: 'L', action: 'loop', label: 'Repeat 2 times', count: 2, steps: [{ id: 'c', action: 'click', label: 'Click Add', at: [30, 30] }] },
  { id: 't', action: 'waitFor', label: 'Wait 2 seconds', durationMs: 2000 },
];
const panel = (extra: Partial<Parameters<typeof StepsPanel>[0]> = {}) =>
  <StepsPanel steps={steps} mode="edit" onChange={() => undefined} onSelect={() => undefined} onRerecord={() => undefined} onAddAfter={() => undefined} {...extra} />;

describe('DES-01, DES-06: the open card folds open and shut', () => {
  it('keeps the card that was open while it folds shut, then removes it; picking it again turns it back', () => {
    vi.useFakeTimers();
    const { container, rerender } = render(panel({ selectedId: 'a' }));
    const wrap = container.querySelector('[data-step-id="a"] .step-edit-wrap')!;
    rerender(panel({ selectedId: null }));
    expect(container.querySelector('[data-step-id="a"] .step-edit-wrap')).toBe(wrap);
    expect(wrap).toHaveClass('closing');
    act(() => { vi.advanceTimersByTime(60); });
    rerender(panel({ selectedId: 'a' }));
    expect(container.querySelector('[data-step-id="a"] .step-edit-wrap')).toBe(wrap);
    expect(wrap).not.toHaveClass('closing');
    rerender(panel({ selectedId: 'b' }));
    act(() => { vi.advanceTimersByTime(EXIT_MS); });
    expect(container.querySelector('[data-step-id="a"] .step-edit-wrap')).toBeNull();
    expect(container.querySelector('[data-step-id="b"] .step-edit-wrap')).not.toBeNull();
  });
  it('folds with the height (0fr to 1fr), and the Edit panel grows from the ⋯ button', () => {
    const steps = css('../../components/steps/steps.css');
    expect(steps).toMatch(/@keyframes bpFold \{ from \{ grid-template-rows: 0fr;/);
    expect(steps).toMatch(/\.step-edit-wrap \{[^}]*animation: bpFold 200ms cubic-bezier\(\.2,\.7,\.3,1\)/);
    expect(steps).toMatch(/\.step-editpanel \{[^}]*transform-origin: top right;/);
  });
});

describe('DES-04: notes that fit', () => {
  it('shortens a slow step and a check that covers nothing on a closed row, the whole note on hover', () => {
    const slow = slowNote({ preMs: 5200, actionMs: 300, settleMs: 450, postMs: 150 }, 2)!;
    expect(shortNote(slow)).toBe('Slow: 5.2 s waiting for the page');
    expect(shortNote(slowNote({ preMs: 10, actionMs: 4000, settleMs: 30, postMs: 30 })!)).toBe('Slow: 4.0 s doing the step');
    expect(shortNote(UNCHECKED_NOTE)).toBe('Check covers nothing');
    render(panel({ notes: { b: slow } }));
    expect(screen.getByText('Slow: 5.2 s waiting for the page')).toHaveAttribute('title', slow);
  });
  it('gives the open card its whole note on a row of its own under the head', () => {
    const { container } = render(panel({ selectedId: 'b', statuses: { b: 'failed' }, notes: { b: "Couldn't find the Next button" } }));
    const row = container.querySelector('[data-step-id="b"] > .step-note-row')!;
    expect(row).toHaveTextContent("Couldn't find the Next button");
    expect(row).toHaveClass('tone-failed');
    expect(container.querySelector('[data-step-id="b"] .step-main .step-note')).toBeNull();
    expect(css('../../components/steps/steps.css')).toMatch(/\.step-note-row \{ padding: 0 14px 6px 66px;/);
  });
  it('says "Not played since the change" once, above the first, with a dot on each', () => {
    const { container } = render(panel({ unplayedIds: new Set(['b', 'c', 't']), statuses: { c: 'passed' } }));
    expect(screen.getAllByText('Not played since the change. Run the test to check them.')).toHaveLength(1);
    expect(container.querySelector('.steps-unplayed')!.nextElementSibling).toHaveAttribute('data-step-id', 'b');
    const dotted = [...container.querySelectorAll('.step-card')].filter(c => c.querySelector('.step-n .step-dot')).map(c => c.getAttribute('data-step-id'));
    expect(dotted).toEqual(['b', 't']);
  });
});

describe('DES-02, DES-07: the open card keeps still and fits one row', () => {
  it('has the help there before focus, so focusing adds no row', () => {
    const { container } = render(panel({ selectedId: 'a' }));
    const n = container.querySelectorAll('.step-edit *').length;
    fireEvent.focus(screen.getByLabelText(/What to look for/));
    expect(container.querySelectorAll('.step-edit *').length).toBe(n);
  });
  it('has no Re-record and no "Where it acts on the page" for a seconds wait', () => {
    render(panel({ selectedId: 't' }));
    fireEvent.click(screen.getByLabelText('More for this step'));
    expect(screen.queryByRole('menuitem', { name: /Re-record/ })).toBeNull();
    fireEvent.click(screen.getByRole('menuitem', { name: /Edit/ }));
    expect(screen.getByRole('dialog', { name: 'Edit step' })).not.toHaveTextContent('Where it acts on the page');
  });
});

describe('DES-05: the "+" between steps', () => {
  it('is a 12 px band over the gap, faint while the list is hovered, with a line across on its own hover', () => {
    const c = css('../../components/steps/steps.css');
    expect(c).toMatch(/\.step-add-here \{\s*height: 12px; margin: -9px 0;/);
    expect(c).toMatch(/\.steps-list:hover \.step-add-here \{ opacity: \.35; \}/);
    expect(c).toMatch(/\.step-add-here::before \{[^}]*height: 1px; background: var\(--accent\)/);
  });
});

describe('DES-11: one "Next step goes here" while a Repeat is open', () => {
  it('shows only the slot inside the loop', () => {
    const { container } = render(panel({ openLoopId: 'L', insertAfterId: 'a', onCloseLoop: () => undefined }));
    const slots = container.querySelectorAll('.step-next');
    expect(slots).toHaveLength(1);
    expect(slots[0].previousElementSibling?.getAttribute('data-step-id') ?? slots[0].previousElementSibling?.previousElementSibling?.getAttribute('data-step-id')).toBe('c');
  });
});

describe('DES-12: Play to here leaves the steps after it quiet', () => {
  it('gives the steps after the target no status while it plays', () => {
    let v = runReducer(runReducer(INITIAL_RUN, { type: 'prepare' }), { type: 'start', runId: 'r', ids: ['a', 'b', 'L', 'c', 't'], at: 0 });
    v = runReducer(v, { type: 'step', ev: { runId: 'r', index: 0, stepId: 'a', state: 'passed' } });
    const { statuses } = editorStatuses(v, steps, 'play', 'b');
    expect(statuses.a).toBe('passed');
    expect(statuses).not.toHaveProperty('c');
    expect(statuses).not.toHaveProperty('t');
    expect(editorStatuses(v, steps, 'run').statuses.t).toBe('waiting');
  });
});

describe('DES-08: one primary button on a failed run', () => {
  it('makes See report secondary when Open in editor is offered', () => {
    expect(runSource).toMatch(/kind=\{offersFix \? 'secondary' : 'primary'\}.*>See report</);
    expect(runSource).toMatch(/kind="primary" icon="edit".*>Open in editor</);
  });
});

describe('DES-09: notifications blocked by macOS', () => {
  it('says so with a way to open System Settings, and dims the switches', async () => {
    notify.perm = 'denied';
    const { container } = render(<NotificationsSection />);
    fireEvent.click(await screen.findByRole('button', { name: /Open System Settings/ }));
    expect(opened).toEqual([NOTIFICATION_SETTINGS_URL]);
    expect(screen.getAllByText('Blocked by macOS')).toHaveLength(2);
    expect(container.querySelectorAll('.set-toggle.blocked')).toHaveLength(2);
    expect(screen.getByRole('switch', { name: 'Failures' })).not.toBeDisabled();
  });
  it('shows nothing of it when allowed', async () => {
    notify.perm = 'granted';
    render(<NotificationsSection />);
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Failures' })).toBeInTheDocument());
    expect(screen.queryByText('Blocked by macOS')).toBeNull();
  });
  it('lets the shell open that pane, and nothing else new', () => {
    const rx = new RegExp(`^${JSON.parse(tauriConf).plugins.shell.open}$`);
    expect(rx.test(NOTIFICATION_SETTINGS_URL)).toBe(true);
    expect(rx.test('https://breakpatch.dev/manual')).toBe(true);
    expect(rx.test('x-apple.systempreferences:com.apple.preference.security')).toBe(false);
    expect(rx.test('file:///etc/passwd')).toBe(false);
    expect(rx.test('-a Terminal')).toBe(false);
  });
});

describe('DES-16, DES-17', () => {
  it('folds the Community side column into the main column', () => {
    expect(suiteSource).toMatch(/'se-body' \+ \(Panel \? '' : ' solo'\)/);
    expect(suiteSource).toMatch(/\{Panel && \(\s*<div className="se-right">/);
  });
  it('eases the Use the page ring in', () => {
    expect(css('../../components/live/live.css')).toMatch(/\.live-frame \{ transition: box-shadow 180ms ease-out; \}/);
  });
});
