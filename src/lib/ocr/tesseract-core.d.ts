// tesseract.js-core ships plain Emscripten builds without type declarations. Only the two LSTM builds are bundled (src/lib/ocr/ocr.worker.ts).
declare module 'tesseract.js-core/tesseract-core-simd-lstm.js' {
  const factory: import('./recognizer').TesseractCoreFactory;
  export default factory;
}
declare module 'tesseract.js-core/tesseract-core-lstm.js' {
  const factory: import('./recognizer').TesseractCoreFactory;
  export default factory;
}
