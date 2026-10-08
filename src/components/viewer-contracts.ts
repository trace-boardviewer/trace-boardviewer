import type { DocumentAnnotation, DocumentBookmark, DocumentCalibration } from '../lib/documents';
import type { Language } from '../lib/i18n';
import type { PdfSession } from '../lib/pdf/session-contract';
import type { SchematicDesign } from '../lib/schematic/model';

/**
 * Prop contracts of the three document viewers. Every viewer is a CONTROLLED component: the application shell
 * owns camera, bookmarks, annotations and selection (and persists them in the workspace manifest), the viewer owns
 * only transient interaction state. No viewer reads files, talks to Electron or touches the board model.
 *
 * Document space: PDF = points at scale 1, origin top-left of the UNROTATED page, Y down (src/lib/pdf/document.ts);
 * image = source pixels, origin top-left; schematic = millimetres of the sheet definition (model.ts, Y down).
 * UI texts are English constants inside each component marked `// i18n: pending` (catalogs are frozen this phase).
 */
export type ViewerRotation = 0 | 90 | 180 | 270;
export interface ViewerCamera {
  /** PDF: 1-based page. Image/schematic: unused. */
  page?: number;
  /** 1 = 100% (PDF: 1 CSS px per point; image: 1 CSS px per pixel; schematic: viewer-defined base scale). */
  zoom?: number;
  rotation?: ViewerRotation;
  /** Pan offsets in document space (viewer-defined origin; stored opaquely and restored verbatim). */
  x?: number;
  y?: number;
  /** Fit mode requested by the user; 'none' once the user zooms manually. */
  fit?: 'width' | 'page' | 'none';
  /** Board camera only: the viewed side (a mirrored bottom view cannot be restored from the numbers alone). */
  side?: 'top' | 'bottom';
}
export interface DocRect { x: number; y: number; width: number; height: number }
export interface ViewerHighlight {
  id: string;
  /** 'search' = calm accent, 'probe' = cross-reference match, 'selection' = current target (brighter, electrical selection accent). */
  kind: 'search' | 'probe' | 'selection';
  page?: number;
  rect: DocRect;
  label?: string;
  /** The currently navigated hit (stronger style). */
  active?: boolean;
  /** Set when the highlighted text is recognized text (OCR): its confidence 0-100. The viewer marks it as such. */
  confidence?: number;
}
/** A clickable region produced by the cross-reference (a text hit that equals an existing board reference or net). */
export interface ViewerProbeRegion {
  id: string; page?: number; rect: DocRect; label: string;
  /** Set when the link comes from recognized text (OCR): its confidence 0-100 (always at least OCR_LINK_MIN_CONFIDENCE). */
  confidence?: number;
}

export interface ViewerCommon {
  camera: ViewerCamera;
  onCameraChange(next: ViewerCamera): void;
  theme: 'dark' | 'light';
  motion: boolean;
  /** Narrow pane (split view / <= 1200 px): hide thumbnails and secondary chrome. */
  compact?: boolean;
}

export interface PdfViewerProps extends ViewerCommon {
  session: PdfSession;
  bookmarks: readonly DocumentBookmark[];
  annotations: readonly DocumentAnnotation[];
  onBookmarksChange(next: DocumentBookmark[]): void;
  onAnnotationsChange(next: DocumentAnnotation[]): void;
  /** Cross-reference results to paint (in addition to the viewer's own search highlights). */
  highlights?: readonly ViewerHighlight[];
  probeRegions?: readonly ViewerProbeRegion[];
  onProbeRegionClick?(id: string): void;
  /** Search box value is controlled so the unified search can drive it. */
  searchQuery: string;
  onSearchQueryChange(query: string): void;
  /** Interface language of the viewer's localized texts (text recognition); default English. */
  language?: Language;
  /** Incrementing number: focus the viewer's search field (Ctrl+F inside the viewer pane). */
  focusSearchNonce?: number;
  /**
   * Explicit "go to" intent from the shell (`ProbeState.nonce`): the viewer navigates to the active highlight / probe target
   * ONLY when this value changes after it mounted. A remount, a restored query or already-drawn highlights must never move the
   * reading camera (B46); the camera prop (page/zoom/scroll) stays authoritative until a new intent arrives.
   */
  navigateNonce?: number;
}

export interface ImageViewerProps extends ViewerCommon {
  name: string;
  /** Original file bytes; the viewer sniffs the kind, sanitizes SVG and enforces the pixel budget itself. */
  data: Uint8Array;
  calibration?: DocumentCalibration;
  /** Only set from a completed two-point calibration with a user-entered known distance. */
  onCalibrationChange(next: DocumentCalibration | undefined): void;
  /** Images are single-page: bookmarks/annotations use page 1 and image-pixel x/y. */
  bookmarks: readonly DocumentBookmark[];
  annotations: readonly DocumentAnnotation[];
  onBookmarksChange(next: DocumentBookmark[]): void;
  onAnnotationsChange(next: DocumentAnnotation[]): void;
}

export interface SchematicSelection {
  /** `symbolKey(instancePath, symbolId)` of the selected placement. */
  symbolKey?: string;
  /** `pinKey(instancePath, symbolId, pinId)` */
  pinKey?: string;
  /** `SchNet.id`: every wire, label and pin of the net is emphasized. */
  netId?: string;
}
export interface SchematicViewerProps extends ViewerCommon {
  design: SchematicDesign;
  /** Which sheet INSTANCE (SchSheetInstance.path) is displayed. */
  instancePath: string;
  onInstanceChange(path: string): void;
  selection: SchematicSelection;
  onSelectSymbol(target: { instancePath: string; symbolId: string; ref: string }): void;
  onSelectPin(target: { instancePath: string; symbolId: string; pinId: string; ref: string; pinNumber: string }): void;
  onSelectNet(netId: string | null): void;
  /** Search/cross-reference highlights; rect is in the sheet's mm space and `page` is unused (use instance navigation). */
  highlights?: readonly (ViewerHighlight & { instancePath: string })[];
}
