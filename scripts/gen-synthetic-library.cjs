'use strict';

/*
 * Synthetic library generator: writes a deterministic collection of invented board files, schematics, datasheets, photos, firmware,
 * archives and chaos (copies, renamed and mis-named files, truncated files, hostile archives) plus the ground truth that says what
 * every file is. It exists to test and measure the Library (a local index over a technician's folders) without any real board.
 *
 *   node scripts/gen-synthetic-library.cjs --preset=small  --seed=1 --out=<dir>
 *   node scripts/gen-synthetic-library.cjs --files=5000 --bytes=1G --seed=7 --out=<dir>
 *
 * Options
 *   --files=<n>      number of files on disk (archive members are extra)
 *   --bytes=<size>   upper bound of the total size of the files (5000000, 64M, 1G, ...); the library lands at 90 to 100 % of it
 *   --seed=<s>       any text or number; the same seed and options always give the same bytes
 *   --out=<dir>      where to write; must be empty or missing unless --force, and must not be inside this repository
 *   --preset=<name>  small (400 files, 32 MiB), medium (5,000 files, 1 GiB) or scale (100,000 files, 15 GiB); --files and --bytes override
 *   --force          write into a folder that holds an earlier synthetic library (only its own files are replaced)
 *   --no-bench       board files come from the model generator only (default: some come from scripts/gen-synthetic-board.cjs)
 *   --no-hostile     leave out the hostile archives and signature-only files
 *   --json           print the manifest as JSON
 *
 * What is written (nothing outside --out; never committed):
 *   <out>/library/            the files to scan: use this folder as the Library root
 *   <out>/ground-truth.json   per file: family, revision, role, kind, format, duplicate set, strong component, part numbers; families and groups
 *   <out>/ground-truth.schema.json, <out>/result.schema.json   JSON Schemas of the truth and of a grouping result (metrics runner)
 *   <out>/manifest.json       options, totals, file mix, generation time and a hash of the tree
 *
 * The generator core is TypeScript in src/lib/library/testing/ (shared with the vitest builders) and runs through Node's built-in type stripping.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const REPO = path.resolve(__dirname, '..');
const CORE = path.join(REPO, 'src', 'lib', 'library', 'testing');
const MARKER = 'trace-synthetic-library';
const OWN_ENTRIES = ['library', 'ground-truth.json', 'ground-truth.schema.json', 'result.schema.json', 'manifest.json'];

/** The path as the file system API should see it: on Windows the extended form, so paths over 260 characters work. */
function fsPath(target) {
  if (process.platform !== 'win32') return target;
  const absolute = path.win32.resolve(target);
  return absolute.startsWith('\\\\?\\') ? absolute : absolute.startsWith('\\\\') ? `\\\\?\\UNC\\${absolute.slice(2)}` : `\\\\?\\${absolute}`;
}

function realOrSelf(target) {
  try { return fs.realpathSync.native(target); } catch { return path.resolve(target); }
}

/** Throws unless `out` may be written: outside the repository, not above it, empty (or a folder this generator wrote when `force`). */
function checkOutput(out, force) {
  const target = path.resolve(out);
  const where = realOrSelf(target);
  const repo = realOrSelf(REPO);
  const inside = (parent, child) => { const relative = path.relative(parent, child); return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative)); };
  if (inside(repo, where) || inside(repo, target)) throw new Error(`--out ${target} is inside the repository; generated libraries are never kept in it`);
  if (inside(where, repo)) throw new Error(`--out ${target} contains the repository`);
  if (!fs.existsSync(target)) return target;
  if (!fs.statSync(target).isDirectory()) throw new Error(`--out ${target} exists and is not a folder`);
  const entries = fs.readdirSync(target);
  if (entries.length === 0) return target;
  if (!force) throw new Error(`--out ${target} is not empty (use --force to replace an earlier synthetic library there)`);
  let manifest = null;
  try { manifest = JSON.parse(fs.readFileSync(path.join(target, 'manifest.json'), 'utf8')); } catch { /* not ours */ }
  if (!manifest || manifest.generator !== MARKER) throw new Error(`--out ${target} is not empty and holds no synthetic library; nothing was changed`);
  for (const name of OWN_ENTRIES) fs.rmSync(fsPath(path.join(target, name)), { recursive: true, force: true });
  return target;
}

function nodeSupportsTypeStripping() {
  return Boolean(process.features && process.features.typescript);
}

async function loadCore() {
  if (!nodeSupportsTypeStripping()) throw new Error(`this script runs TypeScript through Node's type stripping: use Node 22.18 or newer (this is ${process.version})`);
  const load = name => import(pathToFileURL(path.join(CORE, name)).href);
  const [library, presets, groundTruth, metrics] = await Promise.all([load('library.ts'), load('presets.ts'), load('ground-truth.ts'), load('metrics.ts')]);
  return { library, presets, groundTruth, metrics };
}

/** GenCAD text of the benchmark generator for the library's board source. */
function benchGenCad() {
  const generator = require('./gen-synthetic-board.cjs');
  return (pins, seed) => {
    const chunks = [];
    generator.generateGenCad({ pins, seed }, { write: text => { chunks.push(text); } });
    return chunks.join('');
  };
}

function nodeHasher() {
  return bytes => crypto.createHash('sha256').update(bytes).digest('hex');
}

/** The truth as JSON text: one line per family, item, group and duplicate set, so a diff of two truths is readable. */
function truthText(truth) {
  const lines = array => array.map(entry => `  ${JSON.stringify(entry)}`).join(',\n');
  const head = ['schemaVersion', 'generator', 'options', 'totals'].map(key => ` ${JSON.stringify(key)}: ${JSON.stringify(truth[key])}`).join(',\n');
  const arrays = ['families', 'items', 'groups', 'duplicateSets'].map(key => ` ${JSON.stringify(key)}: [\n${lines(truth[key])}\n ]`).join(',\n');
  return `{\n${head},\n${arrays},\n "partIndex": ${JSON.stringify(truth.partIndex)}\n}\n`;
}

/** Hash of the tree: every file's path and content hash in path order. Equal for two runs of the same options. */
function treeHash(truth) {
  const hash = crypto.createHash('sha256');
  for (const item of [...truth.items].filter(entry => !entry.container).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) hash.update(`${item.path}\0${item.size}\0${item.sha256}\n`);
  return hash.digest('hex');
}

/**
 * Generates a library into `out`. `options` are the generator options (files, bytes, seed, preset, hostile); `bench` false leaves the
 * benchmark's GenCAD boards out. Returns { out, root, truth, manifest }.
 */
async function generateToDisk(options, out, { force = false, bench = true, log = () => {} } = {}) {
  const core = await loadCore();
  const target = checkOutput(out, force);
  const root = path.join(target, 'library');
  fs.mkdirSync(fsPath(root), { recursive: true });
  const made = new Set([root]);
  const sink = {
    writeFile({ path: segments, bytes, mtimeMs }) {
      const file = path.join(root, ...segments);
      const directory = path.dirname(file);
      if (!made.has(directory)) { fs.mkdirSync(fsPath(directory), { recursive: true }); made.add(directory); }
      fs.writeFileSync(fsPath(file), bytes);
      const when = new Date(mtimeMs);
      fs.utimesSync(fsPath(file), when, when);
    },
  };
  const started = Date.now();
  const generated = core.library.generateLibrary({ ...options, hasher: nodeHasher(), benchGenCad: bench ? benchGenCad() : null }, sink);
  const { truth, stats } = generated;
  const problems = core.metrics.validateResult({ version: core.metrics.RESULT_VERSION, groups: [] });
  if (problems.length) throw new Error(`internal: ${problems.join('; ')}`);
  fs.writeFileSync(path.join(target, 'ground-truth.json'), truthText(truth));
  fs.writeFileSync(path.join(target, 'ground-truth.schema.json'), `${JSON.stringify(core.groundTruth.GROUND_TRUTH_SCHEMA, null, 2)}\n`);
  fs.writeFileSync(path.join(target, 'result.schema.json'), `${JSON.stringify(core.metrics.RESULT_SCHEMA, null, 2)}\n`);
  const manifest = {
    generator: MARKER, generatorVersion: core.groundTruth.GENERATOR_VERSION, schemaVersion: core.groundTruth.GROUND_TRUTH_SCHEMA_VERSION,
    options: { files: generated.options.files, bytes: generated.options.bytes, seed: generated.options.seed, preset: generated.options.preset, bench, hostile: generated.options.hostile },
    stats: { ...stats, ms: Date.now() - started }, treeHash: treeHash(truth), node: process.version, platform: process.platform,
  };
  fs.writeFileSync(path.join(target, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  log(`${stats.files} files + ${stats.members} archive members, ${(stats.bytes / 1048576).toFixed(1)} MiB, ${stats.families} families, ${manifest.stats.ms} ms`);
  return { out: target, root, truth, manifest };
}

/** Checks that the files under <out>/library match the ground truth in <out> (size and SHA-256 of every file). Returns the list of problems. */
function verifyLibrary(out, limit = 20) {
  const truth = JSON.parse(fs.readFileSync(path.join(out, 'ground-truth.json'), 'utf8'));
  const problems = [];
  for (const item of truth.items) {
    if (item.container) continue;
    const file = path.join(out, 'library', ...item.path.split('/'));
    let bytes;
    try { bytes = fs.readFileSync(fsPath(file)); } catch { problems.push(`missing ${item.path}`); if (problems.length >= limit) break; continue; }
    if (bytes.length !== item.size) problems.push(`size ${item.path}: ${bytes.length} instead of ${item.size}`);
    else if (crypto.createHash('sha256').update(bytes).digest('hex') !== item.sha256) problems.push(`hash ${item.path}`);
    if (problems.length >= limit) break;
  }
  return problems;
}

function parseArguments(argv, presets) {
  const value = name => { const hit = argv.find(item => item === `--${name}` || item.startsWith(`--${name}=`)); return hit === undefined ? undefined : hit.includes('=') ? hit.slice(name.length + 3) : ''; };
  const flag = name => argv.includes(`--${name}`);
  const known = new Set(['files', 'bytes', 'seed', 'out', 'preset', 'force', 'no-bench', 'no-hostile', 'json', 'help', 'quiet']);
  for (const item of argv) {
    const name = /^--([^=]+)/.exec(item);
    if (!name || !known.has(name[1])) throw new Error(`unknown argument ${item}; --help shows usage`);
  }
  const files = value('files') === undefined ? undefined : Number(value('files'));
  const bytes = value('bytes') === undefined ? undefined : presets.parseByteSize(value('bytes'));
  const seedText = value('seed');
  return {
    help: flag('help'), json: flag('json'), quiet: flag('quiet'), force: flag('force'), bench: !flag('no-bench'), out: value('out'),
    options: { ...(files !== undefined ? { files } : {}), ...(bytes !== undefined ? { bytes } : {}), seed: seedText === undefined || seedText === '' ? undefined : (/^\d+$/.test(seedText) ? Number(seedText) : seedText), preset: value('preset') || null, hostile: !flag('no-hostile') },
  };
}

async function main(argv) {
  try {
    const presets = await import(pathToFileURL(path.join(CORE, 'presets.ts')).href);
    const args = parseArguments(argv, presets);
    if (args.help || argv.length === 0) { console.log(require('node:fs').readFileSync(__filename, 'utf8').split('*/')[0].replace(/^'use strict';\s*\/\*\n?/, '')); return 0; }
    if (!args.out) throw new Error('give --out=<dir>');
    const options = presets.resolveOptions({ ...args.options, seed: args.options.seed === undefined ? 1 : args.options.seed });
    const result = await generateToDisk(options, args.out, { force: args.force, bench: args.bench, log: args.quiet ? () => {} : message => console.log(message) });
    if (args.json) console.log(JSON.stringify(result.manifest, null, 2));
    else if (!args.quiet) {
      console.log(`library root: ${result.root}`);
      console.log(`ground truth: ${path.join(result.out, 'ground-truth.json')}`);
    }
    return 0;
  } catch (error) {
    console.error(error.message);
    return 1;
  }
}

module.exports = { MARKER, checkOutput, fsPath, generateToDisk, verifyLibrary, truthText, treeHash, loadCore, benchGenCad };

if (require.main === module) main(process.argv.slice(2)).then(code => { process.exitCode = code; });
