# Library contributor contracts

The Library is a local, derived index of folders chosen through a native dialog. These contracts are infrastructure; they do not expose a Library UI yet.

## Boundaries and invariants

Main brokers trusted-sender IPC, the folder dialog, registered roots, settings and decisions. The utility-process service owns enumeration, bounded hashing and sniffing, ZIP directory listing, scheduling, grouping and the database. A hidden sandboxed indexer page runs board, schematic, PDF and OCR parsers in disposable workers. The UI queries through `LibraryApi`; it never runs background parsers. `protocol.ts` separates these four boundaries and versions every envelope at 1. Unknown versions are refused; a new incompatible shape increments the protocol version.

Original files are never copied, cached, extracted to disk, renamed, moved or deleted. ZIP members are read in place. No organised-copy API exists. Firmware is classified only. Encrypted files are indexed by name and size only; no library message accepts a decryption key. Workspace keys remain session-only.

No Library process has network access. Content, names, identifiers, hashes and the database stay on the machine. Diagnostic reports exclude Library data; only enabled state, schema version, root count, a power-of-ten file-count bucket and closed error-code histograms may be included. No PDF Author, image EXIF, GPS or document copies belong in summaries.

Renderer requests supply IDs, never paths. Main resolves them against registered roots, checks ownership, rechecks realpath containment and identity immediately before open/attach/reveal, and refuses links/junctions and NTFS streams. Schema validation cannot establish filesystem containment or trusted senders. Network roots picked by the dialog are allowed, including UNC roots, but never watched live. Every path in query/file responses is normalized relative to its root. Existing workspace open/attach payloads retain their existing absolute-path contract.

## Types and defaults

`src/lib/library/model.ts` defines roots/options, files/identity/states/kinds/roles, sourced board identifiers, component and passive summaries, groups and evidence, revision and duplicate relations, corrections, stage state and progress. Confidence is an integer 0–100; evidence score is 0–1. Summary refs are distinct strings, compressed only by the trusted service. MinHash is exactly 128 unsigned 32-bit numbers. Limits are shared in `validate.ts`: 20,000 components/terms, 5,000 histogram rows, 2,000 rails/pages, 250,000 refs and a 16 MiB aggregate string budget per message. A summary declares `truncated` whenever extraction hits a cap.

Full text is off by default for each root. A content reachable from several roots may retain full text only while at least one associated root opts in; queries must respect the requesting root filters. Turning the last opt-in off purges those postings. Settings persist `gentle`, `normal` or `use-more` performance; battery/startup may temporarily force gentle mode. Scan OCR is `off` or `triage`; triage recognizes only pages 1–2, never runs in gentle mode and defaults off on battery. All-page OCR requires an explicit request. There is no library-wide refdes index: `ref:` is scoped to a group.

Corrections are user data independent of the rebuildable database. Pair/role/hide targets use full SHA-256 (including the complete-file-set workspace key for companion sets) or root + relative location + optional ZIP entry. Merge/split/label/tag requests name current group IDs; main must resolve them to durable member targets in `StoredDecision.targets` before persisting. Group IDs remain stable through regrouping by majority-member overlap. A move updates location targets after identity confirmation. Do not persist only an ephemeral database row ID.

## Protocol and validation

Channels use `trace:library-<operation>`. Requests contain `version`, `requestId`, `operation` and `args`; responses echo the ID/operation and carry either `ok: true, result` or `ok: false, error` (a code, never file text). Void results are `null`. Operations cover roots/add/remove/options, scan/pause/resume/stop/status, get/update settings, query/group/file/similar, decide, open/attach/reveal, OCR and delete-index. Progress/change/error events have their own versioned envelope. Progress is throttled to at most 4 Hz. UI bridge wrappers assign request IDs and check reply correlation before resolving.

Main-to-service configuration alone includes registered realpaths. Service/indexer jobs contain bounded bytes, a basename, extractor version, generation and content/job IDs. Results contain only bounded summaries, heartbeat fractions or closed error codes. The service keeps an outstanding-job table and calls `validateResultForJob` before inserting: it verifies correlation, expected summary kind/format, full-text permission and OCR scope. A valid result for an already cancelled job must still be dropped. The service increments poison-file attempts before dispatch, stops automatic retries after two crashes, and commits each stage's outputs and state atomically.

`validate.ts` covers every operation's arguments, replies, settings, decisions, progress/events, main/service messages, indexer jobs and all summary variants. Validators are total booleans, reject unknown fields, wrong enums/types, unsafe locations, accessors, prototype keys, cycles, excessive depth and oversized collections. They accept ordinary structured-clone data and null-prototype dictionaries. They do not replace sender checks, root authorization, cursor ownership, request correlation or process isolation.

The CommonJS twin in `electron/library/validate.cjs` is generated from the standalone TypeScript source using the development Node runtime:

```sh
node scripts/library-validate.cjs
node scripts/library-validate.cjs --check
```

The twin uses no TypeScript at application runtime. The parity tests run both validators on identical valid and hostile cases and require generated-source freshness. Update source and twin together. String and binary limits are cumulative across a message; large details require paging rather than increasing the budgets silently.

## Search grammar

`query.ts` parses at most 200 UTF-16 code units in one forward scan. Whitespace separates AND terms; double quotes preserve spaces, `\"` and `\\` escape quotes/backslashes. NFKC normalizes values. Bare terms search the normal term/name indexes. Recognized fields:

| Input | Meaning |
| --- | --- |
| `part:TPS51225` or `exact:TPS51225` | Exact normalized part |
| `base:TPS51225` | Family-rule-normalized base part |
| `prefix:TPS51` or `part:TPS51*` | Part prefix, at least five characters |
| `family:buck-ctl` | Explicit knowledge family ID |
| `board:QX-Z123` | Board identifier |
| `ref:U7000` | Reference inside `filters.groupId` only |
| `rail:+3V3` | Power rail |
| `file:"rev B.pdf"` | Literal file-name substring |

Unknown field syntax stays a literal bare term. An unfinished quote produces a recoverable issue; missing values and short prefixes are omitted with codes. Non-string input gives an empty result; oversized text gives `too-long` without scanning it. The query request separately carries closed mode/sort/direction, facet filters, a service-owned opaque cursor (≤512 characters), and a limit of 1–200. The store binds SQL values and escapes FTS syntax itself; parser text is never executable SQL, regex or raw MATCH syntax. Sort adds the stable row ID as a final tie-breaker, and cursor validation binds it to filters/sort/generation.

## Sniff-only registry seam

`sniffAny` reads no files and passes at most 64 KiB of the supplied head to the sniffs, after the dispatcher's own bounded UTF-16 BOM normalization (`sniffHead`). Boards and ZIP archives come from the format registry (`../formats/registry`: `BOARD_ADAPTERS` and `CONTAINER_ADAPTERS`) through the dispatcher's `rankAdapters` and `ambiguousCandidates`, so a listing and an import rank the same candidates and apply the same rule: confidence, then extension ownership, then ID, and two CERTAIN (≥90) board candidates return ambiguity and no selected format. Containers and documents do not create a board ambiguity. The verdict reports alternatives, capability status, key requirements and input-budget excess without parsing. PDF/image/schematic signatures reuse the existing document sniff. RAR, 7z, gzip, spreadsheets and firmware are classified here only, because no board reader covers them; a ZIP head alone cannot establish its project kind (an EasyEDA Pro or ODB++ reader outranks the generic container when its own sniff matches). Firmware needs a binary head, a firmware extension and a power-of-two size class. A head that ends before the file is passed as such, so a reader whose markers may lie beyond the window stays a POSSIBLE candidate and the parse decides.

The registry's sniffs are the single implementation: where a board reader and the library once disagreed, the reader was followed (XZZ is the `.pcb` reader and is not flagged for a key from the head, the Landrex section lines stand alone on their line, HyperLynx and Fabmaster are LIKELY, never CERTAIN), or its sniff was corrected where it overclaimed (an EAGLE schematic and an OLE compound file under a name that is not an Altium PCB are only POSSIBLE board candidates, so the document sniff and the spreadsheet rule win). New readers need no change here.

Keep the bounded-head, window and ambiguity regression tests. Adapter follow-up: optional `Board.meta` (`title`, `revision`, `drawing`, `company`, `date`, each ≤256), populated by GenCAD, KiCad and EAGLE.

## Package plug-in points

| Area | Implements |
| --- | --- |
| Store | [Schema v1](LIBRARY_SCHEMA.md), migrations, bounded queries/facets/details, settings/corrections JSON, durable decision mapping, full-text root policy |
| Scanner | Native broker and sender/root authorization, no-follow containment, identity/hash/move policy, registry seam, bounded in-place ZIP reads, scheduling/throttling/progress and crash recovery |
| Indexer | Versioned jobs, disposal/cancel/watchdogs, parser summaries and truncation, confidence-marked OCR on pages 1–2, full text only on job permission, network denial and permission denial |
| Knowledge | [Pure recognition rules](LIBRARY_KNOWLEDGE.md): sourced identifiers, precise exact/base/family rules, component categories, capped terms and rails |
| Grouping | Deterministic evidence graph, conflict-blocked strong unions, suggestions, stable group IDs, revisions/duplicates and explanations from evidence codes |
| Browse/detail UI | `LibraryApi`, query issues/tiers, relative locations, paging, evidence explanations, eight-language catalog strings and accessible virtual lists |
| Workspace integration | Open/attach/reveal by revalidated file IDs, existing SHA-256/file-set identity, diagnostic exclusion canary |

Threat scope here is contract validation only: no IPC handler, process, permission, dependency or security setting is registered. The infrastructure packages must test forged senders, stale IDs, links escaping roots, changed files and sandbox network denial when they implement those boundaries.
