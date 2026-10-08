'use strict';

// Content-free format diagnostic report (trace-format-diagnostic/1): the one validator of the closed whitelist in
// diagnostic-schema.json, the canonical serialization the save dialog writes, and the dedupe code. The main process validates
// every report the renderer hands over before anything is written; the tests and owner-side scripts use the same functions.
// Nothing here touches the network, the clipboard or a file: the caller owns every input and output.
const crypto = require('node:crypto');
const SCHEMA = require('./diagnostic-schema.json');

const SCHEMA_ID = SCHEMA.$id;
const MAX_BYTES = SCHEMA.maxBytes;
/** Upper bound of nodes one validation visits, so a hostile object graph costs bounded work before anything is rejected. */
const MAX_NODES = 200000;
const SECRET_BYTES = 32;
const DEDUPE_BYTES = 8;

function invalid(path, reason) {
  return Object.assign(new Error(`Invalid diagnostic report at ${path}: ${reason}.`), { code: 'DIAGNOSTIC_INVALID' }); // Developer-facing; the UI shows its own text.
}

/** Two significant digits, the rounding every count and ratio of the report uses (0 stays 0). */
function roundSig2(value) {
  if (!Number.isFinite(value) || value === 0) return 0;
  return Number(value.toPrecision(2));
}

const isPlainObject = (value) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};
const enumValues = (name) => {
  const values = SCHEMA.enums[name];
  if (!Array.isArray(values)) throw new TypeError(`diagnostic-schema.json: unknown enumeration ${name}`); // Schema defect, developer-facing.
  return values;
};
const resolve = (node) => (node.ref ? SCHEMA.definitions[node.ref] : node);
const patterns = new Map();
const patternOf = (source) => {
  let pattern = patterns.get(source);
  if (!pattern) { pattern = new RegExp(source); patterns.set(source, pattern); }
  return pattern;
};
const hasDecimals = (value, decimals) => Number(value.toFixed(decimals)) === value;

/**
 * Checks `value` against `node` and returns a fresh copy that holds only what the schema names, in schema order (so a validated
 * report can never carry a getter, a prototype or an extra key into the file). Throws DIAGNOSTIC_INVALID with the path.
 */
function check(value, rawNode, path, context) {
  if (++context.nodes > MAX_NODES) throw invalid(path, 'too many values');
  const node = resolve(rawNode);
  if (node.level === 2 && context.level !== 2) throw invalid(path, 'a level-2 field in a level-1 report');
  if (value === null) {
    if (node.nullable === true || rawNode.nullable === true) return null;
    throw invalid(path, 'null is not allowed');
  }
  switch (node.type) {
    case 'const':
      if (!Object.is(value, node.value)) throw invalid(path, 'unexpected value');
      return value;
    case 'boolean':
      if (typeof value !== 'boolean') throw invalid(path, 'expected a boolean');
      return value;
    case 'enum':
      if (typeof value !== 'string' || !enumValues(node.values).includes(value)) throw invalid(path, 'not in the enumeration');
      return value;
    case 'integer':
      if (!Number.isSafeInteger(value) || value < node.min || value > node.max) throw invalid(path, 'integer out of range');
      return value;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value) || value < node.min || value > node.max || !hasDecimals(value, node.decimals)) throw invalid(path, 'number out of range or not rounded');
      return value;
    case 'sig2':
      if (!Number.isSafeInteger(value) || value < 0 || value > node.max || roundSig2(value) !== value) throw invalid(path, 'expected a count rounded to two significant digits');
      return value;
    case 'sig2real':
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > node.max || roundSig2(value) !== value) throw invalid(path, 'expected a number rounded to two significant digits');
      return value;
    case 'share':
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1 || !hasDecimals(value, 2)) throw invalid(path, 'expected a share between 0 and 1 with two decimals');
      return value;
    case 'string':
      if (typeof value !== 'string' || value.length > node.maxLength || !patternOf(node.pattern).test(value)) throw invalid(path, 'string does not match its pattern');
      return value;
    case 'array': {
      if (!Array.isArray(value)) throw invalid(path, 'expected an array');
      if (value.length < (node.minItems ?? 0) || value.length > node.maxItems) throw invalid(path, 'array length out of range');
      const copy = [];
      for (let index = 0; index < value.length; index++) {
        if (!Object.hasOwn(value, index)) throw invalid(`${path}[${index}]`, 'missing array item');
        copy.push(check(value[index], node.items, `${path}[${index}]`, context));
      }
      return copy;
    }
    case 'tuple': {
      if (!Array.isArray(value) || value.length !== node.items.length) throw invalid(path, 'expected a tuple');
      return node.items.map((item, index) => {
        if (!Object.hasOwn(value, index)) throw invalid(`${path}[${index}]`, 'missing tuple item');
        return check(value[index], item, `${path}[${index}]`, context);
      });
    }
    case 'record': {
      if (!isPlainObject(value)) throw invalid(path, 'expected an object');
      const keys = Object.keys(value);
      if (keys.length > node.maxEntries) throw invalid(path, 'too many entries');
      if (Object.getOwnPropertySymbols(value).length) throw invalid(path, 'symbol keys are not allowed');
      const allowed = node.keys.enum ? new Set(enumValues(node.keys.enum)) : null;
      const pattern = node.keys.pattern ? patternOf(node.keys.pattern) : null;
      const copy = {};
      for (const key of keys.sort()) {
        if (allowed ? !allowed.has(key) : !pattern.test(key)) throw invalid(`${path}.${JSON.stringify(key).slice(0, 40)}`, 'key not whitelisted');
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !('value' in descriptor)) throw invalid(path, 'accessor properties are not allowed');
        Object.defineProperty(copy, key, { value: check(descriptor.value, node.values, `${path}.${key}`, context), enumerable: true, writable: true, configurable: true });
      }
      return copy;
    }
    case 'object': {
      if (!isPlainObject(value)) throw invalid(path, 'expected an object');
      if (Object.getOwnPropertySymbols(value).length) throw invalid(path, 'symbol keys are not allowed');
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(node.properties, key)) throw invalid(`${path}.${JSON.stringify(key).slice(0, 40)}`, 'field not whitelisted');
      }
      for (const key of node.required) if (!Object.hasOwn(value, key)) throw invalid(`${path}.${key}`, 'required field missing');
      const copy = {};
      for (const [key, child] of Object.entries(node.properties)) {
        if (!Object.hasOwn(value, key)) continue;
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!('value' in descriptor)) throw invalid(`${path}.${key}`, 'accessor properties are not allowed');
        copy[key] = check(descriptor.value, child, `${path}.${key}`, context);
      }
      return copy;
    }
    default:
      throw new TypeError(`diagnostic-schema.json: unknown node type at ${path}`); // Schema defect, developer-facing.
  }
}

/** The cross-field rules listed in diagnostic-schema.json ("rules"). */
function checkRules(report) {
  if (report.privacy.dedupe !== (typeof report.dedupe === 'string')) throw invalid('root.dedupe', 'present exactly when privacy.dedupe is true');
  const opened = report.detection.outcome === 'opened';
  if (opened !== (report.result !== null) || opened !== (report.plausibility !== null)) throw invalid('root.result', 'result and plausibility belong to an opened file only');
  if ((report.detection.outcome === 'unrecognized') !== (report.detection.selected === null && !report.detection.ambiguous)) throw invalid('root.detection.selected', 'null exactly for an unrecognized or an ambiguous file');
  if (report.detection.ambiguous && report.detection.outcome !== 'failed') throw invalid('root.detection.ambiguous', 'an ambiguous file is never opened');
}

/**
 * Validates a report and returns its canonical copy. `options.reviewed` additionally requires privacy.reviewedByUser (the save
 * path: only a report the user saw in the review dialog is written).
 */
function validateReport(value, options = {}) {
  if (!isPlainObject(value)) throw invalid('root', 'expected an object');
  const level = isPlainObject(value.privacy) ? value.privacy.level : undefined;
  const context = { nodes: 0, level: level === 2 ? 2 : 1 };
  const report = check(value, SCHEMA.root, 'root', context);
  checkRules(report);
  if (options.reviewed === true && report.privacy.reviewedByUser !== true) throw invalid('root.privacy.reviewedByUser', 'the report was not reviewed');
  if (Buffer.byteLength(serializeReport(report), 'utf8') > MAX_BYTES) throw invalid('root', 'the report is too large');
  return report;
}

/** Canonical file text: schema field order, two-space indentation, one trailing newline. */
function serializeReport(report) {
  return `${JSON.stringify(report, null, 2)}\n`;
}

/**
 * Every whitelisted field as one line "path: type and constraint", sorted. src/lib/diagnostics/schema.golden.txt holds the
 * expected list, so a field added to the schema without updating it (or the reverse) fails the golden test.
 */
function schemaFields() {
  const lines = [];
  const describe = (rawNode) => {
    const node = resolve(rawNode);
    const nullable = rawNode.nullable === true || node.nullable === true ? '?' : '';
    const level = node.level === 2 ? ' [level 2]' : '';
    switch (node.type) {
      case 'enum': return `enum(${node.values}: ${enumValues(node.values).length})${nullable}${level}`;
      case 'const': return `const(${JSON.stringify(node.value)})${nullable}${level}`;
      case 'integer': return `integer(${node.min}..${node.max})${nullable}${level}`;
      case 'number': return `number(${node.min}..${node.max}, ${node.decimals} decimals)${nullable}${level}`;
      case 'sig2': return `sig2(..${node.max})${nullable}${level}`;
      case 'sig2real': return `sig2real(..${node.max})${nullable}${level}`;
      case 'share': return `share${nullable}${level}`;
      case 'string': return `string(${node.pattern})${nullable}${level}`;
      case 'boolean': return `boolean${nullable}${level}`;
      default: return `${node.type}${nullable}${level}`;
    }
  };
  const walk = (rawNode, path) => {
    const node = resolve(rawNode);
    lines.push(`${path}: ${describe(rawNode)}`);
    if (node.type === 'object') for (const [key, child] of Object.entries(node.properties)) walk(child, `${path}.${key}${node.required.includes(key) ? '' : '(optional)'}`);
    else if (node.type === 'array') walk(node.items, `${path}[]`);
    else if (node.type === 'tuple') node.items.forEach((item, index) => walk(item, `${path}[${index}]`));
    else if (node.type === 'record') walk(node.values, `${path}{${node.keys.enum ? `enum ${node.keys.enum}: ${enumValues(node.keys.enum).length}` : node.keys.pattern}}`);
  };
  walk(SCHEMA.root, 'root');
  return lines.sort();
}

/**
 * The whole whitelist as text: every field (see schemaFields) and, for each enumeration, every member on a line of its own.
 * src/lib/diagnostics/schema.golden.txt holds the expected text, so a member added to or removed from any list shows up as a
 * line in the review of the change that makes it.
 */
function schemaDescription() {
  const enums = Object.entries(SCHEMA.enums).map(([name, values]) => ['enum ' + name, ...values.map((value) => '  ' + value)].join('\n'));
  return [...schemaFields(), '', ...enums].join('\n') + '\n';
}

// --- Dedupe code ----------------------------------------------------------------------------------------------------------------
// An optional 8-byte HMAC-SHA256 of the file bytes under a random secret of this installation: the same tester gets the same code
// for the same file, anyone else (without the secret) can neither reproduce nor test it. Never an unsalted hash: a public hash
// would let anyone prove that a tester holds a specific file. The secret stays in the profile and is never part of a report.

/** A stored secret ({ version: 1, secret: <64 hex> }) or null when the value is missing or damaged. */
function parseSecret(stored) {
  if (!isPlainObject(stored) || stored.version !== 1 || typeof stored.secret !== 'string' || !/^[0-9a-f]{64}$/.test(stored.secret)) return null;
  return Buffer.from(stored.secret, 'hex');
}
function newSecret(randomBytes = crypto.randomBytes) {
  return { version: 1, secret: Buffer.from(randomBytes(SECRET_BYTES)).toString('hex') };
}
/**
 * The code of one file set (the primary file plus its companions), framed like the board identity: entries sorted by lowercase
 * basename, each as name, NUL, uint64be length and bytes, so it never depends on which entry file was chosen.
 */
function dedupeCode(secret, entries) {
  if (!Buffer.isBuffer(secret) || secret.length !== SECRET_BYTES) throw new TypeError('The dedupe secret must be 32 bytes.'); // Developer-facing.
  const list = entries.map(({ name, data }) => [String(name).toLowerCase(), Buffer.from(data.buffer, data.byteOffset, data.byteLength)])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const hmac = crypto.createHmac('sha256', secret);
  for (const [name, data] of list) {
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(data.length));
    hmac.update(Buffer.from(name, 'utf8')).update(Buffer.from([0])).update(length).update(data);
  }
  return hmac.digest().subarray(0, DEDUPE_BYTES).toString('hex');
}

// --- What the renderer gets for the chosen file ------------------------------------------------------------------------------------
/**
 * The name the parsers see. The report never carries a name, and the renderer does not get the user's one either: only the
 * lowercase extension (it selects some readers) survives, or the fixed public basename of a companion set member (format.asc,
 * pins.asc, nails.asc), whose role the ASC reader needs.
 */
function parserName(basename, isCompanionMember) {
  const lower = String(basename).toLowerCase();
  if (isCompanionMember) return lower;
  const match = /(\.[a-z0-9_]{1,10})$/.exec(lower);
  return `diagnostic${match ? match[1] : ''}`;
}
const OS_FAMILIES = new Set(SCHEMA.enums.os);
const osFamily = (platform) => (OS_FAMILIES.has(platform) && platform !== 'other' ? platform : 'other');

module.exports = Object.freeze({
  SCHEMA, SCHEMA_ID, MAX_BYTES, roundSig2, validateReport, serializeReport, schemaFields, schemaDescription, parseSecret, newSecret, dedupeCode, parserName, osFamily,
});
