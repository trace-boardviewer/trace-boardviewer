/**
 * Errors of the image-to-board alignment code. `code` is the stable machine-readable part (the UI maps it to a localized text);
 * `message` is English for logs and tests. `detail` says which points and which side (board or photo) the problem is on, so the
 * UI can mark them.
 */
export type RegistrationErrorCode =
  /** Fewer point pairs than the model needs. */
  | 'TOO_FEW_POINTS'
  | 'TOO_MANY_POINTS'
  /** A coordinate is missing, not a number or not finite. */
  | 'INVALID_POINT'
  /** Two points coincide on one side: the pair adds nothing and usually is a double click. */
  | 'DUPLICATE_POINTS'
  /** All points (or three of four) lie on a line, so the map is not determined across it. */
  | 'COLLINEAR'
  /** The point configuration does not determine the model for another reason (the system is rank-deficient). */
  | 'DEGENERATE'
  /** The solved map is not invertible (for example the photo points all coincide, or scale zero). */
  | 'SINGULAR'
  /** The perspective map folds over the points: they were matched in a crossing order or do not describe a flat photo. */
  | 'FOLDED'
  /** A saved alignment is not valid (wrong shape, non-finite or non-invertible matrix). */
  | 'INVALID_RECORD';

export interface RegistrationErrorDetail {
  readonly indices?: readonly number[];
  readonly side?: 'board' | 'image';
  readonly model?: string;
  readonly needed?: number;
  readonly given?: number;
}

export class RegistrationError extends Error {
  constructor(readonly code: RegistrationErrorCode, message: string, readonly detail: RegistrationErrorDetail = {}) {
    super(message);
    this.name = 'RegistrationError';
  }
}

export type ThermalErrorCode =
  /** The grid has no cells, or width * height does not match the data. */
  | 'INVALID_GRID'
  /** The text holds no row of numbers. */
  | 'NO_NUMBERS'
  /** Rows of the number block have different lengths. */
  | 'RAGGED'
  | 'TOO_LARGE';

export class ThermalError extends Error {
  constructor(readonly code: ThermalErrorCode, message: string, readonly line?: number) {
    super(message);
    this.name = 'ThermalError';
  }
}
