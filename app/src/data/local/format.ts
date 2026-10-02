// How the local backend writes its files so they sit well in Git: 2-space JSON, a fixed key
// order whatever order the object was built in, short arrays of numbers on one line, times
// as ISO strings and a newline at the end. Same data in → same bytes out.

export const FORMAT = 'breakpatch';
/** The folder format this app reads and writes. A higher number in breakpatch.json is from a newer app. */
export const SCHEMA_VERSION = 1;

/** Keys that come first, in this order; then the rest alphabetically; then LAST. */
const FIRST = [
  'format', 'schemaVersion', 'id', 'action', 'name', 'label', 'description', 'target', 'text',
  'baseUrl', 'startUrl', 'url', 'method', 'icon', 'status', 'version', 'result',
  'viewport', 'defaultViewport', 'width', 'height', 'dpr',
];
const LAST = ['setUp', 'cleanUp', 'createdBy', 'createdAt', 'updatedBy', 'updatedAt', 'savedBy', 'savedAt', 'tests', 'steps'];

/** Times are kept as numbers in the app and written as ISO strings. */
const TIME_KEYS = new Set(['createdAt', 'updatedAt', 'savedAt', 'startedAt', 'finishedAt', 'at', 'queuedAt', 'lastSeen', 'deletedAt']);

function rank(k: string): [number, string] {
  const f = FIRST.indexOf(k); if (f >= 0) return [f, ''];
  const l = LAST.indexOf(k); if (l >= 0) return [2000 + l, ''];
  return [1000, k];
}
function byRank(a: string, b: string) {
  const [ra, sa] = rank(a), [rb, sb] = rank(b);
  return ra - rb || (sa < sb ? -1 : sa > sb ? 1 : 0);
}

const isPrim = (v: unknown) => v === null || ['string', 'number', 'boolean'].includes(typeof v);

function write(v: unknown, indent: string, key?: string): string | undefined {
  if (v === undefined || typeof v === 'function') return undefined;
  if (key && TIME_KEYS.has(key) && typeof v === 'number' && Number.isFinite(v)) return JSON.stringify(new Date(v).toISOString());
  if (isPrim(v)) return JSON.stringify(v);
  const inner = indent + '  ';
  if (Array.isArray(v)) {
    if (v.length === 0) return '[]';
    if (v.every(x => typeof x === 'number')) return `[${v.map(x => JSON.stringify(x)).join(', ')}]`;
    return `[\n${v.map(x => inner + (write(x, inner) ?? 'null')).join(',\n')}\n${indent}]`;
  }
  const o = v as Record<string, unknown>;
  const parts = Object.keys(o).sort(byRank).flatMap(k => {
    const s = write(o[k], inner, k);
    return s === undefined ? [] : [`${inner}${JSON.stringify(k)}: ${s}`];
  });
  return parts.length ? `{\n${parts.join(',\n')}\n${indent}}` : '{}';
}

/** The file text for a value. */
export function toFileText(v: unknown): string {
  return (write(v, '') ?? 'null') + '\n';
}

/** Parses a file, turning ISO times back into millis. Throws on invalid JSON. */
export function fromFileText<T = unknown>(text: string): T {
  return JSON.parse(text, function (k, v) {
    if (TIME_KEYS.has(k) && typeof v === 'string') { const t = Date.parse(v); return Number.isNaN(t) ? v : t; }
    return v;
  }) as T;
}

/** A readable id from a name: "Log in and out" → "log-in-and-out". */
export function slugify(s: string): string {
  return s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '') || 'untitled';
}

/** The slug, or slug-2, slug-3… when it's taken. */
export function uniqueSlug(name: string, taken: (id: string) => boolean): string {
  const base = slugify(name);
  if (!taken(base)) return base;
  for (let i = 2; ; i++) if (!taken(`${base}-${i}`)) return `${base}-${i}`;
}
