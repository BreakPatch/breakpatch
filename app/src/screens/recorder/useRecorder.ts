// Editor state for the Recorder and the Shared steps editor (README "State (UI level)" →
// Recorder: steps, selected step, dirty, composer text, current action, AI state,
// candidate box, open loop, re-record step). All engine work goes through getEngine().
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ActionKind, Box, Direction, Generated, Point, SampleFile, Step, Viewport } from '../../data/types';
import { demoEngine, getEngine, EngineError, type CheckingPhase, type FileChoice, type FileChooserEvent, type Plan, type PlanStep, type RecordParams, type SecretScope } from '../../engine';
import { around, gesture, inside, sampleApp } from '../../components/live';
import { actionInfo, touchWords, TOUCH_HIDDEN } from '../../engine/labels';
import { isTouch } from '../../data/devices';
import { appendStep, defaultLabel, findStep, flatRows, insertAfter, numberOf, removeStep, replaceStep, stepsBefore, updateStep } from '../../components/steps';
import { POINT_KINDS, STICKY } from './actions';
import { secrets } from '../../platform';
import { useSession } from '../../state/session';
import { originOf } from '../../lib/sites';
import { ensureSecretSites } from '../../lib/secretSites';
import { secretsForRequest } from '../../lib/secretScope';
import { checkpointLabel, intentAskText, notFoundText, planNotFoundText, thinkingText } from './describe';
import { chosenIntent, fromEngine, readIntent, type Intent } from './intent';
import { answered, CAREFUL_NOTE, planIntent, planNeeds, planRun, planSentence, type PlanItem, type PlanRun } from './plan';

/** `plan`: the index of the story's step (plan.ts) this is about, when it is one. */
export type AiState =
  | { state: 'idle' }
  | { state: 'thinking'; text: string; what: string; plan?: number }
  /** Found what a described step names. `intent`: what Confirm does with it (and how many times). */
  | { state: 'result'; text: string; what: string; box: Box; at: Point; target: string; frame?: number; intent: Intent; plan?: number }
  /** `message`: why it couldn't be looked for (the AI assistant isn't downloaded), instead of "Couldn't find". */
  | { state: 'notfound'; text: string; what: string; plan?: number; message?: string }
  /**
   * A click, drag or scroll on the live view, or a described step with nothing to look for
   * ("scroll down", "type hello", "go to example.com"): nothing reached the page. The bar asks
   * "Click Next button?" and the step is done and recorded only on Confirm (Enter, or the same spot
   * again). `box`: where on the page; none for typing into the focused field or going to an address.
   */
  /** `said`: the sentence it came from, for a described step with no spot on the page (typing, an address, a scroll). */
  | { state: 'proposal'; params: RecordParams; frame?: number; box?: Box; label: string; target?: string; named: boolean; repeat?: number; said?: string; note?: string; plan?: number };

export interface ActionOptions {
  writeSource: 'typed' | 'secret' | 'generated';
  secretRef: string;
  generated: Generated;
  seconds: number;          // Wait for a set time
  maxWait: number;          // Wait until: maximum wait, seconds
  sample: SampleFile;       // Upload file
  fileType: string;         // Check a download ('' = any)
  direction: Direction;     // Swipe / scroll
  distance: number;
}

const DEFAULT_OPTIONS: ActionOptions = { writeSource: 'typed', secretRef: '', generated: 'uniqueName', seconds: 2, maxWait: 10, sample: 'pdf', fileType: '', direction: 'down', distance: 300 };

let seq = 0;
/** The engine names these after what was clicked ("Click Done"); other labels come from defaultLabel. */
const CLICKS = new Set<ActionKind>(['click', 'doubleClick', 'longClick', 'rightClick', 'hover']);
export const localId = (p = 's') => `${p}${Date.now().toString(36)}${(seq++).toString(36)}`;

interface Extra { label?: string; target?: string; checkpoint?: Box; frame?: number }

/** What a write step types: a saved secret, a generated value or the text. */
const writeValue = (it: Pick<Intent, 'text' | 'secretRef' | 'generated'>): Pick<RecordParams, 'text' | 'secretRef' | 'generated'> =>
  it.secretRef ? { secretRef: it.secretRef } : it.generated ? { generated: it.generated } : { text: it.text ?? '' };
/** Plan steps a click on the page can stand in for: the person shows where it is. */
const POINTED = new Set<PlanStep['action']>(['click', 'doubleClick', 'rightClick', 'hover', 'write']);

/** What the step being recorded is doing now, for its row and the live view ("Clicking…"). */
export function phaseText(phase: CheckingPhase, action: ActionKind): string {
  switch (phase) {
    case 'watching': return 'Looking at the page…';
    case 'acting': return ACTING[action] ?? 'Doing the step…';
    case 'naming': return 'Naming the step…';
    case 'choosing': return 'Choose the file to upload…';
    default: return 'Waiting for the page…';
  }
}
const ACTING: Partial<Record<ActionKind, string>> = {
  click: 'Clicking…', doubleClick: 'Clicking…', longClick: 'Clicking…', rightClick: 'Clicking…', hover: 'Moving the pointer…',
  write: 'Typing…', navigate: 'Opening the page…', waitFor: 'Waiting…', swipe: 'Swiping…', scroll: 'Scrolling…', drag: 'Dragging…',
  upload: 'Uploading…', switchTab: 'Switching tabs…', downloadCheck: 'Checking the download…',
};

/**
 * What a "Write saved secret" step's call carries: the value from the Keychain just for this call
 * (the engine types it and never stores it), or the workspace's sealed one, which only the shell
 * opens (lib/secretScope.ts). A secret saved before sites existed is offered the app's site once.
 */
export async function secretFor(ref: string | undefined, appUrl: string | undefined): Promise<SecretScope & { secrets: Record<string, string> } | undefined> {
  if (!ref) return undefined;
  await ensureSecretSites([ref], appUrl);
  return secretsForRequest([ref]);
}

export function useRecorder({ viewport, onError, appUrl, filesDir, appId }: {
  viewport: Pick<Viewport, 'width' | 'height' | 'device'>; onError: (message: string) => void;
  /** The app's base address: where a saved secret is allowed when it has no sites yet. */
  appUrl?: string;
  /** <tests folder>/files, for uploads of the user's own files. */
  filesDir?: string;
  /** For "Don't ask again for this app" (saving a typed password as a saved secret). */
  appId?: string;
}) {
  const engine = getEngine();
  const sample = engine.liveMode === 'sample';
  // A phone or tablet test: the bar asks "Tap Next button?", not "Click" (engine labels.touch_words).
  const touch = isTouch(viewport);
  const words = touch ? touchWords : (l: string) => l;
  const [steps, setStepsState] = useState<Step[]>([]);
  const stepsRef = useRef<Step[]>([]);
  const [dirty, setDirty] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [openLoopId, setOpenLoopId] = useState<string | null>(null);
  const [rerecordId, setRerecordId] = useState<string | null>(null);
  const [action, setAction] = useState<ActionKind>('click');
  const [text, setText] = useState('');
  const [options, setOptionsState] = useState<ActionOptions>(DEFAULT_OPTIONS);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [phase, setPhase] = useState<CheckingPhase>('watching');
  const [busyAction, setBusyAction] = useState<ActionKind>('click');
  const [addedId, setAddedId] = useState<string | null>(null);
  // Where new steps go: after this step (Play to here, "Add a step after this one"), else at the end.
  const [insertAfterId, setInsertAfterState] = useState<string | null>(null);
  const insertRef = useRef<string | null>(null);
  const setInsertAfter = useCallback((id: string | null) => { insertRef.current = id; setInsertAfterState(id); }, []);
  // Steps after an insertion that haven't been played since: "Not played since the change".
  const [unplayed, setUnplayed] = useState<Set<string>>(new Set());
  // The step the page is at now (the last one recorded or played), for "Add a step after this one".
  const [atStepId, setAtStepId] = useState<string | null>(null);
  const [savedPill, setSavedPill] = useState<string | null>(null);
  const [ai, setAi] = useState<AiState>({ state: 'idle' });
  const aiToken = useRef(0);
  const busyRef = useRef(false);
  /** A step was recorded or re-recorded with the engine since the last load: the save says where. */
  const recordedRef = useRef(false);
  const onErrorRef = useRef(onError); onErrorRef.current = onError;

  const setSteps = useCallback((fn: (s: Step[]) => Step[]) => {
    const next = fn(stepsRef.current);
    stepsRef.current = next;
    setStepsState(next);
    return next;
  }, []);

  // "Checking the screen…" follows the engine's record.checking events while a step records.
  // A click opened the page's file picker: the app asks which file (FileChooserDialog).
  const [fileAsk, setFileAsk] = useState<FileChooserEvent | null>(null);
  // "Use the page": the user works the page directly; nothing is recorded or proposed. Afterwards
  // the page is "set up by hand": where it is among the steps is unknown.
  const [hand, setHandState] = useState(false);
  const [manual, setManual] = useState(false);
  const manualRef = useRef(false);
  useEffect(() => { manualRef.current = manual; }, [manual]);
  const [handAsk, setHandAsk] = useState<FileChooserEvent | null>(null);
  useEffect(() => engine.on('browser.fileChooser', d => setHandAsk(d)), [engine]);
  const setHand = useCallback(async (on: boolean) => {
    if (on) { aiToken.current++; setAi({ state: 'idle' }); }
    try { await engine.hand(on); } catch (e) { onErrorRef.current(e instanceof Error ? e.message : "Couldn't do that."); return; }
    setHandState(on);
    if (!on) { setManual(true); setAtStepId(null); setHandAsk(null); }
  }, [engine]);
  // Steps played on a page set up by hand: "Played on a page set up by hand" until the next full Run.
  const [handPlayed, setHandPlayed] = useState<Set<string>>(new Set());
  // A typed password (a Write into a masked field): offer once to save it as a saved secret.
  const [secretAsk, setSecretAsk] = useState<string | null>(null);
  useEffect(() => engine.on('record.fileChooser', d => { if (busyRef.current || d.stepId) setFileAsk(d); }), [engine]);
  // A picker that opened a moment after a click the engine had already answered (DESK-07): the
  // step becomes an upload of the chosen file.
  useEffect(() => engine.on('record.stepChanged', ({ step }) => {
    if (!findStep(stepsRef.current, step.id)) return;
    setSteps(s => updateStep(s, step.id, old => ({ ...old, ...step, target: old.target ?? step.target })));
    setDirty(true);
  }), [engine, setSteps]);
  const chooseFile = (c: FileChoice) => { setFileAsk(null); void engine.chooseFile(c).catch(e => onErrorRef.current(e instanceof Error ? e.message : "Couldn't use that file.")); };
  useEffect(() => engine.on('record.checking', d => { if (busyRef.current) { setChecking(true); setPhase(d.phase); } }), [engine]);
  useEffect(() => { if (!savedPill) return; const t = setTimeout(() => setSavedPill(null), 1500); return () => clearTimeout(t); }, [savedPill]);

  const setOptions = (patch: Partial<ActionOptions>) => setOptionsState(o => ({ ...o, ...patch }));

  /** Replaces everything (after loading, or after saving with the saved steps). */
  const load = useCallback((next: Step[]) => {
    setSteps(() => next); setDirty(false); setRerecordId(null); setOpenLoopId(null);
    setInsertAfter(insertRef.current && findStep(next, insertRef.current) ? insertRef.current : null);
    recordedRef.current = false;
  }, [setSteps, setInsertAfter]);

  /** Puts a new step at the insertion point (moving it on), else at the end or in the open loop. */
  const place = (s: Step[], step: Step) => {
    const after = insertRef.current;
    if (after && findStep(s, after)) {
      const next = insertAfter(s, after, step);
      // Everything after it was recorded on a page without this step: flag it until the next Run.
      const rows = flatRows(next).map(r => r.step.id);
      const later = rows.slice(rows.indexOf(step.id) + 1);
      if (later.length) setUnplayed(u => new Set([...u, ...later]));
      return next;
    }
    return appendStep(s, step, openLoopId);
  };
  /** After a Run (all played) or Play to here: where the page is now, and where new steps go. */
  const played = useCallback((opts: { full: boolean; at: string | null; insertAfter: string | null; passed?: string[]; fresh?: boolean; step?: string }) => {
    if (opts.full) { setUnplayed(new Set()); setHandPlayed(new Set()); }
    // Run and Play to here start in a brand-new browser: the page is no longer set up by hand.
    if (opts.fresh) setManual(false);
    else if (opts.step && manualRef.current) setHandPlayed(h => new Set([...h, opts.step!]));
    // A step that just passed has been played since the change, whichever way it was played.
    else if (opts.passed?.length) setUnplayed(u => new Set([...u].filter(id => !opts.passed!.includes(id))));
    setAtStepId(opts.at); setInsertAfter(opts.insertAfter); setAddedId(null); setSelectedId(null);
  }, [setInsertAfter]);

  /** Any edit from the steps panel. */
  const change = useCallback((next: Step[]) => {
    setSteps(() => next); setDirty(true);
    setOpenLoopId(id => (id && findStep(next, id) ? id : null));
    setRerecordId(id => (id && findStep(next, id) ? id : null));
  }, [setSteps]);

  const afterAdd = (kind: ActionKind) => { if (!STICKY.has(kind)) setAction('click'); };

  /**
   * Records one step with the engine: the row appears at once, the disc pulses while the screen is
   * checked. `rr`: the step this re-records (by default the one being re-recorded now); null adds one.
   */
  async function record(params: RecordParams, extra: Extra = {}, rr: string | null = rerecordId): Promise<boolean> {
    if (busyRef.current) return false;
    busyRef.current = true;
    const tempId = localId('pending-');
    const prevInsert = insertRef.current;
    const guess = extra.label ?? guessLabel(params, sample);
    if (rr) setBusyId(rr);
    else {
      setSteps(s => place(s, { ...params, id: tempId, label: guess, target: extra.target } as Step));
      if (prevInsert) setInsertAfter(tempId);
      setBusyId(tempId);
    }
    setSelectedId(rr ?? tempId);
    setChecking(true); setSavedPill(null); setPhase('watching'); setBusyAction(params.action); setAddedId(null);
    try {
      // The secret's value goes to the engine with this call only, never into the step.
      const forStep = extra.checkpoint ? undefined : await secretFor(params.secretRef, appUrl);
      const sent: RecordParams = { ...params, ...(filesDir ? { filesDir } : {}), ...(forStep ?? {}), ...(extra.frame !== undefined ? { frame: extra.frame } : {}),
        // Found with the AI assistant: the user's words are what to look for (the engine still names it).
        ...(extra.target && !extra.checkpoint ? { target: extra.target } : {}),
        ...(extra.label && !extra.checkpoint && params.action !== 'checkpoint' ? { label: extra.label } : {}) };
      const got = extra.checkpoint ? await engine.recordCheckpoint(extra.checkpoint, extra.frame) : await engine.recordPoint(sent);
      const step: Step = { ...got, label: extra.label ?? (CLICKS.has(params.action) ? got.label : defaultLabel({ ...params, ...got, action: got.action })), target: extra.target ?? got.target ?? (params.action === 'write' ? 'The focused field' : undefined) };
      if (sample) sampleApp.perform(step, viewport);
      const next = setSteps(s => (rr ? replaceStep(s, rr, step) : updateStep(s, tempId, () => step)));
      const id = rr ?? step.id;
      if (!rr && insertRef.current === tempId) setInsertAfter(step.id);
      recordedRef.current = true;
      setSelectedId(id); setDirty(true); setRerecordId(null); setAddedId(id); setAtStepId(id);
      setSavedPill(`Step ${numberOf(next, id)} saved`);
      afterAdd(params.action);
      const noAsk = useSession.getState().prefs.noSecretAsk ?? [];
      if (step.action === 'write' && step.masked && step.text && !step.secretRef && !step.generated && !(appId && noAsk.includes(appId))) setSecretAsk(id);
      return true;
    } catch (e) {
      if (!rr && insertRef.current === tempId) setInsertAfter(prevInsert);
      if (!rr) setSteps(s => removeStep(s, tempId));
      setSelectedId(rr);
      onErrorRef.current(e instanceof EngineError || e instanceof Error ? e.message : "Couldn't record that step.");
      return false;
    } finally {
      busyRef.current = false; setBusyId(null); setChecking(false); setFileAsk(a => (a?.stepId ? a : null));
    }
  }

  /**
   * The same step `n` times, one after another, each recorded and checked on its own ("add 2
   * people": two clicks on the +). Only the first is held to the frame it was found on: the page
   * moves on after each. Stops at the first that fails. While re-recording, only the first
   * re-records the step; the others are new steps right after it.
   */
  async function recordTimes(params: RecordParams, extra: Extra, n: number, rr: string | null = rerecordId): Promise<boolean> {
    const { frame: _f, ...later } = extra;
    if (!await record(params, extra, rr)) return false;
    if (n < 2) return true;
    // Re-recording: the rest go after the re-recorded step (each moves the point on), then the
    // point goes back to where it was.
    const before = insertRef.current;
    if (rr) insertRef.current = rr;
    try {
      for (let i = 1; i < n; i++) if (!await record(params, later, null)) return false;
      return true;
    } finally {
      if (rr) setInsertAfter(before && findStep(stepsRef.current, before) ? before : null);
    }
  }

  /** Steps that need no engine call (Repeat, Insert shared steps). */
  function addLocal(step: Step) {
    if (rerecordId) { setRerecordId(null); }
    const next = setSteps(s => place(s, step));
    if (insertRef.current) setInsertAfter(step.id);
    setSelectedId(step.id); setDirty(true);
    if (step.action === 'loop') setOpenLoopId(step.id);
    setSavedPill(`Step ${numberOf(next, step.id)} saved`);
    afterAdd(step.action);
  }

  function addLoop(count = 5) {
    addLocal({ id: localId('loop'), action: 'loop', label: `Repeat ${count} times`, target: `Steps below run ${count} times`, count, steps: [] });
  }

  // ---------- Describe ----------
  /**
   * The describe box: the sentence says what to do (intent.ts), what to do it to and how many
   * times; the chosen action only counts when it names none. Then what it names is looked for
   * (record.locate) and shown for Confirm. A step with nothing to look for (a scroll of the page,
   * typing into the field that has the focus, going to an address) is shown for Confirm too.
   * Nothing reaches the page before Confirm, except a wait for a set time.
   */
  async function describe(t: string) {
    const token = ++aiToken.current;
    const read = readIntent(t);
    let it: Intent;
    setRetryNote(false);
    // A sentence this can't do: said next to the box (until it's edited), not in a toast that goes.
    if (read.kind === 'unhandled') { setAi({ state: 'idle' }); setText(t); setUnhandled(read.message); return; }
    setUnhandled(null);
    if (read.kind === 'intent') it = read.intent;
    else {
      setAi({ state: 'thinking', text: t, what: read.target });
      // Only for words this can't place, and only with the AI assistant; else as before.
      let got: Intent | null = null;
      if (read.kind === 'unsure') { try { got = fromEngine(await engine.intent(t)); } catch { got = null; } }
      if (token !== aiToken.current) return;
      it = got ?? chosenIntent(read.target, action, options);
    }
    await seek(it, t, token);
  }
  /**
   * Looks for what a described step (or a story's step, `plan`) acts on, and shows it for Confirm.
   * A checkpoint or Wait until may look for plain text on the screen (record.locate `shows`).
   */
  async function seek(it: Intent, said: string, token: number, plan?: number) {
    if (!it.target) { act(it, token, said, plan); return; }
    const what = it.target;
    setAi({ state: 'thinking', text: said, what, plan });
    const opts = { ...(it.near ? { near: it.near } : {}), ...(it.action === 'checkpoint' || it.action === 'waitUntil' ? { shows: true } : {}) };
    let res = null, message: string | undefined;
    try { res = await engine.locate(what, Object.keys(opts).length ? opts : undefined); }
    catch (e) { res = null; if (e instanceof EngineError && e.code === 'not_ready') message = e.message; }
    if (token !== aiToken.current) return;
    if (res) setAi({ state: 'result', text: said, what, box: res.box, at: res.at, target: res.target, frame: res.frame, intent: it, plan });
    else { setAi({ state: 'notfound', text: said, what, plan, ...(message ? { message } : {}) }); if (plan === undefined) setText(said); }
  }
  /**
   * A described step with nothing to look for. A scroll of the page, typing into the field that has
   * the focus and going to an address are shown for Confirm ("Write "the password" into the field
   * that has the focus?"), so a misread sentence never reaches the page. A wait is done at once.
   */
  function act(it: Intent, token: number, said: string, plan?: number) {
    if (token !== aiToken.current) return;
    setAi({ state: 'idle' });
    const times = it.repeat > 1 ? `, ${it.repeat} times` : '';
    const ask = (params: RecordParams, label: string, box?: Box) => {
      aiToken.current++;
      setAi({ state: 'proposal', params, box, label: label + times, named: true, repeat: it.repeat, said, plan });
    };
    switch (it.action) {
      case 'scroll': case 'swipe': {
        const params: RecordParams = { action: it.action, from: [Math.round(viewport.width / 2), Math.round(viewport.height / 2)], direction: it.direction ?? 'down', distance: it.distance ?? options.distance };
        ask(params, `${defaultLabel(params)} ${params.distance} px`, around(params.from!, 24));
        return;
      }
      case 'waitFor': {
        // A story's step is always a new step, never the one being re-recorded.
        const done = record({ action: 'waitFor', durationMs: Math.max(1, it.seconds ?? options.seconds) * 1000 }, {}, plan !== undefined ? null : rerecordId);
        if (plan !== undefined) void done.then(ok => { if (ok) planAnswered(plan, 'done'); });
        return;
      }
      case 'write': if (it.text || it.secretRef || it.generated) {
        const params: RecordParams = { action: 'write', ...writeValue(it) };
        ask(params, `${defaultLabel(params)} into the field that has the focus`);
        // Where it will type: the focused field outlined and named, or a word that there's none.
        const asked = aiToken.current;
        void engine.focused().then(f => {
          if (asked !== aiToken.current) return;
          setAi(a => a.state !== 'proposal' ? a : f.box
            ? { ...a, box: f.box, label: `${defaultLabel(params)} into ${f.name ?? 'the field that has the focus'}${times}` }
            : { ...a, label: `${defaultLabel(params)}${times}`, note: 'No field is selected: click the field first.' });
        }).catch(() => undefined);
      } return;
      case 'navigate': if (it.url) { const params: RecordParams = { action: 'navigate', nav: 'url', url: it.url }; ask(params, defaultLabel(params)); } return;
      default: return;
    }
  }
  const cancelAi = () => { aiToken.current++; setAi({ state: 'idle' }); };

  // ---------- Proposals: the page only gets what the user confirmed ----------
  function propose(params: RecordParams, frame: number | undefined, box: Box, label: string, at?: Point, plan?: number) {
    const token = ++aiToken.current;
    setAi({ state: 'proposal', params, frame, box, label: words(label), named: !at || sample, plan });
    if (!at) return;
    // The element's box and name come a moment later; the bar asks at once with "here".
    void engine.propose(at).then(got => {
      if (token !== aiToken.current) return;
      setAi(a => a.state !== 'proposal' ? a : {
        ...a, box: got.box ?? a.box, named: true,
        // A story's typing step keeps its own words ('Type "Ada" into …'); a click is named after what it clicks.
        ...(got.name && a.params.action !== 'write' ? { label: words(`${actionInfo(a.params.action).verb} ${got.name}`), target: got.target } : {}),
      });
    }).catch(() => { if (token === aiToken.current) setAi(a => (a.state === 'proposal' ? { ...a, named: true } : a)); });
  }
  function confirmProposal() {
    if (ai.state !== 'proposal') return;
    const a = ai; aiToken.current++; setAi({ state: 'idle' });
    // Named by the AI assistant already: the engine needn't ask it again.
    const extra = { frame: a.frame, ...(a.target ? { label: a.label, target: a.target } : {}) };
    afterPlanStep(a.plan, recordTimes(a.params, extra, a.repeat ?? 1, a.plan !== undefined ? null : rerecordId));
  }
  const retryAi = () => {
    // A story's step: look for it again (Edit changes what to look for).
    if (ai.state !== 'idle' && ai.plan !== undefined) { const run = planRef.current; if (run) askPlan(run); return; }
    // Described, with no spot on the page: the sentence goes back in the box to change, not "click the page".
    if (ai.state === 'proposal' && ai.said !== undefined) { const t = ai.said; cancelAi(); setText(t); setRefocus(n => n + 1); return; }
    if (ai.state === 'proposal') { cancelAi(); setRetryNote(true); return; }     // pick again on the page
    if (ai.state === 'result' || ai.state === 'notfound') void describe(ai.text);
  };
  const [retryNote, setRetryNote] = useState(false);
  /** Bumped when the describe box should take the focus again (Try again on a described step). */
  const [refocus, setRefocus] = useState(0);
  /** What the describe box said it can't do, shown by the box until the sentence changes. */
  const [unhandled, setUnhandled] = useState<string | null>(null);
  // "Click the page again" is for the proposal it was about: gone once anything else is asked.
  useEffect(() => { if (ai.state !== 'idle') setRetryNote(false); }, [ai.state]);
  function confirmAi() {
    if (ai.state === 'proposal') { confirmProposal(); return; }
    if (ai.state !== 'result') return;
    const a = ai; setAi({ state: 'idle' });
    const x = { target: a.target, frame: a.frame };
    // What the sentence asked for; the chosen action only when it named none (intent.ts).
    const it = a.intent;
    const kind = it.action;
    // A story's step is always a new step, never the one being re-recorded.
    const rr = a.plan !== undefined ? null : rerecordId;
    let done: Promise<boolean>;
    if (kind === 'checkpoint') done = record({ action: 'checkpoint' }, { ...x, checkpoint: a.box, label: checkpointLabel(it.from === 'words' || it.from === 'plan' ? it.target ?? a.text : a.text) }, rr);
    else if (kind === 'waitUntil') done = record({ action: 'waitUntil', region: a.box, timeoutMs: options.maxWait * 1000 }, x, rr);
    else if (kind === 'swipe' || kind === 'scroll') done = recordTimes({ action: kind, from: a.at, direction: it.direction ?? options.direction, distance: it.distance ?? options.distance }, x, it.repeat, rr);
    else if (kind === 'write') done = recordTimes({ action: 'write', at: a.at, ...writeValue(it) }, x, it.repeat, rr);
    else {
      const k = POINT_KINDS.has(kind) ? kind : 'click';
      done = recordTimes({ action: k, at: a.at, ...(k === 'upload' ? { sample: options.sample } : {}) }, x, it.repeat, rr);
    }
    afterPlanStep(a.plan, done);
  }

  // ---------- A test from a story (plan.ts): its steps, one at a time, through the flow above ----------
  const [plan, setPlanState] = useState<PlanRun | null>(null);
  const planRef = useRef<PlanRun | null>(null);
  const setPlan = (run: PlanRun | null) => { planRef.current = run; setPlanState(run); };
  /** The current step needs words from the person (what to type), or they asked to change it. */
  const [planEditing, setPlanEditing] = useState(false);
  /** Asks about the run's current step: finds it on the page, or opens Edit when it needs a value. */
  function askPlan(run: PlanRun) {
    const token = ++aiToken.current;
    setRetryNote(false); setUnhandled(null);
    const s = run.steps[run.index];
    if (!s) { setAi({ state: 'idle' }); setPlanEditing(false); return; }
    if (planNeeds(s)) { setAi({ state: 'idle' }); setPlanEditing(true); return; }
    setPlanEditing(false);
    void seek(planIntent(s), planSentence(s, { touch }), token, run.index);
  }
  function planAnswered(i: number, state: 'done' | 'skipped') {
    const run = planRef.current;
    if (!run || run.steps[i]?.state !== 'todo') return;
    const next = answered(run, i, state);
    setPlan(next); askPlan(next);
  }
  /** After a story's step was confirmed: the next one once it's recorded; on a failure it's asked about again from the plan. */
  function afterPlanStep(i: number | undefined, done: Promise<boolean>) {
    if (i === undefined) return;
    void done.then(ok => { if (ok) planAnswered(i, 'done'); });
  }
  function startPlan(p: Plan) {
    setRerecordId(null);
    // A phone or tablet has no pointer to hover or right click with (the engine leaves them out too).
    const steps = touch ? p.steps.filter(s => !TOUCH_HIDDEN.has(s.action)) : p.steps;
    const run = planRun(steps, p.note, (p.dropped ?? 0) + p.steps.length - steps.length, p.overLimit);
    setPlan(run); askPlan(run);
  }
  /** The current step changed by the person (Edit): what to look for, what to type. Asked about again. */
  function editPlanStep(patch: Partial<PlanStep>) {
    const run = planRef.current;
    if (!run || !run.steps[run.index]) return;
    const steps = run.steps.map((s, k): PlanItem => {
      if (k !== run.index) return s;
      const { needs: _n, text: _t, secretRef: _s, generated: _g, ...rest } = s;
      const value = 'text' in patch || 'secretRef' in patch || 'generated' in patch ? {} : { text: s.text, secretRef: s.secretRef, generated: s.generated };
      const next = { ...rest, ...value, ...patch };
      return Object.fromEntries(Object.entries(next).filter(([, v]) => v !== undefined && v !== '')) as unknown as PlanItem;
    });
    const next = { ...run, steps };
    setPlan(next); askPlan(next);
  }
  function stopPlan() { aiToken.current++; setAi({ state: 'idle' }); setPlan(null); setPlanEditing(false); }
  /** The plan step a click on the page stands in for: the person shows where the current step is. */
  function pointedPlanStep(): number | undefined {
    const run = planRef.current;
    const s = run?.steps[run.index];
    return run && s && s.state === 'todo' && !planEditing && POINTED.has(s.action) && !planNeeds(s) ? run.index : undefined;
  }

  // ---------- Page ----------
  const pageBusy = () => busyRef.current || ai.state === 'thinking' || hand;
  // Nothing a user does on the live view reaches the page: a click, drag or scroll proposes the step,
  // and only Confirm does it. `frame`: the live view frame the user pressed on; the engine refuses
  // the step if the page has changed since.
  function pagePoint(p: Point, frame?: number) {
    if (pageBusy()) return;
    setRetryNote(false);
    // The same spot again confirms.
    if (ai.state === 'proposal' && ai.params.at && ai.box && inside(p, ai.box)) { confirmProposal(); return; }
    if (ai.state !== 'idle') cancelAi();
    // During a story: a click shows where its current step is (a click, hover or typing step).
    const pi = pointedPlanStep();
    if (pi !== undefined) {
      const s = planRef.current!.steps[pi];
      const params: RecordParams = { action: s.action as ActionKind, at: p, ...(s.action === 'write' ? writeValue(planIntent(s)) : {}) };
      propose(params, frame, around(p, 24), s.action === 'write' ? planSentence({ ...s, target: undefined }).replace(' into the field that has the focus', ' here') : guessLabel(params, sample), p, pi);
      return;
    }
    const kind: ActionKind = POINT_KINDS.has(action) && action !== 'swipe' && action !== 'scroll' ? action : 'click';
    const params: RecordParams = { action: kind, at: p, ...(kind === 'upload' ? { sample: options.sample } : {}) };
    propose(params, frame, around(p, 24), guessLabel(params, sample), p);
  }
  function pageDrag(from: Point, to: Point, frame?: number) {
    if (pageBusy()) return;
    setRetryNote(false);
    if (ai.state !== 'idle') cancelAi();
    const box = [Math.min(from[0], to[0]), Math.min(from[1], to[1]), Math.max(from[0], to[0]), Math.max(from[1], to[1])] as Box;
    if (action === 'drag') { const params: RecordParams = { action: 'drag', from, to }; propose(params, frame, box, 'Drag and drop from here to there'); }
    else {
      const g = gesture(from, to);
      setOptions({ direction: g.direction, distance: g.distance });
      const params: RecordParams = { action: action === 'scroll' ? 'scroll' : 'swipe', from, direction: g.direction, distance: g.distance };
      propose(params, frame, box, `${defaultLabel(params)} ${g.distance} px`);
    }
  }
  /** Scrolling on the live view proposes a scroll step (it adds up while the bar is open). */
  function pageScroll(at: Point, dx: number, dy: number, frame?: number) {
    if (pageBusy() || (!dx && !dy)) return;
    const prev = ai.state === 'proposal' && ai.params.action === 'scroll' && ai.params.nav === undefined ? ai : null;
    const vert = Math.abs(dy) >= Math.abs(dx);
    const signed = (vert ? dy : dx) + (prev ? (prev.params.direction === 'up' || prev.params.direction === 'left' ? -1 : 1) * (prev.params.distance ?? 0) : 0);
    const direction = vert ? (signed >= 0 ? 'down' : 'up') : (signed >= 0 ? 'right' : 'left');
    const params: RecordParams = { action: 'scroll', from: prev?.params.from ?? at, direction, distance: Math.round(Math.abs(signed)) };
    if (!params.distance) { cancelAi(); return; }
    aiToken.current++;
    setAi({ state: 'proposal', params, frame: prev?.frame ?? frame, box: around(params.from!, 24), label: `${defaultLabel(params)} ${params.distance} px`, named: true });
  }
  function pageBox(box: Box | null, at: Point, frame?: number) {
    if (pageBusy()) return;
    if (ai.state !== 'idle') cancelAi();
    const region = box ?? snapBox(at, viewport);
    const named = text.trim();
    // During a story whose current step is a check: the box drawn is where it looks.
    const run = planRef.current, s = run?.steps[run.index];
    if (run && s?.action === 'checkpoint' && s.state === 'todo' && !planEditing) {
      afterPlanStep(run.index, record({ action: 'checkpoint' }, { checkpoint: region, label: checkpointLabel(s.target ?? ''), frame }, null));
      return;
    }
    if (action === 'checkpoint') { setText(''); void record({ action: 'checkpoint' }, { checkpoint: region, label: named ? checkpointLabel(named) : undefined, frame }); }
    else void record({ action: 'waitUntil', region, timeoutMs: options.maxWait * 1000 }, { frame });
  }

  // ---------- Composer ----------
  function send() {
    if (busyRef.current || ai.state === 'thinking' || hand) return;
    const t = text.trim();
    switch (action) {
      case 'write': {
        if (options.writeSource === 'secret') { if (!options.secretRef) return; void record({ action: 'write', secretRef: options.secretRef }); }
        else if (options.writeSource === 'generated') void record({ action: 'write', generated: options.generated });
        // Typed exactly as written: leading and trailing spaces are part of what's typed.
        else { if (!text) return; void record({ action: 'write', text }); }
        setText(''); return;
      }
      case 'navigate': if (!t) return; setText(''); void record({ action: 'navigate', nav: 'url', url: /^[a-z]+:\/\//i.test(t) ? t : 'https://' + t }); return;
      case 'waitFor': void record({ action: 'waitFor', durationMs: Math.max(1, options.seconds) * 1000 }); return;
      case 'downloadCheck': void record({ action: 'downloadCheck', fileType: options.fileType || undefined }); return;
      case 'switchTab': void record({ action: 'switchTab' }); return;
      case 'loop': addLoop(); return;
      case 'drag': case 'group': return;
      default: if (!t) return; setText(''); void describe(t);
    }
  }

  function startRerecord(id: string) {
    const s = findStep(stepsRef.current, id);
    if (!s) return;
    cancelAi();
    // Re-recording ends a story's run through its steps: its clicks would be the story's.
    if (planRef.current) { setPlan(null); setPlanEditing(false); }
    setRerecordId(id); setSelectedId(id);
    if (s.action === 'write') { setAction('write'); setText(s.text ?? ''); if (s.secretRef) setOptions({ writeSource: 'secret', secretRef: s.secretRef }); }
    else if (s.action !== 'loop' && s.action !== 'group') setAction(s.action);
    if (sample) sampleApp.replay(stepsBefore(stepsRef.current, id), viewport);
  }

  const askBase = ai.state === 'result' ? intentAskText(ai.what, ai.intent) : ai.state === 'proposal' ? `${ai.label}?${ai.note ? ` ${ai.note}` : ''}` : null;
  // A story's step that looks like it deletes, pays or sends something says so as it asks.
  const careful = (ai.state === 'result' || ai.state === 'proposal') && ai.plan !== undefined && !!plan?.steps[ai.plan]?.careful;

  return {
    steps, dirty, selectedId, openLoopId, rerecordId, action, text, options, ai, busyId, checking, savedPill, sample, addedId,
    /** "Clicking…", "Waiting for the page…": what the step being recorded is doing now. */
    phaseText: busyId !== null ? phaseText(phase, busyAction) : null,
    stepsRef, recordedRef, setSelectedId, setOpenLoopId, setAction, setOptions, setDirty,
    /** The describe box's text; editing it clears what it said it can't do. */
    setText: (t: string) => { setText(t); setUnhandled(null); },
    unhandled, refocus,
    load, change, record, addLocal, addLoop, send, describe, confirmAi, retryAi, cancelAi, pageScroll, retryNote,
    /** A test from a story: the run through its steps, and what the person does with them. */
    plan, planEditing, startPlan, stopPlan, editPlanStep,
    /** A story's step in words, in touch words on a phone or tablet ("Tap the Next button"). */
    planText: (s: PlanStep) => planSentence(s, { touch }),
    skipPlanStep: () => { const run = planRef.current; if (run) planAnswered(run.index, 'skipped'); },
    retryPlanStep: () => { const run = planRef.current; if (run) askPlan(run); },
    openPlanEdit: () => { aiToken.current++; setAi({ state: 'idle' }); setPlanEditing(true); },
    closePlanEdit: () => setPlanEditing(false),
    insertAfterId, setInsertAfter, unplayed, atStepId, played,
    hand, setHand, manual, handPlayed, handAsk,
    handChooseFile: (c: FileChoice) => { setHandAsk(null); void engine.handChooseFile(c).catch(() => undefined); },
    /** A step was edited: when it now does something else to the page, the steps after it haven't been played since. */
    edited: (id: string, affectsPage: boolean) => {
      if (!affectsPage) return;
      const rows = flatRows(stepsRef.current).map(r => r.step.id);
      const later = rows.slice(rows.indexOf(id) + 1);
      if (later.length) setUnplayed(u => new Set([...u, ...later]));
    },
    /** A run starts clean: no step selected, no "Added". */
    runStarted: () => { setAddedId(null); setSelectedId(null); setSavedPill(null); }, fileAsk, chooseFile, filesDir,
    secretAsk: secretAsk && findStep(steps, secretAsk) ? findStep(steps, secretAsk)! : null,
    /** Keep as typed text; with `forApp`, never ask again for this app. */
    keepTyped: (forApp = false) => {
      setSecretAsk(null);
      if (forApp && appId) { const s = useSession.getState(); s.setPrefs({ noSecretAsk: [...new Set([...(s.prefs.noSecretAsk ?? []), appId])] }); }
    },
    /** Saves the step's typed value as a saved secret (allowed on the app's site) and makes the step use it. */
    saveAsSecret: async (name: string) => {
      const id = secretAsk; const s = id ? findStep(stepsRef.current, id) : undefined;
      if (!id || !s?.text) return;
      const origin = appUrl ? originOf(appUrl) : null;
      await secrets.set(name, s.text, origin ? { origins: [origin] } : {});
      setSteps(list => updateStep(list, id, st => ({ ...st, text: undefined, secretRef: name, label: `Write saved secret ${name}` })));
      setDirty(true); setSecretAsk(null);
    },
    pagePoint, pageDrag, pageBox, startRerecord, cancelRerecord: () => setRerecordId(null),
    thinking: ai.state === 'thinking' ? thinkingText(ai.what) : null,
    ask: askBase && (careful ? `${askBase} ${CAREFUL_NOTE}` : askBase),
    notFound: ai.state === 'notfound' ? ai.message ?? (ai.plan !== undefined ? planNotFoundText(ai.what) : notFoundText(ai.what)) : null,
    busy: busyId !== null,
  };
}

export type Recorder = ReturnType<typeof useRecorder>;

/** Label shown on the new row while the engine records (the engine's label replaces it). */
function guessLabel(p: RecordParams, sample: boolean): string {
  if (!CLICKS.has(p.action)) return defaultLabel(p);
  const t = sample && p.at ? demoEngine()?.targets.find(x => x.visible() && inside(p.at!, x.box)) : undefined;
  return t ? t.label.replace(/^Click/, defaultLabel({ action: p.action }).replace(/ here$/, '')) : defaultLabel(p);
}

/** A click with the box tool: the sample button under the point, or a box around it. */
function snapBox(at: Point, vp: Pick<Viewport, 'width' | 'height'>): Box {
  const t = demoEngine()?.targets.find(x => x.visible() && inside(at, x.box));
  if (t) return t.box;
  const b = around(at, 120, 40);
  return [Math.max(0, b[0]), Math.max(0, b[1]), Math.min(vp.width, b[2]), Math.min(vp.height, b[3])];
}
