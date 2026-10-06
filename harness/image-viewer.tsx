import { Profiler, StrictMode, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/manrope/400.css';
import '@fontsource/manrope/500.css';
import '@fontsource/manrope/600.css';
import '@fontsource/manrope/700.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import '../src/styles.css';
import { ImageViewer } from '../src/components/ImageViewer';
import type { ViewerCamera } from '../src/components/viewer-contracts';
import type { DocumentAnnotation, DocumentBookmark, DocumentCalibration } from '../src/lib/documents';
import { imageToScreen, loadImageDocument, screenToImage } from '../src/lib/images';

// ---------------------------------------------------------------------------------------------
// Synthetic fixtures (original, generated here; nothing is read from disk)
// ---------------------------------------------------------------------------------------------

const enc = new TextEncoder();
const QUAD = { tl: '#e62828', tr: '#28c83c', bl: '#3250e6', br: '#f0dc28' } as const;

const canvasOf = (width: number, height: number) => Object.assign(document.createElement('canvas'), { width, height });
const toBytes = async (canvas: HTMLCanvasElement, type: string, quality?: number) => {
  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, type, quality));
  if (!blob || blob.type !== type) throw new Error(`canvas.toBlob(${type}) is not supported (${blob?.type})`);
  return new Uint8Array(await blob.arrayBuffer());
};

function quadCanvas(width = 400, height = 300) {
  const canvas = canvasOf(width, height), ctx = canvas.getContext('2d')!;
  ctx.fillStyle = QUAD.tl; ctx.fillRect(0, 0, width / 2, height / 2);
  ctx.fillStyle = QUAD.tr; ctx.fillRect(width / 2, 0, width / 2, height / 2);
  ctx.fillStyle = QUAD.bl; ctx.fillRect(0, height / 2, width / 2, height / 2);
  ctx.fillStyle = QUAD.br; ctx.fillRect(width / 2, height / 2, width / 2, height / 2);
  return canvas;
}

/** A board-photo look-alike with a printed 1 mm = 20 px ruler along the bottom (so calibration has a real reference). */
function boardCanvas(width = 1600, height = 1000) {
  const canvas = canvasOf(width, height), ctx = canvas.getContext('2d')!;
  const gradient = ctx.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, '#1d5a3c'); gradient.addColorStop(1, '#0f3b27');
  ctx.fillStyle = gradient; ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = '#c9a95a'; ctx.lineWidth = 6; ctx.lineCap = 'round';
  for (let i = 0; i < 14; i++) { ctx.beginPath(); ctx.moveTo(80, 120 + i * 48); ctx.lineTo(300 + (i % 4) * 160, 120 + i * 48); ctx.lineTo(420 + (i % 5) * 150, 90 + i * 52); ctx.stroke(); }
  for (let col = 0; col < 8; col++) for (let row = 0; row < 5; row++) {
    const x = 640 + col * 100, y = 160 + row * 100;
    ctx.fillStyle = '#2b2b2f'; ctx.fillRect(x - 28, y - 28, 56, 56);
    ctx.fillStyle = '#d7d7d9'; for (let p = 0; p < 4; p++) ctx.fillRect(x - 40, y - 24 + p * 14, 12, 8);
    ctx.fillStyle = '#e8eff5'; ctx.font = '600 16px sans-serif'; ctx.fillText(`U${col * 5 + row + 1}`, x - 14, y + 6);
  }
  ctx.fillStyle = '#f5f5ee'; ctx.fillRect(100, height - 150, 1000, 70);
  ctx.fillStyle = '#111';
  for (let mm = 0; mm <= 40; mm++) { const long = mm % 10 === 0, mid = mm % 5 === 0; ctx.fillRect(120 + mm * 20 - 1, height - 150, 2, long ? 40 : mid ? 28 : 16); }
  ctx.font = '600 18px sans-serif';
  for (let mm = 0; mm <= 40; mm += 10) ctx.fillText(String(mm), 120 + mm * 20 - 8, height - 96);
  ctx.fillText('mm', 120 + 40 * 20 + 20, height - 96);
  ctx.fillStyle = '#e62828'; ctx.beginPath(); ctx.arc(1380, 800, 40, 0, Math.PI * 2); ctx.fill();
  return canvas;
}

/** Inserts an EXIF APP1 segment (orientation tag only) right after SOI; orientation 6 = "rotate 90 degrees clockwise to display". */
function withExifOrientation(jpeg: Uint8Array, orientation: number): Uint8Array {
  const tiff = [0x4d, 0x4d, 0x00, 0x2a, 0, 0, 0, 8, 0x00, 0x01, 0x01, 0x12, 0x00, 0x03, 0, 0, 0, 1, 0x00, orientation, 0, 0, 0, 0, 0, 0];
  const body = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
  const segment = [0xff, 0xe1, (body.length + 2) >> 8, (body.length + 2) & 255, ...body];
  return Uint8Array.from([...jpeg.subarray(0, 2), ...segment, ...jpeg.subarray(2)]);
}

const svgDoc = (attrs: string, body: string) => `<svg xmlns="http://www.w3.org/2000/svg" ${attrs}>${body}</svg>`;
const RED = '<rect x="0" y="110" width="100" height="40" fill="#ff0000"/>';
export const SVG_FIXTURES = {
  // B30: the controls (width+viewBox, full size) and the two single-dimension cases of the audit.
  'svg-width-only': svgDoc('width="100"', RED),
  'svg-height-only': svgDoc('height="100"', '<rect x="200" y="0" width="100" height="100" fill="#ff0000"/>'),
  'svg-width-viewbox': svgDoc('width="100" viewBox="0 0 100 150"', RED),
  'svg-full': svgDoc('width="100" height="150"', RED),
  'svg-quad': svgDoc('width="400" height="300"', `<rect width="200" height="150" fill="${QUAD.tl}"/><rect x="200" width="200" height="150" fill="${QUAD.tr}"/><rect y="150" width="200" height="150" fill="${QUAD.bl}"/><rect x="200" y="150" width="200" height="150" fill="${QUAD.br}"/>`),
  'svg-gradient': svgDoc('width="320" height="200" viewBox="0 0 320 200"', '<defs><linearGradient id="g" x1="0" x2="1"><stop offset="0" stop-color="#e62828"/><stop offset="1" stop-color="#3250e6"/></linearGradient></defs><rect width="320" height="200" style="fill:url(#g);stroke:#fff;stroke-width:4"/>'),
  // Everything here must be removed and disclosed; the red rect and the gradient style must survive.
  'svg-hostile': svgDoc('width="300" height="200" onload="window.__pwned=\'onload\'" xmlns:xlink="http://www.w3.org/1999/xlink"', [
    '<script>window.__pwned = "script"</script>',
    '<script xlink:href="http://127.0.0.1:5203/__hostile/script.js"></script>',
    '<style>@import url("http://127.0.0.1:5203/__hostile/import.css"); rect { fill: blue }</style>',
    '<defs><linearGradient id="ok"><stop offset="0" stop-color="#ff0000"/><stop offset="1" stop-color="#ff0000"/></linearGradient></defs>',
    '<rect id="safe" x="0" y="0" width="300" height="100" style="fill:url(#ok)" onclick="window.__pwned=\'click\'"/>',
    '<rect x="0" y="100" width="300" height="50" fill="url(http://127.0.0.1:5203/__hostile/fill.svg#p)" style="background:url(http://127.0.0.1:5203/__hostile/style.png)"/>',
    '<image href="http://127.0.0.1:5203/__hostile/remote.png" x="0" y="150" width="50" height="50"/>',
    '<image xlink:href="https://hostile.invalid/remote2.png" x="50" y="150" width="50" height="50"/>',
    '<image href="file:///etc/passwd" x="100" y="150" width="50" height="50"/>',
    '<image href="relative/local.png" x="150" y="150" width="50" height="50"/>',
    '<use href="http://127.0.0.1:5203/__hostile/use.svg#x"/>',
    '<use xlink:href="other.svg#x"/>',
    '<foreignObject width="100" height="100"><iframe xmlns="http://www.w3.org/1999/xhtml" src="http://127.0.0.1:5203/__hostile/frame.html"></iframe><body xmlns="http://www.w3.org/1999/xhtml" onload="window.__pwned=\'fo\'"/></foreignObject>',
    '<a href="javascript:window.__pwned=\'a\'"><rect width="10" height="10"/></a>',
    '<set attributeName="onmouseover" to="window.__pwned=\'set\'"/>',
    '<animate attributeName="href" to="http://127.0.0.1:5203/__hostile/animate"/>',
    '<g onmouseover="window.__pwned=\'g\'" style="filter:url(http://127.0.0.1:5203/__hostile/filter.svg#f)"><circle cx="250" cy="150" r="20" fill="#28c83c"/></g>',
  ].join('')),
  // Entity expansion (billion laughs): must be rejected or sanitized quickly, never hang the page.
  'svg-entity-bomb': `<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;"><!ENTITY c "&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;"><!ENTITY d "&c;&c;&c;&c;&c;&c;&c;&c;&c;&c;"><!ENTITY e "&d;&d;&d;&d;&d;&d;&d;&d;&d;&d;"><!ENTITY f "&e;&e;&e;&e;&e;&e;&e;&e;&e;&e;"><!ENTITY g "&f;&f;&f;&f;&f;&f;&f;&f;&f;&f;"><!ENTITY h "&g;&g;&g;&g;&g;&g;&g;&g;&g;&g;">]><svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><text>&h;</text></svg>`,
  'svg-latin1': '<?xml version="1.0" encoding="ISO-8859-1"?><svg xmlns="http://www.w3.org/2000/svg" width="120" height="40"><text x="4" y="28" font-size="24" font-family="sans-serif">café</text></svg>',
  'svg-huge': svgDoc('width="1000000" height="1000000"', '<rect width="500000" height="500000" fill="#e62828"/>'),
  'svg-thin-huge': svgDoc('width="1000000000000" height="1"', '<rect width="1000000000000" height="1" fill="#e62828"/>'),
} as const;

const setIhdrSize = (png: Uint8Array, width: number, height: number) => {
  const copy = png.slice();
  new DataView(copy.buffer).setUint32(16, width); new DataView(copy.buffer).setUint32(20, height);
  return copy;
};

async function buildFixture(name: string): Promise<Uint8Array> {
  if (name in SVG_FIXTURES) {
    const text = SVG_FIXTURES[name as keyof typeof SVG_FIXTURES];
    return name === 'svg-latin1' ? Uint8Array.from(text, c => c.charCodeAt(0)) : enc.encode(text);
  }
  switch (name) {
    case 'board-png': return toBytes(boardCanvas(), 'image/png');
    case 'quad-png': return toBytes(quadCanvas(), 'image/png');
    case 'quad-jpeg': return toBytes(quadCanvas(), 'image/jpeg', 0.95);
    case 'quad-webp': return toBytes(quadCanvas(), 'image/webp', 0.95);
    case 'exif-jpeg': return withExifOrientation(await toBytes(quadCanvas(), 'image/jpeg', 0.95), 6);
    case 'alpha-png': {
      const canvas = canvasOf(480, 320), ctx = canvas.getContext('2d')!;
      ctx.fillStyle = 'rgba(86, 212, 207, 0.85)'; ctx.beginPath(); ctx.arc(240, 160, 130, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = 'rgba(230, 40, 40, 0.6)'; ctx.fillRect(40, 40, 160, 120);
      return toBytes(canvas, 'image/png');
    }
    case 'big-png': {
      const canvas = canvasOf(4096, 3072), ctx = canvas.getContext('2d')!;
      const gradient = ctx.createLinearGradient(0, 0, 4096, 3072); gradient.addColorStop(0, '#1d5a3c'); gradient.addColorStop(1, '#3250e6');
      ctx.fillStyle = gradient; ctx.fillRect(0, 0, 4096, 3072);
      ctx.strokeStyle = '#f0dc28'; ctx.lineWidth = 3; for (let i = 0; i < 200; i++) { ctx.beginPath(); ctx.moveTo(0, i * 16); ctx.lineTo(4096, 3072 - i * 16); ctx.stroke(); }
      return toBytes(canvas, 'image/png');
    }
    case 'png-too-large': return setIhdrSize(await toBytes(quadCanvas(8, 8), 'image/png'), 20000, 20000);
    case 'png-zero-size': return setIhdrSize(await toBytes(quadCanvas(8, 8), 'image/png'), 0, 5);
    case 'png-corrupt': { const png = await toBytes(quadCanvas(16, 16), 'image/png'); const copy = png.slice(0, 64); copy.fill(0xaa, 40); return copy; }
    case 'bytes-unknown': return enc.encode('GIF89a\u0001\u0000\u0001\u0000 not a supported image');
    case 'html-not-svg': return enc.encode('<!DOCTYPE html><html><body><svg width="10" height="10"></svg><script>window.__pwned="html"</script></body></html>');
    case 'empty': return new Uint8Array(0);
    default: throw new Error(`unknown fixture ${name}`);
  }
}

// ---------------------------------------------------------------------------------------------
// Harness page (the shell's role: owns the controlled state)
// ---------------------------------------------------------------------------------------------

interface HarnessState { camera: ViewerCamera; calibration?: DocumentCalibration; bookmarks: DocumentBookmark[]; annotations: DocumentAnnotation[]; events: string[]; commits: number; cameraEmits: number; fixture: string; theme: string }
interface Api {
  mounted: boolean;
  fixtures: string[];
  load(name: string): Promise<void>;
  loadBytes(label: string, data: Uint8Array): void;
  props(next: { theme?: 'dark' | 'light'; compact?: boolean; motion?: boolean }): void;
  setCamera(camera: ViewerCamera): void;
  setCalibration(calibration: DocumentCalibration | undefined): void;
  setBookmarks(next: DocumentBookmark[]): void;
  setAnnotations(next: DocumentAnnotation[]): void;
  state(): HarnessState;
  phase(): 'loading' | 'error' | 'ready';
  clientOf(x: number, y: number): { x: number; y: number };
  imageAt(clientX: number, clientY: number): { x: number; y: number };
  stageSize(): { width: number; height: number };
  canvasPixel(clientX: number, clientY: number): number[];
  canvasStats(): { width: number; height: number; cssWidth: number; cssHeight: number; dpr: number; red: number };
  probeSvg(svg: string, sanitized: boolean): Promise<{ width: number; height: number; red: number; removed: string[] }>;
  fixtureText(name: string): string;
  fixtureBytes(name: string): Promise<Uint8Array>;
  resetCounters(): void;
}
declare global { interface Window { __imgv: Api; __pwned?: string; __bitmapCalls: number; __bitmapClosed: number } }

// Counters prove that rejected files never reach the decoder and that aborted decodes release their bitmaps.
window.__bitmapCalls = 0; window.__bitmapClosed = 0;
const nativeCreate = window.createImageBitmap.bind(window);
window.createImageBitmap = ((...args: Parameters<typeof createImageBitmap>) => { window.__bitmapCalls++; return nativeCreate(...args); }) as typeof createImageBitmap;
const nativeClose = ImageBitmap.prototype.close;
ImageBitmap.prototype.close = function close(this: ImageBitmap) { window.__bitmapClosed++; return nativeClose.call(this); };

const params = new URLSearchParams(location.search);
const names = ['board-png', 'quad-png', 'quad-jpeg', 'quad-webp', 'exif-jpeg', 'alpha-png', 'big-png', ...Object.keys(SVG_FIXTURES), 'png-too-large', 'png-zero-size', 'png-corrupt', 'bytes-unknown', 'html-not-svg', 'empty'];
const apiRef: { current: Partial<Api> } = { current: {} };
window.__imgv = new Proxy({ mounted: false, fixtures: names } as Api, { get: (target, key) => (key in target ? (target as never)[key] : (apiRef.current as never)[key]) });

function Harness() {
  const [fixture, setFixture] = useState(params.get('fixture') ?? 'board-png');
  const [data, setData] = useState<Uint8Array>(new Uint8Array(0));
  const [theme, setTheme] = useState<'dark' | 'light'>(params.get('theme') === 'light' ? 'light' : 'dark');
  const [compact, setCompact] = useState(params.get('compact') === '1');
  const [motion, setMotion] = useState(params.get('motion') !== 'off');
  const [camera, setCamera] = useState<ViewerCamera>({});
  const [calibration, setCalibration] = useState<DocumentCalibration | undefined>();
  const [bookmarks, setBookmarks] = useState<DocumentBookmark[]>([]);
  const [annotations, setAnnotations] = useState<DocumentAnnotation[]>([]);
  const cameraRef = useRef<ViewerCamera>({});
  const events = useRef<string[]>([]);
  const commits = useRef(0), cameraEmits = useRef(0);
  const stateRef = useRef({ fixture, theme, calibration, bookmarks, annotations });
  stateRef.current = { fixture, theme, calibration, bookmarks, annotations };
  // `?camera=ref` keeps the camera out of React state, like a shell that stores it in an external store.
  const cameraInState = params.get('camera') !== 'ref';
  const log = (line: string) => { events.current.push(line); if (events.current.length > 500) events.current.shift(); };

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.motion = motion ? 'on' : 'off';
    document.body.dataset.chrome = params.get('chrome') === '0' ? 'off' : 'on';
  }, [theme, motion]);

  useEffect(() => {
    const surface = () => document.querySelector<HTMLElement>('.imgv-surface')!;
    const live = () => { const c = cameraRef.current; const rect = surface().getBoundingClientRect(); return { c, rect }; };
    const toView = () => {
      const { c, rect } = live();
      return { view: { center: { x: c.x ?? 0, y: c.y ?? 0 }, scale: c.zoom ?? 1, rotation: (c.rotation ?? 0) as 0 | 90 | 180 | 270 }, rect };
    };
    const canvas = () => document.querySelector<HTMLCanvasElement>('.imgv-canvas')!;
    apiRef.current = {
      async load(name) {
        const bytes = await buildFixture(name);
        log(`load ${name}`);
        cameraRef.current = {}; setCamera({}); setCalibration(undefined); setBookmarks([]); setAnnotations([]);
        setFixture(name); setData(bytes);
      },
      loadBytes(label, bytes) { log(`loadBytes ${label}`); setFixture(label); setData(bytes); },
      props(next) { if (next.theme) setTheme(next.theme); if (next.compact !== undefined) setCompact(next.compact); if (next.motion !== undefined) setMotion(next.motion); },
      setCamera(next) { cameraRef.current = next; setCamera(next); },
      setCalibration(next) { setCalibration(next); },
      setBookmarks(next) { setBookmarks(next); },
      setAnnotations(next) { setAnnotations(next); },
      state: () => ({ camera: cameraRef.current, calibration: stateRef.current.calibration, bookmarks: stateRef.current.bookmarks, annotations: stateRef.current.annotations, events: events.current.slice(), commits: commits.current, cameraEmits: cameraEmits.current, fixture: stateRef.current.fixture, theme: stateRef.current.theme }),
      phase() { return (document.querySelector('.imgv')?.getAttribute('data-phase') ?? 'loading') as 'loading' | 'error' | 'ready'; },
      clientOf(x, y) {
        const { view, rect } = toView();
        const s = imageToScreen({ x, y }, view, surface().clientWidth, surface().clientHeight);
        return { x: rect.left + s.x, y: rect.top + s.y };
      },
      imageAt(clientX, clientY) {
        const { view, rect } = toView();
        return screenToImage({ x: clientX - rect.left, y: clientY - rect.top }, view, surface().clientWidth, surface().clientHeight);
      },
      stageSize: () => ({ width: surface().clientWidth, height: surface().clientHeight }),
      canvasPixel(clientX, clientY) {
        const el = canvas(), rect = el.getBoundingClientRect();
        const px = Math.round((clientX - rect.left) * el.width / rect.width), py = Math.round((clientY - rect.top) * el.height / rect.height);
        return Array.from(el.getContext('2d')!.getImageData(px, py, 1, 1).data);
      },
      canvasStats() {
        const el = canvas(), rect = el.getBoundingClientRect();
        const data = el.getContext('2d')!.getImageData(0, 0, el.width, el.height).data;
        let red = 0;
        for (let i = 0; i < data.length; i += 4) if (data[i] > 200 && data[i + 1] < 60 && data[i + 2] < 60 && data[i + 3] > 200) red++;
        return { width: el.width, height: el.height, cssWidth: rect.width, cssHeight: rect.height, dpr: devicePixelRatio, red };
      },
      async probeSvg(svg, sanitized) {
        // `sanitized`: the library pipeline (sanitize -> blob URL -> <img>); otherwise the browser's own intrinsic rendering of the raw, benign SVG as the control.
        let source: CanvasImageSource, width: number, height: number, removed: string[] = [], dispose = () => {};
        if (sanitized) {
          const doc = await loadImageDocument(enc.encode(svg));
          source = doc.source; width = doc.width; height = doc.height; removed = doc.removed; dispose = doc.dispose;
        } else {
          const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
          const img = new Image();
          await new Promise<void>((resolve, reject) => { img.onload = () => resolve(); img.onerror = () => reject(new Error('raw svg failed')); img.src = url; });
          source = img; width = img.naturalWidth; height = img.naturalHeight; dispose = () => URL.revokeObjectURL(url);
        }
        const probe = canvasOf(width, height), ctx = probe.getContext('2d', { willReadFrequently: true })!;
        ctx.drawImage(source, 0, 0, width, height);
        const data = ctx.getImageData(0, 0, width, height).data;
        let red = 0;
        for (let i = 0; i < data.length; i += 4) if (data[i] > 200 && data[i + 1] < 60 && data[i + 2] < 60 && data[i + 3] > 200) red++;
        dispose();
        return { width, height, red, removed };
      },
      fixtureText: name => SVG_FIXTURES[name as keyof typeof SVG_FIXTURES] ?? '',
      fixtureBytes: name => buildFixture(name),
      resetCounters() { commits.current = 0; cameraEmits.current = 0; events.current = []; window.__bitmapCalls = 0; window.__bitmapClosed = 0; },
    };
    (window.__imgv as { mounted: boolean }).mounted = true;
    void apiRef.current.load!(params.get('fixture') ?? 'board-png');
  }, []);

  return (
    <div className="harness">
      <header className="harness-bar">
        <strong>Image viewer harness</strong>
        <label>Fixture
          <select value={fixture} onChange={event => void window.__imgv.load(event.target.value)}>
            {!names.includes(fixture) ? <option value={fixture}>{fixture}</option> : null}
            {names.map(name => <option key={name}>{name}</option>)}
          </select>
        </label>
        <button type="button" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>Theme: {theme}</button>
        <button type="button" onClick={() => setCompact(!compact)}>Compact: {String(compact)}</button>
        <button type="button" onClick={() => setMotion(!motion)}>Motion: {String(motion)}</button>
        <span>calibration: {calibration ? `${calibration.pixelsPerMm.toFixed(3)} px/mm` : 'none'} · bookmarks {bookmarks.length} · notes {annotations.length}</span>
      </header>
      <main className="harness-view">
        <Profiler id="imgv" onRender={() => { commits.current++; }}>
          <ImageViewer
            name={`${fixture}.img`}
            data={data}
            camera={cameraInState ? camera : cameraRef.current}
            onCameraChange={next => { cameraRef.current = next; cameraEmits.current++; if (cameraInState) setCamera(next); }}
            theme={theme}
            motion={motion}
            compact={compact}
            calibration={calibration}
            onCalibrationChange={next => { log(`calibration ${next ? next.pixelsPerMm : 'cleared'}`); setCalibration(next); }}
            bookmarks={bookmarks}
            annotations={annotations}
            onBookmarksChange={next => { log(`bookmarks ${next.length}`); setBookmarks(next); }}
            onAnnotationsChange={next => { log(`annotations ${next.length}`); setAnnotations(next); }}
          />
        </Profiler>
      </main>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(params.get('strict') === '0' ? <Harness /> : <StrictMode><Harness /></StrictMode>);
