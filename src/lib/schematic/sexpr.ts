/**
 * Iterative, bounded reader for KiCad s-expressions (https://dev-docs.kicad.org/en/file-formats/sexpr-intro/):
 * parentheses, bare tokens, double-quoted UTF-8 strings. Nothing here knows about schematics; it only turns text
 * into a tree and gives strict accessors. Written from the published syntax description.
 */
import { SCHEMATIC_LIMITS, SchematicError, type SchematicErrorCode } from './model';

export interface SexprAtom { readonly kind: 'atom'; readonly value: string; readonly quoted: boolean; readonly line: number }
export interface SexprList { readonly kind: 'list'; readonly items: SexprNode[]; readonly line: number }
export type SexprNode = SexprAtom | SexprList;

export interface SexprLimits {
  /** Characters of source text. */
  maxChars: number;
  /** Deepest allowed list nesting. */
  maxDepth: number;
  /** Atoms plus lists. */
  maxNodes: number;
}
export const DEFAULT_SEXPR_LIMITS: Readonly<SexprLimits> = Object.freeze({
  maxChars: 64 * 1024 * 1024,
  maxDepth: SCHEMATIC_LIMITS.maxNestingDepth,
  maxNodes: SCHEMATIC_LIMITS.maxExpression,
});

export const isAtom = (node: SexprNode): node is SexprAtom => node.kind === 'atom';
export const isList = (node: SexprNode): node is SexprList => node.kind === 'list';

export const sexprError = (message: string, code: SchematicErrorCode = 'INVALID_FORMAT'): SchematicError =>
  new SchematicError(message, code, 'kicad-sch');

const ESCAPES: Record<string, string> = { '\\': '\\', '"': '"', n: '\n', r: '\r', t: '\t' };

const isSpace = (c: number): boolean => c === 32 || (c >= 9 && c <= 13);

/** Reads exactly one top-level list; throws `SchematicError` (INVALID_FORMAT / LIMIT_EXCEEDED) otherwise. */
export function readSexpr(text: string, options: Partial<SexprLimits> = {}): { root: SexprList; nodes: number } {
  const limits = { ...DEFAULT_SEXPR_LIMITS, ...options };
  const n = text.length;
  if (n > limits.maxChars) throw sexprError(`Schematic text has ${n} characters; the limit is ${limits.maxChars}.`, 'LIMIT_EXCEEDED');
  const stack: SexprList[] = [];
  // Opening positions only matter for the unterminated-list message; kept parallel to `stack`.
  const openCols: number[] = [];
  let root: SexprList | null = null;
  let nodes = 0;
  let line = 1;
  let lineStart = 0;
  let i = 0;

  const count = (): void => {
    if (++nodes > limits.maxNodes) throw sexprError(`Schematic has more than ${limits.maxNodes} expression nodes (line ${line}).`, 'LIMIT_EXCEEDED');
  };
  const place = (node: SexprNode): void => {
    const parent = stack[stack.length - 1];
    if (parent) { parent.items.push(node); return; }
    root = node as SexprList;
  };

  while (i < n) {
    const c = text.charCodeAt(i);
    if (c === 10) { line++; i++; lineStart = i; continue; }
    if (isSpace(c)) { i++; continue; }
    const column = i - lineStart + 1;
    if (!root && stack.length === 0 && c !== 40) {
      throw sexprError(c === 41
        ? `Unexpected ")" at line ${line}, column ${column}.`
        : `Expected "(" to start the schematic at line ${line}, column ${column}.`);
    }
    if (root && stack.length === 0) {
      throw sexprError(c === 41
        ? `Unexpected ")" at line ${line}, column ${column}.`
        : `Unexpected content after the closing parenthesis of the top-level expression at line ${line}, column ${column}.`);
    }
    if (c === 40) {
      if (stack.length >= limits.maxDepth) throw sexprError(`Expressions nest deeper than ${limits.maxDepth} levels at line ${line}.`, 'LIMIT_EXCEEDED');
      count();
      const list: SexprList = { kind: 'list', items: [], line };
      place(list);
      stack.push(list);
      openCols.push(column);
      i++;
      continue;
    }
    if (c === 41) {
      if (stack.length === 0) throw sexprError(`Unexpected ")" at line ${line}, column ${column}.`);
      stack.pop();
      openCols.pop();
      i++;
      continue;
    }
    if (c === 34 || c === 124) {
      // "..." with escapes, or |...| as an opaque blob (embedded binary data); both become a quoted atom.
      const startLine = line;
      const quote = c;
      let out = '';
      let chunk = ++i;
      for (;;) {
        if (i >= n) throw sexprError(`Unterminated ${quote === 34 ? 'string' : 'blob'} starting at line ${startLine}, column ${column}.`);
        const ch = text.charCodeAt(i);
        if (ch === quote) { out += text.slice(chunk, i); i++; break; }
        if (ch === 92 && quote === 34) {
          out += text.slice(chunk, i);
          if (i + 1 >= n) throw sexprError(`Unterminated string starting at line ${startLine}, column ${column}.`);
          const next = text[i + 1]!;
          out += ESCAPES[next] ?? `\\${next}`;
          if (next === '\n') { line++; lineStart = i + 2; }
          i += 2;
          chunk = i;
          continue;
        }
        if (ch === 10) { line++; lineStart = i + 1; }
        i++;
      }
      count();
      place({ kind: 'atom', value: out, quoted: true, line: startLine });
      continue;
    }
    const start = i;
    while (i < n) {
      const ch = text.charCodeAt(i);
      if (ch === 40 || ch === 41 || isSpace(ch)) break;
      if (ch === 34) throw sexprError(`Unexpected quote inside a token at line ${line}, column ${i - lineStart + 1}.`);
      i++;
    }
    count();
    place({ kind: 'atom', value: text.slice(start, i), quoted: false, line });
  }

  if (stack.length > 0) {
    const innermost = stack[stack.length - 1]!;
    throw sexprError(`Unterminated expression: ${stack.length} unclosed "(" at the end of the file (the innermost was opened at line ${innermost.line}, column ${openCols[openCols.length - 1]}).`);
  }
  if (!root) throw sexprError('The schematic is empty: expected a "(" expression.');
  return { root, nodes };
}

/** Head token of a list: its first item when that is a bare (unquoted) atom. */
export function listHead(list: SexprList): string | undefined {
  const first = list.items[0];
  return first && first.kind === 'atom' && !first.quoted ? first.value : undefined;
}

export function childLists(list: SexprList, name: string): SexprList[] {
  const found: SexprList[] = [];
  for (const item of list.items) if (item.kind === 'list' && listHead(item) === name) found.push(item);
  return found;
}

export function childList(list: SexprList, name: string): SexprList | undefined {
  for (const item of list.items) if (item.kind === 'list' && listHead(item) === name) return item;
  return undefined;
}

const NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

/** Strict finite number from a bare token (or its text); never returns NaN, Infinity or negative zero. */
export function parseNumber(input: SexprNode | string, what: string): number {
  let text: string;
  let where = '';
  if (typeof input === 'string') text = input;
  else {
    where = ` (line ${input.line})`;
    if (input.kind === 'list') throw sexprError(`${what} must be a number but a nested expression was found${where}.`);
    if (input.quoted) throw sexprError(`${what} must be a number but a quoted string "${input.value.slice(0, 40)}" was found${where}.`);
    text = input.value;
  }
  if (!NUMBER.test(text)) throw sexprError(`${what} must be a number but "${text.slice(0, 40)}" was found${where}.`);
  const value = Number(text);
  if (!Number.isFinite(value)) throw sexprError(`${what} "${text.slice(0, 40)}" is not a finite number${where}.`);
  return value === 0 ? 0 : value;
}
