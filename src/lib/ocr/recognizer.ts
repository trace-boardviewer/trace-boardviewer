import { OCR_PAGE_SEGMENTATION, OcrError } from './contract';
import type { GrayImage, OcrEngineFactory, OcrLanguage, OcrWord, QuarterTurn } from './contract';
import { encodePgm, joinUnderscoreSplits, mergePasses, parseTsvWords, rotateGray, unrotateBox } from './raster';

/**
 * The engine itself, independent of where it runs: the OCR worker calls it with the bundled Emscripten build, the Node tests call it
 * in-process with the same build. It never fetches anything: the caller passes the compiled-code bytes (`wasm`) and the language
 * data, and `instantiateWasm` hands the bytes to WebAssembly directly, so the Emscripten loader's own fetch/XHR path is never taken.
 */

/** The part of tesseract.js-core's embind API this module uses. */
export interface TesseractApi {
  Init(datapath: string | null, language: string, oem: number): number;
  Version(): string;
  SetPageSegMode(mode: number): void;
  /** Reads the image from the engine file system path `/input` (tesseract.js-core addition). */
  SetImageFile(exif?: number, angle?: number): number;
  SetSourceResolution(dpi: number): void;
  Recognize(monitor: null): number;
  GetTSVText(page: number): string;
  Clear(): void;
  End(): void;
}
export interface TesseractModule {
  FS: { writeFile(path: string, data: Uint8Array): void; unlink(path: string): void };
  TessBaseAPI: new () => TesseractApi;
}
/** The default export of `tesseract.js-core/tesseract-core-*.js` (an Emscripten MODULARIZE factory). */
export type TesseractCoreFactory = (moduleArg: Record<string, unknown>) => Promise<TesseractModule>;

export interface RecognizerInput {
  core: TesseractCoreFactory;
  /** The `.wasm` that belongs to `core` (SIMD and plain builds are not interchangeable). */
  wasm: BufferSource;
  language: OcrLanguage;
  /** `<language>.traineddata`, raw or gzip-compressed (detected by its magic bytes). */
  data: Uint8Array;
}
export interface RecognizeImageOptions { dpi: number; rotations: readonly QuarterTurn[]; pageSegmentation?: number }
export interface Recognizer {
  readonly version: string;
  recognize(image: GrayImage, options: RecognizeImageOptions): { words: OcrWord[]; passes: number };
  dispose(): void;
}

/**
 * An OcrEngineFactory that runs the engine in the CURRENT thread (no worker of its own). For a context that already is a worker,
 * such as a future background indexer, and for the Node tests. Recognition is synchronous here, so a time budget cannot interrupt a
 * page: `timeoutMs` is checked only before a page starts. The renderer must use the worker engine (bundled.ts) instead.
 */
export function inProcessOcrEngine(input: Omit<RecognizerInput, 'language'>): OcrEngineFactory {
  return async ({ language, signal }) => {
    if (signal?.aborted) throw new OcrError('ABORTED', 'Text recognition was cancelled.');
    const recognizer = await createRecognizer({ ...input, language });
    let disposed = false;
    return {
      language,
      get disposed() { return disposed; },
      dispose() { if (!disposed) { disposed = true; recognizer.dispose(); } },
      async recognize(image, options) {
        if (disposed) throw new OcrError('ABORTED', 'The text recognition engine was stopped.');
        if (options.signal?.aborted) throw new OcrError('ABORTED', 'Text recognition was cancelled.');
        if (options.timeoutMs !== undefined && !(options.timeoutMs > 0)) throw new OcrError('TIMEOUT', 'Text recognition exceeded its time budget.');
        return recognizer.recognize(image, { dpi: options.dpi, rotations: options.rotations ?? [0, 1], pageSegmentation: options.pageSegmentation }).words;
      },
    };
  };
}

/** LSTM only: the shipped data is the integer LSTM model (no legacy classifier). */
const OEM_LSTM_ONLY = 1;
const INPUT_PATH = '/input';

export async function gunzipIfNeeded(bytes: Uint8Array): Promise<Uint8Array> {
  if (bytes.length < 2 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) return bytes;
  const stream = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export function validImage(image: GrayImage): boolean {
  return Number.isInteger(image.width) && Number.isInteger(image.height) && image.width > 0 && image.height > 0
    && image.data instanceof Uint8Array && image.data.length === image.width * image.height;
}

export async function createRecognizer(input: RecognizerInput): Promise<Recognizer> {
  let failInstantiate: (error: unknown) => void = () => {};
  const instantiateFailed = new Promise<never>((_, reject) => { failInstantiate = reject; });
  instantiateFailed.catch(() => {});
  let module: TesseractModule;
  try {
    module = await Promise.race([
      input.core({
        print: () => {}, printErr: () => {},
        instantiateWasm(imports: WebAssembly.Imports, done: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void) {
          WebAssembly.instantiate(input.wasm, imports).then(result => done(result.instance, result.module), failInstantiate);
          return {};
        },
      }),
      instantiateFailed,
    ]);
  } catch (error) {
    // A CompileError here means WebAssembly is not allowed in this context (a content security policy without 'wasm-unsafe-eval').
    throw new OcrError('UNAVAILABLE', `The text recognition engine could not start: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  const data = await gunzipIfNeeded(input.data);
  module.FS.writeFile(`/${input.language}.traineddata`, data);
  const api = new module.TessBaseAPI();
  if (api.Init(null, input.language, OEM_LSTM_ONLY) !== 0) throw new OcrError('UNAVAILABLE', `The language data "${input.language}" could not be loaded.`);
  const version = api.Version();
  let disposed = false;

  return {
    version,
    recognize(image, options) {
      if (disposed) throw new OcrError('UNAVAILABLE', 'The recognizer has been disposed.');
      if (!validImage(image)) throw new OcrError('INVALID', 'The image must be width x height bytes of 8-bit grey.');
      if (!(options.dpi > 0)) throw new OcrError('INVALID', 'The resolution must be positive.');
      const passes: OcrWord[][] = [];
      const rotations = [...new Set(options.rotations.length ? options.rotations : [0 as QuarterTurn])];
      for (const turns of rotations) {
        const turned = rotateGray(image, turns);
        module.FS.writeFile(INPUT_PATH, encodePgm(turned));
        try {
          api.SetPageSegMode(options.pageSegmentation ?? OCR_PAGE_SEGMENTATION);
          if (api.SetImageFile(1, 0) !== 0) throw new OcrError('FAILED', 'The engine rejected the page image.');
          api.SetSourceResolution(Math.round(options.dpi));
          api.Recognize(null);
          const words = joinUnderscoreSplits(parseTsvWords(api.GetTSVText(0)));
          passes.push(words.map(word => ({ ...word, ...unrotateBox(word, turns, image.width, image.height), rotation: turns })));
        } finally {
          api.Clear();
          try { module.FS.unlink(INPUT_PATH); } catch { /* already gone */ }
        }
      }
      return { words: mergePasses(passes), passes: passes.length };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      try { api.End(); } catch { /* the instance is dropped with its worker anyway */ }
    },
  };
}
