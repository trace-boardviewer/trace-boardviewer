import { describe, expect, it } from 'vitest';
import * as overlay from './index';
import {
  type Correspondence, analyzeThermal, buildFeatureIndex, checkRightFile, featuresUnderPolygon, findHotRegions, imagePolygonToBoard, intersectWithNets, mapBoardToImage, parseThermalCsv, photoOverlay,
  registerBoardImage, registrationFromRecord, registrationToRecord, resizeMatrix, deriveRegistration, transform, invert,
} from './index';
import { Rng, cameraMatrix, makePairs } from './testkit';
import { makeThermalGrid, makeToyBoard } from './testkit-board';

describe('the public API of src/lib/overlay', () => {
  it('exports every function the interface needs', () => {
    const functions = [
      'registerBoardImage', 'fitTransform', 'mapBoardToImage', 'mapImageToBoard', 'mapBoardRectToImage', 'mapImageRectToBoard', 'mapBoardPointsToImage', 'mapImagePointsToBoard', 'linearizeAt',
      'deriveRegistration', 'rankPhotosForBoardPoint', 'registrationToRecord', 'registrationFromRecord', 'suggestOrientation', 'modelForCount', 'mirroredForSide', 'orientBoardPoint',
      'boardToScreenMatrix', 'screenToBoardMatrix', 'imageViewMatrix', 'imageToScreenMatrix', 'screenToImageMatrix', 'boardToImageScreenMatrix', 'photoOverlay', 'viewMatchingPhoto',
      'invert', 'multiply', 'multiplyAll', 'transform', 'transformPoints', 'toCssMatrix', 'toCssMatrix3d',
      'parseThermalCsv', 'gridFromRgba', 'makeGrid', 'gridStats', 'differenceGrid', 'sampleGrid', 'sampleGridAtBoard', 'gridCellCentersToBoard', 'gridFootprintOnBoard', 'resampleToBoard', 'resizeMatrix',
      'findHotRegions', 'analyzeHotRegions', 'analyzeThermal', 'intersectWithNets', 'buildFeatureIndex', 'featuresUnderPolygon', 'imagePolygonToBoard', 'clipPolygonToRect', 'polygonArea',
      'checkRightFile', 'typicalPitchMm', 'chiSquareSurvivalEven',
    ];
    for (const name of functions) expect(typeof (overlay as Record<string, unknown>)[name], name).toBe('function');
    expect(typeof overlay.RegistrationError).toBe('function');
    expect(typeof overlay.ThermalError).toBe('function');
    expect(Object.isFrozen(overlay.RIGHT_FILE_THRESHOLDS)).toBe(true);
  });

  it('carries a photo of a board through every step the interface takes: align, save, overlay, thermal, nets, damage, right file', () => {
    const rng = new Rng(601);
    const board = makeToyBoard({ netOf: (column, row) => (column === 6 && row === 3 ? 'VDD_MAIN' : `S${column}_${row}`) });
    const { query } = buildFeatureIndex(board);

    // 1. Align a 4K photo: four pairs, then a fifth to see the error.
    const photoSpec = { focalPx: 3000, width: 3840, height: 2160, distanceMm: 100, tiltDeg: 4, rollDeg: 20, mirrored: false };
    const photoCamera = cameraMatrix(photoSpec);
    const picks = [0, 9, 59, 50, 24].map(i => board.components[i].position);
    const pairs: Correspondence[] = makePairs(rng, picks, p => transform(photoCamera, p)!, 1.5).map((p, i) => ({ ...p, label: `R${i}` }));
    const exact = registerBoardImage(pairs.slice(0, 4));
    expect(exact.warnings.map(w => w.code)).toContain('EXACT_FIT');
    const visible = registerBoardImage(pairs);
    expect(visible.model).toBe('homography');
    expect(visible.degreesOfFreedom).toBe(2);
    expect(visible.rmsBoard).toBeLessThan(0.2);

    // 2. Save it with the workspace and load it again.
    const loaded = registrationFromRecord(JSON.parse(JSON.stringify(registrationToRecord(visible, pairs))))!;
    expect(loaded.rmsBoard).toBeCloseTo(visible.rmsBoard, 9);

    // 3. Show the photo under the board.
    const overlayMatrix = photoOverlay(loaded, { center: { x: 0, y: 0 }, scale: 12, rotation: 0, mirrored: false }, 1280, 720, { width: 3840, height: 2160 });
    expect(overlayMatrix.css3d).toMatch(/^matrix3d\(/);
    expect(overlayMatrix.quad).not.toBeNull();

    // 4. A thermal camera of 160 x 120 cells beside it, with the fixed mapping from the visible picture, and an export of the picture as CSV text.
    const thermalCamera = cameraMatrix({ ...photoSpec, focalPx: 200, width: 160, height: 120 });
    const heatAt = board.centre(6, 3);
    const grid = makeThermalGrid(160, 120, invert(thermalCamera)!, [{ at: heatAt, rise: 35, sigmaMm: 1.4 }], rng);
    const csv = ['Hőkép;export', 'Temperature unit;°C', '', ...Array.from({ length: 120 }, (_, j) => Array.from(grid.values.subarray(j * 160, (j + 1) * 160)).map(v => v.toFixed(2).replace('.', ',')).join(';'))].join('\r\n');
    const parsed = parseThermalCsv(csv);
    expect([parsed.width, parsed.height, parsed.unit]).toEqual([160, 120, 'celsius']);
    const thermalRegistration = registerBoardImage(makePairs(rng, picks, p => transform(thermalCamera, p)!, 0.3));
    const derived = deriveRegistration(visible, resizeMatrix({ width: 3840, height: 2160 }, { width: 160, height: 120 }));
    expect(mapBoardToImage(derived, heatAt)!.x).toBeGreaterThan(0);

    // 5. The hot regions, the parts under them, the shorted rail.
    const { result, reports } = analyzeThermal(parsed, thermalRegistration, query, { side: 'top' });
    expect(result.regions).toHaveLength(1);
    expect(reports[0].parts[0].feature.ref).toBe('R6_3');
    const rail = intersectWithNets(reports[0], ['vdd_main']);
    expect(rail.parts.map(p => p.hit.feature.ref)).toEqual(['R6_3']);
    expect(rail.pins.map(p => p.feature.net)).toEqual(['VDD_MAIN']);
    expect(findHotRegions(parsed, { threshold: { mode: 'delta', delta: 30 } }).regions.length).toBeLessThanOrEqual(1);

    // 6. Damage painted on the photo.
    const painted = [{ x: -3, y: -1.5 }, { x: 3, y: -1.5 }, { x: 3, y: 1.5 }, { x: -3, y: 1.5 }].map(p => ({ x: p.x + heatAt.x, y: p.y + heatAt.y })).map(p => transform(loaded.boardToImage, p)!);
    const area = imagePolygonToBoard(loaded, painted)!;
    expect(featuresUnderPolygon(area, query).parts.map(h => h.feature.ref)).toEqual(['R6_3']);

    // 7. Is it the right file?
    const verdict = checkRightFile(pairs, { bounds: board.bounds, pins: board.pins });
    expect(['consistent', 'uncertain']).toContain(verdict.verdict);
    expect(verdict.explanation.length).toBeGreaterThan(40);
  });
});
