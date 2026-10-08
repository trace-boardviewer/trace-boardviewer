/*
 * Original TRACE module (MIT). A bounded, single-pass XML scanner (SAX style) written for the IPC-2581 reader.
 *
 * It never builds a document tree: start and end tags are handed to a handler as they are read, so memory follows what
 * the handler keeps, not the size of the document. Text and CDATA content are skipped (IPC-2581 carries its data in
 * attributes); outside the root element only whitespace is accepted.
 *
 * Safety properties, each covered by tests:
 *   - Entities are never expanded. A DOCTYPE that declares entities (<!ENTITY ...>) is refused; external identifiers in a
 *     DOCTYPE are never resolved (nothing is fetched or opened). In attribute values only the five predefined entities and
 *     numeric character references are decoded; any other reference is kept as literal text.
 *   - Every construct is bounded: element depth, element count, attributes per element, attribute value length, tag and
 *     DOCTYPE length, name length, and the length of comments, processing instructions and CDATA sections. Breaking a bound
 *     throws BoardFormatError('LIMIT_EXCEEDED').
 *   - Linear time: every character is examined a bounded number of times (indexOf and charCode loops, no regular expression
 *     that can backtrack). Input may arrive in chunks (`write`); an incomplete construct at a chunk end is kept until more
 *     input arrives, and it is scanned again only once the waiting input has doubled, so any chunking stays linear. The
 *     search for the end of a comment, CDATA section or processing instruction resumes where it stopped; a tag or DOCTYPE
 *     is rescanned from its "<", which the tag bound (maxTag) keeps bounded.
 *   - Well-formedness that matters for a truncated or corrupted file is checked: one root element, matching end tags, quoted
 *     attribute values without '<', no duplicate attributes, nothing but whitespace, comments and processing instructions
 *     outside the root, and the document must end after the root is closed.
 */
import { BoardFormatError } from './common';

export interface XmlLimits {
  /** Maximum element nesting depth (the root is depth 1). */
  maxDepth: number;
  /** Maximum attributes on one element. */
  maxAttributes: number;
  /** Maximum characters in one attribute value (before entity decoding). */
  maxAttributeValue: number;
  /** Maximum characters in one start or end tag, from "<" to ">" (attributes and whitespace included), and in the DOCTYPE declaration. */
  maxTag: number;
  /** Maximum characters in an element or attribute name. */
  maxName: number;
  /** Maximum characters in one comment, processing instruction or CDATA section. */
  maxMarkup: number;
  /** Maximum number of elements in the document. */
  maxElements: number;
}

/** IPC-2581 exports nest about 15 levels deep and carry short attribute values; these bounds leave a wide margin for real files. */
export const XML_LIMITS: Readonly<XmlLimits> = Object.freeze({
  maxDepth: 256,
  maxAttributes: 128,
  maxAttributeValue: 256 << 10,
  maxTag: 1 << 20,
  maxName: 256,
  maxMarkup: 16 << 20,
  maxElements: 20_000_000,
});

/** Attributes as a flat list: name, value, name, value, ... (names as written, values entity-decoded). */
export type XmlAttributes = string[];
export interface XmlDoctype { root: string; entities: boolean; external: boolean }
export interface XmlHandler {
  /** A start tag. `depth` is 1 for the root element. A self-closing tag is reported as open followed by close. */
  open(name: string, attributes: XmlAttributes, depth: number): void;
  close(name: string, depth: number): void;
  /**
   * Called for a DOCTYPE declaration. When it declares entities the scanner throws after this call unless the handler
   * returns true (used by sniffing, which only reports the fact; entities are never expanded either way).
   */
  doctype?(doctype: XmlDoctype): boolean | void;
}

/** Value of the first attribute named `name`, or undefined. */
export function attribute(attributes: XmlAttributes, name: string): string | undefined {
  for (let index = 0; index < attributes.length; index += 2) if (attributes[index] === name) return attributes[index + 1];
  return undefined;
}

/** The name without a namespace prefix (`ipc:Pin` → `Pin`). */
export const localName = (name: string): string => { const colon = name.indexOf(':'); return colon < 0 ? name : name.slice(colon + 1); };

const PREDEFINED = new Map([['lt', '<'], ['gt', '>'], ['amp', '&'], ['quot', '"'], ['apos', "'"]]);
/** Only the five predefined entities and numeric character references; anything else stays literal (never expanded). */
export function decodeEntities(value: string): string {
  if (value.indexOf('&') < 0) return value;
  return value.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z]{1,32});/g, (match, body: string) => {
    if (body.charCodeAt(0) !== 35) return PREDEFINED.get(body) ?? match;
    const code = body.charCodeAt(1) === 120 ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : match;
  });
}

const isSpace = (code: number): boolean => code === 32 || code === 10 || code === 13 || code === 9;
/** Name characters as XML allows them in practice: ASCII letters, digits, '.', '-', '_', ':' and every non-ASCII character. */
const isNameChar = (code: number): boolean =>
  code >= 97 && code <= 122 || code >= 65 && code <= 90 || code >= 48 && code <= 57 || code === 45 || code === 46 || code === 95 || code === 58 || code >= 0x80;
const isNameStart = (code: number): boolean => code >= 97 && code <= 122 || code >= 65 && code <= 90 || code === 95 || code === 58 || code >= 0x80;
const INCOMPLETE = -1;
const EXTERNAL_ID = /\s(?:SYSTEM|PUBLIC)\s/;

/**
 * Feed text with `write` (any number of chunks), then call `end`. Handlers may call `stop()` to end scanning early
 * (sniffing reads only up to the root start tag); after a stop, further input is ignored and `end` performs no checks.
 */
export class XmlScanner {
  private buffer = '';
  private position = 0;
  /** Chunks written while an incomplete construct waits for enough input (see `write`). */
  private queued: string[] = [];
  private queuedLength = 0;
  private readonly stack: string[] = [];
  private rootSeen = false;
  private rootClosed = false;
  private doctypeSeen = false;
  private elements = 0;
  private consumedChars = 0;
  private consumedLines = 0;
  /** For a comment, CDATA section or PI left incomplete at buffer index 0: how far its closer search already got. */
  private resume = 0;
  private finished = false;
  private stopped = false;
  private readonly limits: XmlLimits;

  constructor(private readonly handler: XmlHandler, private readonly label = 'XML', limits: Partial<XmlLimits> = {}) {
    this.limits = { ...XML_LIMITS, ...limits };
  }

  /** Ends scanning at the next event boundary; used by handlers that have seen enough. */
  stop(): void { this.stopped = true; }
  get isStopped(): boolean { return this.stopped; }
  /** Current element depth (0 outside the root). */
  get depth(): number { return this.stack.length; }

  write(chunk: string): void {
    if (this.finished) throw new Error('XmlScanner.write after end');
    if (this.stopped || !chunk) return;
    this.queued.push(chunk);
    this.queuedLength += chunk.length;
    // An incomplete construct is rescanned from its "<" (and the buffer flattened) when the scan resumes, so after one the
    // scan waits until the waiting input has at least doubled: every character is then handled a bounded number of times,
    // however finely the input is split. The construct bounds are checked at each resumption.
    if (this.queuedLength < this.buffer.length - this.position) return;
    this.flush();
    this.scan(false);
  }

  /** Drops the consumed part of the buffer and appends the queued chunks. */
  private flush(): void {
    if (this.position > 0) {
      for (let index = 0; index < this.position; index++) if (this.buffer.charCodeAt(index) === 10) this.consumedLines++;
      this.consumedChars += this.position;
    }
    this.buffer = this.buffer.slice(this.position) + (this.queued.length === 1 ? this.queued[0] : this.queued.join(''));
    this.position = 0;
    this.queued = [];
    this.queuedLength = 0;
  }

  end(): void {
    if (this.finished) return;
    if (!this.stopped) {
      this.flush();
      this.scan(true);
      if (!this.stopped) {
        if (!this.rootSeen) throw this.malformed('the document has no root element', this.buffer.length);
        if (this.stack.length) throw this.malformed(`the document ends inside <${this.stack[this.stack.length - 1].slice(0, 40)}>`, this.buffer.length);
      }
    }
    this.finished = true;
    this.buffer = '';
  }

  private line(at: number): number {
    let lines = this.consumedLines + 1;
    const end = Math.min(at, this.buffer.length);
    for (let index = 0; index < end; index++) if (this.buffer.charCodeAt(index) === 10) lines++;
    return lines;
  }
  private malformed(message: string, at: number): BoardFormatError {
    return new BoardFormatError(`${this.label} is malformed: ${message} (line ${this.line(at)}).`);
  }
  private limit(message: string): BoardFormatError {
    return new BoardFormatError(`${this.label} exceeds the import limit: ${message}.`, 'LIMIT_EXCEEDED');
  }

  private scan(final: boolean): void {
    const text = this.buffer, length = text.length;
    let at = this.position;
    while (at < length && !this.stopped) {
      const open = text.indexOf('<', at), textEnd = open < 0 ? length : open;
      if (textEnd > at) {
        // Character data. Inside the root it is not needed; outside it only whitespace (and a leading byte-order mark) may appear.
        if (this.stack.length === 0) {
          for (let index = at; index < textEnd; index++) {
            const code = text.charCodeAt(index);
            if (isSpace(code) || code === 0xfeff && index + this.consumedChars === 0) continue;
            throw this.malformed(this.rootSeen ? 'text after the root element' : 'text before the root element', index);
          }
        }
        at = textEnd;
      }
      if (open < 0) break;
      const next = this.markup(text, open, final);
      if (next === INCOMPLETE) break;
      at = next;
    }
    this.position = at;
  }

  /** INCOMPLETE when more input may complete the construct at `at`; throws when the input is final or the pending construct is already too long. */
  private incomplete(at: number, final: boolean, cap: number, what: string): number {
    if (final) throw this.malformed(`the document ends inside ${what}`, at);
    if (this.buffer.length - at > cap) throw this.limit(`${what} longer than ${cap} characters`);
    return INCOMPLETE;
  }

  /** Index after the closer of a comment, CDATA section or PI that opens at `at`, resuming a search that an earlier chunk left incomplete. */
  private closer(text: string, at: number, opener: number, closing: string, final: boolean, what: string): number {
    const from = at === 0 && this.resume > 0 ? Math.max(opener, this.resume - closing.length + 1) : opener;
    const close = text.indexOf(closing, at + from);
    if (close < 0) {
      const result = this.incomplete(at, final, this.limits.maxMarkup, what);
      this.resume = text.length - at;
      return result;
    }
    this.resume = 0;
    if (close + closing.length - at > this.limits.maxMarkup) throw this.limit(`${what} longer than ${this.limits.maxMarkup} characters`);
    return close + closing.length;
  }

  private markup(text: string, at: number, final: boolean): number {
    const length = text.length;
    if (at + 1 >= length) return this.incomplete(at, final, this.limits.maxTag, 'a tag');
    const second = text.charCodeAt(at + 1);
    if (second === 47) return this.endTag(text, at, final); // '</'
    if (second === 63) { // '<?' processing instruction (including the XML declaration)
      if (at + 2 < length && !isNameStart(text.charCodeAt(at + 2))) throw this.malformed('a processing instruction without a target', at);
      return this.closer(text, at, 2, '?>', final, 'a processing instruction');
    }
    if (second === 33) { // '<!'
      if (text.startsWith('<!--', at)) return this.closer(text, at, 4, '-->', final, 'a comment');
      if (text.startsWith('<![CDATA[', at)) {
        if (this.stack.length === 0) throw this.malformed('CDATA outside the root element', at);
        return this.closer(text, at, 9, ']]>', final, 'a CDATA section');
      }
      if (text.startsWith('<!DOCTYPE', at)) return this.doctype(text, at, final);
      const rest = text.slice(at, at + 9);
      if (rest.length < 9 && ['<!DOCTYPE', '<![CDATA[', '<!--'].some(prefix => prefix.startsWith(rest))) return this.incomplete(at, final, this.limits.maxMarkup, 'a declaration');
      throw this.malformed('an unsupported markup declaration', at);
    }
    return this.startTag(text, at, final);
  }

  private doctype(text: string, at: number, final: boolean): number {
    if (this.rootSeen || this.doctypeSeen) throw this.malformed('a DOCTYPE after the root element or a second DOCTYPE', at);
    // An incomplete DOCTYPE is rescanned from its start when more input arrives, so it gets the (smaller) tag bound.
    const length = text.length, cap = Math.min(this.limits.maxMarkup, this.limits.maxTag);
    let index = at + 9, quote = 0, depth = 0, entities = false;
    if (index >= length) return this.incomplete(at, final, cap, 'the DOCTYPE');
    if (!isSpace(text.charCodeAt(index))) throw this.malformed('an invalid DOCTYPE', at);
    for (; index < length; index++) {
      if (index - at > cap) throw this.limit(`a DOCTYPE longer than ${cap} characters`);
      const code = text.charCodeAt(index);
      if (quote) { if (code === quote) quote = 0; continue; }
      if (code === 34 || code === 39) { quote = code; continue; }
      if (depth > 0 && code === 60) { // '<' inside the internal subset
        if (text.startsWith('<!--', index)) {
          const close = text.indexOf('-->', index + 4);
          if (close < 0) return this.incomplete(at, final, cap, 'the DOCTYPE');
          index = close + 2; continue;
        }
        if (text.startsWith('<!ENTITY', index)) entities = true;
        else if (length - index < 8 && '<!ENTITY'.startsWith(text.slice(index))) return this.incomplete(at, final, cap, 'the DOCTYPE');
        continue;
      }
      if (code === 91) depth++; // '['
      else if (code === 93) depth = Math.max(0, depth - 1); // ']'
      else if (code === 62 && depth === 0) break; // '>'
    }
    if (index >= length) return this.incomplete(at, final, cap, 'the DOCTYPE');
    const declaration = text.slice(at + 9, index), subset = declaration.indexOf('[');
    const head = (subset < 0 ? declaration : declaration.slice(0, subset)).trim();
    let nameEnd = 0;
    while (nameEnd < head.length && isNameChar(head.charCodeAt(nameEnd))) nameEnd++;
    const doctype: XmlDoctype = { root: head.slice(0, nameEnd), entities, external: EXTERNAL_ID.test(` ${head} `) };
    this.doctypeSeen = true;
    const accepted = this.handler.doctype?.(doctype) === true;
    if (entities && !accepted) throw new BoardFormatError(`${this.label} declares entities (<!ENTITY>); entity declarations are not supported and are never expanded.`);
    return index + 1;
  }

  /** Index after the name that starts at `at` (equal to `at` when no name starts there). */
  private name(text: string, at: number): number {
    let index = at;
    const end = Math.min(text.length, at + this.limits.maxName + 1);
    while (index < end && isNameChar(text.charCodeAt(index))) index++;
    if (index - at > this.limits.maxName) throw this.limit(`a name longer than ${this.limits.maxName} characters`);
    return index;
  }

  /** Index of the first non-space character at or after `at`, never further than the tag bound allows. */
  private skipSpace(text: string, at: number, tagStart: number): number {
    let index = at;
    const end = Math.min(text.length, tagStart + this.limits.maxTag + 1);
    while (index < end && isSpace(text.charCodeAt(index))) index++;
    if (index - tagStart > this.limits.maxTag) throw this.limit(`a tag longer than ${this.limits.maxTag} characters`);
    return index;
  }

  private endTag(text: string, at: number, final: boolean): number {
    const length = text.length, nameEnd = this.name(text, at + 2);
    if (nameEnd >= length) return this.incomplete(at, final, this.limits.maxTag, 'an end tag');
    if (nameEnd === at + 2 || !isNameStart(text.charCodeAt(at + 2))) throw this.malformed('an end tag without a valid name', at);
    const close = this.skipSpace(text, nameEnd, at);
    if (close >= length) return this.incomplete(at, final, this.limits.maxTag, 'an end tag');
    if (text.charCodeAt(close) !== 62) throw this.malformed('an end tag that does not close with ">"', at);
    const name = text.slice(at + 2, nameEnd), expected = this.stack[this.stack.length - 1];
    if (expected === undefined) throw this.malformed(`the end tag </${name.slice(0, 40)}> has no start tag`, at);
    if (expected !== name) throw this.malformed(`the end tag </${name.slice(0, 40)}> does not match <${expected.slice(0, 40)}>`, at);
    const depth = this.stack.length;
    this.stack.pop();
    if (this.stack.length === 0) this.rootClosed = true;
    this.handler.close(name, depth);
    return close + 1;
  }

  private startTag(text: string, at: number, final: boolean): number {
    const length = text.length, limits = this.limits;
    if (!isNameStart(text.charCodeAt(at + 1))) throw this.malformed('a "<" that starts no tag', at);
    const nameEnd = this.name(text, at + 1);
    if (nameEnd >= length) return this.incomplete(at, final, limits.maxTag, 'a start tag');
    const name = text.slice(at + 1, nameEnd), attributes: XmlAttributes = [];
    let seen: Set<string> | undefined;
    let index = nameEnd;
    for (;;) {
      const next = this.skipSpace(text, index, at);
      if (next >= length) return this.incomplete(at, final, limits.maxTag, 'a start tag');
      const code = text.charCodeAt(next);
      if (code === 62 || code === 47) { // '>' or '/>'
        let selfClosing = false, after = next + 1;
        if (code === 47) {
          if (next + 1 >= length) return this.incomplete(at, final, limits.maxTag, 'a start tag');
          if (text.charCodeAt(next + 1) !== 62) throw this.malformed(`<${name.slice(0, 40)}> has a "/" that does not close the tag`, at);
          selfClosing = true; after = next + 2;
        }
        this.element(name, attributes, selfClosing, at);
        return after;
      }
      if (next === index) throw this.malformed(`<${name.slice(0, 40)}> needs whitespace before an attribute`, next);
      if (!isNameStart(code)) throw this.malformed(`<${name.slice(0, 40)}> has an invalid attribute`, next);
      const attributeEnd = this.name(text, next);
      if (attributeEnd >= length) return this.incomplete(at, final, limits.maxTag, 'a start tag');
      const equals = this.skipSpace(text, attributeEnd, at);
      if (equals >= length) return this.incomplete(at, final, limits.maxTag, 'a start tag');
      if (text.charCodeAt(equals) !== 61) throw this.malformed(`<${name.slice(0, 40)}> has an attribute without a value`, equals);
      const open = this.skipSpace(text, equals + 1, at);
      if (open >= length) return this.incomplete(at, final, limits.maxTag, 'a start tag');
      const quote = text.charCodeAt(open);
      if (quote !== 34 && quote !== 39) throw this.malformed(`<${name.slice(0, 40)}> has an unquoted attribute value`, open);
      // The closing quote is searched only within the bounds, so a value that never ends costs at most the bound to reject.
      const searchEnd = Math.min(length, open + 2 + limits.maxAttributeValue, at + limits.maxTag + 1);
      let close = open + 1;
      while (close < searchEnd && text.charCodeAt(close) !== quote) close++;
      if (close - open - 1 > limits.maxAttributeValue) throw this.limit(`an attribute value longer than ${limits.maxAttributeValue} characters`);
      if (close - at > limits.maxTag) throw this.limit(`a tag longer than ${limits.maxTag} characters`);
      if (close >= length) return this.incomplete(at, final, limits.maxTag, 'a start tag');
      const raw = text.slice(open + 1, close);
      if (raw.indexOf('<') >= 0) throw this.malformed(`<${name.slice(0, 40)}> has "<" inside an attribute value`, open);
      const attributeName = text.slice(next, attributeEnd);
      if (attributes.length >= limits.maxAttributes * 2) throw this.limit(`more than ${limits.maxAttributes} attributes on one element`);
      if (attributes.length >= 16) {
        if (!seen) { seen = new Set(); for (let k = 0; k < attributes.length; k += 2) seen.add(attributes[k]); }
        if (seen.has(attributeName)) throw this.malformed(`<${name.slice(0, 40)}> repeats the attribute ${attributeName.slice(0, 40)}`, next);
        seen.add(attributeName);
      } else if (attribute(attributes, attributeName) !== undefined) throw this.malformed(`<${name.slice(0, 40)}> repeats the attribute ${attributeName.slice(0, 40)}`, next);
      attributes.push(attributeName, decodeEntities(raw));
      index = close + 1;
    }
  }

  private element(name: string, attributes: XmlAttributes, selfClosing: boolean, at: number): void {
    if (this.stack.length === 0) {
      if (this.rootClosed) throw this.malformed('a second root element', at);
      this.rootSeen = true;
    }
    const depth = this.stack.length + 1;
    if (depth > this.limits.maxDepth) throw this.limit(`element nesting deeper than ${this.limits.maxDepth}`);
    if (++this.elements > this.limits.maxElements) throw this.limit(`more than ${this.limits.maxElements} elements`);
    if (selfClosing) {
      if (depth === 1) this.rootClosed = true;
      this.handler.open(name, attributes, depth);
      if (!this.stopped) this.handler.close(name, depth);
      return;
    }
    this.stack.push(name);
    this.handler.open(name, attributes, depth);
  }
}
