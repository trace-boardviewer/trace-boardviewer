# Readings format, version 1

This document describes contributor-facing storage and import foundations. The dedicated readings interface is not exposed in 1.3.1.

TRACE readings files contain component references, pin numbers, net names and measurement values. They contain no board geometry or source file contents. Paths and identities are never inferred; free text contains only supplied text. Customer/job records are outside this format.

The TypeScript contract is `src/lib/readings/schema.ts`; `electron/readings.cjs` provides the main-process validator twin. Both normalize names with NFKC and trimming, preserve case, drop unknown fields, reject invalid values, and return canonical objects. The JSON Schema in [readings-v1.schema.json](readings-v1.schema.json) describes canonical exported packs. Additional application checks enforce unique reading IDs, sorted/distinct pin sets and the exact licence list. Import must run the runtime validator, even after JSON Schema validation.

## Pack

A `.trace-readings.json` file has `format: "trace-readings"`, `version: 1`, an SPDX `license`, a `board` object and a `readings` array. Optional metadata: `title`, `attribution`, `createdAt`. Unknown board identity is `{}`; attaching such an import to a board requires the caller to choose the family. Identified boards carry the 64 lower-case hexadecimal fingerprint and `fingerprintVersion: 1`, optionally file SHA-256 keys, label, board number and canonical `(ref, pin)` set. The fingerprint is the shared board-fingerprint module's hash of numbered pin identities; it does not establish identical topology. Do not add an `fp1:` prefix to the stored hash.

```json
{
  "format": "trace-readings",
  "version": 1,
  "license": "CC0-1.0",
  "board": {},
  "readings": [
    {
      "id": "reference-1",
      "kind": "diode",
      "target": { "ref": "U1", "pin": "3", "net": "VCC" },
      "value": 0.412,
      "unit": "V",
      "conditions": { "power": "unpowered", "polarity": "red-on-reference" },
      "tolerance": { "abs": 0.02, "rel": 0.05 },
      "source": "known-good"
    }
  ]
}
```

`buildPack` defaults to CC0-1.0. A reading licensed differently is excluded and reported in `excluded`. Explicit `foreign: 'mark'` preserves it and adds `licenses`: the pack licence first, then all other licences sorted and distinct. Both validators reject unmarked foreign entries and unused licence declarations. Marking preserves the original obligations; it does not relicense an ODbL entry as CC0. `planImport` retains per-entry licence/provenance, converts known-good entries to imported references, keeps measured entries measured, and deduplicates repeat imports excluding the import timestamp. Changed entries with colliding IDs receive caller-generated new IDs.

## Reading

| Field | Contract |
| --- | --- |
| `id` | 1–64 ASCII characters, first alphanumeric, remainder alphanumeric or `._:~-`; unique within the family/pack |
| `kind` | `diode`, `voltage`, `resistance`, `continuity` |
| `target` | Part: `ref`; pin: `ref` and `pin`; net: `net`. Optional net alongside a part/pin records its net when measured, without changing its key. |
| Numeric value | Diode/voltage: finite `value` and `unit: "V"`; resistance: nonnegative finite `value` and `unit: "ohm"`. Magnitude at most 10¹². |
| Overload | Numeric kinds may instead hold `ol: true`, with neither `value` nor `unit`. |
| Continuity | Boolean `connected`, with no numeric value, unit or OL field. |
| `conditions` | Required `power`: `powered` or `unpowered`. Optional `state`, `reference`, `polarity`, `meterMode`, `meter`. |
| `reference` | One net, part or pin describing the other probe. Omission means board ground. Cannot hold both net and ref. |
| `polarity` | `red-on-reference` or `black-on-reference`; omission means unrecorded. |
| `meterMode` | Voltage only: `dc` or `ac`; omission means dc. The other kinds imply their meter mode. |
| `tolerance` | At least one of nonnegative `abs` (SI unit, at most 10¹²) or `rel` (fraction, at most 10). |
| `source` | `measured`, `known-good`, `imported`. Imported requires `license` and `provenance`. |
| `provenance` | Required origin: `trace-pack`, `csv`, `openboarddata`, `note`; optional title, attribution, sourceId, importedAt. |
| Optional text/time | `raw` retains the input verbatim; `note`; ISO `takenAt`. |

Keys use the escaped `partKeyText`/`pinKeyText` convention of `note-keys.ts`. Net keys begin `@net:`; escaping makes them distinct from part/pin keys. Canonical reading names preserve case. The fingerprint pin set is a separate upper-case, sorted/distinct identity representation and excludes synthetic unnumbered pins.

Bounds: 100,000 readings or append events; 256 characters per ref/pin, 512 per net, 64 raw/meter, 32 state, 2,000 note, 256 title/label, 1,000 attribution, 128 provenance sourceId/board number, 64 licence, 40 timestamp; at most 32 licences, 256 family members, 256 file keys per member and 1,000,000 pin pairs. Licence syntax accepts SPDX-style identifiers or `LicenseRef-…`, not arbitrary licence expressions.

## CSV

Export is UTF-8 with BOM, comma separated, CRLF, RFC 4180 quoting. Columns:

```text
id,kind,ref,pin,net,value,unit,ol,connected,raw,power,state,reference_ref,reference_pin,reference_net,polarity,meter_mode,meter,tol_abs,tol_rel,source,license,origin,title,attribution,source_id,imported_at,taken_at,note
```

Absent fields are empty. Booleans are `true`/`false`. Numeric cells use round-trip decimal representation. Text cells beginning with spreadsheet formula characters receive an apostrophe; import removes exactly one escape, preserving original text. Pack CSV export writes the effective licence on every row because CSV has no pack metadata.

Import permits reordered/case-insensitive headers, comma/semicolon/tab delimiters, decimal commas with semicolons, and meter input forms such as `412mV`, `4k7`, `OL`. Missing power defaults to powered for voltage and unpowered otherwise and is counted. Missing source defaults to known-good; callers supply IDs for rows without them. Unknown columns are reported. Invalid rows are skipped with row-level issues; unterminated quoted cells and size/count limits reject the file. CSV is bounded to 32 Mi characters, 8,192 characters per cell and 64 columns. It does not carry board identity; callers must associate the file explicitly.

## OpenBoardData file import

Only local text files are imported. A board file has `ID`, `BRAND`, `TYPE`, `COMMENT` headers and rows `NETNAME DIODE_VALUE NORMAL_VOLTAGE RESISTANCE [COMMENT …]`; combined files prefix each row with its board ID. Comments begin `#`; blank-led lines and component sections are skipped. Combined files with multiple boards require selection. `ol` means open/overload; `na` and other unknown markers produce no reading. Repeated nets keep their first row and report the duplicate.

Every entry retains `ODbL-1.0` and OpenBoardData attribution/provenance. Diode/resistance are unpowered; normal voltage is powered. The format does not record polarity. Diode fields are volts unless all nonzero plain diode numbers are whole numbers above 4, when millivolts are assumed and reported. Raw values are retained; invalid fields have line-level issues. Reimport IDs are stable by board, net and quantity. No network lookup accompanies import.

## Store

`createRepairStore` in `electron/repair-store.cjs` owns `<profile>/readings/`. Family IDs are 64 lower-case hex characters. A FIFO queue serializes reads, appends, compaction and shutdown. Events: `family.create`, `family.link`, `family.rename`, `reading.add`, `reading.replace`, `reading.remove`. Validation and state conflict checks complete before writing; one append commits one checksummed JSONL record with a sequence number. The first event creates a family. IDs cannot be added twice; replace/remove need an existing ID. An append is atomic as a batch.

Each family has `<id>.jsonl` and `<id>.snapshot.jsonl`. Compaction writes a temporary snapshot with header, canonical reading lines and CRC/byte-count trailer, atomically renames it, then truncates the log. Records already included in the snapshot are skipped on replay, covering a kill between rename and truncate. A torn/invalid log record and its following tail are copied to a deterministic `.damaged-…` file before truncation. Damaged snapshots are left unchanged and reported unreadable. Stale family temporary files are removed on load. `families.json` is a derived list cache.

Limits: 64 MiB reading state, 16 MiB family header, 64 MiB record/log, 3 cached families, 10,000 listed families. Warm appends reuse one descriptor per cached family; compaction, cache eviction, forgetting and shutdown close it. Directory setup happens once per store. Automatic compaction starts after 1,000 records or 4 MiB log. Snapshot load checks CRC and indexes canonical reading lines without parsing 100,000 objects. A normal read returns one JSON-array string; `parseFamilySnapshot` parses it on the renderer side. These are separate costs. Compaction replaces old event history with current state; the JSONL is not a permanent audit history.

Crash guarantee: a process kill preserves a consistent prefix including acknowledged appends; CRC detects incomplete writes. This is **not a power-loss durability guarantee**: appends/snapshots are not fsynced. Single-store ownership per profile is required; there is no cross-process writer lock. A CRC protects against accidental damage, not malicious local modification.

## IPC and UI integration

All channels use the existing trusted-sender guard. `TraceDesktop` exposes optional `listReadingFamilies()`, `readReadings(familyId, { headerOnly })`, `appendReadings(familyId, events)`, `importReadings()`, `exportReadings({ format: 'pack' | 'csv', pack, name })`. Import/export use main-owned dialogs. Import returns basename, byte count and bounded decoded text, never a path; the renderer parses and plans it, then main revalidates appended events. Export validates the pack, including licence marking, before opening the save dialog and atomically writes main-generated bytes. Imports/exports are bounded to 64 MiB. Shutdown rejects new writes/dialogs and drains accepted operations.

The UI should translate stable `READINGS_*`/`STORE_CLOSING` codes, show parser assumptions/issues, excluded foreign entries and audit findings, obtain confirmation for similar-family suggestions and note migration, and retain original notes. Exact file/fingerprint matching can select a family; similarity ≥0.95 is only a suggestion. Since fingerprints omit topology, compare the recorded pin net with the current board and show a net-change flag before applying a reference. Capture and note migration are pure planning functions and do not persist without append calls.

Comparison uses `max(abs, rel × |reference|)`, inclusive tolerance edges and absolute floors near zero. OL/OL passes, OL/numeric fails, and continuity compares booleans. Pairing requires compatible quantity, target and conditions; an unrecorded polarity is flagged. Coverage reports measured nets/rails and uncovered targets; golden capture orders rails, test points and connector pins. The UI remains a later package.
