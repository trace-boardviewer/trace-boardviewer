# Adding a board format reader

Every board format TRACE knows is one folder under `src/lib/formats/adapters/<id>/`. The registry
(`src/lib/formats/registry.ts`) discovers the folders at build time, and everything else is derived from them:
the dispatcher's candidate list, `FORMAT_CAPABILITIES`, the extensions the renderer and the native side accept
(`electron/formats.json`), the open-dialog families, the companion-file rules and the support table in
`docs/SUPPORT.md`. Adding a reader therefore touches no shared list.

Readers are compiled into the application. There are no runtime plugins: code loaded from outside `app.asar` would
bypass the integrity checks, and a reader runs in the renderer, where it sees every file the user opens.

## 1. The folder

```
src/lib/formats/adapters/<id>/
  index.ts       default export: defineBoardAdapter({...})   (required)
  fixtures.ts    default export: AdapterFixture[]             (required unless detection is 'none')
  *.ts           the reader itself, if it is not in src/lib/formats/<name>.ts already
  *.test.ts      the reader's own tests (any name ending in .test.ts)
```

`<id>` is lowercase with dashes, equals `capability.id`, and is stable: it appears in the support table, in
diagnostics and in corpus manifests. A recognizer that is replaced by a real reader keeps its id (for example
`ipc2581`, `odbpp`): replace the folder's `index.ts`, do not add a second folder.

## 2. The contract (`src/lib/formats/adapter.ts`)

```ts
export default defineBoardAdapter({
  capability: { id, name, extensions, variants, status, validation, electrical, geometry, units, sides, requires?, notes, openTool? },
  evidence?,          // real-file overlay for the support table (validation lanes only)
  listOrder: 300,     // position in the support table and extension lists; never affects detection
  family: 'ECAD design',               // open-dialog family: 'GenCAD' | 'Boardview' | 'ECAD design' | 'Gerber' | 'Archive'
  detection: 'signature',              // 'signature' | 'structure' | 'name' | 'none'
  limits?: { maxInputBytes, maxTotalBytes, maxComponents, maxPins },  // defaults: 64 MiB, 64 MiB, 250,000, 1,000,000
  companions?: { sets: [['format.asc', 'pins.asc', 'nails.asc']] },
  keys?: ['fz'],                       // key kinds the reader may request
  structure?: hook,                    // optional layout hook of the diagnostic report (section 10)
  sniff(input) { ... },                // { head, name, size } -> { confidence, reason, variant?, needsKey? }
  parse(input, context) { ... },       // Board | null, or a promise of one
});
```

Companion sets declare fixed, case-insensitive basenames. The native opener gathers only those siblings in the
same directory, checks their combined byte budget before reading, and gives every entry role the same board key.
An extensionless member is openable only when its exact basename belongs to a declared set. The normal file chooser
adds its localized all-files filter for these sets; arbitrary extensionless files remain outside normal board opening.
Sets may share pin files while supplying alternative outlines. Discovery returns the union of possible siblings;
selection uses the set with the most available fixed names, with declaration order breaking ties. Only that selected
set is read, budgeted and hashed. Explicit outline entries keep their own set. ZIP import applies the same selection
within each folder; two separately supplied outlines remain an ambiguous choice.

**sniff** sees at most the first 64 KiB of the file (`SNIFF_BYTES`, after UTF-16 files were re-encoded as UTF-8),
the file name and the full size. It must be total (never throws), bounded (no allocation in proportion to the file,
linear time) and side-effect free. It returns a confidence and a short English reason:

| Confidence | Meaning | Built-in examples |
| --- | --- | --- |
| 90–100 (`CERTAIN`) | the format's own signature at its fixed place: magic number at an offset, root element, first record, mandatory header line | KiCad root 100, EAGLE root 100, XZZ magic 100, CST 100, BVR header on line 1 100, Altium ASCII 95, GenCAD `$HEADER` 90, OLE compound file under an Altium PCB name 90 |
| 50–89 (`LIKELY`) | markers anywhere in the head, or a known file name plus matching content | Samsung markers 85, BDV markers 84, BVR header further down 83, BRDOUT 82, Landrex lines 81, decoded FZ text 70, ASC trio name 50 |
| 1–49 (`POSSIBLE`) | the name alone, a weak recognizer, or markers that may lie beyond the 64 KiB window | Gerber 48, Mentor 45, encrypted FZ 40, gzip (ODB++) 35, OLE compound file under another name 30, EAGLE schematic 20, KiCad/EAGLE open prologue 12/11, markers beyond the window 6–9 |
| 0 | not this format: the parse is never called | |

A sniff must never miss a file its parse would claim: when the deciding bytes may lie beyond the window, return a
POSSIBLE confidence and let the parse decide. A text reader does so only for a head that can still be text
(`mayContinueAsText` in `src/lib/formats/sniff.ts`: the head ends before the file and has no NUL byte in its first KiB), so
that random binary data of a large file is claimed by no reader. Inside a tier, more specific evidence gets the higher
number; pick a value that does not tie with an adapter your files can overlap with.

**parse** receives the whole file (`ParseInput`: name, bytes, companions, session keys) and a `ParseContext`:
`signal` (cancellation; check it between phases of long work), `limits` (check them before allocating),
`progress(fraction)` and `requestKey(kind)` (resolves with the session key, or rejects with `KEY_REQUIRED`, which
makes the UI ask and re-run the import; keys are session-only and are never stored, logged or reported). It returns
the board in canonical form (mm, Y up, sides `top`/`bottom`/`both`, every pin on an existing component, every net
pin an existing pin), or `null` when the full file turns out not to be its format. A recognized but malformed file
throws `BoardFormatError` with a stable code (`INVALID_FORMAT`, `LIMIT_EXCEEDED`, `UNSUPPORTED_VARIANT`,
`KEY_REQUIRED`, `INVALID_KEY`, `COMPANIONS_REQUIRED`, `WRONG_KIND`); a family that is recognized but not readable
throws `UNSUPPORTED_VARIANT` with its id as `format`. Any other exception is a bug: the dispatcher wraps it as
`<id>: unexpected parser failure`. User-visible failure texts that need translation go into all eight catalogs
(`electron/locales/*.json`, key `parse.error.<name>`) and travel as `BoardFormatError.issue`.

**Status** (`capability.status` / `validation`, enforced by `registry.test.ts`): `supported` / `real-files` (files
written by the vendor's own software were validated), `open-tool-validated` / `open-tool-files` (files that open
tools wrote from open designs were validated; `openTool` names the tool and the designs), `draft` /
`synthetic-fixtures` (original synthetic fixtures only), `recognized-unsupported` / `none`, `extension-only` /
`none`. A status moves only with the tests and the evidence that justify it.

## 3. How a file is dispatched (`src/lib/formats/dispatch.ts`)

1. Size guard; UTF-16 with a byte-order mark is re-encoded as UTF-8.
2. Every adapter sniffs the head. Candidates are ranked by confidence, then by whether they own the file's
   extension, then by id. Registration order and `listOrder` play no part.
3. Two board adapters at `CERTAIN` or above: the file is refused with `AMBIGUOUS_FORMAT`, naming both formats.
4. Candidates are parsed strongest first; the first board wins, `null` falls through to the next candidate, a
   format error ends the import. Byte budgets are checked before a parse, record budgets on its result.
5. A container candidate (ZIP) is opened instead of parsed (section 4).

`parseBoard` (synchronous, used by the board worker) and `parseBoardAsync` (progress, cancellation, asynchronous
readers) share one core. `detectFormat` returns the ranking without parsing anything.

## 4. Archives

A container adapter (`defineContainerAdapter`, today only `adapters/zip/`) lists the members of an archive; it never
parses a board. When a container is the strongest candidate, the dispatcher sniffs every member with a board extension
(only a bounded head of each is inflated), takes the members some reader is at least LIKELY about as the boards (all
recognized members when there are none), treats one companion set in one folder as one board, refuses an archive with
more than one board (`parse.error.archiveSeveralBoards`, listing them), unpacks the chosen member and its companions
within the container's budgets (64 MiB unpacked, 4,096 entries, at most 64 board-like entries, 250:1 expansion for
entries above 1 MiB, size and CRC-32 checked) and dispatches it like a file of its own. Archives inside archives are not
opened, unsafe names and `__MACOSX` metadata are ignored, and nothing is written to disk.

A format that is itself an archive (an ODB++ job or an EasyEDA Pro project in a ZIP) is a board adapter, not a
container: its sniff recognizes the archive by its first member names (the local header at offset 0 carries the first
name) and returns more than the ZIP container's 60, so it receives the whole archive. It can list and read the members
with `readZip` from `src/lib/formats/zip.ts`, which applies the same bounded inflate.

## 5. Sniff-only identification (`sniffBoard`)

`sniffBoard(head, name, size)` (exported from `src/lib/formats`) runs only the sniffs on the first bytes of a file: no
parse, no unpack, no side effects, linear in the head. It is meant for listings and background scans of large folders:
read at most `SNIFF_BYTES` (64 KiB) of each file, pass the full size so the sniffs know whether the file continues, and
call it in a worker (the sniffs are parser code; like the readers they stay out of the main process). It returns plain
frozen data that can cross a worker boundary: `best` (what the dispatcher would try first), every `candidate` (id,
kind, format name, support status, confidence, reason, `variant`, `needsKey`) and `ambiguous` (two readers certain,
so opening would be refused). The verdict is a sniff: the full parse may still decline the file.

`meta` carries a few facts a head states outright, at most 8 camelCase keys with short values: KiCad `fileVersion` and
`generator`, GenCAD `version` and `units`, EAGLE `version`, BVR `version`, Altium `storage`, XZZ `obfuscated`, FZ
`encrypted`, BRD `encoded`, Allegro `version`, IPC-2581 `revision`, Gerber `units`, ZIP `firstEntry`. A new adapter may
add its own (`sniffed(confidence, reason, { meta: { ... } })`); keep them cheap, bounded and free of personal data.

## 6. Extension collisions

`.brd` has four owners (Landrex/TestLink, TOPTEST BRD2, EAGLE, Allegro), `.cad` two (GenCAD, Samsung), `.bvr` two
(BVRAW_FORMAT_3, BVRAW_FORMAT_1). An extension may be shared only if every owner detects by content: at most one owner
of an extension may use `detection: 'name'`, and every owner needs fixtures. `registry.test.ts` fails otherwise, and it
also runs the claim-collision matrix: every fixture of every adapter must be read by its own adapter, with no other
adapter certain about it, under any registration order, and no sniff may say 0 for a file its reader claims. Known
overlaps between formats (a GenCAD `$TEXT` section that mentions Samsung markers, a KiCad file with a `BRDOUT:` line, …)
have a pinned verdict in the same test; add yours there when your files can carry another format's markers.

## 7. Parsing rules

- Linear time in the file size. Never use `^\s*` with the `m` flag (it crosses line breaks; use `[ \t]*`), never
  nest quantifiers that can split the same text in two ways, and prefer `indexOf` scans and hand-written tokenizers
  to regular expressions over the whole file. Add a timing test for every pattern you fixed.
- Check record counts and expansion budgets before allocating (preflight), not after.
- Decode text with `decodeText` (UTF-8 when the whole file is valid UTF-8, otherwise windows-1252) so the reader and
  its sniff agree; sniff helpers in `src/lib/formats/sniff.ts` (`ruleHolds`, `completeLines`, `indexOfBytes`) give
  the same readings on the head.
- No `eval`, no network, no DOM, no file access: a reader gets bytes and returns a board.
- Units mm, Y up; disclose every approximation and every skipped record as a warning (`board.warnings`).

## 8. Fixtures and evidence

- `fixtures.ts` exports original synthetic samples (`AdapterFixture`: label, file name with the adapter's extension,
  bytes, optional companions and keys, `expect: 'refused'` for recognized-unsupported families). They are written by
  hand or generated in code from the public format description. The same samples seed the parser fuzzer
  (`tests/fuzz`, docs/FUZZING.md), which feeds the new adapter's parse and sniff mutated and cut versions of them with no
  change to the harness.
- Never commit a vendor, customer, leaked or downloaded board, or bytes copied out of one, and never name such a file
  or its location. Real-file validation runs in a separate lane on lawfully obtained samples; its result enters the
  repository only as an `evidence` record (counts, measured agreement, what was not covered).
- GPL, LGPL and AGPL readers may serve as behaviour references only; nothing is copied or transliterated.

## 9. After adding the folder

1. `node node_modules/vitest/vitest.mjs run src/lib/formats tests/fuzz` — the conformance kit (`conformance.test.ts`), the
   registry tests and the short fuzz run cover the new adapter automatically.
2. Regenerate the derived files and commit them with the adapter:
   `UPDATE_FORMATS=1 node node_modules/vitest/vitest.mjs run src/lib/formats/registry.test.ts` (electron/formats.json)
   and `UPDATE_SUPPORT=1 node node_modules/vitest/vitest.mjs run src/lib/support-table.test.ts` (docs/SUPPORT.md).
3. Add the adapter id to the format diagnostic report's whitelist (section 10): `src/lib/diagnostics/registry.test.ts` fails until
   it is listed in `enums.formatId` of `electron/diagnostic-schema.json` and in `FORMAT_IDS` of `src/lib/diagnostics/report.ts`, and
   `UPDATE_DIAGNOSTIC_GOLDEN=1 node node_modules/vitest/vitest.mjs run src/lib/diagnostics/schema.test.ts` rewrites the golden file.
4. Add a changelog fragment in `changes/unreleased/` for the new format.

## 10. Diagnostic structure hook (optional)

Help > "Format diagnostic report..." describes a file that fails or opens wrongly without copying anything of it
(docs/DIAGNOSTIC-REPORT.md). The collector follows the dispatcher: every adapter sniffs, the candidates are tried strongest
first, and the result and plausibility facts come from the board the chosen adapter returned. An adapter that also wants the
*layout* of its files described adds one optional member next to `sniff` and `parse`:

```ts
export default defineBoardAdapter({
  ...
  structure: myFormatHook,   // StructureHook (src/lib/formats/structure-hook.ts); omit it and the adapter is reported with detection and result facts only
});
```

A hook has an `id` (a member of `enums.hookId`; adapters of one family share a hook: BRD and BRD2, BVR 1 and 3), a `kind`
(`text` or `binary`), the public `keywords` it may count, the `steps` of the format's pipeline (`header`, `container`, `decrypt`,
`decompress`) and `collect(input, sink)`. It never returns text: it talks to a sink, and the sink accepts only what the schema
lists: keywords the hook declared AND `enums.keyword` contains, header fields from `enums.headerCode` / `enums.headerCount` with integer
values, numeric tokens as order of magnitude and decimal places, unit and pad-angle facts for the plausibility metrics, and (at
level 2 only) collapsed line shapes and binary block tags. A reference, a net name, a coordinate or any other string of the file can
therefore not reach a report without a visible change of the whitelist, which `schema.golden.txt` pins in review.

Rules for a hook: bounded and linear in the input, total (it never throws; the collector catches it anyway), no I/O and no
allocation in proportion to the file beyond what the reader itself needs, keywords are the format's public vocabulary and never
values, and a key supplied by the user may be used to reach the structure behind an encryption but is never reported. Call
`sink.reached(step)` as each pipeline step completes: the stage of a failure the reader reports without one is the first step the
hook could not complete. `src/lib/diagnostics/registry.test.ts` checks every hook against the whitelist and every adapter's fixtures
against the report (no word of a fixture may appear in it), whether the adapter has a hook or not.

EasyEDA Pro is supported with real project backups: top-side placement is verified, bottom-side placement is unverified and disclosed on import. IPC-2581 and IPC-D-356 evidence is limited to KiCad 9 exports. Pin lists accept explicit `ParseOptions.pinList` column/unit/decimal/side settings; unfamiliar headers require mapping, and the mapping-confirmation UI is a separate feature. `ParseOptions.ipc356` carries access, unit, rotation and via overrides. Schematics use the separate schematic model and dispatcher (`src/lib/schematic/index.ts`), including Altium SchDoc and project companions.
