import { describe, expect, it } from 'vitest';
import { type Point2, type ViewTransform, boardToScreen, screenToBoard } from '../geometry';
import { type ImageView, imageToScreen, screenToImage } from '../images';
import { boardToImageScreenMatrix, boardToScreenMatrix, imageToScreenMatrix, imageViewMatrix, photoOverlay, screenToBoardMatrix, screenToImageMatrix, viewMatchingPhoto } from './compose';
import { type Matrix3, transform } from './matrix3';
import { mapBoardToImage, mapImageToBoard, registerBoardImage } from './registration';
import { BOARD_100x60, Rng, cameraMatrix, forAll, makePairs, randomPoint, wellSpreadPoints } from './testkit';

const dist = (a: Point2, b: Point2) => Math.hypot(a.x - b.x, a.y - b.y);
const map = (m: Matrix3, p: Point2) => transform(m, p)!;

function randomView(rng: Rng): ViewTransform {
  return { center: randomPoint(rng, { minX: -80, minY: -50, maxX: 80, maxY: 50 }), scale: rng.range(0.5, 40), rotation: rng.pick([0, 90, 180, 270, rng.range(-360, 360)]), mirrored: rng.chance(0.5) };
}
function randomImageView(rng: Rng): ImageView {
  return { center: randomPoint(rng, { minX: 0, minY: 0, maxX: 3840, maxY: 2160 }), scale: rng.range(0.05, 4), rotation: rng.pick([0, 90, 180, 270] as const) };
}
function registration(rng: Rng, tilt = 12, noisePx = 0.4) {
  const spec = { focalPx: 3000, width: 3840, height: 2160, distanceMm: 250, tiltDeg: rng.range(-tilt, tilt), panDeg: rng.range(-tilt, tilt), rollDeg: rng.range(-180, 180), mirrored: rng.chance(0.5) };
  const m = cameraMatrix(spec);
  const pairs = makePairs(rng, wellSpreadPoints(rng, 7, BOARD_100x60), p => map(m, p), noisePx);
  return registerBoardImage(pairs, { mirrored: spec.mirrored });
}

describe('views as matrices', () => {
  it('boardToScreenMatrix is boardToScreen (every rotation, both sides) and its inverse is screenToBoard', () => {
    forAll(300, 201, rng => {
      const view = randomView(rng), w = rng.int(300, 2400), h = rng.int(200, 1400);
      const matrix = boardToScreenMatrix(view, w, h), inverse = screenToBoardMatrix(view, w, h)!;
      for (let k = 0; k < 10; k++) {
        const p = randomPoint(rng, { minX: -200, minY: -200, maxX: 200, maxY: 200 });
        expect(dist(map(matrix, p), boardToScreen(p, view, w, h))).toBeLessThan(1e-7 * (1 + view.scale));
        const s = randomPoint(rng, { minX: 0, minY: 0, maxX: w, maxY: h });
        expect(dist(map(inverse, s), screenToBoard(s, view, w, h))).toBeLessThan(1e-7);
      }
    });
  });

  it('imageViewMatrix is imageToScreen of the image viewer for the four display rotations', () => {
    forAll(300, 202, rng => {
      const view = randomImageView(rng), w = rng.int(300, 2400), h = rng.int(200, 1400);
      const matrix = imageViewMatrix(view, w, h);
      for (let k = 0; k < 10; k++) {
        const p = randomPoint(rng, { minX: -100, minY: -100, maxX: 4000, maxY: 2300 });
        expect(dist(map(matrix, p), imageToScreen(p, view, w, h))).toBeLessThan(1e-6);
      }
    });
  });
});

describe('a registration under the board view and under the image view', () => {
  it('draws a photo pixel where the board draws the place it shows (photo under the board)', () => {
    forAll(120, 211, rng => {
      const r = registration(rng), view = randomView(rng), w = 1600, h = 900;
      const photoToScreen = imageToScreenMatrix(r, view, w, h);
      for (let k = 0; k < 10; k++) {
        const pixel = randomPoint(rng, { minX: 0, minY: 0, maxX: 3840, maxY: 2160 });
        const board = mapImageToBoard(r, pixel)!;
        expect(dist(map(photoToScreen, pixel), boardToScreen(board, view, w, h))).toBeLessThan(1e-5 * (1 + view.scale));
      }
    });
  });

  it('answers a click on the board canvas with the photo pixel under it (screen to photo)', () => {
    forAll(120, 212, rng => {
      const r = registration(rng), view = randomView(rng), w = 1600, h = 900;
      const toImage = screenToImageMatrix(r, view, w, h)!;
      const photoToScreen = imageToScreenMatrix(r, view, w, h);
      for (let k = 0; k < 10; k++) {
        const screen = randomPoint(rng, { minX: 0, minY: 0, maxX: w, maxY: h });
        const pixel = transform(toImage, screen);
        expect(pixel).not.toBeNull();
        expect(dist(map(photoToScreen, pixel!), screen)).toBeLessThan(1e-4);
        expect(dist(pixel!, mapBoardToImage(r, screenToBoard(screen, view, w, h))!)).toBeLessThan(1e-5);
      }
    });
  });

  it('draws the board over the photo in the image viewer (board to screen through the photo)', () => {
    forAll(120, 213, rng => {
      const r = registration(rng), view = randomImageView(rng), w = 1600, h = 900;
      const boardToPhotoScreen = boardToImageScreenMatrix(r, view, w, h);
      for (let k = 0; k < 10; k++) {
        const p = randomPoint(rng, BOARD_100x60);
        expect(dist(map(boardToPhotoScreen, p), imageToScreen(mapBoardToImage(r, p)!, view, w, h))).toBeLessThan(1e-6);
        // ... and the image viewer's own inverse takes it back to the photo pixel.
        expect(dist(screenToImage(map(boardToPhotoScreen, p), view, w, h), mapBoardToImage(r, p)!)).toBeLessThan(1e-5);
      }
    });
  });

  it('shows the board turned and mirrored like the photo when the board camera takes the linearization of the map', () => {
    forAll(100, 214, rng => {
      const r = registration(rng, 0, 0);
      const boardView = viewMatchingPhoto(r);
      const at = mapBoardToImage(r, r.reference)!;
      for (let k = 0; k < 10; k++) {
        const p = randomPoint(rng, BOARD_100x60);
        // Screen centre = the photo pixel of the reference: the board camera and the photo then agree everywhere (a straight photo has no perspective).
        const screen = boardToScreen(p, boardView, 2 * at.x, 2 * at.y);
        expect(dist(screen, mapBoardToImage(r, p)!)).toBeLessThan(1e-4);
      }
    });
  });
});

describe('viewMatchingPhoto', () => {
  it('scales with the zoom, turns and mirrors like the photo, and can be centred elsewhere', () => {
    const r = registration(new Rng(215), 0, 0);
    const base = viewMatchingPhoto(r);
    expect(base.center).toEqual(r.reference);
    expect(base.scale).toBeCloseTo(r.linear.pixelsPerMm, 12);
    expect(base.rotation).toBeCloseTo(r.linear.rotationDegrees, 12);
    expect(base.mirrored).toBe(r.mirrored);
    const zoomed = viewMatchingPhoto(r, { zoom: 0.25, center: { x: 5, y: -3 } });
    expect(zoomed.scale).toBeCloseTo(base.scale * 0.25, 12);
    expect(zoomed.center).toEqual({ x: 5, y: -3 });
    // The board camera of the app accepts the numbers as they are.
    const view: ViewTransform = zoomed;
    expect(dist(map(boardToScreenMatrix(view, 800, 600), { x: 5, y: -3 }), { x: 400, y: 300 })).toBeLessThan(1e-9);
  });
});

describe('what to hand to the canvas and to CSS', () => {
  /** Applies `matrix(a, b, c, d, e, f)` to a point the way CSS does. */
  const applyCss = (css: string, p: Point2): Point2 => {
    const [a, b, c, d, e, f] = css.match(/matrix\(([^)]*)\)/)![1].split(',').map(Number);
    return { x: a * p.x + c * p.y + e, y: b * p.x + d * p.y + f };
  };
  const applyCss3d = (css: string, p: Point2): Point2 => {
    const v = css.match(/matrix3d\(([^)]*)\)/)![1].split(',').map(Number);
    const w = v[3] * p.x + v[7] * p.y + v[15];
    return { x: (v[0] * p.x + v[4] * p.y + v[12]) / w, y: (v[1] * p.x + v[5] * p.y + v[13]) / w };
  };

  it('photoOverlay of an affine alignment has both CSS forms and the screen quad of the photo', () => {
    forAll(60, 221, rng => {
      const spec = { focalPx: 3000, width: 3840, height: 2160, distanceMm: 250, rollDeg: rng.range(-180, 180), mirrored: rng.chance(0.5) };
      const m = cameraMatrix(spec);
      const r = registerBoardImage(makePairs(rng, wellSpreadPoints(rng, 3, BOARD_100x60), p => map(m, p)), { mirrored: spec.mirrored });
      const view = randomView(rng), w = 1600, h = 900;
      const overlay = photoOverlay(r, view, w, h, { width: 3840, height: 2160 });
      expect(overlay.css).not.toBeNull();
      const probes = [{ x: 0, y: 0 }, { x: 3840, y: 0 }, { x: 3840, y: 2160 }, { x: 0, y: 2160 }, { x: 1000, y: 700 }];
      probes.forEach((p, i) => {
        const expected = map(overlay.matrix, p);
        expect(dist(applyCss(overlay.css!, p), expected)).toBeLessThan(1e-6 * (1 + Math.abs(expected.x) + Math.abs(expected.y)));
        expect(dist(applyCss3d(overlay.css3d, p), expected)).toBeLessThan(1e-6 * (1 + Math.abs(expected.x) + Math.abs(expected.y)));
        if (i < 4) expect(dist(overlay.quad!.corners[i], expected)).toBeLessThan(1e-9);
      });
      expect(overlay.quad!.bounds.maxX).toBeGreaterThan(overlay.quad!.bounds.minX);
    });
  });

  it('a perspective alignment has only the matrix3d form', () => {
    const rng = new Rng(222);
    const spec = { focalPx: 3000, width: 3840, height: 2160, distanceMm: 120, tiltDeg: 25, panDeg: 10, rollDeg: 20, mirrored: true };
    const m = cameraMatrix(spec);
    const r = registerBoardImage(makePairs(rng, wellSpreadPoints(rng, 6, BOARD_100x60), p => map(m, p)), { mirrored: true });
    const view: ViewTransform = { center: { x: 0, y: 0 }, scale: 8, rotation: 0, mirrored: false };
    const overlay = photoOverlay(r, view, 1600, 900, { width: 3840, height: 2160 });
    expect(overlay.css).toBeNull();
    expect(overlay.css3d).toMatch(/^matrix3d\(/);
    for (const p of [{ x: 100, y: 100 }, { x: 3700, y: 2000 }, { x: 1920, y: 1080 }]) {
      const expected = map(overlay.matrix, p);
      expect(dist(applyCss3d(overlay.css3d, p), expected)).toBeLessThan(1e-6 * (1 + Math.abs(expected.x) + Math.abs(expected.y)));
    }
  });

  it('says that the photo has no screen quad when a corner of it is on the horizon of the map', () => {
    const r = registration(new Rng(223));
    // W is negative on the left half of the photo: its left corners are on the far side of the horizon of the map.
    const flipped = { ...r, imageToBoard: [0.01, 0, 0, 0, 0.01, 0, 0.001, 0, -1] as Matrix3 };
    const overlay = photoOverlay(flipped, { center: { x: 0, y: 0 }, scale: 1, rotation: 0, mirrored: false }, 800, 600, { width: 3840, height: 2160 });
    expect(overlay.quad).toBeNull();
    expect(overlay.css).toBeNull();
    expect(overlay.css3d).toMatch(/^matrix3d\(/);
  });
});
