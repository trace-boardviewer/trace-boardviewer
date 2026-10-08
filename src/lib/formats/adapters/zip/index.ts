import { defineContainerAdapter, NO_MATCH, sniffed } from '../../adapter';
import { MAX_IMPORT_BYTES } from '../../common';
import { extensionOf, startsWith } from '../../sniff';
import { readZip } from '../../zip';

const LIMITS = Object.freeze({ maxArchiveBytes: MAX_IMPORT_BYTES, maxEntries: 4096, maxExtractedBytes: MAX_IMPORT_BYTES, maxRatio: 250, maxCandidates: 64 });

export default defineContainerAdapter({
  capability: {
    id: 'zip', name: 'ZIP archive (a board with its companion files)', extensions: ['.zip'], variants: ['stored and deflated entries (methods 0 and 8), ZIP64 sizes; UTF-8 or code page 437 names'], status: 'draft', validation: 'synthetic-fixtures',
    notes: [
      'The board is chosen by content: every entry with a board extension is sniffed, and the one board the archive holds is opened; companion files (the ASC trio) are taken from the same folder of the archive. An archive that holds several boards is refused with their names, so that no board is guessed.',
      'Limits: 64 MiB for the archive and 64 MiB unpacked for the board plus its companions, 4,096 entries, at most 64 entries with a board extension, and an expansion of at most 250:1 for entries above 1 MiB; every entry must match its declared size and CRC-32. Archives inside the archive are not opened.',
      'Encrypted entries, compression methods other than stored and deflate, and split archives are refused with a precise message. Names that would leave the archive folder (absolute paths, drive letters, "..") and operating-system metadata (__MACOSX, ._ files) are ignored. Nothing is written to disk.',
      'Notes and the workspace belong to the archive file: the same board opened unpacked is a different file.',
      'Proven on archives written by the fflate library and on hand-built damaged, encrypted, oversized and bomb archives; archives written by other tools follow the same specification.',
    ],
  },
  listOrder: 1000,
  family: 'Archive',
  detection: 'signature',
  limits: LIMITS,
  // LIKELY at most: a board format that is itself a ZIP (a project or job archive) outranks it with its own sniff, and a
  // file of another name that merely starts like a ZIP (an FZ container is random bytes) stays with the reader of its name.
  sniff(input) {
    const zip = startsWith(input.head, [0x50, 0x4b, 0x03, 0x04]) ? 'ZIP local file header' : startsWith(input.head, [0x50, 0x4b, 0x05, 0x06]) ? 'empty ZIP archive' : '';
    if (!zip) return NO_MATCH;
    const length = input.head.length >= 30 && zip.startsWith('ZIP local') ? input.head[26] | input.head[27] << 8 : 0;
    const first = length && input.head.length >= 30 + length ? new TextDecoder().decode(input.head.subarray(30, 30 + Math.min(length, 120))) : '';
    const meta = first ? { meta: { firstEntry: first } } : {};
    return extensionOf(input.name) === '.zip' ? sniffed(60, zip, meta) : sniffed(30, `${zip} in a file not named .zip`, meta);
  },
  open: data => readZip(data, LIMITS),
});
