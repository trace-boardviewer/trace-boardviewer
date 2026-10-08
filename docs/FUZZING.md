# Fuzzing and property-based tests

Two kinds of generated tests protect the importers and the pure libraries. Both are deterministic by default, so a failure is the same failure on every machine.

| What | Where | Normal run | Long run |
| --- | --- | --- | --- |
| Property-based tests (fast-check) | `tests/property/*.test.ts` | part of `pnpm test`, about 5 s | `FC_RUNS_FACTOR=20 pnpm test tests/property` |
| Parser fuzzing, in the test run | `tests/fuzz/fuzz.test.ts` | part of `pnpm test`, about 10 s | `FUZZ_ITERATIONS=20000 pnpm test tests/fuzz` |
| Parser fuzzing runner (hang and memory watch, minimizing) | `scripts/fuzz-parsers.cjs` | `pnpm fuzz`, about 30 s | `pnpm fuzz:long` |
| Saved crashing inputs | `tests/fuzz/regressions/*.json` | replayed by `pnpm test` | written by `pnpm fuzz:long` |

## Property-based tests

fast-check (MIT, development only) generates inputs and shrinks a failing one to a small counterexample. Every property runs with a fixed seed. The settings are in `tests/property/support.ts`:

- `FC_SEED=1234` another fixed seed; `FC_SEED=random` a fresh seed on every run (printed with the counterexample on failure).
- `FC_RUNS_FACTOR=20` twenty times as many cases per property. The timeout of each test grows with it.

A failure prints `seed`, `path` and the shrunk counterexample; run the same test with the same `FC_SEED` to replay it.

Covered: board transforms, camera, hit testing and clipping, the measurement line, cross-probe matching, note keys (escaping is an exact inverse), the workspace and note validators against their native twins, part-value parsing, net classes, board fingerprints, and the queued JSON store under random interleavings and injected failures. `pnpm test:types` type-checks these files, which the application tsconfig leaves out.

## Parser fuzzing

### What is fed

Everything is taken from the registries, so an adapter that is registered later (its folder under `src/lib/formats/adapters/`) is fuzzed without editing the harness, with the seeds of its own `fixtures.ts`:

| Target | What is fed, and what is checked besides the common contract |
| --- | --- |
| `board:<id>` for every board adapter | the adapter's own parse (`PARSERS`), called directly so that a bug is not hidden by the dispatcher's wrapper |
| `board:dispatch` | `parseBoard`: sniffing, ranking, the ambiguity refusal, containers, the budgets; the dispatcher's "unexpected parser failure" wrapper is a finding |
| `sniff:<id>` for every board adapter and container | the sniff on the whole file and on its first half given the size of the whole: total, an integer confidence from 0 to 100, a reason exactly when it is above 0, bounded metadata (`checkSniffResult`) |
| `container:<id>` | the members of an archive: names that stay inside the folder, a declared size that is kept, a head within its limit, at most the registered number of members, unpacking within a budget |
| `util:sniff-board` | `sniffBoard`, the identification used by file listings: candidates ordered by confidence, registered ids, an ambiguity flag that agrees with them |
| `schematic:<id>`, `schematic:dispatch`, `schematic:design` | the schematic readers (KiCad, KiCad legacy, EAGLE, Altium), the dispatcher, and reader plus connectivity engine |
| `util:inflate-zlib`, `util:inflate-raw`, `util:sexpr`, `util:xml-root`, `util:decode-text`, `util:utf8-input` | the shared low-level readers: the two inflaters against the reference inflater, the s-expression reader, the XML prolog reader, text decoding |
| `util:xml-scanner` | the XML scanner of IPC-2581: the same events (or the same kind of failure) however the text is cut into pieces; every end tag closes a start tag |
| `util:csv-tokenizer`, `util:pinlist-analysis` | the CSV tokenizer of the pin list: the same records however the text is cut, at most 512 fields of at most 4096 characters, lines never go back; the column analysis is total |
| `util:ipc356-text` | the IPC-D-356 record reader: features within the importer limit, finite numbers, rotation in 0 to 359 |
| `util:compound-file` | the OLE container of Altium: what it hands out stays within twice the size of the file |
| `util:zip` | the ZIP reader of EasyEDA Pro: an entry inflates to exactly its declared size or is refused; at most 50,000 entries |
| `readings:csv`, `readings:openboarddata` | the readings importers: a documented `ReadingsError` or a result whose readings the validator accepts unchanged, within the reading limit, with bounded issue texts |
| `readings:pack` | a readings pack: never throws; what is accepted is the same pack after it is written and read again |
| `readings:detect`, `readings:value` | the file-kind detection and the typed-value parser: total; a value is finite, within the limit, in the unit of its kind |

Asynchronous parsing (`parseBoardAsync`) runs the same core as `parseBoard`, so the synchronous dispatcher target covers it.

Inputs come from the seeds (the corpus `tests/fuzz/corpus/<adapter>.json`, about 480 KB in 24 files: small synthetic inputs taken from the adapter tests, valid ones, rejected ones and "not this format" ones, with their companion files and import options; for an adapter without a corpus file, the samples of its `fixtures.ts`; for the readings importers, tables, packs and OpenBoardData files made in code by the generators of the readings tests) by mutation: bit and byte changes, insertions and deletions, repeated and swapped ranges, dictionary words of the format, boundary numbers in decimal fields, boundary integers in binary fields, count fields times 1000, line deletion, duplication and floods, byte-order marks and UTF-16, deep nesting, long runs, splices of two seeds, truncation at every 1/64 of the length, token soup, random bytes with a format signature (a list of them, and the first bytes of the target's own seeds, so a new format needs no list), wrong file names (including every extension a registered adapter claims), wrong keys, and, for the IPC-D-356 and pin-list readers, import options (a quarter of their inputs: units, delimiter, column mapping, side words, limits, including extreme numbers). Binary seeds are mostly mutated without changing their length so that offsets and sizes stay plausible.

Every input is derived from `(seed, target, iteration)` alone (`tests/fuzz/prng.ts`), so a finding is replayed by those three values, runs can be split over any number of workers, and the CI run is the same everywhere.

### What is checked

For every input and every target:

1. Only the documented failures are thrown (`BoardFormatError` with a known code, including the dispatcher's `AMBIGUOUS_FORMAT`, `GenCadParseError`, `TextDecodeError` for the direct adapters, `SchematicError`). Any other exception is a finding. Dispatchers must not produce their "unexpected parser failure" wrapper.
2. An error message and every quoted parameter is at most 1000 characters.
3. A successful result satisfies the model contract (`tests/fuzz/invariants.ts`): finite coordinates and sizes, unique ids, every pin in its component and in the net it names, valid sides and shapes, bounded counts (importer limits), schematic ids and instance paths consistent, connectivity referring only to existing nets. Output is bounded in size.
4. The input bytes are not modified, and the same bytes (from a fresh copy) give the same result again.
5. The call returns within `400 ms + 6 ms per KiB` of input (`--time-scale` multiplies this). A time finding is only kept when the best of three runs is over the budget, so a pause of a busy machine does not count.
6. In the runner, a call that exceeds its budget by far is a hang (the worker is terminated and replaced), and a worker that runs out of its heap (`--heap-mb`, default 1 GiB, the memory budget of one input) is a memory finding.

### Short mode (CI)

- `pnpm test` runs `tests/fuzz/fuzz.test.ts`: per target the seeds, each cut at every 1/64 of its length (at fewer points for the targets that draw on the seeds of every format, so that a sweep has about 2,600 inputs), and 150 derived inputs (seed `ci-1`), about 10 s in total. `FUZZ_ITERATIONS`, `FUZZ_SEED`, `FUZZ_TIME_SCALE` change the run; `FUZZ_TARGET=board:kicad FUZZ_ITERATION=57 pnpm test tests/fuzz` replays one input and prints it.
- `pnpm fuzz` is the same run with 2000 derived inputs per target in worker threads with the hang and memory watch (about 30 s on four workers when the machine is idle, under a minute when it is busy). Exit status 1 when anything is found, with minimized inputs reported.
- `tests/fuzz/regressions.test.ts` replays every saved input.
- `tests/fuzz/engine.test.ts` checks the harness itself (determinism, each kind of finding, shrinking).

### Long mode (nightly)

```
pnpm fuzz:long                                     30 minutes, saves minimized crashes
node scripts/fuzz-parsers.cjs --mode long --minutes 120 --workers 6 --save
node scripts/fuzz-parsers.cjs --mode long --minutes 10 --targets board:kicad,schematic --seed my-seed
```

Long mode uses a fresh seed (printed; `--seed` repeats a run), inputs up to 1 MiB, round-robin over all targets in batches until the time is over, and prints a table per target (inputs, outcomes, error codes, slowest input). The report goes to `.fuzz/report/` (ignored by git). For every distinct finding the runner reproduces it, shrinks it (lines first, then bytes, then companions and options; at most 90 s each) and, with `--save`, writes `tests/fuzz/regressions/<target>-<kind>-<hash>.json`. Exit status: 0 nothing found, 1 findings, 2 the run itself failed.

A nightly job needs only Node 24 and the installed dependencies:

```
pnpm install --frozen-lockfile
pnpm fuzz:long        # keep tests/fuzz/regressions and .fuzz/report as artifacts of the job
```

### When something is found

1. Reproduce: `node scripts/fuzz-parsers.cjs --replay <target>:<iteration>` (iteration of a short run), or run the saved fixture through `pnpm test tests/fuzz/regressions`.
2. Decide: a real defect gets a minimal fix in its own commit with a unit test next to the parser; a finding that is only the harness being too strict is fixed in `tests/fuzz/invariants.ts` with a comment saying why.
3. Commit the fixture (`tests/fuzz/regressions/*.json`) together with the fix. It is generated from synthetic seeds, never a real vendor file, and is replayed by every test run from then on.

### Seed corpus

An adapter folder with a `fixtures.ts` is seeded from it (a fixture that the adapter refuses is a seed of kind `error`). A corpus file `tests/fuzz/corpus/<id>.json` replaces those samples for its adapter and is the place for seeds the fixtures do not offer, or for more of them. A reader that is never detected by its bytes (detection `none`) has no seeds and needs none. An entry of a corpus file is `{ id, kind, name, text | b64, companions?, options? }`. `text` is used when the bytes are plain UTF-8 text, otherwise `b64`. `kind` records what the adapter made of it when it was added (`valid`, `error`, `null`); the test run requires the `valid` ones to stay readable. Add seeds only from synthetic data: nothing from a real board file belongs in the repository.

## Coverage-guided fuzzing: Jazzer.js (decision)

Evaluated on paper, not added. Jazzer.js (Code Intelligence, Apache-2.0) is a coverage-guided fuzzer for Node on libFuzzer. It was judged from what is known of its public history, without network access while this was written, so the release dates below should be checked again before the decision is revisited: a long gap in releases (the 2.x line dates from 2023) followed by a 4.x line with ESM support; most recent commits are dependency updates; official support is for Node LTS on Linux x64, macOS and Windows x64 and anything else is best effort; it ships a native addon and instruments source through Babel. That is not "clearly maintained" for a dependency of this project, and it would put a native addon and a second instrumentation pipeline next to TypeScript sources that run here under Vite and Node 24. The harness above already gives mutation fuzzing with deterministic seeds, hang and memory watch and minimization with no native code. Because every target is a plain function from bytes to a result (`tests/fuzz/targets.ts`, `runCase` in `tests/fuzz/engine.ts`), a Jazzer entry (`module.exports.fuzz = data => runCase(target, ...)`) can be added later as an optional Linux nightly job outside the dependency set of the application, if its maintenance is confirmed or the mutation fuzzer stops finding new inputs.
