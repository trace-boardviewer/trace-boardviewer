import type { BoardSelectionState } from '../../app/api';
import type { WorkspaceTab } from '../../lib/documents';
import type { Board, BoardNote, ViewSide } from '../../lib/types';

/**
 * Which physical side the board canvas shows after the selection changed. A pin keeps the side of its own pad (B21: a bottom
 * pad of a top-side parent must stay visible); a 'both' pad or part keeps the current side; a one-sided part switches to its side.
 */
export function deriveSide(board: Board | null, selection: BoardSelectionState, current: ViewSide): ViewSide {
  if (!board) return current;
  if (selection.pinId) {
    const pin = board.pins.find(candidate => candidate.id === selection.pinId);
    if (pin) return pin.side === 'both' ? current : pin.side;
  }
  if (selection.componentId) {
    const component = board.components.find(candidate => candidate.id === selection.componentId);
    if (component && component.side !== 'both') return component.side;
  }
  return current;
}

/** Window width (CSS px) below which a document-centric view cannot afford both side panels (W-win-viewers-02). */
export const PANEL_AUTO_COLLAPSE_BELOW = 1120;
/** The side panels as the user left them: a boolean is an explicit choice, `null` follows the automatic rule. */
export interface PanelPreference { left: boolean | null; right: boolean | null }

/**
 * W-win-viewers-02: at the 960x640 minimum window the two side panels (198 + 238 px) left the document viewers 84 px, and the
 * split view halves what is left. In a narrow window the panels therefore start collapsed whenever the content is a document
 * (Schematic / Documents tab, or the split view); the Board tab keeps both. This is only the DEFAULT: an explicit toggle always wins.
 */
export function autoCollapsePanels(narrowWindow: boolean, tab: WorkspaceTab, split: boolean): boolean {
  return narrowWindow && (split || tab !== 'board');
}

/** Effective visibility of the two side panels: the explicit preference when there is one, otherwise the opposite of `collapsed`. */
export function resolvePanels(preference: PanelPreference, collapsed: boolean): { left: boolean; right: boolean } {
  return { left: preference.left ?? !collapsed, right: preference.right ?? !collapsed };
}

export type Measurements = NonNullable<BoardNote['measurements']>;
export const MEASUREMENT_FIELDS = ['voltage', 'resistance', 'other'] as const;
export const NOTE_TEXT_MAX = 8000;
export const MEASUREMENT_MAX = 64;

/** The measurements as the core stores them: trimmed, empty fields dropped; undefined when none remain. */
export function normalizeMeasurements(raw: Partial<Record<(typeof MEASUREMENT_FIELDS)[number], string>> | undefined | null): Measurements | undefined {
  if (!raw) return undefined;
  const result: Measurements = {};
  for (const name of MEASUREMENT_FIELDS) { const value = (raw[name] ?? '').trim(); if (value) result[name] = value; }
  return Object.keys(result).length ? result : undefined;
}

/** True when the stored note (or its absence) is exactly what a save submitted: the editor closes only then, never on a failed write. */
export function noteMatches(note: BoardNote | undefined, submitted: { text: string; measurements?: Measurements }): boolean {
  const text = submitted.text.trim();
  const measurements = normalizeMeasurements(submitted.measurements);
  if (!text && !measurements) return !note;
  if (!note || note.text !== text) return false;
  const stored = normalizeMeasurements(note.measurements);
  return MEASUREMENT_FIELDS.every(name => stored?.[name] === measurements?.[name]);
}

export const noteOf = (notes: readonly BoardNote[], componentId: string, pinId?: string) => notes.find(note => note.componentId === componentId && note.pinId === pinId);
