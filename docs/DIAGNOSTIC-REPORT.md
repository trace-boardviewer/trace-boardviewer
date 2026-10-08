# Format diagnostic report

When a board file does not open, or opens wrongly (mirrored, the wrong size, parts missing), the developers need to know **how the file is built**, not what is in it. The format diagnostic report is a short JSON text that describes the structure of one file with counts, sizes and format facts only. TRACE creates it on your computer, you read it, and you decide whether to send it. **Nothing is uploaded, and the board file never leaves your machine.**

## Creating a report

1. Open **Help** (the `?` in the status bar, or the Help button on the start screen) and choose **Format diagnostic report...**.
2. Choose the file. Any file can be examined, also one TRACE does not recognise. TRACE opens its own file dialog; a format that comes as a group of files (the ASC trio `format.asc`, `pins.asc`, `nails.asc`) is read together with its companions from the same folder.
3. Wait for the analysis. It runs on your computer in a separate process with a progress bar and **Cancel**. As with a board import, a run that makes no progress is marked as slow after 30 seconds and stopped after 120 seconds.
4. Read the review: the plain-language list of what the report contains, the remaining-risk notice, and the report text itself, exactly as it will be saved.
5. Decide on the two switches, both **off** by default:
   - **Add the structure shapes (level 2)** adds the collapsed shape of the first lines of each section and the tag and length of the first 256 binary blocks (see below). It helps the developers more and tells a little more about the file.
   - **Add a repeat-detection code** adds a short code that lets the developers recognise the same file if you send it twice (see "Repeat-detection code").
6. **Save report...** opens the system save dialog (the suggested name is `trace-format-diagnostic.json`). **Copy text** puts the same text on the clipboard; it does so only when you click it.

## Sharing it

Open the **Format request or file that does not open** form of the project on GitHub and attach the saved file or paste its text into the *Diagnostic report* field. The form asks you to confirm: "I did not attach the board file and I am allowed to use it." Describe in words what you see, name the format or the program that wrote the file, and do not attach the file itself, a schematic or anything proprietary or from a customer.

## What the report contains

Everything in the report is a number or a word from a fixed list. Counts are rounded to two significant digits, shares to two decimals.

| Group | What it says |
| --- | --- |
| App | The TRACE version, a short revision code of the set of readers, and the operating system family (Windows, macOS, Linux). |
| Input | The lowercase file extension if it is in a public list (else `other`), the size as a power of two, the number and extensions of companion files, the container kind (none, ZIP, gzip, tar, compound file, SQLite, Jet, zlib), text or binary, the encoding and the line endings, a 16-slice randomness profile of the bytes with one decimal, and a *known-magic label* from a public signature list (for example `ole-cfb`, `gzip`, `allegro-17.4`), never raw bytes. |
| Detection | Which readers recognised the head of the file and how sure each one was (possible, likely, certain), strongest first, and what happened when TRACE tried them in that order: declined, claimed, failed or not reached. A failure carries only a short **error code** and the **step** where it stopped (header, container, decrypt, decompress, records, build), never the message. A file that two readers are equally certain about is reported as ambiguous. |
| Structure (level 1) | For the reader that took the file: how often each of the format's own public keywords and section markers occurs (for example `$HEADER`, `A!`, `BRDOUT:`, `BVRAW_FORMAT_3`), the number of fields per kind of line (smallest, median, largest), the order of magnitude and number of decimal places of the numbers, header facts from a per-format list (version, unit code, declared counts), and for binary formats a histogram of block tags and power-of-two block lengths. |
| Structure (level 2, switch) | The first 32 lines of each section as a *collapsed shape*: every run of letters becomes `A`, every run of digits `9`, punctuation stays (`S!U12!C0402!YES!90` becomes `A!A9!A9!A!9`), and the tag and length of the first 256 binary blocks as numbers. |
| Result | If the file opened: parts, pins and nets rounded to two significant digits, the shares of top, bottom and both-side parts, the unit kind, whether the outline is present, estimated or absent, the share of pins without a net, of placeholder nets and of pins with a known pad size. |
| Plausibility | A content-free test of the transform a reader applied. The board is re-read under the candidate interpretations (units x1, x25.4, x0.0254; pad angles absolute or relative to the part; bottom side mirrored or not) and each gets the share of pins inside the outline, the number of overlapping pad pairs, the median pin pitch snapped to a standard pitch (0.4, 0.5, 0.65, 0.8, 1.0, 1.27, 2.54 mm) and the pin-density ratio top to bottom. A wrong reading shows up as an outlier; this is how a pad-angle error of a reader was once found (501 overlapping pairs against 7). |
| Keys | Only whether a key was supplied and whether its parity holds. The dialog does not ask for a key: an encrypted file is described up to the step where the key is needed. |
| Performance | How long the reading took (two significant digits) and a power-of-two bucket of the memory used. |
| Privacy | The redaction version, the level, the "reviewed by the user" flag, and whether a repeat-detection code is present. |

## What it never contains

The file name or folder, your user or computer name, dates or time stamps, language or network information, any text from the file (references, net names, pin names, part numbers, values, packages, layer names, titles, comments, company names, serial numbers), coordinates or dimensions beyond an order of magnitude, images, raw bytes, hexadecimal or base64 dumps, decrypted or decompressed content, keys or anything derived from them, an unsalted hash of the file, error messages (which can quote content, as in "duplicate REFDES U12": only codes are reported), and anything you type.

The suggested save name is fixed; the file you examined is read by TRACE's main process, which hands the analysis only the bytes under a neutral name (`diagnostic` plus a safe extension, or `format.asc`, `pins.asc`, `nails.asc`). The real name and folder never reach the analysis.

## Remaining risk

Counts rounded to two digits, the size range and the file variant can still hint at which board family a file belongs to. Level 2 adds more of this: that is why it is a switch, why it is off by default and why you read the report before you share it.

## Repeat-detection code

An optional 8-byte code (16 hexadecimal digits): an HMAC-SHA256 of the file under a random secret that TRACE creates once per installation and keeps in your profile (`diagnostic-secret.json`). The same file gives the same code on your installation, so the developers can see that two reports are about the same file; anyone without the secret can neither compute it nor test a file against it. It is never an unsalted hash, because a public hash would let anyone prove that you hold a particular file. The secret is not part of any report and does not leave your computer. Delete the file to start with a new secret.

## How it is kept local

- The analysis runs in a worker of the application window. There is no network request anywhere in the code path (a test scans every module), and the page may connect to itself only.
- The clipboard is written only by the **Copy text** button.
- The file dialogs are opened by the main process of the application, not by the page; the page cannot name a path.
- Before anything is written, the main process checks the report once more against the closed schema (`electron/diagnostic-schema.json`): unknown fields, values outside the fixed lists, unrounded counts, level-2 fields in a level-1 report and an unreviewed report are refused, and the file that is written is the canonical text of the validated report, byte for byte what the review showed.
- The report never includes anything about a library of files: the analysis takes exactly one file and its companions.

## For developers

- The schema is `trace-format-diagnostic/1` in `electron/diagnostic-schema.json`: closed objects, closed lists, ranges and rounding rules. `src/lib/diagnostics/schema.golden.txt` lists every field and every member of every list; a field or a keyword cannot be added without that file changing in the same commit (`UPDATE_DIAGNOSTIC_GOLDEN=1 node node_modules/vitest/vitest.mjs run src/lib/diagnostics/schema.test.ts` rewrites it).
- The collector (`src/lib/diagnostics/collect.ts`) follows the dispatcher of the adapter registry. An adapter that wants its layout described carries an optional `structure` hook (`src/lib/formats/structure-hook.ts`, `docs/ADAPTERS.md` section 10); an adapter without one is reported with its detection and result facts only. A hook never returns text, only calls on a sink that accepts what the schema lists.
- A new adapter needs its id in `enums.formatId` of the schema; `src/lib/diagnostics/registry.test.ts` fails until it is there.
- Proof of the content-free claim: synthetic files of every format are seeded with canary references, nets, values, titles, coordinates and keys, and the report must hold none of them in plain, UTF-16, hexadecimal, base64 or URL-encoded form, for intact and for damaged files, at both levels (`canary.test.ts`); property tests with random bytes, hostile names and mutations check the schema and the same absence (`property.test.ts`); `registry.test.ts` does the same for every adapter fixture, with or without a hook; the golden test pins the whitelist; the IPC checks in `tests/desktop-checks.cjs` cover the dialogs, the neutral name, the secret and the validated save.
