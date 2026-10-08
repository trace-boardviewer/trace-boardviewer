import { openPdf } from '../pdf/document';
import { buildPdfFixture } from '../pdf/pdf-fixture';
import type { FixturePage, FixtureText } from '../pdf/pdf-fixture';
import { rotateGray } from './raster';
import type { GrayImage, QuarterTurn } from './contract';

/**
 * Synthetic scans for tests and the browser harness only (the application never imports this module): pages of text are drawn by
 * pdf.js (Helvetica from the bundled standard fonts), rendered to 8-bit grey and wrapped as image-only pages of a new PDF, so the
 * result has no text layer at all, exactly like a scanned schematic. Ground truth is the text that was drawn.
 */
export interface SyntheticPage {
  /** Page box in points (default 360 x 200). */
  width?: number; height?: number;
  texts: FixtureText[];
  /** Quarter turns clockwise applied to the scanned image (e.g. 3: the labels read bottom to top on the scan). */
  turn?: QuarterTurn;
  /** Deterministic speckle: share of pixels flipped to a random grey (0..0.2). */
  noise?: number;
  /** /Rotate of the scanned page. */
  rotate?: 0 | 90 | 180 | 270;
}

function speckle(image: GrayImage, share: number, seed: number): GrayImage {
  if (!(share > 0)) return image;
  let state = seed >>> 0 || 1;
  const random = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 4294967296; };
  const data = image.data.slice();
  for (let i = 0; i < data.length; i++) if (random() < share) data[i] = Math.floor(random() * 256);
  return { ...image, data };
}

/** The rendered grey image of one text page (the scan before it is wrapped). */
export async function renderTextPage(page: SyntheticPage, dpi: number): Promise<GrayImage> {
  const width = page.width ?? 360, height = page.height ?? 200;
  const handle = await openPdf(buildPdfFixture({ pages: [{ width, height, texts: page.texts }] }));
  try {
    const raster = await handle.renderPageGray(1, { dpi, maxPixels: 40_000_000 });
    return rotateGray(raster.image, page.turn ?? 0);
  } finally {
    await handle.destroy();
  }
}

/** An image-only PDF whose pages are the scans of `pages` at `dpi` (default 300). */
export async function buildSyntheticScan(pages: readonly SyntheticPage[], options: { dpi?: number; extra?: FixturePage[] } = {}): Promise<Uint8Array> {
  const dpi = options.dpi ?? 300;
  const scanned: FixturePage[] = [];
  for (const [index, page] of pages.entries()) {
    const image = speckle(await renderTextPage(page, dpi), Math.min(0.2, page.noise ?? 0), index + 1);
    const turned = (page.turn ?? 0) % 2 === 1;
    const width = page.width ?? 360, height = page.height ?? 200;
    const box = turned ? { width: height, height: width } : { width, height };
    scanned.push({ ...box, rotate: page.rotate, raster: { width: image.width, height: image.height, data: image.data } });
  }
  return buildPdfFixture({ pages: [...scanned, ...(options.extra ?? [])] });
}
