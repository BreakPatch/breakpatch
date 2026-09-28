// Web origins ("sites") for saved secrets and set-up calls. Same rules as the engine
// (engine/src/breakpatch_engine/sites.py) and the shell (src-tauri/src/secrets.rs normalize_origin):
// scheme://host[:port], lower case, default port left out, http(s) only.

/** `https://app.example.com` for any http(s) address on that site, else null. */
export function originOf(address: string | null | undefined): string | null {
  const text = (address ?? '').trim();
  if (!/^https?:\/\//i.test(text)) return null;
  try {
    const u = new URL(text);
    if (!u.hostname) return null;
    const host = u.hostname.replace(/\.$/, '').toLowerCase();
    return `${u.protocol}//${host}${u.port ? ':' + u.port : ''}`;
  } catch { return null; }
}

/** How a site reads in a sentence: `app.example.com`, `localhost:3000`. */
export function siteName(origin: string): string {
  return origin.replace(/^https?:\/\//, '');
}

/** The site a person typed, allowing a bare host (`app.example.com` → https). */
export function parseSite(typed: string): string | null {
  const t = typed.trim();
  if (!t) return null;
  return originOf(/^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : 'https://' + t);
}
