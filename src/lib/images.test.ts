import { describe, expect, it } from 'vitest';
import {
  assertSvgBudget, calibrate, cameraToView, clampCenter, createDecodeGate, decodeSvgText, fitView, fitViewMode, formatMeasurement, hasExternalUrl, hitTestMarker,
  decodeRaster, ImageError, imageToScreen, isDataImageHref, isForbiddenAttribute, isForbiddenElement, isFragmentHref, isSafeHref, isSafeStyle, isValidCalibration,
  loadImageDocument, measure, nextRotation, panBy, parseKnownDistanceMm, parseSvgLength, parseViewBox, readImageDimensions, resolveSvgSize, sameCamera, sanitizeSvg,
  screenToImage, sniffImage, viewToCamera, visibleImageRect, SVG_NS, XLINK_NS, zoomAt, IMAGE_LIMITS,
} from './images';
import type { Rotation } from './images';
import prologCases from '../../tests/fixtures/xml-prolog-cases.json';

const ascii = (text: string) => Uint8Array.from(text, c => c.charCodeAt(0));
const bytes = (...values: number[]) => Uint8Array.from(values);
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
};
const pngHeader = (width: number, height: number) => concat(
  bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13), ascii('IHDR'),
  bytes(width >>> 24, (width >>> 16) & 255, (width >>> 8) & 255, width & 255, height >>> 24, (height >>> 16) & 255, (height >>> 8) & 255, height & 255, 8, 6, 0, 0, 0),
);

describe('sniffImage', () => {
  it('recognises every supported container by magic bytes', () => {
    expect(sniffImage(pngHeader(1, 1))).toBe('png');
    expect(sniffImage(bytes(0xff, 0xd8, 0xff, 0xe0, 0, 16))).toBe('jpeg');
    expect(sniffImage(concat(ascii('RIFF'), bytes(0, 0, 0, 0), ascii('WEBPVP8 ')))).toBe('webp');
    expect(sniffImage(ascii('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBe('svg');
    expect(sniffImage(ascii('  \n<svg viewBox="0 0 1 1"></svg>'))).toBe('svg');
    expect(sniffImage(ascii('<?xml version="1.0"?>\n<!DOCTYPE svg PUBLIC "x" "y">\n<svg/>'))).toBe('svg');
    expect(sniffImage(concat(bytes(0xef, 0xbb, 0xbf), ascii('<?xml version="1.0"?><svg/>')))).toBe('svg');
    // The prolog may open with a comment, a DOCTYPE or a processing instruction: the native sniffer attaches such files.
    expect(sniffImage(ascii('<!-- drawn by hand -->\n<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBe('svg');
    expect(sniffImage(ascii('<!DOCTYPE svg PUBLIC "x" "y">\n<!-- c -->\n<svg/>'))).toBe('svg');
    expect(sniffImage(concat(bytes(0xef, 0xbb, 0xbf), ascii('<!-- c --><svg/>')))).toBe('svg');
    expect(sniffImage(ascii('<?xml-stylesheet href="s.css"?>\n<svg/>'))).toBe('svg');
  });
  it('rejects truncated, foreign and HTML inputs', () => {
    expect(sniffImage(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a))).toBeNull();
    expect(sniffImage(bytes(0xff, 0xd8))).toBeNull();
    expect(sniffImage(concat(ascii('RIFF'), bytes(0, 0, 0, 0), ascii('WAVEfmt ')))).toBeNull();
    expect(sniffImage(ascii('<!DOCTYPE html><html><body><svg></svg></body></html>'))).toBeNull();
    expect(sniffImage(ascii('<html><svg/></html>'))).toBeNull();
    expect(sniffImage(ascii('<?xml version="1.0"?><root/>'))).toBeNull();
    expect(sniffImage(ascii('<svgx/>'))).toBeNull();
    expect(sniffImage(ascii('<SVG viewBox="0 0 1 1"></SVG>'))).toBeNull(); // XML names are case-sensitive; the native sniffer refuses it too
    expect(sniffImage(ascii(`<?xml version="1.0"?>${' '.repeat(5000)}<svg/>`))).toBeNull();
    expect(sniffImage(ascii(`<!--${'x'.repeat(5000)}--><svg/>`))).toBeNull(); // the prolog must fit the 4 KiB window
    expect(sniffImage(ascii('<!DOCTYPE svg [ <!ENTITY e "x"> ]><svg>&e;</svg>'))).toBeNull();
    expect(sniffImage(concat(bytes(0, 0), ascii('<svg/>')))).toBeNull();
    expect(sniffImage(new Uint8Array(0))).toBeNull();
    expect(sniffImage(ascii('GIF89a'))).toBeNull();
  });
  it('decides every prolog shape of the shared fixture set as the native document sniffer does', () => {
    for (const { label, text, root, bom } of prologCases as Array<{ label: string; text: string; root: string | null; bom?: boolean }>) {
      const data = bom ? concat(bytes(0xef, 0xbb, 0xbf), ascii(text)) : ascii(text);
      expect(sniffImage(data), label).toBe(root === 'svg' ? 'svg' : null);
    }
  });
});

describe('readImageDimensions', () => {
  it('reads PNG, JPEG and all three WebP headers and returns null for truncated data', () => {
    expect(readImageDimensions(pngHeader(640, 480), 'png')).toEqual({ width: 640, height: 480 });
    expect(readImageDimensions(pngHeader(640, 480).subarray(0, 20), 'png')).toBeNull();
    const jpeg = concat(bytes(0xff, 0xd8, 0xff, 0xe0, 0, 4, 1, 2, 0xff, 0xff, 0xff, 0xc2, 0, 17, 8, 0x01, 0x90, 0x02, 0x80, 3), bytes(0xff, 0xda));
    expect(readImageDimensions(jpeg, 'jpeg')).toEqual({ width: 640, height: 400 });
    expect(readImageDimensions(bytes(0xff, 0xd8, 0xff, 0xda, 0, 2), 'jpeg')).toBeNull();
    expect(readImageDimensions(bytes(0xff, 0xd8, 0x00, 0xc0), 'jpeg')).toBeNull();
    const riff = (chunk: string, payload: number[]) => concat(ascii('RIFF'), bytes(0, 0, 0, 0), ascii('WEBP'), ascii(chunk), bytes(0, 0, 0, 0), bytes(...payload), new Uint8Array(16));
    expect(readImageDimensions(riff('VP8X', [0, 0, 0, 0, 0x3f, 0x01, 0x00, 0xdf, 0x00, 0x00]), 'webp')).toEqual({ width: 320, height: 224 });
    expect(readImageDimensions(riff('VP8 ', [0, 0, 0, 0x9d, 0x01, 0x2a, 0x40, 0x01, 0xf0, 0x00]), 'webp')).toEqual({ width: 320, height: 240 });
    // VP8L packs (width-1) in 14 bits, (height-1) in the next 14 bits, then 1 alpha bit and 3 version bits (LSB first): 319 | 239 << 14.
    expect(readImageDimensions(riff('VP8L', [0x2f, 0x3f, 0xc1, 0x3b, 0x00, 0]), 'webp')).toEqual({ width: 320, height: 240 });
    expect(readImageDimensions(riff('VP8L', [0x2f, 0x3f, 0xc1, 0x3b, 0x10, 0]), 'webp')).toEqual({ width: 320, height: 240 });
    expect(readImageDimensions(riff('VP8L', [0x2f, 0x3f, 0xc1, 0x3b, 0x20, 0]), 'webp')).toBeNull();
    expect(readImageDimensions(riff('VP8L', [0x2f, 0xff, 0xff, 0xff, 0x0f, 0]), 'webp')).toEqual({ width: 16384, height: 16384 });
    expect(readImageDimensions(riff('VP8L', [0x2e, 0x3f, 0xc1, 0x3b, 0x00, 0]), 'webp')).toBeNull();
    expect(readImageDimensions(riff('ALPH', [0, 0, 0, 0, 0, 0]), 'webp')).toBeNull();
    expect(readImageDimensions(ascii('RIFF'), 'webp')).toBeNull();
  });
  it('reads a minimal lossless WebP header and rejects truncation, zero sides and foreign containers', () => {
    const riff = (chunk: string, payload: number[]) => concat(ascii('RIFF'), bytes(0, 0, 0, 0), ascii('WEBP'), ascii(chunk), bytes(0, 0, 0, 0), bytes(...payload));
    // The VP8L header ends at byte 24, so a 25-byte prefix of a tiny lossless file is enough (no 30-byte minimum).
    const tiny = riff('VP8L', [0x2f, 0, 0, 0, 0]);
    expect(tiny.length).toBe(25);
    expect(readImageDimensions(tiny, 'webp')).toEqual({ width: 1, height: 1 });
    expect(readImageDimensions(tiny.subarray(0, 24), 'webp')).toBeNull();
    const vp8x = riff('VP8X', [0, 0, 0, 0, 0x3f, 0x01, 0x00, 0xdf, 0x00, 0x00]);
    expect(readImageDimensions(vp8x.subarray(0, 29), 'webp')).toBeNull();
    expect(readImageDimensions(riff('VP8 ', [0, 0, 0, 0x9d, 0x01, 0x2a, 0x40, 0x01, 0xf0]), 'webp')).toBeNull();
    expect(readImageDimensions(riff('VP8 ', [0, 0, 0, 0x9d, 0x01, 0x2b, 0x40, 0x01, 0xf0, 0x00]), 'webp')).toBeNull();
    expect(readImageDimensions(riff('VP8 ', [0, 0, 0, 0x9d, 0x01, 0x2a, 0x00, 0x00, 0xf0, 0x00]), 'webp')).toBeNull();
    expect(readImageDimensions(pngHeader(0, 5), 'png')).toBeNull();
    expect(readImageDimensions(pngHeader(5, 0), 'png')).toBeNull();
    expect(readImageDimensions(pngHeader(4294967295, 4294967295), 'png')).toEqual({ width: 4294967295, height: 4294967295 });
    const notPng = pngHeader(5, 5).slice(); notPng[1] = 0x51;
    expect(readImageDimensions(notPng, 'png')).toBeNull();
    expect(readImageDimensions(pngHeader(5, 5), 'webp')).toBeNull();
    expect(readImageDimensions(vp8x, 'jpeg')).toBeNull();
    expect(readImageDimensions(bytes(0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, 0, 0, 5, 1), 'jpeg')).toBeNull();
    expect(readImageDimensions(bytes(0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, 10, 0, 5, 1, 1, 0x11, 0), 'jpeg')).toEqual({ width: 5, height: 10 });
  });
  it('fails closed on a header that lies about its segment lengths', () => {
    expect(readImageDimensions(bytes(0xff, 0xd8, 0xff, 0xe0, 0xff, 0xf0, 1, 2, 3, 4), 'jpeg')).toBeNull();
    expect(readImageDimensions(bytes(0xff, 0xd8, 0xff, 0xe0, 0, 1, 1, 2), 'jpeg')).toBeNull();
  });
});

describe('B30: intrinsic SVG size with one missing dimension', () => {
  // CSS Images 3 section 5.3: without an aspect ratio a missing dimension keeps the default object size (300 x 150), it is not copied from the other side.
  it('keeps the default height when only a width is given and there is no viewBox', () => {
    expect(resolveSvgSize('100', null, null)).toEqual({ width: 100, height: 150, viewBox: '0 0 100 150' });
    expect(resolveSvgSize('100', '100%', null)).toEqual({ width: 100, height: 150, viewBox: '0 0 100 150' });
    expect(resolveSvgSize('1in', null, null)).toEqual({ width: 96, height: 150, viewBox: '0 0 96 150' });
  });
  it('keeps the default width when only a height is given and there is no viewBox', () => {
    expect(resolveSvgSize(null, '100', null)).toEqual({ width: 300, height: 100, viewBox: '0 0 300 100' });
    const mm = resolveSvgSize('auto', '20mm', null);
    expect(mm).toMatchObject({ width: 300, height: 76 });
    expect(mm.viewBox).toMatch(/^0 0 300 75\.59/);
  });
  it('still derives the missing side from a viewBox aspect ratio and keeps both given sides untouched', () => {
    expect(resolveSvgSize('100', null, '0 0 100 150')).toEqual({ width: 100, height: 150, viewBox: null });
    expect(resolveSvgSize('100', null, '10 10 50 100')).toEqual({ width: 100, height: 200, viewBox: null });
    expect(resolveSvgSize(null, '90', '0 0 300 100')).toEqual({ width: 270, height: 90, viewBox: null });
    expect(resolveSvgSize('100', '100', null)).toEqual({ width: 100, height: 100, viewBox: '0 0 100 100' });
  });
  it('writes the preserved size and a viewBox through the sanitizer so no drawing is cropped', () => {
    const widthOnly = sanitize(el('svg').attr('width', '100').append(el('rect').attr('y', '110').attr('width', '100').attr('height', '40').attr('fill', '#f00')));
    if ('error' in widthOnly) throw new Error(widthOnly.error);
    expect(widthOnly).toMatchObject({ width: 100, height: 150 });
    expect(widthOnly.svg).toContain('width="100" height="150" viewBox="0 0 100 150"');
    const heightOnly = sanitize(el('svg').attr('height', '100'));
    if ('error' in heightOnly) throw new Error(heightOnly.error);
    expect(heightOnly).toMatchObject({ width: 300, height: 100 });
    expect(heightOnly.svg).toMatch(/<svg (?=[^>]*height="100")(?=[^>]*width="300")(?=[^>]*viewBox="0 0 300 100")/);
  });
  it('shrinks an over-budget size without losing the content', () => {
    const huge = resolveSvgSize('100000', null, null, 80_000_000);
    expect(huge.viewBox).toBe('0 0 100000 150');
    expect(huge.width * huge.height).toBeLessThanOrEqual(80_000_000 + 20_000);
    expect(huge.width / huge.height).toBeCloseTo(100000 / 150, -1);
  });
});

describe('B36: SVG pixel budget is enforced on the final integer size', () => {
  const isWhole = (n: number) => Number.isInteger(n) && n >= 1;
  const within = (size: { width: number; height: number }, cap: number) => isWhole(size.width) && isWhole(size.height) && size.width * size.height <= cap;

  it('B36 thin image: 10000 x 1 under a 100 px cap becomes 100 x 1, not 1000 x 1', () => {
    const size = resolveSvgSize('10000', '1', null, 100);
    expect(size).toEqual({ width: 100, height: 1, viewBox: '0 0 10000 1' });
    expect(resolveSvgSize('1', '10000', null, 100)).toEqual({ width: 1, height: 100, viewBox: '0 0 1 10000' });
  });
  it('B36 huge ratio: width 1e12 x height 1 under the default cap stays within 80 000 000 pixels', () => {
    const wide = resolveSvgSize('1000000000000', '1', null);
    expect(wide).toEqual({ width: IMAGE_LIMITS.maxPixels, height: 1, viewBox: '0 0 1000000000000 1' });
    const tall = resolveSvgSize('1', '1000000000000', null);
    expect(tall).toEqual({ width: 1, height: IMAGE_LIMITS.maxPixels, viewBox: '0 0 1 1000000000000' });
    expect(within(wide, IMAGE_LIMITS.maxPixels) && within(tall, IMAGE_LIMITS.maxPixels)).toBe(true);
  });
  it('B36 1 x 1 and the smallest cap are kept as they are', () => {
    expect(resolveSvgSize('1', '1', null, 1)).toEqual({ width: 1, height: 1, viewBox: '0 0 1 1' });
    expect(resolveSvgSize('50', '50', null, 1)).toEqual({ width: 1, height: 1, viewBox: '0 0 50 50' });
    expect(resolveSvgSize('1', '1', null)).toEqual({ width: 1, height: 1, viewBox: '0 0 1 1' });
  });
  it('B36 fractional sizes round to whole pixels and never cross the cap by rounding', () => {
    expect(resolveSvgSize('0.4', '0.4', null)).toMatchObject({ width: 1, height: 1 });
    expect(resolveSvgSize('99.5', '10.4', null, 5000)).toMatchObject({ width: 100, height: 10 });
    for (const cap of [999, 1000, 1001, 1234]) expect(within(resolveSvgSize('99.5', '10.4', null, cap), cap), `cap ${cap}`).toBe(true);
    expect(within(resolveSvgSize('100.49', '100.49', null, 10_000), 10_000)).toBe(true);
  });
  it('B36 NaN, Infinity, negative and overflowing lengths count as missing and never reach the size', () => {
    for (const bad of ['NaN', 'Infinity', '-Infinity', '-5', '0', '1e999', '-1e999', 'abc', '', '12abc']) {
      expect(resolveSvgSize(bad, bad, null), JSON.stringify(bad)).toEqual({ width: 300, height: 150, viewBox: '0 0 300 150' });
    }
    expect(resolveSvgSize('1e999', '40', null)).toMatchObject({ width: 300, height: 40 });
    expect(resolveSvgSize('-5', '40', '0 0 10 20')).toMatchObject({ width: 20, height: 40, viewBox: null });
  });
  it('B36 an unusable cap (NaN, Infinity, 0, negative, fractional) falls back or floors, it never disables the budget', () => {
    for (const cap of [Number.NaN, Number.POSITIVE_INFINITY, 0, -5, 0.5]) {
      const size = resolveSvgSize('100000', '100000', null, cap);
      expect(within(size, IMAGE_LIMITS.maxPixels), String(cap)).toBe(true);
      expect(size.width).toBeGreaterThan(8000);
    }
    expect(within(resolveSvgSize('10', '10', null, 50.9), 50)).toBe(true);
  });
  it('B36 one dimension with a viewBox keeps the viewBox geometry (no crop) and still obeys the cap', () => {
    const size = resolveSvgSize('1000000000000', null, '0 0 1 1000');
    expect(size.viewBox).toBeNull();
    expect(within(size, IMAGE_LIMITS.maxPixels)).toBe(true);
    expect(size.height / size.width).toBeCloseTo(1000, -1);
    const small = resolveSvgSize('100', null, '0 0 100 150', 10_000);
    expect(small).toEqual({ width: 81, height: 122, viewBox: null });
    expect(within(small, 10_000)).toBe(true);
    // A ratio that overflows a double is bounded instead of producing Infinity or NaN.
    const overflow = resolveSvgSize('1e300', null, '0 0 1e300 1e-300');
    expect(within(overflow, IMAGE_LIMITS.maxPixels)).toBe(true);
  });
  it('B36 B30 stays fixed: a thin one-sided SVG under budget keeps the default other side', () => {
    expect(resolveSvgSize('100', null, null)).toEqual({ width: 100, height: 150, viewBox: '0 0 100 150' });
    expect(resolveSvgSize(null, '100', null)).toEqual({ width: 300, height: 100, viewBox: '0 0 300 100' });
    expect(resolveSvgSize('100', null, null, 1000)).toEqual({ width: 25, height: 38, viewBox: '0 0 100 150' });
  });
  it('B36 holds for every combination of awkward sides and caps', () => {
    const sides = ['1', '2', '3', '7', '99', '100', '101', '1000', '4096', '12345', '1e6', '1e9', '1e12', '0.5', '2.5', '1e15'];
    for (const cap of [1, 2, 3, 10, 99, 100, 1000, 65_536, 80_000_000]) {
      for (const w of sides) for (const h of sides) {
        const size = resolveSvgSize(w, h, null, cap);
        if (!within(size, cap)) throw new Error(`${w} x ${h} under ${cap} gave ${size.width} x ${size.height}`);
      }
    }
  });
  it('B36 the sanitizer metadata and the serialized root carry the bounded integer size', () => {
    const wide = sanitize(el('svg').attr('width', '1000000000000').attr('height', '1'));
    if ('error' in wide) throw new Error(wide.error);
    expect(wide).toMatchObject({ width: IMAGE_LIMITS.maxPixels, height: 1 });
    expect(wide.width * wide.height).toBeLessThanOrEqual(IMAGE_LIMITS.maxPixels);
    expect(wide.svg).toMatch(/<svg (?=[^>]*width="80000000")(?=[^>]*height="1")(?=[^>]*viewBox="0 0 1000000000000 1")/);
    const thin = sanitize(el('svg').attr('width', '1e9').attr('height', '0.3'));
    if ('error' in thin) throw new Error(thin.error);
    expect(within(thin, IMAGE_LIMITS.maxPixels)).toBe(true);
    const nan = sanitize(el('svg').attr('width', 'NaN').attr('height', 'Infinity'));
    if ('error' in nan) throw new Error(nan.error);
    expect(nan).toMatchObject({ width: 300, height: 150 });
    const ratio = sanitize(el('svg').attr('width', '1000000000000').attr('viewBox', '0 0 1 1000'));
    if ('error' in ratio) throw new Error(ratio.error);
    expect(within(ratio, IMAGE_LIMITS.maxPixels)).toBe(true);
    expect(ratio.svg).toContain('viewBox="0 0 1 1000"');
  });
  it('B36 the loader gate rejects sizes that are not whole or exceed the budget, before any element exists', () => {
    expect(() => assertSvgBudget(8944, 8944)).not.toThrow();
    expect(() => assertSvgBudget(IMAGE_LIMITS.maxPixels, 1)).not.toThrow();
    for (const [width, height] of [[8945, 8945], [IMAGE_LIMITS.maxPixels, 2], [8_944_271_910, 1]]) {
      expect(() => assertSvgBudget(width, height), `${width}x${height}`).toThrowError(expect.objectContaining({ code: 'LIMIT_EXCEEDED' }));
    }
    for (const [width, height] of [[0, 5], [5, 0], [-1, 5], [1.5, 2], [Number.NaN, 5], [5, Number.POSITIVE_INFINITY]]) {
      expect(() => assertSvgBudget(width, height), `${width}x${height}`).toThrowError(expect.objectContaining({ code: 'SVG_REJECTED' }));
    }
    expect(() => assertSvgBudget(11, 10, 100)).toThrowError(expect.objectContaining({ code: 'LIMIT_EXCEEDED' }));
  });
  it('B36 raster inputs are refused from the header alone: nothing oversized is ever decoded', async () => {
    // Node has no createImageBitmap, so reaching the decoder would surface as DECODE_FAILED; the budget codes prove it was not reached.
    await expect(decodeRaster(pngHeader(20000, 20000), 'png')).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    await expect(decodeRaster(pngHeader(8945, 8945), 'png')).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    await expect(decodeRaster(pngHeader(4294967295, 4294967295), 'png')).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    await expect(decodeRaster(pngHeader(100, 100), 'png', { maxPixels: 99 })).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    await expect(decodeRaster(pngHeader(10, 10), 'png', { maxBytes: 8 })).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    await expect(decodeRaster(pngHeader(0, 10), 'png')).rejects.toMatchObject({ code: 'DECODE_FAILED', message: expect.stringContaining('header') });
    await expect(decodeRaster(bytes(0xff, 0xd8, 0xff, 0x00, 1, 2, 3, 4), 'jpeg')).rejects.toMatchObject({ code: 'DECODE_FAILED' });
    const controller = new AbortController();
    controller.abort();
    await expect(decodeRaster(pngHeader(10, 10), 'png', { signal: controller.signal })).rejects.toMatchObject({ code: 'ABORTED' });
    await expect(loadImageDocument(pngHeader(20000, 20000))).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    await expect(loadImageDocument(ascii('GIF89a......'))).rejects.toMatchObject({ code: 'UNSUPPORTED' });
    await expect(loadImageDocument(new Uint8Array(0))).rejects.toMatchObject({ code: 'UNSUPPORTED' });
  });
});

describe('SVG policy', () => {
  it('forbids scripting, foreign content, links and animation elements only', () => {
    for (const tag of ['script', 'SCRIPT', 'foreignObject', 'iframe', 'embed', 'object', 'audio', 'video', 'a', 'set', 'animate', 'animateMotion', 'animateTransform']) expect(isForbiddenElement(tag), tag).toBe(true);
    for (const tag of ['svg', 'g', 'path', 'rect', 'use', 'image', 'linearGradient', 'clipPath', 'text', 'style', 'defs', 'symbol', 'filter', 'feGaussianBlur']) expect(isForbiddenElement(tag), tag).toBe(false);
  });
  it('removes every event handler and HTML loader attribute, keeps SVG presentation attributes', () => {
    // Handler names are an open set (browsers keep adding them), so every `on*` attribute is dropped, namespaced or not; no SVG attribute starts with "on".
    for (const name of ['onload', 'ONCLICK', 'onbegin', 'onmouseover', 'xlink:onclick', 'onfuturething', 'one', 'xml:base', 'src', 'formaction']) expect(isForbiddenAttribute(name), name).toBe(true);
    for (const name of ['fill', 'stroke-width', 'd', 'viewBox', 'xlink:href', 'href', 'style', 'transform', 'opacity', 'xml:space', 'offset', 'operator', 'orient', 'opacity']) expect(isForbiddenAttribute(name), name).toBe(false);
  });
  it('accepts only fragment and inline image hrefs', () => {
    expect(isSafeHref('#g')).toBe(true);
    expect(isSafeHref('  #grad-1.a:b  ')).toBe(true);
    expect(isSafeHref('data:image/png;base64,iVBORw0KGgo=')).toBe(true);
    expect(isSafeHref('DATA:IMAGE/JPEG;base64,/9j/4AAQ\n  SkZJRg==')).toBe(true);
    expect(isSafeHref('data:image/webp;base64,UklGRg==')).toBe(true);
    expect(isSafeHref('data:image/gif;base64,R0lGODlh')).toBe(true);
    for (const bad of [
      'javascript:alert(1)', ' JaVaScRiPt:alert(1)', 'data:text/html;base64,PHNjcmlwdD4=', 'data:image/svg+xml;base64,PHN2Zz4=',
      'data:image/png,notbase64', 'data:image/png;base64,###', 'https://example.invalid/x.png', 'http://127.0.0.1/x.png', '//example.invalid/x.png',
      '/x.png', 'x.png', '', '#', '# g', '#g javascript:', 'file:///etc/passwd', 'blob:http://x/y', 'vbscript:x', '\u0001#g',
    ]) expect(isSafeHref(bad), JSON.stringify(bad)).toBe(false);
    expect(isFragmentHref('data:image/png;base64,AA==')).toBe(false);
    expect(isDataImageHref('#g')).toBe(false);
  });
  it('strips styles that load or execute anything and keeps fragment references', () => {
    expect(isSafeStyle('fill:red;stroke:#00f;stroke-width:2')).toBe(true);
    expect(isSafeStyle('.a{fill:red}.b{opacity:.5}')).toBe(true);
    // Inkscape and Illustrator write gradients as `fill:url(#id)` inside style; those never leave the document.
    for (const good of ['fill:url(#g)', 'FILL:URL(#g)', "fill:url('#g');stroke:url( \"#h\" )", '.a{fill:url(#g)}.b{clip-path:url(#c)}']) expect(isSafeStyle(good), good).toBe(true);
    for (const bad of [
      'fill: url( https://example.invalid/a.svg#g )', 'fill:url(a.svg#g)', 'fill:url(#g) url(x.png)', 'background:url(data:image/png;base64,AA==)', 'fill:url()',
      '@import url(https://example.invalid/a.css)', "@import 'x.css'",
      'width:expression(alert(1))', 'background:javascript:alert(1)', 'fill:u\\72l(x)', 'background:image-set("x.png" 1x)', 'background:-webkit-image-set(url(#g) 1x)',
      '@font-face{src:local(x)}', 'behavior:url(x.htc)', '-moz-binding:x', 'background:src("x.png")', 'background:image("x.png")', 'background:cross-fade(url(#g), #fff)',
    ]) expect(isSafeStyle(bad), bad).toBe(false);
  });
  it('allows functional references only to document fragments', () => {
    expect(hasExternalUrl('url(#grad)')).toBe(false);
    expect(hasExternalUrl("url('#grad') url(\"#mask\")")).toBe(false);
    expect(hasExternalUrl('none')).toBe(false);
    expect(hasExternalUrl('url(https://example.invalid/a.svg#g)')).toBe(true);
    expect(hasExternalUrl('url(#a) url(b.svg#c)')).toBe(true);
    expect(hasExternalUrl('url( "x.svg" )')).toBe(true);
    expect(hasExternalUrl('u\\72l(x)')).toBe(true);
  });
  it('resolves intrinsic sizes and bounds them', () => {
    expect(parseSvgLength('120')).toBe(120);
    expect(parseSvgLength('25.4mm')).toBeCloseTo(96);
    expect(parseSvgLength('1in')).toBe(96);
    expect(parseSvgLength('100%')).toBeNull();
    expect(parseSvgLength('abc')).toBeNull();
    expect(parseSvgLength('-5')).toBeNull();
    expect(parseSvgLength(null)).toBeNull();
    expect(parseViewBox('0 0 200 100')).toEqual({ x: 0, y: 0, width: 200, height: 100 });
    expect(parseViewBox('0,0,200,100')).toEqual({ x: 0, y: 0, width: 200, height: 100 });
    expect(parseViewBox('0 0 0 100')).toBeNull();
    expect(parseViewBox('1 2 3')).toBeNull();
    expect(resolveSvgSize('300', '150', null)).toEqual({ width: 300, height: 150, viewBox: '0 0 300 150' });
    expect(resolveSvgSize(null, null, '0 0 400 200')).toEqual({ width: 400, height: 200, viewBox: null });
    expect(resolveSvgSize('100%', '100%', '0 0 40 20')).toEqual({ width: 40, height: 20, viewBox: null });
    expect(resolveSvgSize('200', null, '0 0 40 20')).toEqual({ width: 200, height: 100, viewBox: null });
    expect(resolveSvgSize(null, '50', '0 0 40 20')).toEqual({ width: 100, height: 50, viewBox: null });
    expect(resolveSvgSize(null, null, null)).toEqual({ width: 300, height: 150, viewBox: '0 0 300 150' });
    const huge = resolveSvgSize('100000', '100000', null, 80_000_000);
    expect(huge.width * huge.height).toBeLessThanOrEqual(80_000_000 + 20_000);
    expect(huge.width).toBeCloseTo(8944, -1);
    expect(huge.viewBox).toBe('0 0 100000 100000');
  });
});

/** A tiny namespaced DOM that implements exactly the surface sanitizeSvg uses. */
class FakeAttr { constructor(readonly name: string, public value: string, readonly namespaceURI: string | null, readonly localName: string) {} }
class FakeNode {
  parentNode: FakeElement | null = null;
  constructor(readonly nodeType: number, readonly nodeName: string, public data = '') {}
}
class FakeElement extends FakeNode {
  attributes: FakeAttr[] = [];
  childNodes: FakeNode[] = [];
  constructor(readonly localName: string, readonly namespaceURI: string | null, prefix: string | null = null) { super(1, prefix ? `${prefix}:${localName}` : localName); }
  removeChild(child: FakeNode) { this.childNodes = this.childNodes.filter(c => c !== child); child.parentNode = null; }
  removeAttributeNode(attr: FakeAttr) { this.attributes = this.attributes.filter(a => a !== attr); }
  getAttribute(name: string) { return this.attributes.find(a => a.name === name)?.value ?? null; }
  setAttribute(name: string, value: string) { const existing = this.attributes.find(a => a.name === name); if (existing) existing.value = value; else this.attributes.push(new FakeAttr(name, value, null, name)); }
  get textContent(): string { return this.childNodes.map(c => c instanceof FakeElement ? c.textContent : c.data).join(''); }
  append(...children: FakeNode[]) { for (const child of children) { child.parentNode = this; this.childNodes.push(child); } return this; }
  attr(name: string, value: string, namespaceURI: string | null = null) {
    const local = name.includes(':') ? name.slice(name.indexOf(':') + 1) : name;
    this.attributes.push(new FakeAttr(name, value, namespaceURI, local)); return this;
  }
}
const el = (name: string, ns: string | null = SVG_NS, prefix: string | null = null) => new FakeElement(name, ns, prefix);
const text = (value: string) => new FakeNode(3, '#text', value);
const comment = (value: string) => new FakeNode(8, '#comment', value);
const pi = (target: string, value: string) => new FakeNode(7, target, value);
const fakeDocument = (root: FakeElement | null, errors = 0) => ({
  documentElement: root,
  getElementsByTagName: (name: string) => ({ length: name === 'parsererror' ? errors : 0 }),
  getElementsByTagNameNS: () => ({ length: 0 }),
}) as unknown as Document;
const serialize = (node: unknown): string => {
  const element = node as FakeElement;
  const attrs = element.attributes.map(a => ` ${a.name}="${a.value}"`).join('');
  const children = element.childNodes.map(c => c instanceof FakeElement ? serialize(c) : c.nodeType === 3 ? c.data : '').join('');
  return `<${element.nodeName}${attrs}>${children}</${element.nodeName}>`;
};
const sanitize = (root: FakeElement | null, errors = 0) => sanitizeSvg('<svg/>', () => fakeDocument(root, errors), serialize);

describe('sanitizeSvg with an injected DOM', () => {
  it('removes hostile content, keeps safe content and discloses what it removed', () => {
    const root = el('svg').attr('xmlns', SVG_NS, 'http://www.w3.org/2000/xmlns/').attr('xmlns:xlink', XLINK_NS, 'http://www.w3.org/2000/xmlns/')
      .attr('xmlns:inkscape', 'http://www.inkscape.org/namespaces/inkscape', 'http://www.w3.org/2000/xmlns/')
      .attr('viewBox', '0 0 100 50').attr('onload', 'alert(1)').attr('inkscape:version', '1.0', 'http://www.inkscape.org/namespaces/inkscape');
    const defs = el('defs').append(el('linearGradient').attr('id', 'g').append(el('stop').attr('offset', '0').attr('stop-color', 'red')));
    const script = el('script').append(text('alert(1)'));
    const style = el('style').append(text('@import url(https://example.invalid/a.css)'));
    const safeStyle = el('style').append(text('.a{fill:red}'));
    const image = el('image').attr('href', 'https://example.invalid/x.png').attr('xlink:href', 'data:image/png;base64,iVBORw0KGgo=', XLINK_NS).attr('width', '10').attr('height', '10');
    const use = el('use').attr('href', '#g');
    const useExternal = el('use').attr('xlink:href', 'other.svg#g', XLINK_NS);
    const rect = el('rect').attr('fill', 'url(https://example.invalid/g.svg#p)').attr('stroke', 'url(#g)').attr('style', 'fill:url(#g);stroke:url(https://example.invalid/s.svg#q)').attr('onclick', 'x()').attr('width', '5').attr('height', '5');
    const anchor = el('a').attr('href', 'https://example.invalid').append(el('text').append(text('link')));
    const foreign = el('foreignObject').append(el('div', 'http://www.w3.org/1999/xhtml'));
    const html = el('div', 'http://www.w3.org/1999/xhtml', 'html');
    const animate = el('animate').attr('attributeName', 'href').attr('to', 'javascript:alert(1)');
    const g = el('g').append(comment('c'), pi('xml-stylesheet', 'href="https://example.invalid/a.css"'), el('circle').attr('r', '3'), animate);
    root.append(defs, script, style, safeStyle, image, use, useExternal, rect, anchor, foreign, html, g);
    const result = sanitize(root);
    if ('error' in result) throw new Error(result.error);
    // Names are disclosed as authored (`foreignObject`, not `foreignobject`); the rect's style is dropped as a whole because one declaration points outside the document.
    expect(result.removed).toEqual(expect.arrayContaining(['script', 'svg onload', 'svg xmlns:inkscape', 'svg inkscape:version', 'style', 'image href', 'use xlink:href', 'rect fill', 'rect style', 'rect onclick', 'a', 'foreignObject', 'html:div', 'animate']));
    expect(result.removed).not.toContain('use');
    expect(result.removed).not.toContain('image xlink:href');
    expect(result.removed).not.toContain('rect stroke');
    expect(result.svg.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<svg')).toBe(true);
    expect(result.svg).toContain('<linearGradient id="g">');
    expect(result.svg).toContain('<use href="#g">');
    expect(result.svg).toContain('<image xlink:href="data:image/png;base64,iVBORw0KGgo=" width="10" height="10">');
    expect(result.svg).toContain('<style>.a{fill:red}</style>');
    expect(result.svg).toContain('<rect stroke="url(#g)" width="5" height="5">');
    expect(result.svg).toContain('<circle r="3">');
    expect(result.svg).not.toMatch(/script|alert|example\.invalid|onload|onclick|@import|foreignObject|<a |animate|xml-stylesheet|inkscape|<c>/);
    expect(result.svg).toContain('width="100" height="50"');
    expect(result).toMatchObject({ width: 100, height: 50 });
  });
  it('rejects parser errors, non-SVG roots, oversized text and deep nesting', () => {
    expect(sanitize(el('svg'), 1)).toEqual({ error: expect.stringContaining('well-formed') });
    expect(sanitize(el('parsererror', 'http://www.w3.org/1999/xhtml'))).toEqual({ error: expect.stringContaining('well-formed') });
    expect(sanitize(el('html', 'http://www.w3.org/1999/xhtml'))).toEqual({ error: expect.stringContaining('root') });
    expect(sanitize(el('svg', 'http://www.w3.org/1999/xhtml'))).toEqual({ error: expect.stringContaining('root') });
    expect(sanitize(null)).toEqual({ error: expect.stringContaining('parsed') });
    expect(sanitizeSvg('x'.repeat(IMAGE_LIMITS.maxSvgChars + 1), () => fakeDocument(el('svg')), serialize)).toEqual({ error: expect.stringContaining('16 MiB') });
    expect(sanitizeSvg('<'.repeat(IMAGE_LIMITS.maxSvgElements * 2 + 1), () => fakeDocument(el('svg')), serialize)).toEqual({ error: expect.stringContaining('200 000') });
    expect(sanitizeSvg('<svg/>', () => { throw new Error('boom'); }, serialize)).toEqual({ error: expect.stringContaining('parsed') });
    let deep = el('svg');
    const root = deep;
    for (let i = 0; i < IMAGE_LIMITS.maxSvgDepth; i++) { const child = el('g'); deep.append(child); deep = child; }
    expect(sanitize(root)).toEqual({ error: expect.stringContaining('256') });
    const wide = el('svg');
    for (let i = 0; i < 300; i++) wide.append(el('g'));
    expect('svg' in sanitize(wide)).toBe(true);
  });
  it('writes an intrinsic size and viewBox so the rendered image keeps its drawing', () => {
    const result = sanitize(el('svg').attr('width', '100%').attr('height', '100%'));
    if ('error' in result) throw new Error(result.error);
    expect(result.svg).toContain('width="300" height="150" viewBox="0 0 300 150"');
    const sized = sanitize(el('svg').attr('width', '20mm').attr('height', '10mm'));
    if ('error' in sized) throw new Error(sized.error);
    expect(sized).toMatchObject({ width: 76, height: 38 });
  });
  it('caps the disclosure list', () => {
    const root = el('svg');
    for (let i = 0; i < 150; i++) root.append(el(`weird${i}`, 'urn:x'));
    const result = sanitize(root);
    if ('error' in result) throw new Error(result.error);
    expect(result.removed).toHaveLength(101);
    expect(result.removed[100]).toBe('50 more');
  });
});

describe('calibration and measurement', () => {
  it('derives pixels per millimetre only from valid input', () => {
    expect(calibrate({ x: 0, y: 0 }, { x: 30, y: 40 }, 10)).toEqual({ pixelsPerMm: 5 });
    expect(() => calibrate({ x: 1, y: 1 }, { x: 1, y: 1 }, 10)).toThrow(/distinct/);
    expect(() => calibrate({ x: 0, y: 0 }, { x: 3, y: 4 }, 0)).toThrow(/positive/);
    expect(() => calibrate({ x: 0, y: 0 }, { x: 3, y: 4 }, -2)).toThrow(/positive/);
    expect(() => calibrate({ x: 0, y: 0 }, { x: 3, y: 4 }, Number.NaN)).toThrow(/positive/);
    expect(() => calibrate({ x: 0, y: 0 }, { x: 3, y: 4 }, Number.POSITIVE_INFINITY)).toThrow(/positive/);
    expect(() => calibrate({ x: Number.NaN, y: 0 }, { x: 3, y: 4 }, 1)).toThrow(/finite/);
    expect(() => calibrate({ x: 0, y: 0 }, { x: Number.POSITIVE_INFINITY, y: 4 }, 1)).toThrow(/finite/);
  });
  it('measures in millimetres only when calibrated and never formats mm otherwise', () => {
    const calibration = calibrate({ x: 0, y: 0 }, { x: 100, y: 0 }, 25);
    expect(measure({ x: 0, y: 0 }, { x: 0, y: 40 }, calibration)).toBe(10);
    expect(measure({ x: 0, y: 0 }, { x: 0, y: 40 }, undefined)).toBeNull();
    expect(measure({ x: 0, y: 0 }, { x: 0, y: 40 }, null)).toBeNull();
    expect(measure({ x: 0, y: 0 }, { x: 0, y: 40 }, { pixelsPerMm: 0 })).toBeNull();
    expect(measure({ x: 0, y: 0 }, { x: 0, y: 40 }, { pixelsPerMm: Number.NaN })).toBeNull();
    expect(formatMeasurement(40, calibration)).toBe('10.00 mm');
    expect(formatMeasurement(41.26, calibration, mm => mm.toFixed(3))).toBe('10.315 mm');
    expect(formatMeasurement(40.4, undefined)).toBe('40 px');
    expect(formatMeasurement(40.5, { pixelsPerMm: -1 })).toBe('41 px');
    expect(formatMeasurement(Number.NaN, calibration)).toBe('—');
    expect(formatMeasurement(-1, undefined)).toBe('—');
  });
});

describe('view helpers', () => {
  for (const rotation of [0, 90, 180, 270] as Rotation[]) {
    it(`round-trips, zooms around the cursor and pans in screen pixels at ${rotation} degrees`, () => {
      const view = { center: { x: 310.5, y: 120.25 }, scale: 1.75, rotation };
      const point = { x: 12.5, y: 480.75 };
      const back = screenToImage(imageToScreen(point, view, 1024, 700), view, 1024, 700);
      expect(back.x).toBeCloseTo(point.x, 9);
      expect(back.y).toBeCloseTo(point.y, 9);
      const cursor = { x: 101, y: 633 };
      const anchor = screenToImage(cursor, view, 1024, 700);
      const zoomed = zoomAt(view, cursor, 4.5, 1024, 700);
      expect(zoomed.scale).toBe(4.5);
      const anchored = imageToScreen(anchor, zoomed, 1024, 700);
      expect(anchored.x).toBeCloseTo(cursor.x, 9);
      expect(anchored.y).toBeCloseTo(cursor.y, 9);
      const before = imageToScreen(point, view, 1024, 700);
      const after = imageToScreen(point, panBy(view, { x: 37, y: -19 }), 1024, 700);
      expect(after.x - before.x).toBeCloseTo(37, 9);
      expect(after.y - before.y).toBeCloseTo(-19, 9);
    });
  }
  it('rotates clockwise on screen', () => {
    const view = { center: { x: 50, y: 50 }, scale: 1, rotation: 90 as Rotation };
    // The image's right edge (x = 100) points down after a clockwise quarter turn.
    const right = imageToScreen({ x: 100, y: 50 }, view, 200, 200);
    expect(right.x).toBeCloseTo(100); expect(right.y).toBeCloseTo(150);
    const bottom = imageToScreen({ x: 50, y: 100 }, view, 200, 200);
    expect(bottom.x).toBeCloseTo(50); expect(bottom.y).toBeCloseTo(100);
    expect(nextRotation(270)).toBe(0);
    expect(nextRotation(0, -90)).toBe(270);
  });
  it('fits the rotated image inside the viewport and clamps the scale', () => {
    const upright = fitView(2000, 1000, 0, 1000, 1000, 50);
    expect(upright.scale).toBeCloseTo(0.45);
    expect(upright.center).toEqual({ x: 1000, y: 500 });
    const sideways = fitView(2000, 1000, 90, 1000, 1000, 50);
    expect(sideways.scale).toBeCloseTo(0.45);
    const tall = fitView(2000, 1000, 90, 1000, 300, 50);
    expect(tall.scale).toBeCloseTo(0.1);
    expect(fitView(1, 1, 0, 100000, 100000).scale).toBe(IMAGE_LIMITS.maxScale);
    expect(fitView(1e9, 1e9, 0, 10, 10).scale).toBe(IMAGE_LIMITS.minScale);
    expect(zoomAt({ center: { x: 0, y: 0 }, scale: 1, rotation: 0 }, { x: 0, y: 0 }, 1e9, 10, 10).scale).toBe(IMAGE_LIMITS.maxScale);
    expect(zoomAt({ center: { x: 0, y: 0 }, scale: 1, rotation: 0 }, { x: 0, y: 0 }, Number.NaN, 10, 10).scale).toBe(1);
  });
});

describe('ImageError (I01)', () => {
  it('carries a stable code and a descriptive message', () => {
    const error = new ImageError('LIMIT_EXCEEDED', 'The image is 20000 x 20000 pixels; the limit is 80,000,000.');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('ImageError');
    expect(error.code).toBe('LIMIT_EXCEEDED');
    expect(error.message).toContain('20000 x 20000');
    expect(new ImageError('ABORTED').message).toBe('ABORTED');
  });
  it('reports calibration failures with their stable code', () => {
    for (const attempt of [() => calibrate({ x: 1, y: 1 }, { x: 1, y: 1 }, 5), () => calibrate({ x: 0, y: 0 }, { x: 3, y: 4 }, 0), () => calibrate({ x: Number.NaN, y: 0 }, { x: 1, y: 1 }, 1), () => calibrate({ x: 0, y: 0 }, { x: 1, y: 0 }, 1e-320)]) {
      try { attempt(); throw new Error('expected failure'); } catch (error) {
        expect(error).toBeInstanceOf(ImageError);
        expect((error as ImageError).code).toBe('INVALID_CALIBRATION');
      }
    }
  });
});

describe('decode gate', () => {
  const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
  it('runs tasks one at a time in order', async () => {
    const gate = createDecodeGate();
    const log: string[] = [];
    const first = deferred<string>();
    const a = gate(async () => { log.push('a:start'); const value = await first.promise; log.push('a:end'); return value; });
    const b = gate(async () => { log.push('b:start'); return 'b'; });
    await Promise.resolve();
    expect(log).toEqual(['a:start']);
    first.resolve('a');
    expect(await a).toBe('a');
    expect(await b).toBe('b');
    expect(log).toEqual(['a:start', 'a:end', 'b:start']);
  });
  it('never starts a task that was aborted while queued and rejects it immediately', async () => {
    const gate = createDecodeGate();
    const blocker = deferred<void>();
    const running = gate(() => blocker.promise);
    const controller = new AbortController();
    let started = false;
    const queued = gate(async () => { started = true; return 1; }, controller.signal);
    controller.abort();
    await expect(queued).rejects.toMatchObject({ name: 'ImageError', code: 'ABORTED' });
    blocker.resolve();
    await running;
    const after = await gate(async () => 'later');
    expect(after).toBe('later');
    expect(started).toBe(false);
  });
  it('rejects an already aborted request and survives a failing task', async () => {
    const gate = createDecodeGate();
    const controller = new AbortController();
    controller.abort();
    await expect(gate(async () => 1, controller.signal)).rejects.toMatchObject({ code: 'ABORTED' });
    await expect(gate(async () => { throw new ImageError('DECODE_FAILED', 'bad'); })).rejects.toMatchObject({ code: 'DECODE_FAILED' });
    expect(await gate(async () => 'ok')).toBe('ok');
  });
});

describe('decodeSvgText', () => {
  it('decodes UTF-8 with and without a BOM and honours a declared 8-bit encoding', () => {
    expect(decodeSvgText(new TextEncoder().encode('<svg>é</svg>'))).toBe('<svg>é</svg>');
    expect(decodeSvgText(concat(bytes(0xef, 0xbb, 0xbf), new TextEncoder().encode('<svg>ő</svg>')))).toBe('<svg>ő</svg>');
    expect(decodeSvgText(new TextEncoder().encode('<svg>ő</svg>'))).toBe('<svg>ő</svg>');
    const latin1Svg = concat(ascii('<?xml version="1.0" encoding="ISO-8859-1"?><svg>'), bytes(0xe9), ascii('</svg>'));
    expect(decodeSvgText(latin1Svg)).toBe('<?xml version="1.0" encoding="ISO-8859-1"?><svg>é</svg>');
    expect(decodeSvgText(concat(ascii('<?xml version="1.0" encoding="utf-16"?><svg>'), bytes(0x41), ascii('</svg>')))).toContain('<svg>A</svg>');
    expect(decodeSvgText(concat(ascii('<?xml version="1.0" encoding="no-such-charset"?><svg>'), bytes(0x41), ascii('</svg>')))).toContain('<svg>A</svg>');
  });
});

describe('typed calibration distance', () => {
  it('accepts positive finite decimals and rejects everything else', () => {
    for (const [text, value] of [['10', 10], [' 12.5 ', 12.5], ['12,5', 12.5], ['0.25', 0.25], ['.5', 0.5], ['5.', 5], ['1e2', 100], ['25 mm', 25], ['25MM', 25], ['+3', 3]] as const) {
      expect(parseKnownDistanceMm(text), text).toEqual({ ok: true, value });
    }
    for (const text of ['', ' ', '0', '0.0', '-5', 'abc', '12 cm', '1,2,3', '1.2.3', 'NaN', 'Infinity', '1e999', '--1', '0x10', '1 2']) {
      expect(parseKnownDistanceMm(text), JSON.stringify(text)).toMatchObject({ ok: false, message: expect.stringContaining('positive number of millimetres') });
    }
  });
  it('validates stored calibrations before they are trusted', () => {
    expect(isValidCalibration({ pixelsPerMm: 12 })).toBe(true);
    for (const bad of [undefined, null, { pixelsPerMm: 0 }, { pixelsPerMm: -1 }, { pixelsPerMm: Number.NaN }, { pixelsPerMm: Number.POSITIVE_INFINITY }]) expect(isValidCalibration(bad)).toBe(false);
  });
  it('round-trips the pixel scale through calibrate and measure at any angle', () => {
    const a = { x: 120.25, y: 80.5 }, b = { x: 120.25 + 300, y: 80.5 + 400 };
    const calibration = calibrate(a, b, 25);
    expect(calibration.pixelsPerMm).toBeCloseTo(20, 12);
    expect(measure({ x: 0, y: 0 }, { x: 60, y: 80 }, calibration)).toBeCloseTo(5, 12);
    expect(measure(b, a, calibration)).toBeCloseTo(25, 12);
  });
});

describe('camera persistence', () => {
  it('restores a stored camera and clamps what a damaged manifest could contain', () => {
    const view = cameraToView({ zoom: 2, rotation: 90, x: 300, y: 200, fit: 'none' }, 1000, 800, 640, 480);
    expect(view).toEqual({ center: { x: 300, y: 200 }, scale: 2, rotation: 90, fit: 'none' });
    expect(cameraToView({ zoom: 2, x: 1e9, y: -1e9 }, 1000, 800, 640, 480).center).toEqual({ x: 1000, y: 0 });
    expect(cameraToView({ zoom: 2, x: Number.NaN }, 1000, 800, 640, 480).center).toEqual({ x: 500, y: 400 });
    expect(cameraToView({ zoom: 1e9 }, 1000, 800, 640, 480).scale).toBe(IMAGE_LIMITS.maxScale);
    expect(cameraToView({ zoom: 0 }, 1000, 800, 640, 480)).toMatchObject({ fit: 'page', rotation: 0 });
    expect(cameraToView({ zoom: -3, fit: 'none' }, 1000, 800, 640, 480).fit).toBe('page');
    expect(cameraToView({ rotation: 45 }, 1000, 800, 640, 480).rotation).toBe(90);
    expect(cameraToView(undefined, 1000, 800, 640, 480)).toMatchObject({ fit: 'page', center: { x: 500, y: 400 } });
  });
  it('lets a fit request win over stored zoom and centre because they depend on the pane size', () => {
    const fitted = cameraToView({ zoom: 5, x: 10, y: 10, fit: 'page' }, 1000, 800, 640, 480);
    expect(fitted.fit).toBe('page');
    expect(fitted.scale).toBeCloseTo(Math.min(592 / 1000, 432 / 800), 12);
    expect(fitted.center).toEqual({ x: 500, y: 400 });
    const width = cameraToView({ fit: 'width' }, 1000, 2000, 640, 480);
    expect(width.fit).toBe('width');
    expect(width.scale).toBeCloseTo(0.592, 12);
    expect(fitViewMode('width', 1000, 2000, 90, 640, 480, 24).scale).toBeCloseTo(592 / 2000, 12);
    expect(fitViewMode('page', 1000, 2000, 90, 640, 480, 24)).toEqual(fitView(1000, 2000, 90, 640, 480, 24));
  });
  it('emits and compares cameras without drifting', () => {
    const camera = viewToCamera({ center: { x: 12.5, y: 7 }, scale: 1.5, rotation: 270, fit: 'none' });
    expect(camera).toEqual({ zoom: 1.5, rotation: 270, x: 12.5, y: 7, fit: 'none' });
    expect(sameCamera(camera, { ...camera })).toBe(true);
    expect(sameCamera(camera, { ...camera, x: 12.5 + 1e-9 })).toBe(true);
    expect(sameCamera(camera, { ...camera, zoom: 1.5001 })).toBe(false);
    expect(sameCamera(camera, { ...camera, rotation: 0 })).toBe(false);
    expect(sameCamera(camera, { ...camera, fit: 'page' })).toBe(false);
    expect(sameCamera({ zoom: 1 }, { zoom: 1, x: 0 })).toBe(false);
    expect(sameCamera({ zoom: 1, rotation: 0 }, { zoom: 1 })).toBe(true);
  });
  it('keeps the view centre inside the image', () => {
    expect(clampCenter({ x: -5, y: 900 }, 100, 800)).toEqual({ x: 0, y: 800 });
    expect(clampCenter({ x: Number.NaN, y: Number.POSITIVE_INFINITY }, 100, 800)).toEqual({ x: 50, y: 400 });
  });
});

describe('visible region and marker hits', () => {
  it('limits drawing to the image rectangle that can reach the viewport', () => {
    const whole = visibleImageRect({ center: { x: 500, y: 400 }, scale: 0.5, rotation: 0 }, 640, 480, 1000, 800);
    expect(whole).toEqual({ x: 0, y: 0, width: 1000, height: 800 });
    const zoomed = visibleImageRect({ center: { x: 500, y: 400 }, scale: 4, rotation: 0 }, 640, 480, 1000, 800)!;
    expect(zoomed).toEqual({ x: 500 - 80 - 1, y: 400 - 60 - 1, width: 162, height: 122 });
    const turned = visibleImageRect({ center: { x: 500, y: 400 }, scale: 4, rotation: 90 }, 640, 480, 1000, 800)!;
    expect(turned).toEqual({ x: 500 - 60 - 1, y: 400 - 80 - 1, width: 122, height: 162 });
    expect(visibleImageRect({ center: { x: 1e6, y: 1e6 }, scale: 1, rotation: 0 }, 640, 480, 1000, 800)).toBeNull();
    const corner = visibleImageRect({ center: { x: 0, y: 0 }, scale: 1, rotation: 0 }, 640, 480, 1000, 800)!;
    expect(corner.x).toBe(0);
    expect(corner.y).toBe(0);
  });
  it('picks the nearest marker within the radius, preferring the one drawn last on a tie', () => {
    const view = { center: { x: 100, y: 100 }, scale: 2, rotation: 0 as Rotation };
    const markers = [{ id: 'a', x: 100, y: 100 }, { id: 'b', x: 104, y: 100 }, { id: 'c', x: 100, y: 100 }, { id: 'bad', x: Number.NaN, y: 0 }];
    expect(hitTestMarker(markers, { x: 200, y: 200 }, view, 400, 400)).toBe('c');
    expect(hitTestMarker(markers, { x: 210, y: 200 }, view, 400, 400)).toBe('b');
    expect(hitTestMarker(markers, { x: 300, y: 300 }, view, 400, 400)).toBeNull();
    expect(hitTestMarker([], { x: 0, y: 0 }, view, 400, 400)).toBeNull();
    const turned = { ...view, rotation: 90 as Rotation };
    expect(hitTestMarker([{ id: 'r', x: 110, y: 100 }], imageToScreen({ x: 110, y: 100 }, turned, 400, 400), turned, 400, 400)).toBe('r');
  });
});
