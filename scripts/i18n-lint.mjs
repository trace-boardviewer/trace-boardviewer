// i18n lint: user-visible English string literals in src/components/** and the `i18n: pending` markers.
//
// Every user-visible text of the interface comes from the catalogs (electron/locales/<language>/<namespace>.json, see
// docs/I18N.md). The legacy exception is the Phase 1 workspace, whose components keep local English tables marked
// `// i18n: pending`; src/lib/i18n-lint.test.ts holds the explicit allow-list of those files and fails when a literal or a
// marker is added anywhere else (or beyond the listed count). This module is the scanner. It parses with the AST parser that
// ships with Vite (vite.parseAst, oxc), so it adds no dependency and reads TSX properly.
//
//   node scripts/i18n-lint.mjs            print the findings and marker counts per file (the numbers of the allow-list)
//   node scripts/i18n-lint.mjs --json     the same as JSON
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAst } from 'vite';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const MARKER = 'i18n: pending';

/** Props whose string value is shown to people or read out by assistive technology. A literal here is user-visible text. */
export const VISIBLE_ATTRIBUTES = new Set([
  'aria-label', 'aria-description', 'aria-roledescription', 'aria-placeholder', 'aria-valuetext',
  'title', 'placeholder', 'alt', 'label', 'closeLabel', 'hint', 'caption', 'description', 'tooltip', 'heading', 'prompt', 'legend', 'summary',
]);
/** Keyboard key and modifier names: identifiers of the platform, not interface text. */
const KEY_NAMES = new Set([
  'Escape', 'Esc', 'Enter', 'Tab', 'Space', 'Home', 'End', 'PageUp', 'PageDown', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown',
  'Shift', 'Control', 'Ctrl', 'Alt', 'Option', 'Cmd', 'Meta', 'Delete', 'Backspace',
]);
/** Words that are brand or unit and never translated; they do not make a text "English". */
const TECHNICAL_TOKENS = /\b(?:TRACE|BOARDVIEWER)\b|\b(?:mm|px)\b/gi;
const withoutTechnicalTokens = value => value.replace(TECHNICAL_TOKENS, ' ');
const CATALOG_KEY = /^[a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9]+)+$/;
/** AST nodes that only pass a value on: a literal under them still belongs to the attribute or child that contains them. */
const TRANSPARENT = new Set([
  'JSXExpressionContainer', 'ConditionalExpression', 'LogicalExpression', 'TemplateLiteral', 'ParenthesizedExpression',
  'TSAsExpression', 'TSNonNullExpression', 'TSSatisfiesExpression', 'ArrayExpression', 'SequenceExpression',
]);
/** Type-level nodes: their literals are types, not values. */
const TYPE_NODES = new Set(['TSTypeAliasDeclaration', 'TSInterfaceDeclaration', 'TSTypeAnnotation', 'TSTypeParameterInstantiation', 'TSLiteralType', 'TSEnumDeclaration']);

/** A multi-word English sentence or a capitalised word: the shape of interface text. Single lowercase words are identifiers. */
export function looksLikeText(value) {
  const text = withoutTechnicalTokens(value).trim();
  if (!/\p{L}/u.test(text) || CATALOG_KEY.test(text) || KEY_NAMES.has(text)) return false;
  if (/monospace|sans-serif|serif/.test(text)) return false; // a font-family list
  const tokens = text.split(/\s+/);
  if (tokens.every(token => /^[a-z0-9_-]+$/.test(token)) && tokens.some(token => /[-_\d]/.test(token))) return false; // CSS class names
  return /\p{L}{3,}\s+\p{L}{2,}/u.test(text) || /^\p{Lu}\p{Ll}{2,}/u.test(text);
}

function lineStarts(code) {
  const starts = [0];
  for (let index = 0; index < code.length; index++) if (code[index] === '\n') starts.push(index + 1);
  return starts;
}
function lineOf(starts, offset) {
  let low = 0, high = starts.length - 1;
  while (low < high) { const middle = (low + high + 1) >> 1; if (starts[middle] <= offset) low = middle; else high = middle - 1; }
  return low + 1;
}
function attributeName(node) {
  const name = node.name;
  return name.type === 'JSXNamespacedName' ? `${name.namespace.name}:${name.name.name}` : name.name;
}

/** The JSX attribute a literal is the (possibly conditional or concatenated) value of, or undefined when it is not directly one. */
function owningAttribute(ancestors) {
  for (let index = ancestors.length - 1; index >= 0; index--) {
    const node = ancestors[index];
    if (node.type === 'JSXAttribute') return node;
    if (!TRANSPARENT.has(node.type)) return undefined;
  }
  return undefined;
}

/** True where a string is data, not text: a comparison, a switch label, a property name, a module specifier, a developer error. */
function isDataPosition(node, ancestors) {
  const parent = ancestors[ancestors.length - 1];
  if (!parent) return false;
  if (['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration', 'ImportExpression'].includes(parent.type)) return true;
  if (parent.type === 'BinaryExpression' && ['==', '===', '!=', '!=='].includes(parent.operator)) return true;
  if (parent.type === 'SwitchCase' && parent.test === node) return true;
  if ((parent.type === 'Property' || parent.type === 'PropertyDefinition') && parent.key === node && !parent.computed) return true;
  if (parent.type === 'MemberExpression' && parent.property === node) return true;
  return ancestors.some(ancestor => (ancestor.type === 'NewExpression' && ancestor.callee.type === 'Identifier' && /Error$/.test(ancestor.callee.name))
    || (ancestor.type === 'CallExpression' && ancestor.callee.type === 'MemberExpression' && ancestor.callee.object.type === 'Identifier' && ancestor.callee.object.name === 'console'));
}

function walk(node, ancestors, visit) {
  if (!node || typeof node.type !== 'string') return;
  if (TYPE_NODES.has(node.type)) return;
  visit(node, ancestors);
  const next = [...ancestors, node];
  for (const [key, value] of Object.entries(node)) {
    if (key === 'type' || key === 'start' || key === 'end') continue;
    if (Array.isArray(value)) { for (const child of value) walk(child, next, visit); }
    else if (value && typeof value === 'object') walk(value, next, visit);
  }
}

/**
 * User-visible string literals of a TypeScript or TSX source: JSX text, text-bearing props (`title`, `aria-label`, ...), and any
 * other string that reads like interface text. Returns [{ line, kind: 'text' | 'prop' | 'string', text }].
 */
export function findLiterals(code, fileName) {
  const ast = parseAst(code, { lang: fileName.endsWith('x') ? 'tsx' : 'ts' });
  const starts = lineStarts(code);
  const found = [];
  walk(ast, [], (node, ancestors) => {
    if (node.type === 'JSXText') {
      if (/\p{L}{2,}/u.test(withoutTechnicalTokens(node.value))) found.push({ line: lineOf(starts, node.start), kind: 'text', text: node.value.trim() });
      return;
    }
    let value;
    if (node.type === 'Literal' && typeof node.value === 'string') value = node.value;
    else if (node.type === 'TemplateElement') value = node.value.cooked ?? '';
    else return;
    if (isDataPosition(node, ancestors)) return;
    const attribute = owningAttribute(ancestors);
    if (attribute) {
      if (!VISIBLE_ATTRIBUTES.has(attributeName(attribute))) return;
      if (/\p{L}{2,}/u.test(withoutTechnicalTokens(value)) && !CATALOG_KEY.test(value.trim())) found.push({ line: lineOf(starts, node.start), kind: 'prop', text: value });
      return;
    }
    if (looksLikeText(value)) found.push({ line: lineOf(starts, node.start), kind: 'string', text: value.trim() });
  });
  return found;
}

/** Number of `i18n: pending` markers in a source text. */
export function countMarkers(code) {
  return code.split(MARKER).length - 1;
}

function* walkFiles(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) { if (entry.name !== 'node_modules') yield* walkFiles(full); } else yield full;
  }
}
const toPosix = (file, root) => path.relative(root, file).split(path.sep).join('/');

/** Component sources (not tests, not styles) whose literals are scanned. */
export function componentFiles(root = ROOT) {
  return [...walkFiles(path.join(root, 'src', 'components'))].map(file => toPosix(file, root)).filter(file => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file)).sort();
}
/** Sources that may carry `i18n: pending` markers: the renderer (src) and the main process (electron), without tests. */
export function markerFiles(root = ROOT) {
  const files = [...walkFiles(path.join(root, 'src')), ...walkFiles(path.join(root, 'electron'))].map(file => toPosix(file, root));
  return files.filter(file => /\.(?:tsx?|cjs|mjs)$/.test(file) && !/\.test\.tsx?$/.test(file) && !file.endsWith('.d.mts')).sort();
}

/** { 'src/components/x.tsx': [findings] } for every component with at least one finding. */
export function scanComponents(root = ROOT) {
  const result = {};
  for (const file of componentFiles(root)) {
    const findings = findLiterals(readFileSync(path.join(root, file), 'utf8'), file);
    if (findings.length) result[file] = findings;
  }
  return result;
}
/** { 'src/x.ts': count } for every source with at least one marker. */
export function scanMarkers(root = ROOT) {
  const result = {};
  for (const file of markerFiles(root)) {
    const count = countMarkers(readFileSync(path.join(root, file), 'utf8'));
    if (count) result[file] = count;
  }
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const literals = scanComponents();
  const markers = scanMarkers();
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ literals: Object.fromEntries(Object.entries(literals).map(([file, list]) => [file, list.length])), markers }, null, 2));
  } else {
    const totalLiterals = Object.values(literals).reduce((sum, list) => sum + list.length, 0);
    const totalMarkers = Object.values(markers).reduce((sum, count) => sum + count, 0);
    console.log(`English literals in src/components: ${totalLiterals} in ${Object.keys(literals).length} files`);
    for (const [file, list] of Object.entries(literals)) {
      console.log(`  ${file}: ${list.length}`);
      if (process.argv.includes('--verbose')) for (const item of list) console.log(`    ${item.line}  ${item.kind}  ${JSON.stringify(item.text).slice(0, 100)}`);
    }
    console.log(`${MARKER} markers: ${totalMarkers} in ${Object.keys(markers).length} files`);
    for (const [file, count] of Object.entries(markers)) console.log(`  ${file}: ${count}`);
  }
}
