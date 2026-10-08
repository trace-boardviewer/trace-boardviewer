import type { Bounds2, Point2, ViewTransform } from '../geometry';
import { type Matrix3, invert, multiply, multiplyAll, rotation, toCssMatrix, toCssMatrix3d, transform } from './matrix3';
import type { MappedQuad, Registration } from './registration';

/**
 * Composition of a registration with the two views the app has: the board camera (src/lib/geometry.ts ViewTransform, the numbers of the
 * persisted BoardCamera) and the image viewer's view (src/lib/images.ts ImageView). Everything is a 3x3 matrix so the UI can hand it to
 * the canvas (affine) or to CSS (`matrix3d`, any plane map) without a per-point loop:
 *
 *   board mm --boardToScreenMatrix--> screen px          (what the board canvas draws)
 *   image px --imageToScreenMatrix--> screen px          (draw the photo UNDER the board: the board view stays as it is)
 *   board mm --boardToImageScreenMatrix--> screen px     (draw the board OVER the photo: the image view stays as it is)
 */

/** The image viewer's view without importing it: image pixel at the viewport centre, CSS px per image px, clockwise display rotation (0, 90, 180, 270). */
export interface ImageViewLike { center: Point2; scale: number; rotation: number }

/** Board millimetres to screen pixels; identical to `boardToScreen(point, view, width, height)`. */
export function boardToScreenMatrix(view: ViewTransform, width: number, height: number): Matrix3 {
  const angle = view.rotation * Math.PI / 180;
  const c = Math.cos(angle) * view.scale, s = Math.sin(angle) * view.scale;
  const sx = view.mirrored ? -1 : 1;
  // screen = (w/2, h/2) + scale * R(rotation) * diag(mirrored ? -1 : 1, -1) * (point - center)
  const a = c * sx, b = s, d = s * sx, e = -c;
  return [a, b, width / 2 - (a * view.center.x + b * view.center.y), d, e, height / 2 - (d * view.center.x + e * view.center.y), 0, 0, 1];
}

/** Photo pixels to screen pixels in the image viewer; identical to `imageToScreen(point, view, width, height)` of src/lib/images.ts. */
export function imageViewMatrix(view: ImageViewLike, width: number, height: number): Matrix3 {
  return multiplyAll(
    [1, 0, width / 2, 0, 1, height / 2, 0, 0, 1],
    rotation(view.rotation * Math.PI / 180),
    [view.scale, 0, 0, 0, view.scale, 0, 0, 0, 1],
    [1, 0, -view.center.x, 0, 1, -view.center.y, 0, 0, 1],
  );
}

/** Photo pixels to screen pixels when the photo is drawn in the board view. Null if the registration is not invertible (it always is for a valid one). */
export function imageToScreenMatrix(registration: Pick<Registration, 'imageToBoard'>, view: ViewTransform, width: number, height: number): Matrix3 {
  return multiply(boardToScreenMatrix(view, width, height), registration.imageToBoard);
}

/** Screen pixels to photo pixels in the board view (where on the photo a click landed). */
export function screenToImageMatrix(registration: Pick<Registration, 'boardToImage'>, view: ViewTransform, width: number, height: number): Matrix3 | null {
  const inverse = invert(boardToScreenMatrix(view, width, height));
  return inverse ? multiply(registration.boardToImage, inverse) : null;
}

/** Screen pixels to board millimetres; identical to `screenToBoard(point, view, width, height)`. */
export function screenToBoardMatrix(view: ViewTransform, width: number, height: number): Matrix3 | null {
  return invert(boardToScreenMatrix(view, width, height));
}

/** Board millimetres to screen pixels when the board is drawn over the photo in the image viewer. */
export function boardToImageScreenMatrix(registration: Pick<Registration, 'boardToImage'>, imageView: ImageViewLike, width: number, height: number): Matrix3 {
  return multiply(imageViewMatrix(imageView, width, height), registration.boardToImage);
}

export interface OverlayTransform {
  /** The matrix that sends photo pixels to screen pixels. */
  readonly matrix: Matrix3;
  /** CSS `matrix(...)` when the map is affine (also valid for `ctx.setTransform`), otherwise null. */
  readonly css: string | null;
  /** CSS `matrix3d(...)` for any map. Set it on an element with `transform-origin: 0 0` whose size is the photo's pixel size. */
  readonly css3d: string;
  /** Where the corners of the photo (0, 0, width, height) land on screen; null when a corner has no image (the photo is partly behind the horizon). */
  readonly quad: MappedQuad | null;
}

/** What the UI needs to show a photo under the board: the matrix, its CSS forms and the screen quad of the photo. */
export function photoOverlay(registration: Pick<Registration, 'imageToBoard'>, view: ViewTransform, width: number, height: number, photo: { width: number; height: number }): OverlayTransform {
  const matrix = imageToScreenMatrix(registration, view, width, height);
  const rect: Bounds2 = { minX: 0, minY: 0, maxX: photo.width, maxY: photo.height };
  const corners = [{ x: rect.minX, y: rect.minY }, { x: rect.maxX, y: rect.minY }, { x: rect.maxX, y: rect.maxY }, { x: rect.minX, y: rect.maxY }].map(p => transform(matrix, p));
  const quad = corners.every(c => c !== null)
    ? (() => { const q = corners as [Point2, Point2, Point2, Point2]; return { corners: q, bounds: { minX: Math.min(...q.map(p => p.x)), minY: Math.min(...q.map(p => p.y)), maxX: Math.max(...q.map(p => p.x)), maxY: Math.max(...q.map(p => p.y)) } }; })()
    : null;
  return { matrix, css: toCssMatrix(matrix), css3d: toCssMatrix3d(matrix), quad };
}

/**
 * A board view (for the board camera: `viewToCamera`) that draws the board the way the photo shows it: turned and mirrored like the photo, at the
 * photo's own scale times `zoom` (CSS pixels per photo pixel), centred on the board point `center` (default: the middle of the pairs the map was
 * fitted to). For a photo taken straight above the board the two then agree everywhere; with perspective, at the centre.
 */
export function viewMatchingPhoto(registration: Pick<Registration, 'linear' | 'mirrored' | 'reference'>, options: { zoom?: number; center?: Point2 } = {}): ViewTransform {
  return { center: options.center ?? registration.reference, scale: registration.linear.pixelsPerMm * (options.zoom ?? 1), rotation: registration.linear.rotationDegrees, mirrored: registration.mirrored };
}
