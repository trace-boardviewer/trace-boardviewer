import { defineBoardAdapter, NO_MATCH, sniffed } from '../../adapter';
import { asciiPrefix } from '../../common';
import { CONTENT_SIGNATURE, hasFzDefaultKeyHeader, hasFzWrappedHeader, hasFzZlibHeader, looksLikeText, parseFz } from '../../fz';
import { fzHook } from '../../../diagnostics/hooks-binary';

const NAME = /\.(fz|cae)$/i;

export default defineBoardAdapter({
  capability: {
    id: 'fz', name: 'FZ / CAE boardview', extensions: ['.fz', '.cae'], variants: ['ASUS FZ (RC6 feedback, published default key)', 'ASRock CAE (RC6 feedback, published default key)', 'unencrypted zlib container (length- or footer-framed)', 'decoded A!/S! text'], status: 'supported', validation: 'real-files', electrical: 'nets', geometry: 'mixed',
    units: 'mil (×0.0254); UNIT:millimeters ×1; any other UNIT value is read as thou with a disclosed note', sides: 'REFDES mirror YES is bottom, otherwise top; test vias T is top, otherwise bottom',
    notes: ['ASUS FZ and ASRock CAE automatically try their respective published 44-word keys; an explicit user session key overrides the default. Other key variants can use the session key dialog. Plain zlib containers and decoded text need no key.', 'Recognized by extension plus structure (encrypted data has no magic). Fixed-offset zlib headers, complete framing, declared decompressed lengths where present and both checksums validate before import. CAE uses framing/checksum validation rather than ASUS parity restrictions.', 'The RADIUS column is used as the pad radius when present (unverified); graphics blocks are ignored and no outline is read. Component bodies are estimated from pins.', 'Automatic import was checked by the maintainer on real encrypted FZ and CAE exports. No vendor file is redistributed; exact geometry has not been compared with a reference viewer.', 'A REFDES without pins is omitted with a note; a repeated REFDES is rejected, where OpenBoardView lets the later one take over the name.'],
  },
  listOrder: 80,
  family: 'Boardview',
  // Encrypted content carries no magic number, so the extension selects the reader (as upstream); decoded A!/S! text is checked by content.
  detection: 'name',
  keys: ['fz'],
  sniff(input) {
    const extension = NAME.exec(input.name)?.[1].toLowerCase();
    if (!extension) return NO_MATCH;
    if (hasFzWrappedHeader(input.head)) return sniffed(80, '.fz/.cae compressed outer envelope');
    if (CONTENT_SIGNATURE.test(asciiPrefix(input.head, 64))) return sniffed(70, '.fz/.cae file holding decoded A!/UNIT: records', { meta: { encrypted: false } });
    if (hasFzZlibHeader(input.head)) return sniffed(70, '.fz/.cae file with a plaintext zlib stream at byte 4', { meta: { encrypted: false } });
    if (looksLikeText(input.head)) return NO_MATCH; // any other text belongs to another format
    if (hasFzDefaultKeyHeader(input.head, extension === 'cae' ? 'cae' : 'fz')) return sniffed(70, '.fz/.cae file whose published default key yields the fixed-offset zlib header', { meta: { encrypted: true, automaticKey: true } });
    return sniffed(40, 'binary .fz/.cae file without a plaintext signature (encrypted data has no magic number)', { needsKey: 'fz', meta: { encrypted: true } });
  },
  structure: fzHook,
  parse: parseFz,
});
