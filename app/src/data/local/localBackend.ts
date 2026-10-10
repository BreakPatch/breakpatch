// Community's backend: tests saved as JSON files in a folder the person picked (docs/editions.md).
//
//   <folder>/breakpatch.json                     { format, schemaVersion, id, name } (id: format.ts newFolderId)
//   <folder>/apps/<appId>/app.json
//   <folder>/apps/<appId>/tests/<testId>.json    test fields + "recordedOn" + "steps" (latest only)
//   <folder>/apps/<appId>/shared/<groupId>.json  shared steps + "steps"
//   <folder>/apps/<appId>/runs/<testId>.json     the last run of that test
//   <folder>/suites/<suiteId>.json
//   <folder>/deleted/<entry>/deleted.json         Recently deleted: what it is, when and by whom
//   <folder>/deleted/<entry>/apps/…, suites/…     its files, at their places in the folder
//
// Ids are the file and folder names (readable slugs), so they aren't repeated inside the files.
// Derived values (step counts, last runs, where shared steps are used) aren't stored either.
// The text of every file as last read or written is the source of truth; the model is parsed
// from it. Saving the same thing writes nothing; outside edits (a `git pull`) are picked up on
// window focus, through the storage's watcher, or by a light poll.
//
// Deleting an app, a test, shared steps or a suite moves its files into deleted/ (Recently
// deleted) for KEEP_DELETED_DAYS; restoring moves them back. Older entries are deleted for good
// when the folder is opened. The folder's name has no leading dot: the Mac's file access refuses
// dot files (storage.ts tempName).
import {
  KEEP_DELETED_MS, cleanDetails, detailsDiff, newestDeletedFirst, upTo,
  type Backend, type DeletedItem, type DeletedKind, type DeletedRef, type Limit, type Listener, type NewApp, type NewSuite, type NewTest, type NotifyStore, type RecentlyDeleted, type TestDetails, type Unsubscribe,
} from '../backend';
import type {
  App, FlakyMark, Member, Person, QueueItem, RecordedOn, Role, Run, RunnerStatus, RunRequest, RunSummary, Step, StepGroup, Suite, SuiteNotify, SuiteRun, Test, TestStatus, Version, Viewport, Weekday,
} from '../types';
import { folderConnectionId } from '../../state/connectionIds';
import { CALL_SCHEMA_VERSION, DEVICE_SCHEMA_VERSION, FORMAT, NEWEST_READ_SCHEMA_VERSION, SCHEMA_VERSION, fromFileText, isFolderId, newFolderId, toFileText, uniqueSlug } from './format';
import { usesCallSteps } from '../../lib/calls';
import { baseName, FileTooBig, join, tempName, type FolderStorage } from './storage';
import { osText } from '../../lib/osWords';
import { deviceOf } from '../devices';
import { MAX_RETRIES } from '../../lib/retries';

/** Stands for a file over 5 MB in the texts read from the folder: it's skipped, never parsed. */
const TOO_BIG = '\u0000breakpatch: file too big\u0000';

export type FolderProblem = 'missing' | 'notBreakpatch' | 'unreadable' | 'newer' | 'notWritable';

/** Why a folder can't be opened. `message` is the plain line the screens show. */
export class FolderError extends Error {
  code: FolderProblem;
  constructor(code: FolderProblem, message: string) { super(message); this.code = code; }
}

export const NEWER_MESSAGE = 'This folder was saved by a newer Breakpatch. Update to open it.';
const NOT_HERE = 'Community runs tests and suites by hand on this Mac.';

export interface FolderMeta { format: typeof FORMAT; schemaVersion: number; name: string; /** The folder's own id (format.ts newFolderId); none in a folder from before it. */ id?: string }

/**
 * Everything in a tests folder at one moment, read the way the screens read it: each app with
 * its tests and shared steps (latest steps included), the last run of each test, and the suites.
 * For reading a folder as a whole, e.g. to copy it somewhere else. Reading it writes nothing.
 */
export interface FolderSnapshot {
  /** The folder, absolute. */
  path: string;
  /** From breakpatch.json, else the folder's name. */
  name: string;
  /** From breakpatch.json (1 when it has none). */
  schemaVersion: number;
  /** Saved by a newer app (schemaVersion above this app's): what's here may be incomplete. */
  newer: boolean;
  apps: {
    app: App;
    tests: { test: Test; steps: Step[]; recordedOn?: RecordedOn }[];
    groups: { group: StepGroup; steps: Step[] }[];
    /** The last run of each test that has one. */
    runs: Run[];
  }[];
  suites: Suite[];
  /** Plain lines about files that couldn't be read and were left out (as onWarnings gives them). */
  skipped: string[];
  /**
   * The text of every file the snapshot was read from, by path in the folder
   * ("apps/web-app/tests/log-in.json"), so a copy can tell later whether the folder changed.
   * A file over 5 MB is there with the text "" (it was never read).
   */
  files: Record<string, string>;
}

/**
 * Where a folder suite's result address is kept, apart from the folder (the Team edition's Solo
 * plan: the Keychain, platform.ts resultAddresses). Community has none: it never saves one.
 */
export interface AddressStore {
  get(wsKey: string, suiteId: string): Promise<string | null>;
  set(wsKey: string, suiteId: string, url: string | null): Promise<void>;
}

export interface LocalOptions {
  storage: FolderStorage;
  /** The edition's address store (edition.resultAddresses); none: addresses aren't kept. */
  addresses?: AddressStore;
  /** The folder, absolute. */
  path: string;
  person: Person;
  /**
   * Re-read on window focus and watch or poll for outside changes. Default true;
   * tests turn it off and call reload() themselves.
   */
  live?: boolean;
  /** Poll interval when the storage can't watch. Default 5 s. */
  pollMs?: number;
  /** The clock (tests). */
  now?: () => number;
}

/** `recordedOn` belongs to the latest version (the only one a folder keeps), next to its steps. */
type TestRec = { test: Omit<Test, 'id' | 'appId' | 'stepCount' | 'lastRun'>; steps: Step[]; recordedOn?: RecordedOn };
type GroupRec = { group: Omit<StepGroup, 'id' | 'appId' | 'stepCount' | 'usedBy'>; steps: Step[] };
type RunRec = Omit<Run, 'appId' | 'testId'>;
interface AppRec { app: App; tests: Map<string, TestRec>; groups: Map<string, GroupRec>; runs: Map<string, RunRec> }
/** An entry in deleted/: its folder's name and what it holds. */
interface BinRec { entry: string; item: Omit<DeletedItem, 'appName'> }
interface Model { meta: FolderMeta | null; apps: Map<string, AppRec>; suites: Map<string, Suite>; bin: Map<string, BinRec> }

/** Recently deleted, in the folder. */
export const DELETED_DIR = 'deleted';
const KINDS: DeletedKind[] = ['app', 'test', 'group', 'suite'];

const DEFAULT_VIEWPORT: Viewport = { width: 1440, height: 900, dpr: 1 };
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown, d = '') => (typeof v === 'string' ? v : d);
const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const clone = <T>(v: T): T => structuredClone(v);
/** Lists are in name order: files have no other order, and edits from outside keep it stable. */
const byName = (a: { name: string; id: string }, b: { name: string; id: string }) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id);

/**
 * A viewport as a file has it. None: a desktop test, never the app's default screen (which may be a
 * phone's, and would make an old test a touch test). A phone or tablet this app knows is at its own
 * size, whatever the file says; one it doesn't know (a newer app's) is kept as it is.
 */
export function viewportIn(v: unknown): Viewport {
  if (!isObj(v) || typeof v.width !== 'number' || typeof v.height !== 'number') return { ...DEFAULT_VIEWPORT };
  const vp = v as unknown as Viewport;
  const d = deviceOf(vp);
  return d ? { ...vp, width: d.width, height: d.height } : vp;
}

/** A test file's `recordedOn` (engine/PROTOCOL.md "Where a test was recorded"): short strings only, else none. */
export function recordedOnIn(v: unknown): RecordedOn | undefined {
  if (!isObj(v) || typeof v.os !== 'string' || !v.os) return undefined;
  const out: RecordedOn = { os: v.os.slice(0, 40) };
  for (const k of ['osVersion', 'arch', 'chromium'] as const) if (typeof v[k] === 'string' && v[k]) out[k] = (v[k] as string).slice(0, 40);
  return out;
}

/** A test file for a phone or tablet, or an app.json whose default screen is one: the folder needs DEVICE_SCHEMA_VERSION. */
function needsDeviceFormat(rel: string, value: unknown): boolean {
  if (!isObj(value)) return false;
  const vp = /^apps\/[^/]+\/tests\/[^/]+\.json$/.test(rel) ? value.viewport : /^apps\/[^/]+\/app\.json$/.test(rel) ? value.defaultViewport : null;
  return isObj(vp) && typeof vp.device === 'string' && vp.device !== '';
}

/** A test or shared steps file with a Call step in it: the folder needs CALL_SCHEMA_VERSION. */
function needsCallFormat(rel: string, value: unknown): boolean {
  return isObj(value) && /^apps\/[^/]+\/(tests|shared)\/[^/]+\.json$/.test(rel) && usesCallSteps(value.steps);
}

/**
 * The folder format a file needs (format.ts), by its path in the folder: CALL_SCHEMA_VERSION for a
 * test or shared steps with a Call step, DEVICE_SCHEMA_VERSION for a phone or tablet test (or an
 * app.json whose default screen is one), else SCHEMA_VERSION. A folder's breakpatch.json says the
 * highest of its files' (this backend raises it as it writes them; an export writes it so).
 */
export function folderFormatFor(rel: string, value: unknown): number {
  return needsCallFormat(rel, value) ? CALL_SCHEMA_VERSION : needsDeviceFormat(rel, value) ? DEVICE_SCHEMA_VERSION : SCHEMA_VERSION;
}

const WEEKDAYS: Weekday[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

/**
 * A suite file's `schedule` (the Team edition's Solo plan runs it on this Mac): the days and a
 * 24-hour time, else none. Community never writes one.
 */
export function scheduleIn(v: unknown): Suite['schedule'] {
  if (!isObj(v) || !Array.isArray(v.days) || typeof v.time !== 'string' || !/^\d{1,2}:\d{2}$/.test(v.time)) return null;
  const days = WEEKDAYS.filter(d => (v.days as unknown[]).includes(d));
  return days.length ? { days, time: v.time } : null;
}

/** A suite file's `notify`: where its result goes and when, never the address (that's in the Keychain). */
export function notifyIn(v: unknown): SuiteNotify | undefined {
  if (!isObj(v) || !['webhook', 'slack', 'teams'].includes(v.kind as string)) return undefined;
  const when = ['every', 'failures', 'changes'].includes(v.when as string) ? v.when as SuiteNotify['when'] : 'every';
  return { kind: v.kind as SuiteNotify['kind'], when, ...(v.screenshot === true ? { screenshot: true } : {}) };
}

/** A suite file's `retries` (lib/retries.ts): 0, 1 or 2, else none (the default). */
export function retriesIn(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= MAX_RETRIES ? v : undefined;
}

/** Steps as saved: no UI-only markers, no undefined fields, children cleaned too. */
function cleanSteps(steps: Step[]): Step[] {
  return steps.map(s => {
    const { rerecorded: _r, steps: kids, ...rest } = s;
    const out = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)) as unknown as Step;
    if (kids) out.steps = cleanSteps(kids);
    return out;
  });
}

function groupRefs(steps: Step[], out: { groupId: string; version: number | 'latest' }[] = []) {
  for (const s of steps) {
    if (s.action === 'group' && s.groupId) out.push({ groupId: s.groupId, version: s.groupVersion ?? 'latest' });
    if (s.steps) groupRefs(s.steps, out);
  }
  return out;
}

/** Where a deleted suite's result address waits in the address store: its Recently deleted entry's name. */
const binAddressKey = (entry: string) => `deleted.${entry}`;

function stamp(t: number): string {
  return new Date(t).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
}

/** Reads breakpatch.json. Throws a FolderError when the folder can't be opened. */
/** breakpatch.json's text; one over 5 MB counts as unreadable. */
export async function readMeta(st: FolderStorage, root: string): Promise<string | null> {
  try { return await st.read(join(root, 'breakpatch.json')); }
  catch (e) {
    if (e instanceof FileTooBig) throw new FolderError('unreadable', "This folder's breakpatch.json is bigger than 5 MB, so it can't be a Breakpatch file. Fix the file or choose another folder.");
    throw e;
  }
}

export function parseMeta(text: string | null): FolderMeta {
  if (text === null) throw new FolderError('missing', "This folder doesn't have a breakpatch.json file.");
  let v: unknown;
  try { v = fromFileText(text); } catch { throw new FolderError('unreadable', "This folder's breakpatch.json can't be read. Fix the file or choose another folder."); }
  if (!isObj(v) || v.format !== FORMAT) throw new FolderError('notBreakpatch', "This folder's breakpatch.json isn't a Breakpatch file.");
  const schemaVersion = num(v.schemaVersion, 1);
  if (schemaVersion > NEWEST_READ_SCHEMA_VERSION) throw new FolderError('newer', NEWER_MESSAGE);
  return { format: FORMAT, schemaVersion, name: str(v.name), ...(isFolderId(v.id) ? { id: v.id } : {}) };
}

export class LocalBackend implements Backend {
  readonly kind = 'local' as const;
  readonly workspace = null;
  readonly local: { path: string };

  private st: FolderStorage;
  private root: string;
  private me: Person;
  private texts = new Map<string, string>();
  private model: Model = { meta: null, apps: new Map(), suites: new Map(), bin: new Map() };
  private warnings: string[] = [];
  private readOnly = false;
  /** Suite results live only for this session: Community keeps no suite run history. */
  private suiteLast = new Map<string, Suite['lastRun']>();
  private subs = new Set<() => void>();
  private warnSubs = new Set<Listener<string[]>>();
  private roSubs = new Set<Listener<boolean>>();
  private chain: Promise<unknown> = Promise.resolve();
  private stops: (() => void)[] = [];
  private closed = false;

  private readonly addresses: AddressStore | null;
  private readonly now: () => number;

  private constructor(o: LocalOptions) {
    this.addresses = o.addresses ?? null;
    this.now = o.now ?? Date.now;
    this.st = o.storage; this.root = o.path.replace(/\/+$/, '') || '/'; this.me = o.person;
    this.local = { path: this.root };
  }

  /** Opens a folder that already has a breakpatch.json (see folder.ts to set one up). */
  static async open(o: LocalOptions): Promise<LocalBackend> {
    const b = new LocalBackend(o);
    parseMeta(await readMeta(o.storage, b.root));
    await b.reload();
    await b.emptyBin().catch(() => {});
    if (o.live !== false) b.startLive(o.pollMs ?? 5000);
    return b;
  }

  /**
   * Reads a folder once, without watching it, even one saved by a newer app (`newer` says so).
   * Throws a FolderError when there's no breakpatch.json or it isn't a Breakpatch file.
   */
  static async read(o: Pick<LocalOptions, 'storage' | 'path' | 'person'>): Promise<FolderSnapshot> {
    const b = new LocalBackend({ ...o, live: false });
    try { parseMeta(await readMeta(o.storage, b.root)); }
    catch (e) { if (!(e instanceof FolderError && e.code === 'newer')) throw e; }
    try { await b.reload(); return await b.snapshot(); }
    finally { b.close(); }
  }

  close() { this.closed = true; this.stops.splice(0).forEach(f => f()); this.subs.clear(); }

  // ---- plumbing ----
  private abs(rel: string) { return join(this.root, rel); }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.chain.then(fn, fn);
    this.chain = p.catch(() => {});
    return p;
  }
  private emit() { this.subs.forEach(f => f()); }
  private watch<T>(select: () => T, l: Listener<T>): Unsubscribe {
    let alive = true, last: string | undefined;
    const push = () => {
      if (!alive) return;
      const v = select(), key = JSON.stringify(v);
      if (key !== last) { last = key; l(v); }
    };
    this.subs.add(push);
    queueMicrotask(push);
    return () => { alive = false; this.subs.delete(push); };
  }

  private startLive(pollMs: number) {
    const again = () => { void this.reload().catch(() => {}); };
    if (typeof window !== 'undefined') {
      const onVis = () => { if (document.visibilityState === 'visible') again(); };
      window.addEventListener('focus', again);
      document.addEventListener('visibilitychange', onVis);
      this.stops.push(() => { window.removeEventListener('focus', again); document.removeEventListener('visibilitychange', onVis); });
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const soon = () => { clearTimeout(timer); timer = setTimeout(again, 300); };
    const poll = () => {
      const id = setInterval(() => { if (typeof document === 'undefined' || document.visibilityState === 'visible') again(); }, pollMs);
      this.stops.push(() => clearInterval(id));
    };
    if (this.st.watch) {
      this.st.watch(this.root, soon).then(
        off => { if (this.closed) off(); else this.stops.push(() => { clearTimeout(timer); off(); }); },
        () => { if (!this.closed) poll(); },
      );
    } else poll();
  }

  /** Every file the folder format knows, relative path → text. Hidden and non-JSON files are left alone. */
  private async scan(): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const json = (n: string) => !n.startsWith('.') && n.endsWith('.json');
    const add = async (rel: string) => {
      try { const t = await this.st.read(this.abs(rel)); if (t !== null) out.set(rel, t); }
      catch (e) { if (e instanceof FileTooBig) out.set(rel, TOO_BIG); else throw e; }
    };
    await add('breakpatch.json');
    for (const e of await this.st.list(this.abs('apps'))) {
      if (!e.isDir || e.name.startsWith('.')) continue;
      const dir = `apps/${e.name}`;
      await add(`${dir}/app.json`);
      if (!out.has(`${dir}/app.json`)) { out.set(`${dir}/app.json`, ''); continue; }
      for (const sub of ['tests', 'shared', 'runs']) {
        for (const f of await this.st.list(this.abs(`${dir}/${sub}`))) if (!f.isDir && json(f.name)) await add(`${dir}/${sub}/${f.name}`);
      }
    }
    for (const f of await this.st.list(this.abs('suites'))) if (!f.isDir && json(f.name)) await add(`suites/${f.name}`);
    // Recently deleted: only what each entry is; its files are read when it's restored.
    for (const e of await this.st.list(this.abs(DELETED_DIR))) if (e.isDir && !e.name.startsWith('.')) await add(`${DELETED_DIR}/${e.name}/deleted.json`);
    return out;
  }

  /** Re-reads the folder; tells subscribers only when a file changed. */
  reload(): Promise<void> {
    return this.serial(async () => {
      if (this.closed) return;
      const next = await this.scan();
      const same = next.size === this.texts.size && [...next].every(([k, v]) => this.texts.get(k) === v);
      if (same && this.model.meta) return;
      this.texts = next;
      this.rebuild();
    });
  }

  private rebuild() {
    const warn: string[] = [];
    const bad = (rel: string, what: string) => warn.push(`${rel}: ${what}`);
    const parse = (rel: string): Record<string, unknown> | null => {
      if (this.texts.get(rel) === TOO_BIG) { bad(rel, 'bigger than 5 MB, skipped'); return null; }
      try { const v = fromFileText(this.texts.get(rel)!); if (isObj(v)) return v; bad(rel, 'not a Breakpatch file, skipped'); }
      catch { bad(rel, 'not valid JSON, skipped'); }
      return null;
    };
    const who = (v: unknown): Person => (isObj(v) && typeof v.name === 'string' ? { uid: str(v.uid, 'local'), name: v.name, email: str(v.email) } : this.me);

    // breakpatch.json: a newer format makes the folder read-only; a broken one keeps the last good one.
    let meta = this.model.meta;
    let readOnly = this.readOnly;
    try { meta = parseMeta(this.texts.get('breakpatch.json') ?? null); readOnly = false; }
    catch (e) {
      if (e instanceof FolderError && e.code === 'newer') readOnly = true;
      else bad('breakpatch.json', (e as Error).message);
    }

    const apps = new Map<string, AppRec>();
    const suites = new Map<string, Suite>();
    const bin = new Map<string, BinRec>();
    for (const rel of [...this.texts.keys()].sort()) {
      const d = /^deleted\/([^/]+)\/deleted\.json$/.exec(rel);
      if (d) {
        const v = parse(rel); if (!v) continue;
        const kind = v.kind as DeletedKind;
        if (!KINDS.includes(kind) || typeof v.id !== 'string' || typeof v.name !== 'string' || ((kind === 'test' || kind === 'group') && typeof v.appId !== 'string')) {
          bad(rel, 'not a Recently deleted entry, skipped'); continue;
        }
        bin.set(d[1], { entry: d[1], item: { kind, id: v.id, ...(typeof v.appId === 'string' ? { appId: v.appId } : {}), name: v.name, deletedAt: num(v.deletedAt),
          deletedBy: who(v.deletedBy), createdBy: who(v.createdBy), ...(v.status === 'published' || v.status === 'draft' ? { status: v.status } : {}) } });
        continue;
      }
      const m = /^apps\/([^/]+)\/(?:(app)\.json|(tests|shared|runs)\/(.+)\.json)$/.exec(rel);
      if (m) {
        const [, appId, isApp, kind, id] = m;
        if (isApp) {
          if (this.texts.get(rel) === '') { bad(`apps/${appId}`, 'no app.json, skipped'); continue; }
          const v = parse(rel); if (!v) continue;
          if (typeof v.name !== 'string') { bad(rel, 'the app has no name, skipped'); continue; }
          const vp = viewportIn(v.defaultViewport);
          apps.set(appId, { app: { id: appId, name: v.name, baseUrl: str(v.baseUrl), icon: typeof v.icon === 'string' ? v.icon : undefined, defaultViewport: vp, createdBy: who(v.createdBy), createdAt: num(v.createdAt) }, tests: new Map(), groups: new Map(), runs: new Map() });
          continue;
        }
        const app = apps.get(appId); if (!app) continue;
        const v = parse(rel); if (!v) continue;
        if (kind === 'runs') {
          if (!Array.isArray(v.steps) || typeof v.startedAt !== 'number') { bad(rel, 'not a run, skipped'); continue; }
          app.runs.set(id, { ...(v as unknown as RunRec), id: str(v.id, `${id}-${stamp(v.startedAt)}`) });
          continue;
        }
        if (typeof v.name !== 'string' || (v.steps !== undefined && !Array.isArray(v.steps))) { bad(rel, `not ${kind === 'tests' ? 'a test' : 'shared steps'}, skipped`); continue; }
        const { steps, version, recordedOn, id: _id, appId: _a, stepCount: _c, lastRun: _l, usedBy: _u, currentVersion: _cv, ...rest } = v;
        const common = { ...rest, name: v.name, currentVersion: num(version), createdBy: who(v.createdBy), createdAt: num(v.createdAt), updatedBy: who(v.updatedBy), updatedAt: num(v.updatedAt) };
        const list = (steps as Step[] | undefined) ?? [];
        if (kind === 'tests') {
          app.tests.set(id, { test: { ...common, startUrl: str(v.startUrl, app.app.baseUrl), status: v.status === 'published' ? 'published' : 'draft', viewport: viewportIn(v.viewport) } as TestRec['test'], steps: list, recordedOn: recordedOnIn(recordedOn) });
        } else {
          app.groups.set(id, { group: common as GroupRec['group'], steps: list });
        }
        continue;
      }
      const s = /^suites\/(.+)\.json$/.exec(rel);
      if (s) {
        const v = parse(rel); if (!v) continue;
        if (typeof v.name !== 'string' || !Array.isArray(v.tests)) { bad(rel, 'not a suite, skipped'); continue; }
        const notify = notifyIn(v.notify);
        const retries = retriesIn(v.retries);
        suites.set(s[1], { id: s[1], name: v.name, tests: (v.tests as Suite['tests']).filter(t => isObj(t) && typeof t.appId === 'string' && typeof t.testId === 'string'), schedule: scheduleIn(v.schedule), ...(notify ? { notify } : {}), ...(retries !== undefined ? { retries } : {}), resultUrl: typeof v.resultUrl === 'string' ? v.resultUrl : undefined, createdBy: who(v.createdBy), createdAt: num(v.createdAt), updatedBy: who(v.updatedBy), updatedAt: num(v.updatedAt) });
      }
    }

    this.model = { meta, apps, suites, bin };
    this.emit();
    if (warn.join('\n') !== this.warnings.join('\n')) { this.warnings = warn; this.warnSubs.forEach(l => l([...warn])); }
    if (readOnly !== this.readOnly) { this.readOnly = readOnly; this.roSubs.forEach(l => l(readOnly)); }
  }

  /** Writes a file (temp file, then rename) unless it already says exactly this. */
  private async put(rel: string, value: unknown) {
    const needs = folderFormatFor(rel, value);
    if (needs > SCHEMA_VERSION) await this.raiseFormat(needs);
    const text = toFileText(value);
    if (this.texts.get(rel) === text) return;
    const path = this.abs(rel);
    const dir = path.slice(0, path.lastIndexOf('/'));
    if (!(await this.st.exists(dir))) await this.st.mkdir(dir);
    const tmp = join(dir, tempName(baseName(path)));
    await this.st.write(tmp, text);
    try { await this.st.rename(tmp, path); }
    catch (e) { await this.st.remove(tmp).catch(() => {}); throw e; }
    this.texts.set(rel, text);
  }
  /**
   * Raises breakpatch.json's schemaVersion to `to` when it's lower (format.ts), before the file that
   * needs it is written, so an older app never sees that file in a folder it would save to.
   */
  private async raiseFormat(to: number) {
    let v: unknown = null;
    try { v = fromFileText(this.texts.get('breakpatch.json') ?? ''); } catch { /* rewritten below */ }
    const meta = isObj(v) ? v : { format: FORMAT, name: this.name };
    if (num(meta.schemaVersion, 1) >= to) return;
    await this.put('breakpatch.json', { ...meta, format: FORMAT, schemaVersion: to });
  }
  private async drop(rel: string) {
    await this.st.remove(this.abs(rel));
    for (const k of [...this.texts.keys()]) if (k === rel || k.startsWith(rel + '/')) this.texts.delete(k);
  }
  /** Runs a write in order with the others and re-reads the model from the files it changed. */
  private write<T>(fn: () => Promise<T>): Promise<T> {
    return this.serial(async () => {
      if (this.readOnly) throw new Error(NEWER_MESSAGE);
      try { return await fn(); }
      finally { this.rebuild(); }
    });
  }

  private appRec(appId: string): AppRec {
    const a = this.model.apps.get(appId);
    if (!a) throw new Error('App not found');
    return a;
  }
  private testRec(appId: string, testId: string): TestRec {
    const t = this.appRec(appId).tests.get(testId);
    if (!t) throw new Error('Test not found');
    return t;
  }

  private testOut(appId: string, id: string, r: TestRec): Test {
    const run = this.model.apps.get(appId)?.runs.get(id);
    const lastRun: RunSummary | undefined = run && {
      result: run.result === 'fail' ? 'fail' : run.healedCount ? 'healed' : 'pass', at: run.startedAt,
      by: 'name' in run.startedBy ? run.startedBy.name : run.startedBy.serviceAccount,
    };
    return clone({ ...r.test, id, appId, stepCount: r.steps.length, lastRun });
  }
  private groupOut(appId: string, id: string, r: GroupRec): StepGroup {
    const usedBy: StepGroup['usedBy'] = [];
    for (const [testId, t] of this.appRec(appId).tests) for (const ref of groupRefs(t.steps)) if (ref.groupId === id) usedBy.push({ testId, version: ref.version });
    return clone({ ...r.group, id, appId, stepCount: r.steps.length, usedBy });
  }
  private runOut(appId: string, testId: string, r: RunRec): Run { return clone({ ...r, appId, testId }); }

  private testFile(r: TestRec) {
    const { currentVersion, ...rest } = r.test;
    return { ...rest, version: currentVersion, recordedOn: r.recordedOn, steps: r.steps };
  }
  private groupFile(r: GroupRec) {
    const { currentVersion, ...rest } = r.group;
    return { ...rest, version: currentVersion, steps: r.steps };
  }

  // ---- extras for the screens ----
  /** Plain lines about files that were skipped (invalid JSON, unknown shape). Calls `l` at once. */
  onWarnings(l: Listener<string[]>): Unsubscribe { this.warnSubs.add(l); l([...this.warnings]); return () => { this.warnSubs.delete(l); }; }
  onReadOnly(l: Listener<boolean>): Unsubscribe { this.roSubs.add(l); l(this.readOnly); return () => { this.roSubs.delete(l); }; }
  /** Folder name from breakpatch.json. */
  get name(): string { return this.model.meta?.name || baseName(this.root); }
  /**
   * The folder's own id (breakpatch.json `id`, format.ts newFolderId), which links to its tests
   * name (lib/openLinks.ts). A folder from before it gets one now, saved in breakpatch.json (one
   * line to commit, so the links work in teammates' copies too).
   */
  folderId(): Promise<string> {
    const have = this.model.meta?.id;
    if (have) return Promise.resolve(have);
    return this.write(async () => {
      let v: unknown = null;
      try { v = fromFileText(this.texts.get('breakpatch.json') ?? ''); } catch { /* rewritten below */ }
      const meta = isObj(v) ? v : { format: FORMAT, schemaVersion: SCHEMA_VERSION, name: this.name };
      if (isFolderId(meta.id)) return meta.id;
      const id = newFolderId();
      await this.put('breakpatch.json', { ...meta, format: FORMAT, id });
      return id;
    });
  }
  /** N apps · N tests for Settings. */
  counts(l: Listener<{ apps: number; tests: number }>): Unsubscribe {
    return this.watch(() => ({ apps: this.model.apps.size, tests: [...this.model.apps.values()].reduce((n, a) => n + a.tests.size, 0) }), l);
  }

  /** The whole folder as it is now (see FolderSnapshot). */
  async snapshot(): Promise<FolderSnapshot> {
    await this.chain;
    let schemaVersion = 1;
    try { const v = fromFileText(this.texts.get('breakpatch.json') ?? ''); if (isObj(v)) schemaVersion = num(v.schemaVersion, 1); }
    catch { /* already in the warnings */ }
    const apps = [...this.model.apps].map(([appId, a]) => ({
      app: clone(a.app),
      tests: [...a.tests].map(([id, r]) => ({ test: this.testOut(appId, id, r), steps: clone(r.steps), ...(r.recordedOn ? { recordedOn: clone(r.recordedOn) } : {}) })).sort((x, y) => byName(x.test, y.test)),
      groups: [...a.groups].map(([id, r]) => ({ group: this.groupOut(appId, id, r), steps: clone(r.steps) })).sort((x, y) => byName(x.group, y.group)),
      runs: [...a.runs].map(([testId, r]) => this.runOut(appId, testId, r)).sort((x, y) => x.testId.localeCompare(y.testId)),
    })).sort((x, y) => byName(x.app, y.app));
    // Suite results live only for the session, so they aren't part of the folder.
    const suites = [...this.model.suites.values()].map(s => clone({ ...s, lastRun: undefined })).sort(byName);
    const files = Object.fromEntries([...this.texts].filter(([, t]) => t !== '').map(([k, t]) => [k, t === TOO_BIG ? '' : t]));
    return { path: this.root, name: this.name, schemaVersion, newer: this.readOnly, apps, suites, skipped: [...this.warnings], files };
  }

  // ---- the person (no sign-in) ----
  currentUser() { return this.me; }
  onUser(l: Listener<Person | null>) { l(this.me); return () => {}; }
  async signIn(): Promise<Person> { throw new Error(osText('There is no sign-in: your tests are saved in a folder on this Mac.')); }
  async sendPasswordReset() { throw new Error(osText('There is no sign-in: your tests are saved in a folder on this Mac.')); }
  async signOut() { /* nothing to sign out of */ }
  myRole(): Role { return 'admin'; }

  // ---- apps ----
  apps(l: Listener<App[]>) {
    return this.watch(() => [...this.model.apps.values()].map(a => clone(a.app)).sort(byName), l);
  }
  addApp(a: NewApp) {
    return this.write(async () => {
      const id = uniqueSlug(a.name, x => this.model.apps.has(x) || this.texts.has(`apps/${x}/app.json`));
      const app: App = { id, name: a.name, baseUrl: a.baseUrl, icon: a.icon ?? 'language', defaultViewport: a.defaultViewport, createdBy: this.me, createdAt: Date.now() };
      const { id: _id, ...file } = app;
      await this.put(`apps/${id}/app.json`, file);
      return clone(app);
    });
  }
  updateApp(id: string, patch: Partial<NewApp>) {
    return this.write(async () => {
      const { id: _id, ...file } = { ...this.appRec(id).app, ...patch };
      await this.put(`apps/${id}/app.json`, file);
    });
  }
  deleteApp(id: string) {
    return this.write(async () => {
      const { app } = this.appRec(id);
      await this.toBin({ kind: 'app', id, name: app.name, createdBy: app.createdBy }, async entry => { await this.moveDir(`apps/${id}`, `${entry}/apps/${id}`); });
    });
  }

  // ---- tests ----
  tests(appId: string, l: Listener<Test[]>) {
    return this.watch(() => {
      const a = this.model.apps.get(appId);
      return a ? [...a.tests].map(([id, r]) => this.testOut(appId, id, r)).sort(byName) : [];
    }, l);
  }
  test(appId: string, testId: string, l: Listener<Test | null>) {
    return this.watch(() => { const r = this.model.apps.get(appId)?.tests.get(testId); return r ? this.testOut(appId, testId, r) : null; }, l);
  }
  createTest(n: NewTest) {
    return this.write(async () => {
      const app = this.appRec(n.appId);
      const id = uniqueSlug(n.name, x => app.tests.has(x));
      const now = Date.now();
      const rec: TestRec = { test: { name: n.name, description: n.description, startUrl: n.startUrl, viewport: n.viewport, setUp: n.setUp, cleanUp: n.cleanUp, status: 'draft', currentVersion: 0, createdBy: this.me, createdAt: now, updatedBy: this.me, updatedAt: now }, steps: [] };
      await this.put(`apps/${n.appId}/tests/${id}.json`, this.testFile(rec));
      return this.testOut(n.appId, id, rec);
    });
  }
  private current(r: TestRec | GroupRec): Version {
    const meta = 'test' in r ? r.test : r.group;
    const recordedOn = 'test' in r ? r.recordedOn : undefined;
    return clone({ number: meta.currentVersion, steps: r.steps, savedBy: meta.updatedBy, savedAt: meta.updatedAt, ...(recordedOn ? { recordedOn } : {}) });
  }
  /** Only the latest version is kept. */
  versions(appId: string, testId: string, l: Listener<Version[]>) {
    return this.watch(() => { const r = this.model.apps.get(appId)?.tests.get(testId); return r && r.test.currentVersion > 0 ? [this.current(r)] : []; }, l);
  }
  /**
   * Only the latest is kept, so any saved version number reads as the latest (a step pinned to
   * an older version of shared steps runs the current ones).
   */
  async version(appId: string, testId: string, n: number) {
    await this.chain;
    const r = this.model.apps.get(appId)?.tests.get(testId);
    return r && n > 0 && r.test.currentVersion > 0 ? this.current(r) : null;
  }
  saveTest(appId: string, testId: string, steps: Step[], _note?: string, recordedOn?: RecordedOn) {
    return this.write(async () => {
      const r = this.testRec(appId, testId);
      const clean = cleanSteps(steps);
      const where = recordedOnIn(recordedOn) ?? r.recordedOn;
      // Nothing changed: no new number, no new file.
      if (r.test.currentVersion > 0 && toFileText(clean) === toFileText(r.steps) && toFileText(where) === toFileText(r.recordedOn)) return this.current(r);
      const now = Date.now();
      const next: TestRec = { test: { ...r.test, currentVersion: r.test.currentVersion + 1, updatedBy: this.me, updatedAt: now }, steps: clean, recordedOn: where };
      await this.put(`apps/${appId}/tests/${testId}.json`, this.testFile(next));
      return this.current(next);
    });
  }
  private patchTest(appId: string, testId: string, p: Partial<TestRec['test']>) {
    return this.write(async () => {
      const r = this.testRec(appId, testId);
      if (Object.entries(p).every(([k, v]) => (r.test as Record<string, unknown>)[k] === v)) return;
      await this.put(`apps/${appId}/tests/${testId}.json`, this.testFile({ ...r, test: { ...r.test, ...p, updatedBy: this.me, updatedAt: Date.now() } }));
    });
  }
  setTestStatus(appId: string, testId: string, status: TestStatus) { return this.patchTest(appId, testId, { status }); }
  /** Kept in the test's file, so it goes to Git with it; not an edit, so the file's updatedAt stays. */
  setFlakyMark(appId: string, testId: string, mark: FlakyMark | null) {
    return this.write(async () => {
      const r = this.testRec(appId, testId);
      const { flakyMark: _old, ...test } = r.test;
      await this.put(`apps/${appId}/tests/${testId}.json`, this.testFile({ ...r, test: { ...test, ...(mark ? { flakyMark: { ...mark } } : {}) } }));
    });
  }
  renameTest(appId: string, testId: string, name: string) { return this.patchTest(appId, testId, { name }); }
  /** Only the latest version is kept, so a new start address moves the version number on (like a save). */
  updateTestDetails(appId: string, testId: string, details: TestDetails) {
    return this.write(async (): Promise<Version | null> => {
      const r = this.testRec(appId, testId);
      const d = cleanDetails(details);
      const { moved, changed } = detailsDiff(r.test, d);
      if (!changed) return null;
      const bump = moved && r.test.currentVersion > 0;
      const next: TestRec = { ...r, test: { ...r.test, name: d.name, description: d.description, startUrl: d.startUrl,
        currentVersion: r.test.currentVersion + (bump ? 1 : 0), updatedBy: this.me, updatedAt: Date.now() } };
      await this.put(`apps/${appId}/tests/${testId}.json`, this.testFile(next));
      return bump ? this.current(next) : null;
    });
  }
  duplicateTest(appId: string, testId: string) {
    return this.write(async () => {
      const app = this.appRec(appId), src = this.testRec(appId, testId);
      const name = `${src.test.name} (copy)`;
      const id = uniqueSlug(`${src.test.name} copy`, x => app.tests.has(x));
      const now = Date.now();
      const rec: TestRec = { test: { ...src.test, name, status: 'draft', currentVersion: src.steps.length ? 1 : 0, createdBy: this.me, createdAt: now, updatedBy: this.me, updatedAt: now }, steps: clone(src.steps), recordedOn: src.recordedOn && clone(src.recordedOn) };
      await this.put(`apps/${appId}/tests/${id}.json`, this.testFile(rec));
      return this.testOut(appId, id, rec);
    });
  }
  /** Its last run goes along, and comes back with it. */
  deleteTest(appId: string, testId: string) {
    return this.write(async () => {
      const { test } = this.testRec(appId, testId);
      await this.toBin({ kind: 'test', id: testId, appId, name: test.name, createdBy: test.createdBy, status: test.status }, async entry => {
        for (const sub of ['tests', 'runs']) await this.moveFile(`apps/${appId}/${sub}/${testId}.json`, `${entry}/apps/${appId}/${sub}/${testId}.json`);
      });
    });
  }

  // ---- shared steps ----
  stepGroups(appId: string, l: Listener<StepGroup[]>) {
    return this.watch(() => {
      const a = this.model.apps.get(appId);
      return a ? [...a.groups].map(([id, r]) => this.groupOut(appId, id, r)).sort(byName) : [];
    }, l);
  }
  groupVersions(appId: string, groupId: string, l: Listener<Version[]>) {
    return this.watch(() => { const r = this.model.apps.get(appId)?.groups.get(groupId); return r ? [this.current(r)] : []; }, l);
  }
  async groupVersion(appId: string, groupId: string, n: number) {
    await this.chain;
    const r = this.model.apps.get(appId)?.groups.get(groupId);
    return r && n > 0 ? this.current(r) : null;
  }
  createGroup(appId: string, name: string, description: string, steps: Step[]) {
    return this.write(async () => {
      const app = this.appRec(appId);
      const id = uniqueSlug(name, x => app.groups.has(x));
      const now = Date.now();
      const rec: GroupRec = { group: { name, description: description || undefined, currentVersion: 1, createdBy: this.me, createdAt: now, updatedBy: this.me, updatedAt: now }, steps: cleanSteps(steps) };
      await this.put(`apps/${appId}/shared/${id}.json`, this.groupFile(rec));
      return { ...clone(rec.group), id, appId, stepCount: rec.steps.length, usedBy: [] };
    });
  }
  saveGroup(appId: string, groupId: string, steps: Step[]) {
    return this.write(async () => {
      const r = this.appRec(appId).groups.get(groupId);
      if (!r) throw new Error('Shared steps not found');
      const clean = cleanSteps(steps);
      if (toFileText(clean) === toFileText(r.steps)) return this.current(r);
      const next: GroupRec = { group: { ...r.group, currentVersion: r.group.currentVersion + 1, updatedBy: this.me, updatedAt: Date.now() }, steps: clean };
      await this.put(`apps/${appId}/shared/${groupId}.json`, this.groupFile(next));
      return this.current(next);
    });
  }

  deleteGroup(appId: string, groupId: string) {
    return this.write(async () => {
      const r = this.appRec(appId).groups.get(groupId);
      if (!r) throw new Error('Shared steps not found');
      await this.toBin({ kind: 'group', id: groupId, appId, name: r.group.name, createdBy: r.group.createdBy }, async entry => {
        await this.moveFile(`apps/${appId}/shared/${groupId}.json`, `${entry}/apps/${appId}/shared/${groupId}.json`);
      });
    });
  }

  // ---- recently deleted: deleted/<entry> ----
  /** Moves a file (relative paths), making the folders it goes into. Nothing there: nothing to do. */
  private async moveFile(from: string, to: string) {
    if (!(await this.st.exists(this.abs(from)))) return;
    const dir = this.abs(to).slice(0, this.abs(to).lastIndexOf('/'));
    if (!(await this.st.exists(dir))) await this.st.mkdir(dir);
    await this.st.rename(this.abs(from), this.abs(to));
    this.texts.delete(from);
  }
  /** Moves a folder with everything in it, file by file, then removes what's left of it. */
  private async moveDir(from: string, to: string) {
    for (const e of await this.st.list(this.abs(from))) {
      if (e.isDir) await this.moveDir(`${from}/${e.name}`, `${to}/${e.name}`);
      else await this.moveFile(`${from}/${e.name}`, `${to}/${e.name}`);
    }
    await this.drop(from);
  }
  /** Writes the entry's deleted.json, moves the item's files in with `move`, and reads the folder again. */
  private async toBin(item: Omit<DeletedItem, 'deletedAt' | 'deletedBy' | 'appName'>, move: (entry: string) => Promise<void>) {
    // Never two at the same time: an app restored under a new id tells its own deleted tests from
    // the next app's by when each was deleted (restoreRec).
    const at = Math.max(this.now(), this.lastBinAt + 1);
    this.lastBinAt = at;
    const name = `${stamp(at)}-${item.kind}-${item.appId ? `${item.appId}-` : ''}${item.id}`;
    const entry = `${DELETED_DIR}/${uniqueSlug(name, x => this.model.bin.has(x) || this.texts.has(`${DELETED_DIR}/${x}/deleted.json`))}`;
    await this.put(`${entry}/deleted.json`, { ...item, deletedAt: at, deletedBy: this.me });
    try { await move(entry); }
    finally { this.texts = await this.scan(); }
  }
  private lastBinAt = 0;
  /** The newest entry for this item. */
  private binRec(r: DeletedRef): BinRec {
    const found = [...this.model.bin.values()].filter(b => b.item.kind === r.kind && b.item.id === r.id && (b.item.appId ?? '') === (r.appId ?? ''))
      .sort((a, b) => b.item.deletedAt - a.item.deletedAt)[0];
    if (!found) throw new Error('This is no longer in Recently deleted.');
    return found;
  }
  /** Back where it was, under a new id when something else has taken its place since. */
  private async restoreRec(b: BinRec) {
    const { kind, id, appId, name } = b.item;
    const from = `${DELETED_DIR}/${b.entry}`;
    const app = appId ? this.model.apps.get(appId) : undefined;
    if (appId && !app) throw new Error('Its app was deleted. Restore the app first.');
    try {
      if (kind === 'app') {
        const to = uniqueSlug(id, x => this.model.apps.has(x) || this.texts.has(`apps/${x}/app.json`));
        await this.moveDir(`${from}/apps/${id}`, `apps/${to}`);
        // Under a new id: its own tests and shared steps in Recently deleted (deleted before it was)
        // go with it. The ones deleted later are the other app's, which has its id now.
        if (to !== id) {
          for (const x of [...this.model.bin.values()]) {
            if (x.item.appId !== id || x.item.deletedAt > b.item.deletedAt) continue;
            const dir = `${DELETED_DIR}/${x.entry}`;
            await this.put(`${dir}/deleted.json`, { ...x.item, appId: to });
            if (await this.st.exists(this.abs(`${dir}/apps/${id}`))) await this.moveDir(`${dir}/apps/${id}`, `${dir}/apps/${to}`);
          }
        }
      } else if (kind === 'test') {
        const to = app!.tests.has(id) ? uniqueSlug(name, x => app!.tests.has(x) || app!.runs.has(x)) : id;
        for (const sub of ['tests', 'runs']) await this.moveFile(`${from}/apps/${appId}/${sub}/${id}.json`, `apps/${appId}/${sub}/${to}.json`);
      } else if (kind === 'group') {
        const to = app!.groups.has(id) ? uniqueSlug(name, x => app!.groups.has(x)) : id;
        await this.moveFile(`${from}/apps/${appId}/shared/${id}.json`, `apps/${appId}/shared/${to}.json`);
      } else {
        const to = this.model.suites.has(id) ? uniqueSlug(name, x => this.model.suites.has(x)) : id;
        await this.moveFile(`${from}/suites/${id}.json`, `suites/${to}.json`);
        // Its result address, kept with the entry (deleteSuite). An entry from before that has it
        // under the suite's id still, which is right only while the id is its own again.
        if (this.addresses) {
          const kept = binAddressKey(b.entry);
          const url = await this.addresses.get(this.connectionId, kept).catch(() => null);
          if (url) {
            await this.addresses.set(this.connectionId, to, url);
            await this.addresses.set(this.connectionId, kept, null).catch(() => {});
          }
        }
      }
      await this.drop(from);
    } finally { this.texts = await this.scan(); }
  }
  /** Deletes the entry with everything in it, and a suite's result address with it (unless a suite of that id is back). */
  private async purgeRec(b: BinRec) {
    await this.drop(`${DELETED_DIR}/${b.entry}`);
    // An app's own deleted tests and shared steps go with it.
    if (b.item.kind === 'app') for (const x of this.model.bin.values()) if (x.item.appId === b.item.id && !this.model.apps.has(b.item.id)) await this.drop(`${DELETED_DIR}/${x.entry}`);
    if (b.item.kind === 'suite' && this.addresses) {
      await this.addresses.set(this.connectionId, binAddressKey(b.entry), null).catch(() => {});
      // An entry from before the address went with it: under the suite's id, unless a suite has it now.
      if (!this.model.suites.has(b.item.id)) await this.addresses.set(this.connectionId, b.item.id, null).catch(() => {});
    }
  }
  /** Deletes for good what has been in Recently deleted for KEEP_DELETED_DAYS (when the folder is opened). */
  emptyBin(): Promise<number> {
    if (this.readOnly) return Promise.resolve(0);
    return this.write(async () => {
      const old = [...this.model.bin.values()].filter(b => b.item.deletedAt + KEEP_DELETED_MS <= this.now());
      for (const b of old) await this.purgeRec(b);
      return old.length;
    });
  }
  readonly recentlyDeleted: RecentlyDeleted = {
    items: (l, appId) => this.watch((): DeletedItem[] => [...this.model.bin.values()].map(b => b.item)
      .filter(i => (appId ? i.appId === appId : true) && (!i.appId || this.model.apps.has(i.appId)))
      .map(i => (i.appId ? { ...i, appName: this.model.apps.get(i.appId)!.app.name } : { ...i }))
      .sort(newestDeletedFirst), l),
    restore: r => this.write(async () => { await this.restoreRec(this.binRec(r)); }),
    deleteNow: r => this.write(async () => { await this.purgeRec(this.binRec(r)); }),
  };

  // ---- runs: the last one per test ----
  runs(appId: string, l: Listener<Run[]>, limit?: Limit) {
    return this.watch(() => {
      const a = this.model.apps.get(appId);
      return a ? upTo([...a.runs].map(([t, r]) => this.runOut(appId, t, r)).sort((x, y) => y.startedAt - x.startedAt), limit) : [];
    }, l);
  }
  testRuns(appId: string, testId: string, l: Listener<Run[]>) {
    return this.watch(() => { const r = this.model.apps.get(appId)?.runs.get(testId); return r ? [this.runOut(appId, testId, r)] : []; }, l);
  }
  async run(appId: string, runId: string) {
    await this.chain;
    for (const [t, r] of this.model.apps.get(appId)?.runs ?? []) if (r.id === runId) return this.runOut(appId, t, r);
    return null;
  }
  addRun(r: Omit<Run, 'id'>) {
    return this.write(async () => {
      this.appRec(r.appId);
      const { appId, testId, ...rest } = r;
      const rec: RunRec = { ...rest, id: `${testId}-${stamp(r.startedAt)}` };
      await this.put(`apps/${appId}/runs/${testId}.json`, rec);
      return this.runOut(appId, testId, rec);
    });
  }

  // ---- suites ----
  suites(l: Listener<Suite[]>) {
    return this.watch(() => [...this.model.suites.values()].map(s => clone({ ...s, lastRun: this.suiteLast.get(s.id) })).sort(byName), l);
  }
  saveSuite(id: string | null, n: NewSuite) {
    return this.write(async () => {
      const now = Date.now();
      const old = id ? this.model.suites.get(id) : undefined;
      if (id && !old) throw new Error('Suite not found');
      const sid = id ?? uniqueSlug(n.name, x => this.model.suites.has(x));
      const rel = `suites/${sid}.json`;
      // Schedule and where the result goes: the Team edition's Solo plan on this Mac. The address
      // itself goes in the edition's address store (the Keychain), never in the folder.
      const schedule = scheduleIn(n.schedule);
      const notify = n.notify === null ? undefined : n.notify ? notifyIn(n.notify) : old?.notify;
      if (this.addresses && n.notify !== undefined && (n.notify === null || n.notify.url)) await this.addresses.set(this.connectionId, sid, n.notify?.url ?? null);
      const retries = n.retries !== undefined ? retriesIn(n.retries) : old?.retries;
      const file = { name: n.name, tests: n.tests.map(t => ({ appId: t.appId, testId: t.testId })), ...(schedule ? { schedule } : {}), ...(notify ? { notify } : {}), ...(retries !== undefined ? { retries } : {}), resultUrl: n.resultUrl || undefined, createdBy: old?.createdBy ?? this.me, createdAt: old?.createdAt ?? now };
      // Saved again unchanged: keep the file (and its updatedAt) as it is.
      const same = !!old && this.texts.get(rel) === toFileText({ ...file, updatedBy: old.updatedBy, updatedAt: old.updatedAt });
      const stamped = same ? { ...file, updatedBy: old!.updatedBy, updatedAt: old!.updatedAt } : { ...file, updatedBy: this.me, updatedAt: now };
      if (!same) await this.put(rel, stamped);
      return clone({ ...stamped, id: sid, schedule, lastRun: this.suiteLast.get(sid) });
    });
  }
  /**
   * Its result address stays in the Keychain until it's deleted for good, kept with its entry in
   * Recently deleted rather than under its id: a new suite of the same name gets the id and none
   * of the address, and restoring puts the address back on the suite it belonged to.
   */
  deleteSuite(id: string) {
    return this.write(async () => {
      const s = this.model.suites.get(id);
      if (!s) throw new Error('Suite not found');
      await this.toBin({ kind: 'suite', id, name: s.name, createdBy: s.createdBy }, async entry => {
        await this.moveFile(`suites/${id}.json`, `${entry}/suites/${id}.json`);
        if (!this.addresses) return;
        const url = await this.addresses.get(this.connectionId, id).catch(() => null);
        if (!url) return;
        try {
          await this.addresses.set(this.connectionId, binAddressKey(entry.slice(DELETED_DIR.length + 1)), url);
          await this.addresses.set(this.connectionId, id, null);
        } catch { /* kept under its id, as before: a restore with the same id still finds it */ }
      });
      this.suiteLast.delete(id);
    });
  }
  /** Where a suite's result goes: its address, from this Mac's Keychain (the folder never holds it). */
  readonly notify: NotifyStore = { address: async suiteId => (this.addresses ? this.addresses.get(this.connectionId, suiteId) : null) };
  /** This folder's connection id (state/connectionIds.ts), which names its Keychain entries. */
  private get connectionId() { return folderConnectionId(this.root); }
  /** No suite run history in Community: the result shows on the suite until the app closes. */
  async addSuiteRun(r: Omit<SuiteRun, 'id'>): Promise<SuiteRun> {
    this.suiteLast.set(r.suiteId, { result: r.result, at: r.startedAt, by: r.requestedBy });
    this.emit();
    return { ...r, id: `${r.suiteId}-${stamp(r.startedAt)}` };
  }

  // ---- Team only: runner, queue, run requests, members ----
  runner(l: Listener<RunnerStatus | null>) { queueMicrotask(() => l(null)); return () => {}; }
  queue(l: Listener<QueueItem[]>) { queueMicrotask(() => l([])); return () => {}; }
  suiteRuns(l: Listener<SuiteRun[]>) { queueMicrotask(() => l([])); return () => {}; }
  runRequests(l: Listener<RunRequest[]>) { queueMicrotask(() => l([])); return () => {}; }
  members(l: Listener<Member[]>) { queueMicrotask(() => l([])); return () => {}; }
  async requestSuiteRun(): Promise<void> { throw new Error(osText(NOT_HERE)); }
  async removeFromQueue(): Promise<void> { throw new Error(osText(NOT_HERE)); }
  async claimRunRequest(): Promise<QueueItem> { throw new Error(osText(NOT_HERE)); }
  async addToQueue(): Promise<QueueItem> { throw new Error(osText(NOT_HERE)); }
  async heartbeat(): Promise<void> { throw new Error(osText(NOT_HERE)); }
  async setRole(): Promise<void> { throw new Error(osText('Community has no members: it is one person on one Mac.')); }
  async removeMember(): Promise<void> { throw new Error(osText('Community has no members: it is one person on one Mac.')); }
}
