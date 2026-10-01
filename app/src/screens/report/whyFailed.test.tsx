// "Why did this fail?" in the report (roadmap #7): on demand, marked as the AI assistant's, kept on
// the run and asked once, only with the explain feature, and plain words for every problem.
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Explanation, Run, Step, StepRun } from '../../data/types';
import { DemoBackend } from '../../data/demo/demoBackend';
import { useSession } from '../../state/session';
import { NO_FEATURES } from '../../edition/types';
import { resetFeaturesForTests, setFeatures } from '../../edition/features';
import { EngineError } from '../../engine/engine';
import { clearExplanationsForTests, explainStep, explanationText, MAX_KEPT } from '../../lib/explain';
import { copyDetails } from './reportData';

const fake = vi.hoisted(() => ({ explain: vi.fn() }));
vi.mock('../../engine', async orig => ({ ...(await orig<typeof import('../../engine')>()), getEngine: () => fake, demoEngine: () => null }));

const { WhyFailed } = await import('./WhyFailed');
const { ReportDetail } = await import('./ReportDetail');

const VP = { width: 1440, height: 900 };
const SAVE: Step = { id: 's3', action: 'click', label: 'Click Save', target: 'Save button, bottom right of the Edit profile dialog', at: [1300, 820] };
const FAILED: StepRun = { stepId: 's3', result: 'failed', reason: 'targetNotFound', preDistance: 30, screenshotPath: '/shots/r1/003-s3.png' };
const RENAMED: Explanation = { summary: 'The Save button now reads “Save changes”.', cause: 'textChanged', suggestion: 'acceptChange' };

let backend: DemoBackend;
let run: Run;

beforeEach(async () => {
  resetFeaturesForTests();
  setFeatures({ ...NO_FEATURES, explain: true });
  clearExplanationsForTests();
  fake.explain.mockReset();
  backend = new DemoBackend({ empty: true, signedIn: true, delayMs: 0 });
  useSession.setState({ backend });
  const app = await backend.addApp({ name: 'Web', baseUrl: 'https://app.example.com', defaultViewport: { ...VP, dpr: 1 } });
  run = await backend.addRun({ appId: app.id, testId: 't1', testName: 'Edit profile', testVersion: 1, startedBy: { uid: 'u', name: 'Maria', email: 'm@x' },
    machine: 'Mac', source: 'desktop', startedAt: Date.now(), durationMs: 5000, result: 'fail', healedCount: 0, steps: [FAILED] });
});
afterEach(() => { cleanup(); resetFeaturesForTests(); });

const why = (stepRun: StepRun | undefined = FAILED) => render(<WhyFailed run={run} step={SAVE} stepRun={stepRun} viewport={VP} />);

describe('Why did this fail?', () => {
  it('asks the engine on demand and shows the answer as the AI assistant’s', async () => {
    fake.explain.mockResolvedValue(RENAMED);
    why();
    expect(fake.explain).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Why did this fail?' }));
    expect(await screen.findByText('The Save button now reads “Save changes”.')).toBeInTheDocument();
    expect(screen.getByText('From the AI assistant')).toBeInTheDocument();
    expect(screen.getByText('Its text changed')).toBeInTheDocument();
    expect(screen.queryByText('If this change is expected, re-record this step to accept it.')).toBeNull();   // with the actions instead (DES2-08)
    expect(fake.explain).toHaveBeenCalledWith(SAVE, FAILED, VP);
  });

  it('keeps the answer on the run, and asks only once', async () => {
    fake.explain.mockResolvedValue(RENAMED);
    const save = vi.spyOn(backend.runNotes, 'saveExplanation');
    why();
    fireEvent.click(screen.getByRole('button', { name: 'Why did this fail?' }));
    await screen.findByText(RENAMED.summary);
    expect(save).toHaveBeenCalledWith(run.appId, run.id, 's3', RENAMED);
    expect((await backend.run(run.appId, run.id))!.steps[0].explanation).toEqual(RENAMED);
    cleanup();
    why();
    fireEvent.click(screen.getByRole('button', { name: 'Why did this fail?' }));
    await screen.findByText(RENAMED.summary);
    expect(fake.explain).toHaveBeenCalledTimes(1);
  });

  it('shows an explanation saved on the run at once', () => {
    why({ ...FAILED, explanation: RENAMED });
    expect(screen.getByText(RENAMED.summary)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Why did this fail?' })).toBeNull();
    expect(fake.explain).not.toHaveBeenCalled();
  });

  it('says so when the AI assistant can’t tell, and can try again', async () => {
    fake.explain.mockResolvedValue(null);
    why();
    fireEvent.click(screen.getByRole('button', { name: 'Why did this fail?' }));
    expect(await screen.findByText(/couldn't tell what changed/)).toBeInTheDocument();
    fake.explain.mockResolvedValue(RENAMED);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText(RENAMED.summary)).toBeInTheDocument();
  });

  it('puts engine problems in plain words', async () => {
    fake.explain.mockRejectedValue(new EngineError('not_ready', "Your licence doesn't include explaining failures."));
    why();
    fireEvent.click(screen.getByRole('button', { name: 'Why did this fail?' }));
    expect(await screen.findByText("Your licence doesn't include explaining failures.")).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    cleanup();
    fake.explain.mockRejectedValue(new EngineError('not_found', 'x'));
    why();
    fireEvent.click(screen.getByRole('button', { name: 'Why did this fail?' }));
    expect(await screen.findByText(/isn't on this Mac/)).toBeInTheDocument();
  });

  it('isn’t there without the feature, for reasons it can’t add to, or without a screenshot', () => {
    setFeatures({ ...NO_FEATURES });
    why();
    expect(screen.queryByRole('button', { name: 'Why did this fail?' })).toBeNull();
    cleanup();
    setFeatures({ ...NO_FEATURES, explain: true });
    why({ ...FAILED, reason: 'secretMissing' });
    expect(screen.queryByRole('button', { name: 'Why did this fail?' })).toBeNull();
    cleanup();
    why({ ...FAILED, screenshotPath: undefined });
    expect(screen.queryByRole('button', { name: 'Why did this fail?' })).toBeNull();
    cleanup();
    why({ stepId: 's3', result: 'passed' });
    expect(screen.queryByRole('button', { name: 'Why did this fail?' })).toBeNull();
  });

  it('puts its suggestion in What to try, with the actions, not twice (DES2-08)', async () => {
    fake.explain.mockResolvedValue(RENAMED);
    render(<MemoryRouter><ReportDetail run={run} test={undefined} steps={[SAVE]} step={SAVE} stepRun={FAILED} number="3" appName="Web" /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: 'Why did this fail?' }));
    await screen.findByText(RENAMED.summary);
    const tip = screen.getByText('If this change is expected, re-record this step to accept it.');
    expect(tip.closest('.rp-try')).not.toBeNull();
    expect(screen.getAllByText(/re-record this step to accept it/)).toHaveLength(1);
  });

  it('sits under the reason in the report', () => {
    render(<MemoryRouter><ReportDetail run={run} test={undefined} steps={[SAVE]} step={SAVE} stepRun={FAILED} number="3" appName="Web" /></MemoryRouter>);
    const heading = screen.getByText("Couldn't find the Save button");
    const ask = screen.getByRole('button', { name: 'Why did this fail?' });
    expect(heading.compareDocumentPosition(ask) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(ask.compareDocumentPosition(screen.getByText('What to try')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('goes into Copy details, marked as the AI assistant’s', () => {
    const text = copyDetails(run, SAVE, '3', { ...FAILED, explanation: RENAMED }, 'Web');
    expect(text).toContain('AI assistant: The Save button now reads “Save changes”.\nLikely cause: Its text changed.');
    expect(copyDetails(run, SAVE, '3', FAILED, 'Web')).not.toContain('AI assistant');
    expect(explanationText({ summary: 'Odd.', cause: 'aliens' as Explanation['cause'], suggestion: 'rerecord' })).toBe('AI assistant: Odd.\nSuggested: Re-record this step.');
  });
});

describe('the explanations kept in this session (A16)', () => {
  const engine = (e: Explanation) => ({ explain: vi.fn(async () => e) }) as unknown as Parameters<typeof explainStep>[0]['engine'];
  it('are kept per workspace: the same run id in another one asks again', async () => {
    const other = new DemoBackend({ empty: true, signedIn: true, delayMs: 0 });
    const a = engine(RENAMED), b = engine({ ...RENAMED, summary: 'Another workspace.' });
    expect(await explainStep({ engine: a, backend, run, step: SAVE, stepRun: FAILED, viewport: VP })).toEqual(RENAMED);
    expect((await explainStep({ engine: b, backend: other, run, step: SAVE, stepRun: FAILED, viewport: VP }))!.summary).toBe('Another workspace.');
    expect(await explainStep({ engine: b, backend, run, step: SAVE, stepRun: FAILED, viewport: VP })).toEqual(RENAMED);   // from the first one's
  });
  it(`keep at most ${MAX_KEPT}, the oldest going first`, async () => {
    const e = engine(RENAMED);
    const ask = (i: number) => explainStep({ engine: e, backend: null, run: { ...run, id: `r${i}` }, step: SAVE, stepRun: FAILED, viewport: VP });
    for (let i = 0; i <= MAX_KEPT; i++) await ask(i);
    const asked = (e.explain as ReturnType<typeof vi.fn>).mock.calls.length;
    await ask(MAX_KEPT);                                   // still kept
    expect((e.explain as ReturnType<typeof vi.fn>).mock.calls.length).toBe(asked);
    await ask(0);                                          // the oldest went
    expect((e.explain as ReturnType<typeof vi.fn>).mock.calls.length).toBe(asked + 1);
  });
});
