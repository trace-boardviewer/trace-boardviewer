/**
 * Image-to-board alignment: photos, microscope images and thermal images laid over the boardview (features F11 to F15). Pure functions, no UI and no I/O.
 *
 *   registration.ts  matched points -> Registration (similarity, affine or projective; bottom side mirrored; residuals; outlier hint; saved form)
 *   fit.ts           the plain point-pair fits it is built on (also for image-to-image maps such as visible-to-thermal)
 *   matrix3.ts       3x3 plane maps, CSS matrices
 *   compose.ts       composition with the board camera and the image viewer's view
 *   thermal.ts       temperature grids: CSV and pixels in, statistics, sampling, mapping to the board
 *   hotspots.ts      hot regions, the parts and pins under them, nets, the loaded board as a feature index
 *   damage.ts        painted areas -> parts, pins, nets
 *   rightfile.ts     is this the right board file? (3 or 4 matched points)
 */
export { RegistrationError, ThermalError } from './errors';
export type { RegistrationErrorCode, RegistrationErrorDetail, ThermalErrorCode } from './errors';

export { IDENTITY, W_MIN, determinant, invert, isAffine, isFiniteMatrix, jacobian, multiply, multiplyAll, normalizeAt, rotation, scaling, toCssMatrix, toCssMatrix3d, toCssMatrix3dValues, transform, transformPoints, translation, weight } from './matrix3';
export type { Matrix3 } from './matrix3';

export { MAX_POINTS, MIN_THIN_RATIO, MODEL_MIN_POINTS, MODEL_PARAMETERS, WARN_THIN_RATIO, fitTransform, leverageBlocks, pointSetQuality } from './fit';
export type { FitModel, FitOptions, LeverageBlock, PointSetQuality } from './fit';

export {
  DEFAULT_NOISE_SIGMA_PX, LEAVE_ONE_OUT_MAX, MIN_RELATIVE_W, OUTLIER_DOMINANCE, OUTLIER_MIN_DOF, OUTLIER_SCORE, POOR_FIT_RATIO, STRONG_DISTORTION_ANISOTROPY,
  deriveRegistration, linearizeAt, mapBoardPointsToImage, mapBoardRectToImage, mapBoardToImage, mapImagePointsToBoard, mapImageRectToBoard, mapImageToBoard, mirroredForSide, modelForCount,
  orientBoardPoint, rankPhotosForBoardPoint, registerBoardImage, registrationFromRecord, registrationToRecord, suggestOrientation,
} from './registration';
export type {
  Correspondence, Linearization, MappedQuad, OrientationCheck, OutlierHint, PhotoCandidate, PhotoChoice, PointResidual, RegisterOptions, Registration, RegistrationModel, RegistrationRecord,
  RegistrationWarning, RegistrationWarningCode,
} from './registration';

export { boardToImageScreenMatrix, boardToScreenMatrix, imageToScreenMatrix, imageViewMatrix, photoOverlay, screenToBoardMatrix, screenToImageMatrix, viewMatchingPhoto } from './compose';
export type { ImageViewLike, OverlayTransform } from './compose';

export {
  MAX_CSV_CHARS, MAX_GRID_CELLS, differenceGrid, gridCellCentersToBoard, gridFootprintOnBoard, gridFromRgba, gridStats, makeGrid, parseThermalCsv, resampleToBoard, resizeMatrix, sampleGrid,
  sampleGridAtBoard, statsOfValues, validateGrid,
} from './thermal';
export type { BoardRaster, CsvOptions, GridStats, PaletteStop, PixelChannel, PixelOptions, Size, ThermalGrid, ThermalUnit } from './thermal';

export { analyzeHotRegions, analyzeThermal, buildFeatureIndex, findHotRegions, intersectWithNets } from './hotspots';
export type {
  AnalyzeOptions, BoardFeature, FeatureHit, FeatureIndexOptions, FeatureQuery, HotRegion, HotRegionOptions, HotRegionResult, HotThreshold, NetIntersection, NetPartHit, RegionReport,
} from './hotspots';

export { clipPolygonToRect, featuresUnderPolygon, imagePolygonToBoard, polygonArea } from './damage';
export type { DamageHit, DamageNet, DamageOptions, DamageReport } from './damage';

export { RIGHT_FILE_THRESHOLDS, checkRightFile, chiSquareSurvivalEven, typicalPitchMm } from './rightfile';
export type { RightFileBoard, RightFileCheck, RightFileEvidence, RightFileEvidenceCode, RightFileOptions, RightFileVerdict } from './rightfile';
