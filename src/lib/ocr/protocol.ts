import type { OcrErrorCode, OcrLanguage, OcrWord, QuarterTurn } from './contract';

/**
 * Messages between the renderer (src/lib/ocr/engine.ts) and the OCR worker (src/lib/ocr/ocr.worker.ts). Every byte the engine
 * uses arrives in these messages (transferred, not copied): the compiled engine, the language data and the page pixels.
 */
export type OcrWorkerRequest =
  | { type: 'init'; id: number; simd: boolean; wasm: ArrayBuffer; language: OcrLanguage; data: ArrayBuffer }
  | { type: 'recognize'; id: number; width: number; height: number; pixels: ArrayBuffer; dpi: number; rotations: QuarterTurn[]; pageSegmentation: number };

export type OcrWorkerReply =
  | { type: 'ready'; id: number; version: string; blocked: string[] }
  | { type: 'words'; id: number; words: OcrWord[]; ms: number }
  | { type: 'error'; id: number; code: OcrErrorCode; message: string };

export const OCR_LANGUAGES: readonly OcrLanguage[] = ['eng'];
const QUARTER_TURNS: readonly number[] = [0, 1, 2, 3];
const ERROR_CODES: readonly string[] = ['ABORTED', 'TIMEOUT', 'UNAVAILABLE', 'FAILED', 'INVALID'];
/** Largest raster the worker accepts (well above OCR_MAX_PAGE_PIXELS; a bound against a corrupted message, not a policy). */
export const MAX_WORKER_PIXELS = 64_000_000;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const isId = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;

/** Structural check of a request (the worker trusts nothing it is sent). Returns null when malformed. */
export function parseWorkerRequest(value: unknown): OcrWorkerRequest | null {
  if (!isRecord(value) || !isId(value.id)) return null;
  if (value.type === 'init') {
    if (typeof value.simd !== 'boolean' || !(value.wasm instanceof ArrayBuffer) || !(value.data instanceof ArrayBuffer)) return null;
    if (!(OCR_LANGUAGES as readonly unknown[]).includes(value.language)) return null;
    return value as OcrWorkerRequest;
  }
  if (value.type === 'recognize') {
    const { width, height, pixels, dpi, rotations, pageSegmentation } = value;
    if (!Number.isInteger(width) || !Number.isInteger(height) || (width as number) < 1 || (height as number) < 1) return null;
    if ((width as number) * (height as number) > MAX_WORKER_PIXELS || !(pixels instanceof ArrayBuffer) || pixels.byteLength !== (width as number) * (height as number)) return null;
    if (typeof dpi !== 'number' || !(dpi > 0 && dpi <= 2400)) return null;
    if (!Array.isArray(rotations) || rotations.length < 1 || rotations.length > 4 || !rotations.every(turn => QUARTER_TURNS.includes(turn))) return null;
    if (!Number.isInteger(pageSegmentation) || (pageSegmentation as number) < 0 || (pageSegmentation as number) > 13) return null;
    return value as OcrWorkerRequest;
  }
  return null;
}

/** Structural check of a reply (the renderer trusts the worker no more than any other input). Returns null when malformed. */
export function parseWorkerReply(value: unknown): OcrWorkerReply | null {
  if (!isRecord(value) || !isId(value.id)) return null;
  if (value.type === 'ready') return typeof value.version === 'string' && Array.isArray(value.blocked) ? value as OcrWorkerReply : null;
  if (value.type === 'error') return typeof value.message === 'string' && ERROR_CODES.includes(value.code as string) ? value as OcrWorkerReply : null;
  if (value.type === 'words') {
    if (!Array.isArray(value.words) || typeof value.ms !== 'number') return null;
    const valid = value.words.every(word => isRecord(word) && typeof word.text === 'string'
      && [word.x, word.y, word.width, word.height, word.confidence].every(Number.isFinite) && QUARTER_TURNS.includes(word.rotation as number));
    return valid ? value as OcrWorkerReply : null;
  }
  return null;
}
