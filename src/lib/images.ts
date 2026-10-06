/**
 * Reference image documents (PNG / JPEG / WebP / sanitized SVG): byte sniffing, header dimension
 * reading, bounded raster decoding, SVG sanitizing, user-confirmed calibration and the view
 * transforms of the image viewer. Everything except `decodeRaster`, `loadImageElement`,
 * `svgToBlobUrl`/`revoke` and the default SVG parser/serializer is pure and runs in Node.
 *
 * Image coordinates are source pixels (x right, y down, origin top-left). Screen coordinates are
 * CSS pixels of the viewport. A view's `scale` is CSS pixels per image pixel, so 1 means 100 %.
 * Nothing here ever reports millimetres without a user-confirmed `Calibration`.
 */
import { xmlRoot } from '../../electron/xml-prolog.mjs';

export type ImageKind = 'png' | 'jpeg' | 'webp' | 'svg';
export type RasterKind = Exclude<ImageKind, 'svg'>;
export type Rotation = 0 | 90 | 180 | 270;
export interface Point { x: number; y: number }
export interface Size { width: number; height: number }
/** Produced only by `calibrate()` from two user-chosen points and a user-entered distance. */
export interface Calibration { pixelsPerMm: number }
export interface ImageView {
  /** Image pixel at the centre of the viewport. */
  center: Point;
  /** CSS pixels per image pixel. */
  scale: number;
  /** Clockwise display rotation of the image. */
  rotation: Rotation;
}

export type ImageErrorCode = 'UNSUPPORTED' | 'LIMIT_EXCEEDED' | 'DECODE_FAILED' | 'ABORTED' | 'INVALID_CALIBRATION' | 'SVG_REJECTED';
/** `code` is the stable, machine-readable part; `message` is the English text shown to the user. */
export class ImageError extends Error {
  constructor(readonly code: ImageErrorCode, message: string = code) { super(message); this.name = 'ImageError'; }
}

export const IMAGE_LIMITS = {
  /** Encoded raster bytes accepted by `decodeRaster`. */
  maxRasterBytes: 256 * 1024 * 1024,
  /** Decoded pixels (width x height) accepted for rasters and declared for SVG. */
  maxPixels: 80_000_000,
  /** UTF-16 code units of SVG text accepted by `sanitizeSvg`. */
  maxSvgChars: 16 * 1024 * 1024,
  maxSvgElements: 200_000,
  maxSvgDepth: 256,
  minScale: 1 / 256,
  maxScale: 256,
} as const;

export const MIME_TYPES: Readonly<Record<ImageKind, string>> = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp', svg: 'image/svg+xml' };
export const SVG_NS = 'http://www.w3.org/2000/svg';
export const XLINK_NS = 'http://www.w3.org/1999/xlink';
const XML_NS = 'http://www.w3.org/XML/1998/namespace';
const XMLNS_NS = 'http://www.w3.org/2000/xmlns/';

export const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
export const pixelDistance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const isFinitePoint = (p: Point) => Number.isFinite(p.x) && Number.isFinite(p.y);

// ---------------------------------------------------------------------------------------------
// Sniffing and header dimensions
// ---------------------------------------------------------------------------------------------

const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const latin1 = (data: Uint8Array, start: number, end: number) => {
  let text = '';
  for (let i = start; i < end; i += 4096) text += String.fromCharCode(...data.subarray(i, Math.min(end, i + 4096)));
  return text;
};
const u16be = (d: Uint8Array, i: number) => (d[i] << 8) | d[i + 1];
const u32be = (d: Uint8Array, i: number) => ((d[i] << 24) | (d[i + 1] << 16) | (d[i + 2] << 8) | d[i + 3]) >>> 0;
const u16le = (d: Uint8Array, i: number) => d[i] | (d[i + 1] << 8);
const u24le = (d: Uint8Array, i: number) => d[i] | (d[i + 1] << 8) | (d[i + 2] << 16);
const u32le = (d: Uint8Array, i: number) => (d[i] | (d[i + 1] << 8) | (d[i + 2] << 16) | (d[i + 3] << 24)) >>> 0;

/**
 * Magic-byte detection. SVG needs an optional UTF-8 BOM and, within the first 4 KiB (text, so no NUL
 * byte), an XML prolog of any shape (declaration, processing instructions, comments, DOCTYPE) followed by
 * a root element named exactly `svg`: the same decision as the native document sniffer, which shares the
 * prolog scanner. HTML documents (`<!DOCTYPE html>`, `<html>`) are therefore never reported as SVG, and
 * neither is a DOCTYPE that declares entities.
 */
export function sniffImage(data: Uint8Array): ImageKind | null {
  if (data.length >= 8 && pngSignature.every((byte, i) => data[i] === byte)) return 'png';
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'jpeg';
  if (data.length >= 12 && latin1(data, 0, 4) === 'RIFF' && latin1(data, 8, 12) === 'WEBP') return 'webp';
  const offset = data.length >= 3 && data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf ? 3 : 0;
  const head = latin1(data, offset, Math.min(data.length, offset + 4096));
  if (head.includes('\0')) return null;
  const xml = xmlRoot(head.trimStart());
  return xml !== null && 'root' in xml && xml.root === 'svg' ? 'svg' : null;
}

/**
 * Declared dimensions from the container header, read without decoding. `null` when the header is
 * truncated, malformed or reports a zero side; the decoder result is always re-checked, so a lying
 * header gains nothing.
 */
export function readImageDimensions(data: Uint8Array, kind: RasterKind): Size | null {
  const size = (width: number, height: number): Size | null => (width > 0 && height > 0 ? { width, height } : null);
  if (kind === 'png') {
    if (data.length < 24 || !pngSignature.every((byte, i) => data[i] === byte) || latin1(data, 12, 16) !== 'IHDR') return null;
    return size(u32be(data, 16), u32be(data, 20));
  }
  if (kind === 'webp') {
    if (data.length < 21 || latin1(data, 0, 4) !== 'RIFF' || latin1(data, 8, 12) !== 'WEBP') return null;
    const chunk = latin1(data, 12, 16);
    // Offsets are into the chunk payload that starts at byte 20 (RFC 9649 / the WebP container specification).
    if (chunk === 'VP8X') return data.length >= 30 ? size(1 + u24le(data, 24), 1 + u24le(data, 27)) : null;
    if (chunk === 'VP8 ') {
      if (data.length < 30 || data[23] !== 0x9d || data[24] !== 0x01 || data[25] !== 0x2a) return null;
      return size(u16le(data, 26) & 0x3fff, u16le(data, 28) & 0x3fff);
    }
    if (chunk === 'VP8L') {
      if (data.length < 25 || data[20] !== 0x2f) return null;
      // 14 bits width-1, 14 bits height-1, 1 bit alpha hint, 3 bits version (only 0 exists).
      const bits = u32le(data, 21);
      return bits >>> 29 === 0 ? size((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1) : null;
    }
    return null;
  }
  // JPEG: walk the marker segments until the first start-of-frame.
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) return null;
  let i = 2;
  while (i + 4 <= data.length) {
    if (data[i] !== 0xff) return null;
    const marker = data[i + 1];
    if (marker === 0xff) { i++; continue; }
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return i + 9 <= data.length ? size(u16be(data, i + 7), u16be(data, i + 5)) : null;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    if (marker === 0xd9 || marker === 0xda) return null;
    const length = u16be(data, i + 2);
    if (length < 2) return null;
    i += 2 + length;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// SVG policy (pure) and sanitizer (injected DOM)
// ---------------------------------------------------------------------------------------------

const forbiddenElements = new Set([
  'script', 'foreignobject', 'iframe', 'embed', 'object', 'audio', 'video', 'a',
  'set', 'animate', 'animatemotion', 'animatetransform', 'animatecolor', 'discard',
  'handler', 'listener', 'prefetch', 'base', 'link', 'meta', 'frame', 'frameset', 'applet',
]);
const forbiddenAttributes = new Set([
  'base', 'xml:base', 'contentscripttype', 'formaction', 'ping', 'srcdoc', 'src', 'data', 'action', 'codebase', 'classid', 'archive',
]);
/**
 * Loaders and executors that never belong in an SVG style. `url()` itself is judged separately by
 * `hasExternalUrl` (document fragments only); a backslash could hide any keyword behind a CSS escape.
 */
const unsafeCss = /@import|expression\s*\(|javascript:|\b(?:image-set|src|image|cross-fade|element|paint)\s*\(|@font-face|@namespace|-moz-binding|behavior\s*:|\\/i;
const fragmentHref = /^#[A-Za-z0-9_.:-]+$/;
const dataImageHref = /^data:image\/(?:png|jpeg|webp|gif);base64,([\s\S]*)$/i;

/** Lower-cased local names; `<SCRIPT>` is removed as well even though XML would not treat it as a script. */
export const isForbiddenElement = (tagName: string) => forbiddenElements.has(tagName.toLowerCase());
/** Every `on*` handler plus HTML-ish loaders that never belong in an SVG. */
export const isForbiddenAttribute = (name: string) => {
  const lower = name.toLowerCase();
  const local = lower.includes(':') ? lower.slice(lower.lastIndexOf(':') + 1) : lower;
  return local.startsWith('on') || forbiddenAttributes.has(lower) || forbiddenAttributes.has(local);
};
export const isFragmentHref = (value: string) => fragmentHref.test(value.trim());
export const isDataImageHref = (value: string) => {
  const match = dataImageHref.exec(value.trim());
  return !!match && /^[A-Za-z0-9+/]*={0,2}$/.test(match[1].replace(/\s+/g, ''));
};
/** `#fragment` (for <use>, gradients, clipPath…) or an inline `data:image/(png|jpeg|webp|gif);base64,` payload (for <image>). */
export const isSafeHref = (value: string) => isFragmentHref(value) || isDataImageHref(value);
/** CSS text (a `style` attribute or a `<style>` body) that loads or runs nothing: only `url(#fragment)` references survive. */
export const isSafeStyle = (value: string) => !unsafeCss.test(value) && !hasExternalUrl(value);
/** Presentation attributes such as `fill="url(...)"` may only reference fragments of the document itself. */
export function hasExternalUrl(value: string): boolean {
  if (value.includes('\\')) return true;
  const pattern = /url\s*\(\s*(['"]?)\s*([^'")]*)/gi;
  for (let match = pattern.exec(value); match; match = pattern.exec(value)) if (!match[2].trim().startsWith('#')) return true;
  return false;
}

export interface SanitizedSvg {
  /** XML declaration plus the serialized, sanitized root element. */
  svg: string;
  /** Unique names of removed elements (`script`) and attributes (`image href`, `svg onload`) for disclosure; capped at 100. */
  removed: string[];
  /** Intrinsic size written into the root `width`/`height` attributes (CSS pixels, integers). */
  width: number;
  height: number;
}
export type SanitizeResult = SanitizedSvg | { error: string };
export type SvgParser = (text: string) => Document | null;
export type SvgSerializer = (root: Element) => string;

/** Browser default: `DOMParser` as `image/svg+xml`. */
export const parseSvgDocument: SvgParser = text => new DOMParser().parseFromString(text, 'image/svg+xml');
export const serializeSvgElement: SvgSerializer = root => new XMLSerializer().serializeToString(root);

/** Default object size of a replaced element without usable intrinsic dimensions (CSS 2.1 section 10.3.2, CSS Images 3). */
const DEFAULT_SVG_SIZE: Size = { width: 300, height: 150 };
const lengthPattern = /^\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)\s*(px|mm|cm|in|pt|pc|em|ex|%)?\s*$/i;
const unitScale: Readonly<Record<string, number>> = { '': 1, px: 1, mm: 96 / 25.4, cm: 96 / 2.54, in: 96, pt: 96 / 72, pc: 16, em: 16, ex: 8 };
/** Absolute SVG length in CSS pixels; percentages and garbage give `null`. */
export function parseSvgLength(value: string | null): number | null {
  const match = value ? lengthPattern.exec(value) : null;
  if (!match) return null;
  const unit = (match[2] ?? '').toLowerCase();
  if (unit === '%') return null;
  const px = Number.parseFloat(match[1]) * unitScale[unit];
  return Number.isFinite(px) && px > 0 ? px : null;
}
export function parseViewBox(value: string | null): { x: number; y: number; width: number; height: number } | null {
  const parts = (value ?? '').trim().split(/[\s,]+/).map(Number);
  if (parts.length !== 4 || parts.some(n => !Number.isFinite(n)) || parts[2] <= 0 || parts[3] <= 0) return null;
  return { x: parts[0], y: parts[1], width: parts[2], height: parts[3] };
}

/** Largest value a derived dimension may take before the budget step; keeps ratio arithmetic finite (a viewBox ratio can overflow a double). */
const MAX_DERIVED_SIDE = 1e15;
const boundSide = (value: number) => (Number.isFinite(value) ? Math.min(value, MAX_DERIVED_SIDE) : MAX_DERIVED_SIDE);

/**
 * Intrinsic size an `<img>` reports, following the default sizing rules of CSS Images 3 section 5.3
 * (https://drafts.csswg.org/css-images-3/#default-sizing) as used by
 * https://html.spec.whatwg.org/multipage/images.html: absolute `width`/`height` win; a missing
 * dimension comes from the viewBox aspect ratio when there is one and otherwise keeps the default
 * object size (300 wide, 150 high), never the other dimension. With neither attribute the viewBox
 * size is used (a viewer shows user units as pixels instead of shrinking into 300x150). Percentages
 * count as missing.
 *
 * The result is always a pair of whole numbers >= 1 whose product is at most `maxPixels` (B36): the
 * size is scaled proportionally, rounded DOWN so rounding cannot cross the cap, and when the 1 px
 * floor of a very thin image would still cross it the longer side gives way. The drawing is never
 * cropped because the declared size becomes the viewBox when none exists (and an existing viewBox is
 * untouched); a changed aspect only letterboxes under the default `preserveAspectRatio`.
 * A `maxPixels` that is not a finite number >= 1 falls back to `IMAGE_LIMITS.maxPixels`.
 */
export function resolveSvgSize(width: string | null, height: string | null, viewBox: string | null, maxPixels = IMAGE_LIMITS.maxPixels): Size & { viewBox: string | null } {
  const cap = Number.isFinite(maxPixels) && maxPixels >= 1 ? Math.floor(maxPixels) : IMAGE_LIMITS.maxPixels;
  const box = parseViewBox(viewBox);
  let w = parseSvgLength(width), h = parseSvgLength(height);
  if (w === null && h === null) { w = box?.width ?? DEFAULT_SVG_SIZE.width; h = box?.height ?? DEFAULT_SVG_SIZE.height; }
  else if (w === null) w = box ? h! * box.width / box.height : DEFAULT_SVG_SIZE.width;
  else if (h === null) h = box ? w * box.height / box.width : DEFAULT_SVG_SIZE.height;
  w = boundSide(w!); h = boundSide(h!);
  const declared = `0 0 ${w} ${h}`;
  let outWidth = Math.max(1, Math.round(w)), outHeight = Math.max(1, Math.round(h));
  if (outWidth * outHeight > cap) {
    const k = Math.sqrt(cap / (w * h));
    outWidth = Math.max(1, Math.floor(w * k));
    outHeight = Math.max(1, Math.floor(h * k));
    if (outWidth * outHeight > cap) { if (outWidth >= outHeight) outWidth = Math.floor(cap / outHeight); else outHeight = Math.floor(cap / outWidth); }
  }
  return { width: outWidth, height: outHeight, viewBox: box ? null : declared };
}

/**
 * The last gate before a native `<img>` is created for an SVG: the size the sanitizer wrote must be
 * whole, positive and within the pixel budget even if `resolveSvgSize` were ever wrong.
 */
export function assertSvgBudget(width: number, height: number, maxPixels: number = IMAGE_LIMITS.maxPixels): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) throw new ImageError('SVG_REJECTED', 'The SVG size is not a positive whole number of pixels.');
  if (width * height > maxPixels) throw new ImageError('LIMIT_EXCEEDED', `The SVG renders at ${width} x ${height} pixels; the limit is ${maxPixels.toLocaleString('en')}.`);
}

function hasParserError(doc: Document): boolean {
  const root = doc.documentElement;
  if (!root) return true;
  if (root.localName === 'parsererror') return true;
  return doc.getElementsByTagName('parsererror').length > 0
    || doc.getElementsByTagNameNS('http://www.mozilla.org/newlayout/xml/parsererror.xml', 'parsererror').length > 0;
}

/**
 * Removes scripting, animation, foreign content, external references and event handlers from an
 * SVG document and serializes what is left. The parser/serializer are injected so the policy can
 * be exercised without a DOM; `parse` must return the document even on syntax errors (DOMParser
 * semantics) so `<parsererror>` can be rejected. Bounds: 16 MiB of text, 200 000 elements,
 * nesting 256. Comments, processing instructions (`<?xml-stylesheet?>`) and the DOCTYPE are dropped.
 */
export function sanitizeSvg(text: string, parse: SvgParser, serialize: SvgSerializer = serializeSvgElement): SanitizeResult {
  if (text.length > IMAGE_LIMITS.maxSvgChars) return { error: 'The SVG text is larger than 16 MiB.' };
  let tags = 0;
  for (let i = text.indexOf('<'); i !== -1; i = text.indexOf('<', i + 1)) if (++tags > IMAGE_LIMITS.maxSvgElements * 2) return { error: 'The SVG contains more than 200 000 elements.' };
  let doc: Document | null;
  try { doc = parse(text); } catch { doc = null; }
  if (!doc || !doc.documentElement) return { error: 'The SVG could not be parsed.' };
  if (hasParserError(doc)) return { error: 'The SVG is not well-formed XML.' };
  const root = doc.documentElement;
  if (root.localName.toLowerCase() !== 'svg' || root.namespaceURI !== SVG_NS) return { error: 'The document root is not an SVG element.' };

  const removed: string[] = [];
  const seen = new Set<string>();
  let overflow = 0;
  const disclose = (raw: string) => {
    const name = raw.length > 80 ? `${raw.slice(0, 79)}…` : raw;
    if (seen.has(name)) return;
    seen.add(name);
    if (removed.length < 100) removed.push(name); else overflow++;
  };
  const stack: Array<{ element: Element; depth: number }> = [{ element: root, depth: 1 }];
  let count = 0;
  while (stack.length) {
    const { element, depth } = stack.pop()!;
    if (depth > IMAGE_LIMITS.maxSvgDepth) return { error: 'The SVG is nested deeper than 256 levels.' };
    if (++count > IMAGE_LIMITS.maxSvgElements) return { error: 'The SVG contains more than 200 000 elements.' };
    const tag = element.localName.toLowerCase();
    for (const attr of Array.from(element.attributes)) {
      const name = attr.name, local = attr.localName.toLowerCase(), ns = attr.namespaceURI;
      let keep: boolean;
      if (ns === XMLNS_NS) keep = attr.value === SVG_NS || attr.value === XLINK_NS || attr.value === XML_NS;
      else if (ns !== null && ns !== XLINK_NS && ns !== XML_NS) keep = false;
      else if (isForbiddenAttribute(name)) keep = false;
      else if (local === 'href') keep = tag === 'image' || tag === 'feimage' ? isSafeHref(attr.value) : isFragmentHref(attr.value);
      else if (local === 'style') keep = isSafeStyle(attr.value);
      else keep = !hasExternalUrl(attr.value);
      if (!keep) { element.removeAttributeNode(attr); disclose(`${element.localName} ${name}`); }
    }
    if (tag === 'style' && !isSafeStyle(element.textContent ?? '')) {
      element.parentNode?.removeChild(element);
      disclose('style');
      continue;
    }
    for (const child of Array.from(element.childNodes)) {
      if (child.nodeType === 1) {
        const el = child as Element;
        if (el.namespaceURI !== SVG_NS) { element.removeChild(el); disclose(el.nodeName); continue; }
        const childTag = el.localName.toLowerCase();
        if (isForbiddenElement(childTag)) { element.removeChild(el); disclose(el.localName); continue; }
        stack.push({ element: el, depth: depth + 1 });
      } else if (child.nodeType !== 3 && child.nodeType !== 4) {
        element.removeChild(child);
      }
    }
  }
  if (overflow) removed.push(`${overflow} more`);
  const size = resolveSvgSize(root.getAttribute('width'), root.getAttribute('height'), root.getAttribute('viewBox'));
  root.setAttribute('width', String(size.width));
  root.setAttribute('height', String(size.height));
  if (size.viewBox) root.setAttribute('viewBox', size.viewBox);
  let svg: string;
  try { svg = serialize(root); } catch { return { error: 'The SVG could not be serialized.' }; }
  return { svg: `<?xml version="1.0" encoding="UTF-8"?>\n${svg}`, removed, width: size.width, height: size.height };
}

// ---------------------------------------------------------------------------------------------
// Browser-only decoding helpers
// ---------------------------------------------------------------------------------------------

export interface DecodeOptions { maxPixels?: number; maxBytes?: number; signal?: AbortSignal }
const cancelled = (what: string) => new ImageError('ABORTED', `${what} was cancelled.`);

/** A `Uint8Array` over a plain `ArrayBuffer`, copying only when the source is shared memory. */
export function toBlobBytes(data: Uint8Array): Uint8Array<ArrayBuffer> {
  if (data.buffer instanceof ArrayBuffer) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  return copy;
}

/**
 * Runs tasks one at a time in call order. A decoded bitmap can take 4 bytes per pixel (320 MB at the
 * default budget) and `createImageBitmap` cannot be interrupted, so rapid document switches must not
 * stack decodes: a request aborted while it waits never starts, and its promise rejects at once.
 */
export function createDecodeGate() {
  let tail: Promise<void> = Promise.resolve();
  return function run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (signal?.aborted) { reject(cancelled('Decoding')); return; }
      const onAbort = () => reject(cancelled('Decoding'));
      signal?.addEventListener('abort', onAbort, { once: true });
      tail = tail.then(async () => {
        try {
          if (signal?.aborted) return;
          resolve(await task());
        } catch (error) {
          reject(error);
        } finally {
          signal?.removeEventListener('abort', onAbort);
        }
      });
    });
  };
}
const decodeGate = createDecodeGate();

/**
 * Decodes PNG/JPEG/WebP with `createImageBitmap`. Encoded bytes are bounded by `maxBytes` and the
 * declared header size by `maxPixels` before decoding (an unreadable header is rejected: a decoder
 * that tolerates what the header reader does not would otherwise dodge the budget); the decoded
 * bitmap is re-checked and closed when it exceeds `maxPixels`. EXIF orientation is applied, so
 * image coordinates are those of the picture the user sees. Memory note: the browser decoder
 * allocates the full bitmap before the post-decode check runs and cannot be interrupted, so `signal`
 * is honoured before the decode starts (queued decodes are skipped) and right after it.
 */
export function decodeRaster(data: Uint8Array, kind: RasterKind, { maxPixels = IMAGE_LIMITS.maxPixels, maxBytes = IMAGE_LIMITS.maxRasterBytes, signal }: DecodeOptions = {}): Promise<ImageBitmap> {
  if (signal?.aborted) return Promise.reject(cancelled('Decoding'));
  if (data.byteLength > maxBytes) return Promise.reject(new ImageError('LIMIT_EXCEEDED', `The image file is larger than ${Math.round(maxBytes / 1048576)} MiB.`));
  const declared = readImageDimensions(data, kind);
  if (!declared) return Promise.reject(new ImageError('DECODE_FAILED', `The ${kind.toUpperCase()} header is invalid or truncated.`));
  if (declared.width * declared.height > maxPixels) {
    return Promise.reject(new ImageError('LIMIT_EXCEEDED', `The image declares ${declared.width} x ${declared.height} pixels; the limit is ${maxPixels.toLocaleString('en')}.`));
  }
  return decodeGate(async () => {
    let bitmap: ImageBitmap;
    try {
      bitmap = await createImageBitmap(new Blob([toBlobBytes(data)], { type: MIME_TYPES[kind] }), { imageOrientation: 'from-image' });
    } catch (error) {
      throw new ImageError('DECODE_FAILED', `The ${kind.toUpperCase()} image could not be decoded.${error instanceof Error && error.message ? ` ${error.message}` : ''}`);
    }
    if (signal?.aborted) { bitmap.close(); throw cancelled('Decoding'); }
    if (bitmap.width * bitmap.height > maxPixels) {
      const { width, height } = bitmap;
      bitmap.close();
      throw new ImageError('LIMIT_EXCEEDED', `The image is ${width} x ${height} pixels; the limit is ${maxPixels.toLocaleString('en')}.`);
    }
    return bitmap;
  }, signal);
}

export const svgToBlobUrl = (sanitizedSvg: string) => URL.createObjectURL(new Blob([sanitizedSvg], { type: MIME_TYPES.svg }));
export const revoke = (url: string) => { try { URL.revokeObjectURL(url); } catch { /* already revoked */ } };

/** Loads a same-origin or blob URL into a detached `<img>`; rejects with `ImageError` on failure or abort. */
export function loadImageElement(url: string, signal?: AbortSignal): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(cancelled('Loading')); return; }
    const image = new Image();
    image.decoding = 'async';
    const finish = () => { signal?.removeEventListener('abort', onAbort); image.onload = null; image.onerror = null; };
    const onAbort = () => { finish(); image.src = ''; reject(cancelled('Loading')); };
    signal?.addEventListener('abort', onAbort, { once: true });
    image.onload = () => { finish(); resolve(image); };
    image.onerror = () => { finish(); reject(new ImageError('DECODE_FAILED', 'The SVG could not be rendered.')); };
    image.src = url;
  });
}

/**
 * SVG bytes as text. The XML declaration's 8-bit encoding is honoured (`DOMParser` ignores it for
 * strings, which would turn Latin-1 text into mojibake); a UTF-8 BOM, a missing, unknown or
 * UTF-16/32 label all mean UTF-8 because `sniffImage` only accepts ASCII-compatible markup.
 */
export function decodeSvgText(data: Uint8Array): string {
  let label = 'utf-8';
  const hasBom = data.length >= 3 && data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf;
  const declared = hasBom ? null : /^\s*<\?xml[^>]*?\sencoding\s*=\s*(["'])([A-Za-z0-9._:-]+)\1/i.exec(latin1(data, 0, Math.min(data.length, 256)));
  if (declared && !/^utf-?(?:8|16|32)/i.test(declared[2])) {
    try { new TextDecoder(declared[2]); label = declared[2]; } catch { /* unknown label: keep UTF-8 */ }
  }
  return new TextDecoder(label).decode(data);
}

export interface ImageDocument {
  kind: ImageKind;
  /** Drawable for `CanvasRenderingContext2D.drawImage`; a closed bitmap must never be drawn, so `dispose` before dropping it. */
  source: ImageBitmap | HTMLImageElement;
  width: number;
  height: number;
  /** SVG only: what the sanitizer removed (see `SanitizedSvg.removed`). */
  removed: string[];
  dispose(): void;
}

/**
 * Full pipeline for the viewer: sniff by bytes, then either bounded raster decode or SVG
 * sanitize-and-render. SVG is only ever displayed as an `<img>` of a blob URL holding the
 * sanitized markup (no script, no network in image context) and its size is bounded before the
 * element is created. Rejects with `ImageError` (`UNSUPPORTED`, `LIMIT_EXCEEDED`, `DECODE_FAILED`,
 * `SVG_REJECTED`, `ABORTED`).
 */
export async function loadImageDocument(data: Uint8Array, signal?: AbortSignal, parse: SvgParser = parseSvgDocument): Promise<ImageDocument> {
  const kind = sniffImage(data);
  if (!kind) throw new ImageError('UNSUPPORTED', 'Not a PNG, JPEG, WebP or SVG image (detected from the file content).');
  if (kind !== 'svg') {
    const bitmap = await decodeRaster(data, kind, { signal });
    return { kind, source: bitmap, width: bitmap.width, height: bitmap.height, removed: [], dispose: () => bitmap.close() };
  }
  if (data.byteLength > IMAGE_LIMITS.maxSvgChars * 3) throw new ImageError('LIMIT_EXCEEDED', 'The SVG file is larger than 48 MiB.');
  const result = sanitizeSvg(decodeSvgText(data), parse);
  if ('error' in result) throw new ImageError(/larger than|more than|deeper than/.test(result.error) ? 'LIMIT_EXCEEDED' : 'SVG_REJECTED', result.error);
  assertSvgBudget(result.width, result.height);
  if (signal?.aborted) throw cancelled('Loading');
  const url = svgToBlobUrl(result.svg);
  try {
    const image = await loadImageElement(url, signal);
    return { kind, source: image, width: result.width, height: result.height, removed: result.removed, dispose: () => { image.src = ''; revoke(url); } };
  } catch (error) {
    revoke(url);
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------
// Calibration and measurement
// ---------------------------------------------------------------------------------------------

export const isValidCalibration = (value: Calibration | null | undefined): value is Calibration =>
  !!value && Number.isFinite(value.pixelsPerMm) && value.pixelsPerMm > 0;

/**
 * A typed known distance: a plain decimal (`12`, `12.5`, `12,5`, `0.25`, `1e2`, optionally followed by `mm`),
 * finite and greater than zero. Anything else is an error message for the user, never a guess.
 */
export function parseKnownDistanceMm(text: string): { ok: true; value: number } | { ok: false; message: string } {
  const normalized = text.trim().replace(/\s*mm$/i, '').replace(',', '.');
  const value = /^\+?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(normalized) ? Number(normalized) : Number.NaN;
  return Number.isFinite(value) && value > 0 ? { ok: true, value } : { ok: false, message: 'Enter the known distance as a positive number of millimetres.' };
}

/** Two distinct finite image points and a positive known distance give the only source of millimetres. */
export function calibrate(a: Point, b: Point, knownDistanceMm: number): Calibration {
  if (!isFinitePoint(a) || !isFinitePoint(b)) throw new ImageError('INVALID_CALIBRATION', 'Calibration points must be finite.');
  const px = pixelDistance(a, b);
  if (!(px > 0)) throw new ImageError('INVALID_CALIBRATION', 'Calibration points must be distinct.');
  if (!Number.isFinite(knownDistanceMm) || knownDistanceMm <= 0) throw new ImageError('INVALID_CALIBRATION', 'The known distance must be a positive number of millimetres.');
  const pixelsPerMm = px / knownDistanceMm;
  if (!Number.isFinite(pixelsPerMm) || pixelsPerMm <= 0) throw new ImageError('INVALID_CALIBRATION', 'The calibration is out of range.');
  return { pixelsPerMm };
}

/** Millimetres between two image points, or `null` without a valid calibration. */
export function measure(a: Point, b: Point, calibration: Calibration | null | undefined): number | null {
  if (!isValidCalibration(calibration) || !isFinitePoint(a) || !isFinitePoint(b)) return null;
  return pixelDistance(a, b) / calibration.pixelsPerMm;
}

/** `pixelDistance` as `12.34 mm` when calibrated, otherwise `123 px`; never mm without a calibration. */
export function formatMeasurement(pixelDistanceValue: number, calibration: Calibration | null | undefined, formatMm: (mm: number) => string = mm => mm.toFixed(2)): string {
  if (!Number.isFinite(pixelDistanceValue) || pixelDistanceValue < 0) return '—';
  if (isValidCalibration(calibration)) return `${formatMm(pixelDistanceValue / calibration.pixelsPerMm)} mm`;
  return `${Math.round(pixelDistanceValue)} px`;
}

// ---------------------------------------------------------------------------------------------
// View transforms
// ---------------------------------------------------------------------------------------------

export const normalizeRotation = (value: number): Rotation => {
  const r = ((Math.round(value / 90) * 90) % 360 + 360) % 360;
  return r as Rotation;
};
export const nextRotation = (rotation: Rotation, delta: 90 | -90 = 90): Rotation => normalizeRotation(rotation + delta);
export const clampScale = (scale: number) => clamp(Number.isFinite(scale) ? scale : 1, IMAGE_LIMITS.minScale, IMAGE_LIMITS.maxScale);

/** Rotates a y-down vector clockwise on screen. */
export const rotatePoint = (p: Point, rotation: Rotation): Point =>
  rotation === 90 ? { x: -p.y, y: p.x } : rotation === 180 ? { x: -p.x, y: -p.y } : rotation === 270 ? { x: p.y, y: -p.x } : { x: p.x, y: p.y };
export const unrotatePoint = (p: Point, rotation: Rotation): Point => rotatePoint(p, normalizeRotation(-rotation));

export function imageToScreen(point: Point, view: ImageView, width: number, height: number): Point {
  const d = rotatePoint({ x: point.x - view.center.x, y: point.y - view.center.y }, view.rotation);
  return { x: width / 2 + d.x * view.scale, y: height / 2 + d.y * view.scale };
}

export function screenToImage(point: Point, view: ImageView, width: number, height: number): Point {
  const d = unrotatePoint({ x: (point.x - width / 2) / view.scale, y: (point.y - height / 2) / view.scale }, view.rotation);
  return { x: view.center.x + d.x, y: view.center.y + d.y };
}

/** Keeps the image pixel under `anchor` fixed while changing the scale. */
export function zoomAt(view: ImageView, anchor: Point, nextScale: number, width: number, height: number): ImageView {
  const original = screenToImage(anchor, view, width, height);
  const next = { ...view, scale: clampScale(nextScale) };
  const moved = screenToImage(anchor, next, width, height);
  return { ...next, center: { x: next.center.x + original.x - moved.x, y: next.center.y + original.y - moved.y } };
}

export function panBy(view: ImageView, screenDelta: Point): ImageView {
  const d = unrotatePoint({ x: screenDelta.x / view.scale, y: screenDelta.y / view.scale }, view.rotation);
  return { ...view, center: { x: view.center.x - d.x, y: view.center.y - d.y } };
}

export function fitView(imageWidth: number, imageHeight: number, rotation: Rotation, width: number, height: number, padding = 24): ImageView {
  const sideways = rotation === 90 || rotation === 270;
  const w = Math.max(1, sideways ? imageHeight : imageWidth), h = Math.max(1, sideways ? imageWidth : imageHeight);
  const scale = Math.min(Math.max(1, width - padding * 2) / w, Math.max(1, height - padding * 2) / h);
  return { center: { x: imageWidth / 2, y: imageHeight / 2 }, scale: clampScale(scale), rotation };
}

/** Screen-space corners (top-left, top-right, bottom-right, bottom-left of the source) of the displayed image. */
export function imageCorners(imageWidth: number, imageHeight: number, view: ImageView, width: number, height: number): Point[] {
  return [{ x: 0, y: 0 }, { x: imageWidth, y: 0 }, { x: imageWidth, y: imageHeight }, { x: 0, y: imageHeight }]
    .map(p => imageToScreen(p, view, width, height));
}

/** Camera fields the viewer stores (`ViewerCamera` of the shell, restated structurally so this module stays UI-free). */
export interface CameraState { zoom?: number; rotation?: number; x?: number; y?: number; fit?: FitMode }
export type FitMode = 'width' | 'page' | 'none';
/** `ImageView` plus the user's fit request: 'page'/'width' re-fit on resize and rotation, 'none' once zoomed or panned manually. */
export interface ViewState extends ImageView { fit: FitMode }

const finiteOr = (value: unknown, fallback: number) => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);

/** The view centre may reach the image border but never leave the image, so some of it always stays visible. */
export const clampCenter = (center: Point, imageWidth: number, imageHeight: number): Point =>
  ({ x: clamp(finiteOr(center.x, imageWidth / 2), 0, imageWidth), y: clamp(finiteOr(center.y, imageHeight / 2), 0, imageHeight) });

/** 'page' fits the whole rotated image, 'width' only its displayed width (tall images scroll). */
export function fitViewMode(mode: 'page' | 'width', imageWidth: number, imageHeight: number, rotation: Rotation, width: number, height: number, padding = 24): ImageView {
  const page = fitView(imageWidth, imageHeight, rotation, width, height, padding);
  if (mode === 'page') return page;
  const sideways = rotation === 90 || rotation === 270;
  const displayedWidth = Math.max(1, sideways ? imageHeight : imageWidth);
  return { ...page, scale: clampScale(Math.max(1, width - padding * 2) / displayedWidth) };
}

/**
 * Restores a stored camera for an image of the given size; missing or non-finite fields fall back
 * to a fitted page view, and a fit request wins over stored zoom/centre (they depend on the pane size).
 */
export function cameraToView(camera: CameraState | undefined, imageWidth: number, imageHeight: number, width: number, height: number): ViewState {
  const rotation = normalizeRotation(finiteOr(camera?.rotation, 0));
  const zoom = camera?.zoom;
  const stored = typeof zoom === 'number' && Number.isFinite(zoom) && zoom > 0;
  const fit: FitMode = camera?.fit === 'page' || camera?.fit === 'width' || camera?.fit === 'none' ? camera.fit : stored ? 'none' : 'page';
  if (fit !== 'none' || !stored) return { ...fitViewMode(fit === 'width' ? 'width' : 'page', imageWidth, imageHeight, rotation, width, height), fit: fit === 'none' ? 'page' : fit };
  return { center: clampCenter({ x: finiteOr(camera?.x, imageWidth / 2), y: finiteOr(camera?.y, imageHeight / 2) }, imageWidth, imageHeight), scale: clampScale(zoom), rotation, fit };
}
export const viewToCamera = (view: ViewState): { zoom: number; rotation: Rotation; x: number; y: number; fit: FitMode } => ({ zoom: view.scale, rotation: view.rotation, x: view.center.x, y: view.center.y, fit: view.fit });

/** Equality that survives a round trip through rounding/serialization (so an echoed camera is not mistaken for a new one). */
export function sameCamera(a: CameraState, b: CameraState): boolean {
  const close = (p: number | undefined, q: number | undefined) => (p === undefined || q === undefined ? p === q : Math.abs(p - q) <= 1e-6 * Math.max(1, Math.abs(p), Math.abs(q)));
  return close(a.zoom, b.zoom) && close(a.x, b.x) && close(a.y, b.y) && (a.rotation ?? 0) === (b.rotation ?? 0) && a.fit === b.fit;
}

/** Axis-aligned image rectangle (integers, clipped to the image) that can reach the viewport; `null` when none of the image is visible. */
export function visibleImageRect(view: ImageView, width: number, height: number, imageWidth: number, imageHeight: number): { x: number; y: number; width: number; height: number } | null {
  const corners = [{ x: 0, y: 0 }, { x: width, y: 0 }, { x: width, y: height }, { x: 0, y: height }].map(p => screenToImage(p, view, width, height));
  const x0 = clamp(Math.floor(Math.min(...corners.map(p => p.x))) - 1, 0, imageWidth), x1 = clamp(Math.ceil(Math.max(...corners.map(p => p.x))) + 1, 0, imageWidth);
  const y0 = clamp(Math.floor(Math.min(...corners.map(p => p.y))) - 1, 0, imageHeight), y1 = clamp(Math.ceil(Math.max(...corners.map(p => p.y))) + 1, 0, imageHeight);
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } : null;
}

/** Id of the marker nearest to a screen point within `radius` CSS pixels; later markers (drawn on top) win ties. */
export function hitTestMarker(markers: readonly { id: string; x: number; y: number }[], screen: Point, view: ImageView, width: number, height: number, radius = 12): string | null {
  let best: string | null = null, bestDistance = radius;
  for (const marker of markers) {
    if (!Number.isFinite(marker.x) || !Number.isFinite(marker.y)) continue;
    const distance = pixelDistance(imageToScreen(marker, view, width, height), screen);
    if (distance <= bestDistance) { best = marker.id; bestDistance = distance; }
  }
  return best;
}
