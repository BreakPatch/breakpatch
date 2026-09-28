// Editor state for the Recorder and the Shared steps editor (README "State (UI level)" →
// Recorder: steps, selected step, dirty, composer text, current action, AI state,
// candidate box, open loop, re-record step). All engine work goes through getEngine().
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ActionKind, Box, Direction, Generated, Point, SampleFile, Step, Viewport } from '../../data/types';
import { demoEngine, getEngine, EngineError, type CheckingPhase, type FileChoice, type FileChooserEvent, type RecordParams } from '../../engine';
import { around, gesture, inside, sampleApp } from '../../components/live';
import { actionInfo } from '../../engine/labels';
import { appendStep, defaultLabel, findStep, flatRows, insertAfter, numberOf, removeStep, replaceStep, stepsBefore, updateStep } from '../../components/steps';
import { POINT_KINDS, STICKY } from './actions';
import { secrets } from '../../platform';
import { useSession } from '../../state/session';
import { originOf } from '../../lib/sites';
import { ensureSecretSites } from '../../lib/secretSites';
import { askText, checkpointLabel, describeWhat, notFoundText, thinkingText } from './describe';

export type AiState =
  | { state: 'idle' }
  | { state: 'thinking'; text: string; what: string }
  | { state: 'result'; text: string; what: string; box: Box; at: Point; target: string; frame?: number }
  | { state: 'notfound'; text: string; what: string }
  /**
   * A click, drag or scroll on the live view: nothing reached the page. The bar asks "Click Next
   * button?" and the step is done and recorded only on Confirm (Enter, or the same spot again).
   */
  | { state: 'proposal'; params: RecordParams; frame?: number; box: Box; label: string; target?: string; named: boolean };

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
 * The value for a "Write saved secret" step, read from the Keychain just for this call (the engine
 * types it and never stores it). A secret saved before sites existed is offered the app's site once.
 */
export async function secretFor(ref: string | undefined, appUrl: string | undefined): Promise<Record<string, string> | undefined> {
  if (!ref) return undefined;
  await ensureSecretSites([ref], appUrl);
  const values = await secrets.resolve([ref]);
  return ref in values ? { [ref]: values[ref] } : {};
}

export function useRecorder({ viewport, onError, appUrl, filesDir, appId }: {
  viewport: Pick<Viewport, 'width' | 'height'>; onError: (message: string) => void;
  /** The app's base address: where a saved secret is allowed when it has no sites yet. */
  appUrl?: string;
  /** <tests folder>/files, for uploads of the user's own files. */
  filesDir?: string;
  /** For "Don't ask again for this app" (saving a typed password as a saved secret). */
  appId?: string;
}) {
  const engine = getEngine();
  const sample = engine.liveMode === 'sample';
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
  // A typed password (a Write into a masked field): offer once to save it as a saved secret.
  const [secretAsk, setSecretAsk] = useState<string | null>(null);
  useEffect(() => engine.on('record.fileChooser', d => { if (busyRef.current) setFileAsk(d); }), [engine]);
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
  const played = useCallback((opts: { full: boolean; at: string | null; insertAfter: string | null; passed?: string[] }) => {
    if (opts.full) setUnplayed(new Set());
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

  /** Records one step with the engine: the row appears at once, the disc pulses while the screen is checked. */
  async function record(params: RecordParams, extra: Extra = {}) {
    if (busyRef.current) return;
    busyRef.current = true;
    const rr = rerecordId;
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
      const secretValues = extra.checkpoint ? undefined : await secretFor(params.secretRef, appUrl);
      const sent: RecordParams = { ...params, ...(filesDir ? { filesDir } : {}), ...(secretValues ? { secrets: secretValues } : {}), ...(extra.frame !== undefined ? { frame: extra.frame } : {}),
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
    } catch (e) {
      if (!rr && insertRef.current === tempId) setInsertAfter(prevInsert);
      if (!rr) setSteps(s => removeStep(s, tempId));
      setSelectedId(rr);
      onErrorRef.current(e instanceof EngineError || e instanceof Error ? e.message : "Couldn't record that step.");
    } finally {
      busyRef.current = false; setBusyId(null); setChecking(false); setFileAsk(null);
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
  async function describe(t: string) {
    const token = ++aiToken.current;
    const what = describeWhat(t);
    setAi({ state: 'thinking', text: t, what });
    let res = null;
    try { res = await engine.locate(t); } catch { res = null; }
    if (token !== aiToken.current) return;
    if (res) setAi({ state: 'result', text: t, what, box: res.box, at: res.at, target: res.target, frame: res.frame });
    else { setAi({ state: 'notfound', text: t, what }); setText(t); }
  }
  const cancelAi = () => { aiToken.current++; setAi({ state: 'idle' }); };

  // ---------- Proposals: the page only gets what the user confirmed ----------
  function propose(params: RecordParams, frame: number | undefined, box: Box, label: string, at?: Point) {
    const token = ++aiToken.current;
    setAi({ state: 'proposal', params, frame, box, label, named: !at || sample });
    if (!at) return;
    // The element's box and name come a moment later; the bar asks at once with "here".
    void engine.propose(at).then(got => {
      if (token !== aiToken.current) return;
      setAi(a => a.state !== 'proposal' ? a : {
        ...a, box: got.box ?? a.box, named: true,
        ...(got.name ? { label: `${actionInfo(a.params.action).verb} ${got.name}`, target: got.target } : {}),
      });
    }).catch(() => { if (token === aiToken.current) setAi(a => (a.state === 'proposal' ? { ...a, named: true } : a)); });
  }
  function confirmProposal() {
    if (ai.state !== 'proposal') return;
    const a = ai; aiToken.current++; setAi({ state: 'idle' });
    // Named by the AI assistant already: the engine needn't ask it again.
    void record(a.params, { frame: a.frame, ...(a.target ? { label: a.label, target: a.target } : {}) });
  }
  const retryAi = () => {
    if (ai.state === 'proposal') { cancelAi(); setRetryNote(true); return; }     // pick again on the page
    if (ai.state === 'result' || ai.state === 'notfound') void describe(ai.text);
  };
  const [retryNote, setRetryNote] = useState(false);
  function confirmAi() {
    if (ai.state === 'proposal') { confirmProposal(); return; }
    if (ai.state !== 'result') return;
    const a = ai; setAi({ state: 'idle' });
    const x = { target: a.target, frame: a.frame };
    if (action === 'checkpoint') void record({ action: 'checkpoint' }, { ...x, checkpoint: a.box, label: checkpointLabel(a.text) });
    else if (action === 'waitUntil') void record({ action: 'waitUntil', region: a.box, timeoutMs: options.maxWait * 1000 }, x);
    else if (action === 'swipe' || action === 'scroll') void record({ action, from: a.at, direction: options.direction, distance: options.distance }, x);
    else void record({ action: POINT_KINDS.has(action) ? action : 'click', at: a.at, ...(action === 'upload' ? { sample: options.sample } : {}) }, x);
  }

  // ---------- Page ----------
  const pageBusy = () => busyRef.current || ai.state === 'thinking';
  // Nothing a user does on the live view reaches the page: a click, drag or scroll proposes the step,
  // and only Confirm does it. `frame`: the live view frame the user pressed on; the engine refuses
  // the step if the page has changed since.
  function pagePoint(p: Point, frame?: number) {
    if (pageBusy()) return;
    setRetryNote(false);
    // The same spot again confirms.
    if (ai.state === 'proposal' && ai.params.at && inside(p, ai.box)) { confirmProposal(); return; }
    if (ai.state !== 'idle') cancelAi();
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
    if (action === 'checkpoint') { setText(''); void record({ action: 'checkpoint' }, { checkpoint: region, label: named ? checkpointLabel(named) : undefined, frame }); }
    else void record({ action: 'waitUntil', region, timeoutMs: options.maxWait * 1000 }, { frame });
  }

  // ---------- Composer ----------
  function send() {
    if (busyRef.current || ai.state === 'thinking') return;
    const t = text.trim();
    switch (action) {
      case 'write': {
        if (options.writeSource === 'secret') { if (!options.secretRef) return; void record({ action: 'write', secretRef: options.secretRef }); }
        else if (options.writeSource === 'generated') void record({ action: 'write', generated: options.generated });
        else { if (!t) return; void record({ action: 'write', text: t }); }
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
    setRerecordId(id); setSelectedId(id);
    if (s.action === 'write') { setAction('write'); setText(s.text ?? ''); if (s.secretRef) setOptions({ writeSource: 'secret', secretRef: s.secretRef }); }
    else if (s.action !== 'loop' && s.action !== 'group') setAction(s.action);
    if (sample) sampleApp.replay(stepsBefore(stepsRef.current, id), viewport);
  }

  return {
    steps, dirty, selectedId, openLoopId, rerecordId, action, text, options, ai, busyId, checking, savedPill, sample, addedId,
    /** "Clicking…", "Waiting for the page…": what the step being recorded is doing now. */
    phaseText: busyId !== null ? phaseText(phase, busyAction) : null,
    stepsRef, recordedRef, setSelectedId, setOpenLoopId, setAction, setText, setOptions, setDirty,
    load, change, record, addLocal, addLoop, send, describe, confirmAi, retryAi, cancelAi, pageScroll, retryNote,
    insertAfterId, setInsertAfter, unplayed, atStepId, played,
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
    ask: ai.state === 'result' ? askText(ai.what) : ai.state === 'proposal' ? `${ai.label}?` : null,
    notFound: ai.state === 'notfound' ? notFoundText(ai.what) : null,
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
