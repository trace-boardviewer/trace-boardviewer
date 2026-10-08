# Library knowledge

The pure recognition rules the Library uses to understand a technician's files: which board a file belongs to, which revision it is, which vendor and device type it suggests, which part a text names, and what a token read from a PDF or a board file is. The code is in `src/lib/library/knowledge/`. It is pure, total, linear-time and does no input or output, so it can run in the library service, in the sandboxed indexer page and in tests alike. This page is the contributor reference for the Knowledge package; the contracts of the Library as a whole are in [LIBRARY.md](LIBRARY.md).

## Rules that hold everywhere

- **Total.** Every function accepts any value: a non-string gives an empty result, a text with lone surrogates or control characters is read like any other.
- **Bounded.** At most `MAX_TEXT_LENGTH` (100,000) UTF-16 units of a text are read, at most `MAX_MATCHES` (256) results are returned, tokens and identifiers longer than 64 units are skipped without being copied.
- **Linear.** One forward scan per text, no regular expression over the text, no backtracking. Each function takes an optional `WorkMeter` that counts examined characters; the tests assert the count, not a clock.
- **Precision first.** A doubtful match is dropped, never promoted. "Unknown" is a valid answer everywhere.
- **Positions.** Spans are `[start, end)` offsets in the original text. Folding (upper case, full-width to ASCII, Unicode dashes to `-`, Unicode blanks to a blank) maps one unit to one unit, so offsets stay valid.
- **Versioned.** `KNOWLEDGE_VERSION` is stored with the results of the name and knowledge stages. Change it with every change of a table or rule that can change a result.

## Modules

| File | Exports | Purpose |
| --- | --- | --- |
| `board-numbers.ts`, `board-number-shapes.ts` | `recognizeBoardNumbers`, `bestBoardNumber`, `confidenceBand`, `BOARD_NUMBER_SHAPES` | board numbers in names, titles and headers |
| `revision.ts` | `parseRevisions`, `bestRevision`, `compareRevisions`, `revisionKey` | revisions and their order within one scheme |
| `hints.ts`, `lexicon.ts` | `vendorHints`, `deviceTypeHints`, `documentTypeHints`, `documentTypeForExtension`, `summarizeHints` | vendor, device type and document type from words |
| `part-numbers.ts`, `part-families.ts` | `normalizePartNumber`, `matchTier`, `PART_FAMILIES`, `PART_CATEGORIES` | part-number keys, tiers and repair function categories |
| `tokens.ts` | `classifyToken`, `tokenizeText`, `countTokenClasses` | the seven token classes |
| `names.ts` | `analyzePath`, `analyzeName`, `pathSegments` | everything the folder chain and file name say |
| `identifiers.ts` | `textIdentifiers`, `pathIdentifiers`, `partTermKeys`, `cleanRaw`, `MAX_IDENTIFIERS` | the results above as `Identifier` rows and part-term keys of the Library model |
| `chars.ts` | `WorkMeter`, folding helpers, limits | shared helpers |

### Board numbers

`recognizeBoardNumbers(text, { scope })` returns matches with `shape` (id), `normalized` (upper case, `-` between groups, a trailing revision split off into `revision`), `raw`, `start`/`end`, `confidence` (0..100), `vendor`, `device`, `loose` (a blank or underscore stands for the dash), `labelled` (a label word such as board, PCB, P/N, DWG, MLB stands within 24 characters before the number) and `provisional`.

The `scope` says where the text comes from: `name`, `folder`, `archive`, `header`, `pdf-metadata`, `outline`, `title-block`, `schematic`, `ocr` or `body` (running text). A shape belongs to a scope group: `all`, `names-title` (everything but running text) or `names` (file, folder and archive names only).

Confidence is the base confidence of the shape, plus 5 behind a label word, minus 10 for a blank or underscore, minus 15 in OCR text, minus 10 in running text. A candidate is dropped when a letter or digit touches it, when the scope does not allow its shape, when a numeric shape continues into more digit groups (dates, versions, phone numbers), when a numeric shape written with a blank or underscore ends in something that reads as a year, when it looks like a phone number (a `+` in front, a word like tel or fax, an area code in brackets, short digit groups that run on to ten digits), or when a shape that needs a device word has none in the text. Reference designators, page and sheet numbers, dates and part numbers match no shape at all.

| Shape id | Layout | Example (invented) | Scopes | Base |
| --- | --- | --- | --- | --- |
| `logic-board-820` | `820-` + 4 or 5 digits, optional `-X` revision | `820-01234-A` | all | 85 |
| `schematic-051` | `051-` + 4 or 5 digits | `051-9876` | names + titles | 80 |
| `la-code` | `LA-` + 4 characters (a digit among them) + `P` | `LA-Z123P` | all | 85 |
| `la-code-nop` | `LA-` + 4 characters with two digits | `LA-1234` | names + titles | 60 |
| `nm-code` | `NM-` + letter + 3 digits | `NM-Z123` | all | 85 |
| `da0-code` | `DA0` + 3 characters + `MB` + 3 characters | `DA0ZZ1MB6E0` | all | 90 |
| `da0-sub` (provisional) | `DA0` + 3 characters + 2 letters + 3 characters | `DA0ZZ1HB6E0` | all | 60 |
| `dotted-48` | 2 or 3 digits, `.`, 5 characters (digit first, letters and digits), `.`, 3 or 4 characters | `48.4ZZ01.011` | all | 60 |
| `inventec-6050a` | `6050A` + 7 digits, optional `-MB-A02` revision | `6050A2999901` | all | 85 |
| `ms-code` | `MS-` + 4 or 5 characters, digit first | `MS-17Z9` | names + titles | 55 |
| `samsung-ba` | `BA41`/`BA59`/`BA92`/`BA94` + `-` + 5 digits + optional letter | `BA41-01234A` | all | 80 |
| `samsung-bn` (provisional) | `BN41`/`BN44`/`BN94` + `-` + 5 digits + optional letter | `BN44-00123A` | all | 70 |
| `amd-109` | `109-` + letter + 5 digits + `-` + 2 digits | `109-Z12345-00` | all | 70 |
| `nvidia-699` (provisional) | `600-`/`699-` + digit, letter, 3 digits + `-` + 4 digits + `-` + 3 digits | `699-1Z123-0123-456` | all | 65 |
| `cn-dell` | country code + `-0` + 5 characters | `CN-0ZZ123` | names + titles | 55 |
| `model-sm` (model) | `SM-` + letter + 3 digits + letter + optional character | `SM-Z999F` | names + titles | 65 |
| `model-gt` (provisional, model) | `GT-` + letter + 4 digits + optional letter | `GT-Z9999` | names + titles | 55 |
| `model-a4` (model) | `A` + 4 digits; only with a device word in the text | `A9999` | names only | 40 |
| `generic-mb` | `MB`, `M/B` or `MAINBOARD` + code of 4 to 8 characters | `MB-ZQ12` | names only | 35 |
| `asus-60n` (provisional) | `60N` + letter + `0` + 3 characters + `-MB` + 4 digits | `60NB0ZZ0-MB1201` | all | 65 |
| `lenovo-fru` (provisional) | `5B` + 2 digits + letter + 5 digits | `5B20Z12345` | names + titles | 55 |
| `hp-spare` (provisional) | `J`/`K`/`L`/`M`/`N`/`P` + 5 digits + `-` + 3 digits | `L12345-601` | names + titles | 50 |
| `sony-console` (provisional, model) | `CUH`/`CFI`/`CECH`/`SCPH` + `-` + 4 digits + optional letters | `CUH-1234A` | names + titles | 65 |

Shapes marked "model" identify a product model number (`identifies: 'model'`); all others identify a board. The table describes the general layout of the numbers printed on boards, written from the public conventions of each maker. It contains no number from any file and no private data. Provisional shapes are conventions that still need a confirming example from public documentation and a content-free calibration on a real collection (counts per shape id only, no names); their confidence is lower on purpose. The vendor of a shape is the vendor id of the lexicon (`apple`, `compal`, `lcfc`, `quanta`, `wistron`, `inventec`, `msi`, `samsung`, `amd`, `nvidia`, `dell`, `asus`, `lenovo`, `hp`, `sony`).

### Revisions

`parseRevisions(text)` reads a label word and a value (`REV A`, `Rev.B`, `REV_02`, `Revision 1.0`, `REVA`, `REV1.0`), `R` and a dotted number (`R1.0`; `R1` alone is a reference designator and is not read), build stages (`EVT`, `DVT`, `PVT`, `FVT` with an optional number, `MP` alone), versions (`V2.5`, `VER 3`), a board word and one letter (`MLB-A`, `MB_B`) and the revision that belongs to a board number (`820-01234-A`, `6050A2999901-MB-A02`). Each result has a scheme (`letter`, `alnum`, `number`, `stage`, `version`), a normalised form without leading zeros, a rank and a confidence. `compareRevisions` orders two revisions of one scheme and returns `undefined` across schemes: the caller shows "order unknown" and may use the file's modification time as a labelled hint.

### Vendor, device type and document type

`vendorHints`, `deviceTypeHints` and `documentTypeHints` match words and short phrases (up to three words) from the lexicon in `lexicon.ts`, in the eight interface languages for device and document types. A hint has an id, a confidence (name 90 or 85 for an ODM, product line 65, weak 45 to 55), the matched words and a span. A product line implies a vendor or device with less certainty ("MacBook" implies Apple and a laptop). Words that mean different things in different languages ("portable", "display") are left out or weak. `documentTypeForExtension` maps file extensions (board formats, schematic formats, images, firmware images; a spreadsheet only weakly suggests a bill of materials; `.pdf` suggests nothing). `summarizeHints` groups hints by id with a small bonus for repeated evidence.

### Part numbers

`normalizePartNumber(text)` cleans the text (upper case, full-width and dash look-alikes folded, wrapper punctuation cut off), drops what is not part of the number (an own reference designator in front such as `U7100_` when the prefix is a known designator, a BOM class prefix such as `IC-`, a maker prefix such as `TI-` when the rest is a known family) and returns `exact`, `base`, `family`, `category`, `maker`, `suffix`, `markers` (`lead-free`, `reel`, `automotive`, `industrial`, `extended-temperature`) and what was stripped. `base` is stem plus core digits of the family; unknown families keep only the exact form. A text with several blanks, a component value (`100nF`) or characters no part number carries gives `null`. A suffix that starts with a digit means the number is longer than the family's, so it matches no family.

Tiers (`matchTier`), best first: `exact`, `base`, `prefix` (a query feature: at least five characters of the candidate's exact form), `family`. Tiers are always reported and never merged silently.

**The family table** (`part-families.ts`) has 325 rows of common repair-relevant families (power management, chargers, embedded controllers, multiphase controllers and power stages, converters and regulators, load switches, USB-C controllers, display bridges and backlight drivers, audio, Ethernet and wireless chips, card readers, flash, EEPROM, DRAM, storage, clocks, MOSFETs, transistors, diodes, ESD parts, level shifters, logic, analog parts, sensors, fan control, processors and microcontrollers). The table is **CC0 1.0** and is written from general public knowledge of the makers' naming (the family names in public datasheet titles and ordering-information pages). No row comes from a scraped catalogue, a distributor feed or a marking-code database, and no row states a price, a stock level or a pin-out. Every row has a `note` (a paraphrase of the public datasheet product line) and real-looking `examples`; the tests fail on a row without a note, on an example that does not resolve to its own row, and on a header without the licence statement.

Categories: `pmic`, `charger`, `ec-sio`, `vrm-controller`, `power-stage`, `gate-driver`, `buck-boost` (switching converters), `ldo`, `load-switch`, `usb-pd`, `usb-mux-redriver`, `usb-hub`, `display-bridge`, `backlight`, `audio-codec`, `ethernet-phy`, `wireless-module`, `card-reader`, `spi-flash`, `eeprom`, `dram`, `nand-emmc-ufs`, `clock-gen`, `oscillator`, `mosfet-n`, `mosfet-p`, `mosfet-dual`, `bjt`, `diode`, `schottky`, `tvs-esd`, `level-shifter`, `opamp-comparator`, `current-sense`, `fuel-gauge`, `battery-protection`, `supervisor`, `voltage-reference`, `logic`, `sensor`, `fan-ctl`, `soc-cpu-gpu`, `mcu`, `connector`, `unknown-ic`. The ids are the keys `library.category.<id>` of the interface catalog. `connector` and `unknown-ic` are assigned by structure rules (schematic pin names, part kind, connected rails), not by a part number.

To add a row, add one `fam`, `one` or `pre` line to `part-families.ts` with a note and at least one example, check that no longer stem steals the example, and bump `KNOWLEDGE_VERSION`.

### Token classes

`classifyToken(token, { scope, previous })` puts a token in exactly one class: `refdes`, `net`, `part-number` (`known` when it belongs to a family, `text` when it only looks like one), `value`, `package`, `board-number` or `noise`. The rules run in a fixed order (documented in `tokens.ts`): page and sheet numbers after their word, numbers and dates, board numbers across the whole token, known part-number families before the reference-designator shape, package names, reference designators (upper case only; signal stems such as `USB3`, `DDR4` and `GPIO12` are nets; leading-zero codes such as `R005` are values), values (`parsePartValue`; `3V3` and signed or prefixed voltages are rails, a plain `50V` is a value), nets (`classifyNetName`, underscore names, active-low names), and unknown part-number-like tokens. A bare number is noise. `tokenizeText` cuts a text into tokens in one pass with the previous token as context.

### Names

`analyzePath(relativePath)` reads the last 12 segments of a path: the file name as a `name` (its extension suggests a document type), folders as `folder`, archive names (`.zip`, `.rar`, `.7z`) as `archive`. Each result carries the segment it came from, and `best` holds the strongest board number (the file name wins ties), revision, vendor, device type and the document types by strength. This is the whole of the "name" stage; no file is opened.

## Integration notes

`identifiers.ts` is the seam to the Library model (`../model`). The scanner (stage "name") and the indexer (title blocks, headers, outlines, OCR text) call it instead of the recognisers:

- `textIdentifiers(text, source, { page, scope })` returns `Identifier` rows: board numbers and model numbers (`kind` from the shape's `identifies`), revisions (`pattern` is the scheme), vendors and device types. `source` is where the text comes from (`name`, `folder`, `archive`, `header`, `pdf-metadata`, `outline`, `title-block`, `schematic`, `ocr`) and, unless `scope` says otherwise, the recognition scope; pass `scope: 'body'` for running text. A board-number row has `raw` (the matched text), `norm` (the normalised form), `pattern` (the shape id) and `confidence`; `page` is set only for a page of a PDF (1 to 2000).
- `pathIdentifiers(relativePath)` does the same for the folder chain, an archive name and the file name, with the source of each segment.
- `partTermKeys(text)` gives the fields of a `PartTerm` (`norm` = exact, `base`, `family`, `category`) or `null` when the text is not a part number.
- Rows are distinct per kind, norm, source and page (the most confident one is kept), sorted strongest first and capped at `MAX_IDENTIFIERS` (256). Raw texts have control characters replaced by blanks and are cut at 256 characters, so every row passes the contract validators of `../validate` (the tests run them over generated texts).
- Document-type hints are not identifiers; use `documentTypeHints` and `documentTypeForExtension` for the file role.
- The grouping stage should not read a board number from `body` scope text as strong evidence; the recogniser already lowers its confidence by 10.

## Known gaps

- Shapes are conventions, not a database of numbers: a vendor that changes its layout needs a new row. A calibration against a real collection of files (hit counts per shape id) is still to be done.
- Order across revision schemes is unknown by design.
- `A1706`-style Apple model numbers are only read in names and only next to a device word.
- A part number such as `4N35` reads as a value (4.35 nF) when it belongs to no family (a limit of `parsePartValue`).
- OCR text is read with a lower confidence; characters that OCR confuses (0 and O, 1 and I) are not repaired.
- The vendor lexicon is nominative: it names brands and ODMs that appear in file and folder names and says nothing about a file's origin or legality.

## Tests

`*.test.ts` in the same folder: board numbers (853 cases, 176 of them negatives), revisions (432), part numbers (2,794, with every family example in four written forms) and the family table (704), token classes (406), hints, names, identifiers (42, including contract-validator checks) and data integrity. `knowledge.property.test.ts` holds the fast-check properties (totality, bounded and well-formed output, determinism, idempotence of the part-number keys, generated positives for every shape, linear work by operation count) and relative-time scaling checks. Properties run with a fixed seed; explore more with `FC_RUNS_FACTOR=20` or `FC_SEED=random`.
