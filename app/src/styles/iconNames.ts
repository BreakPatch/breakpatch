// Finds the Material Symbols names that code spells out where an icon is expected. Used by
// fonts.test.ts (the app, with the Team module) and by the back office's own icon test, since both
// use the icon font subset to assets/fonts/icons.json.

const WORD = /['"`]([a-z][a-z0-9_]*)['"`]/g;

/** The JSX expression starting at code[i] === '{', up to its matching brace. */
function braced(code: string, i: number): string {
  let depth = 0;
  for (let j = i; j < code.length; j++) {
    if (code[j] === '{') depth++;
    else if (code[j] === '}' && --depth === 0) return code.slice(i, j + 1);
  }
  return '';
}

/** Icon names the code spells out where an icon is expected. */
export function iconsNamed(code: string): string[] {
  const found: string[] = [];
  // Literals compared against (status === 'paused' ? …) are conditions, not icons.
  const words = (s: string) => { for (const m of s.replace(/(?:[!=]==?)\s*(['"`])[^'"`]*\1|(['"`])[^'"`]*\2\s*[!=]==?/g, '').matchAll(WORD)) found.push(m[1]); };
  // name= on <Icon>, and icon= / iconAfter= / leadIcon= on any component: a quoted name, or a braced expression of quoted names
  const attrs = /<Icon\b[^>]*?\bname=|\b(?:icon|iconAfter|leadIcon)=/g;
  for (const m of code.matchAll(attrs)) {
    const at = m.index + m[0].length;
    if (code[at] === '"') found.push(...(/^"([a-z][a-z0-9_]*)"/.exec(code.slice(at))?.slice(1) ?? []));
    else if (code[at] === '{') words(braced(code, at));
  }
  // icon: followed by a quoted name, in data and lookup tables
  for (const m of code.matchAll(/\bicon\??:\s*(['"`][a-z][a-z0-9_]*['"`])/g)) words(m[1]);
  // a span with className icon, the name as its text
  for (const m of code.matchAll(/className="icon[^"]*">([a-z][a-z0-9_]*)</g)) found.push(m[1]);
  return found;
}
