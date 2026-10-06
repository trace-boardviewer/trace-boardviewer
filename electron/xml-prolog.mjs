// Root element of an XML text, derived without expanding anything: the optional XML declaration,
// processing instructions, comments and the DOCTYPE may precede it. A DOCTYPE whose internal subset
// declares an ENTITY (or cannot be inspected completely) is unsafe: entity expansion is never performed
// and every caller refuses such a document. An external DTD reference is only text here and is never fetched.
//
// One implementation serves the native document sniffer (electron/documents.cjs, through require) and the
// renderer sniffers (src/lib/images.ts, src/app/sniff.ts), so a file that the native side attaches is never
// refused by a viewer for the shape of its prolog. The module is plain ESM with no imports: the main process
// loads it with require(), the renderer bundles it.
//
// Returns { root } | { unsafe: true } | null.
export function xmlRoot(text) {
  let at = 0;
  const space = (code) => code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
  for (;;) {
    while (at < text.length && space(text.charCodeAt(at))) at++;
    if (text[at] !== '<') return null;
    if (text.startsWith('<?', at)) {
      const end = text.indexOf('?>', at + 2);
      if (end < 0) return null;
      at = end + 2;
    } else if (text.startsWith('<!--', at)) {
      const end = text.indexOf('-->', at + 4);
      if (end < 0) return null;
      at = end + 3;
    } else if (text.startsWith('<!DOCTYPE', at)) {
      let quote = '';
      let depth = 0;
      let subset = '';
      let index = at + 9;
      for (; index < text.length; index++) {
        const character = text[index];
        if (quote) { if (character === quote) quote = ''; else if (depth > 0) subset += character; continue; }
        if (character === '"' || character === "'") { quote = character; continue; }
        if (character === '[') { depth++; continue; }
        if (character === ']') { depth = Math.max(0, depth - 1); continue; }
        if (character === '>' && depth === 0) break;
        if (depth > 0) subset += character;
      }
      if (index >= text.length || subset.includes('<!ENTITY')) return { unsafe: true };
      at = index + 1;
    } else {
      const match = /^<([A-Za-z_][A-Za-z0-9_.:-]*)/.exec(text.slice(at, at + 256));
      return match ? { root: match[1] } : null;
    }
  }
}
