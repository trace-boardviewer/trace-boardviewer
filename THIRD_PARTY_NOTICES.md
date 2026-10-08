# Third-party notices

TRACE's original source and artwork are covered by the root `LICENSE`. The application includes the following separately licensed components. Exact upstream license texts are preserved in `assets/licenses/` and included in the portable application archive.

| Component | License text |
| --- | --- |
| React and React DOM | [MIT](assets/licenses/react-LICENSE.txt) |
| cfb (development dependency, not part of the application; only the tests use it, to build synthetic OLE containers — the Altium reader is original code) | [Apache-2.0](assets/licenses/cfb-Apache-2.0.txt) |
| fast-xml-parser (EAGLE XML) | [MIT](assets/licenses/fast-xml-parser-MIT.txt) |
| fflate (project export in the main process, gzip inflation for the ODB++ reader) | [MIT](assets/licenses/fflate-MIT.txt) |
| DES tables/algorithm used for XZZ record decryption (following dhuertas/DES) | [MIT](assets/licenses/des-dhuertas-MIT.txt) |
| OpenBoardView (file-format reference for BDV/BVR/ASC/BRD semantics; no code is copied) | [MIT](assets/licenses/openboardview-MIT.txt) |
| teboviewformat (TVW record-description reference; the reader is original code) | [MIT](assets/licenses/teboviewformat-MIT.txt) |
| FZ / CAE default RC6 key words (two 44-word numeric tables in `src/lib/formats/fz-default-keys.ts`; data only, no code is copied). FZ key: [FZkey.md in the cryptonek/illegal-numbers repository, commit 3c3ab6f](https://github.com/cryptonek/illegal-numbers/blob/3c3ab6f38b6a4493730fb063ba12cb5c260b6a7e/FZkey.md). CAE key: [OpenBoardView issue 162, comment 2576037248](https://github.com/OpenBoardView/OpenBoardView/issues/162#issuecomment-2576037248) | Licence of both sources not established (see the note below) |
| Lucide React and derived Feather icons | [ISC and MIT](assets/licenses/lucide-LICENSE.txt) |
| IBM Plex Mono font | [SIL Open Font License 1.1](assets/licenses/ibm-plex-mono-OFL.txt) |
| Manrope font | [SIL Open Font License 1.1](assets/licenses/manrope-OFL.txt) |
| PDF.js (`pdfjs-dist` 6.4.299): PDF parser, renderer and worker | [Apache-2.0](assets/licenses/pdfjs-Apache-2.0.txt) |
| PDF.js CMaps (Adobe CMap resources, `pdfjs/cmaps/`) | [BSD-3-Clause (Adobe)](assets/licenses/pdfjs-cmaps-Adobe-BSD-3-Clause.txt) |
| PDF.js standard fonts: Foxit fonts from PDFium (`pdfjs/standard_fonts/Foxit*.pfb`) | [BSD-3-Clause (PDFium authors)](assets/licenses/pdfjs-standard-fonts-Foxit-PDFium-BSD-3-Clause.txt) |
| PDF.js standard fonts: Liberation Sans (`pdfjs/standard_fonts/LiberationSans-*.ttf`) | [Liberation Font License: GPL-2.0 with font exception](assets/licenses/pdfjs-standard-fonts-Liberation-GPL-2.0-font-exception.txt) |
| PDF.js wasm decoder: OpenJPEG (JPEG 2000) | [BSD-2-Clause (UCL and contributors)](assets/licenses/pdfjs-wasm-openjpeg-UCL-BSD-2-Clause.txt), [wrapper: BSD-2-Clause (Mozilla)](assets/licenses/pdfjs-wasm-openjpeg-wrapper-Mozilla-BSD-2-Clause.txt) |
| PDF.js wasm decoder: JBIG2 (from PDFium) | [BSD-3-Clause and Apache-2.0](assets/licenses/pdfjs-wasm-jbig2-PDFium-BSD-3-Clause-and-Apache-2.0.txt), [wrapper: Apache-2.0 (Mozilla)](assets/licenses/pdfjs-wasm-jbig2-wrapper-Mozilla-Apache-2.0.txt) |
| PDF.js wasm color engine: qcms | [MIT (Mozilla, Marti Maria)](assets/licenses/pdfjs-wasm-qcms-MIT.txt), [wrapper: MIT (Mozilla)](assets/licenses/pdfjs-wasm-qcms-wrapper-Mozilla-MIT.txt) |
| PDF.js ICC profile (`pdfjs/iccs/CGATS001Compat-v2-micro.icc`) | [CC0 1.0](assets/licenses/pdfjs-iccs-CC0-1.0.txt) |
| Text recognition (OCR) engine: Tesseract 5.1.0 as built by `tesseract.js-core` 7.0.0 (LSTM WebAssembly builds `tesseract-core-simd-lstm.wasm` 2.86 MB and `tesseract-core-lstm.wasm` 2.86 MB, plus their JavaScript loaders, about 0.18 MB, inside the OCR worker) | [Apache-2.0](assets/licenses/tesseract-Apache-2.0.txt) |
| English OCR language data `eng.traineddata` (tessdata_best, integer LSTM model, gzip-compressed, 2.95 MB) from `@tesseract.js-data/eng` 1.0.0 (the package is MIT and ships no licence file; the data itself is tesseract-ocr/tessdata_best) | [Apache-2.0](assets/licenses/tesseract-Apache-2.0.txt) |
| Leptonica (image library compiled into the OCR engine) | [BSD-2-Clause (Leptonica)](assets/licenses/leptonica-BSD-2-Clause.txt) |
| libpng 1.6.38 (compiled into the OCR engine) | [PNG Reference Library License version 2](assets/licenses/libpng-PNG-Reference-Library-License-2.txt) |
| zlib 1.2.12 (compiled into the OCR engine) | [Zlib](assets/licenses/zlib-Zlib.txt) |
| The Independent JPEG Group's JPEG library, libjpeg 9 (compiled into the OCR engine) | [IJG](assets/licenses/libjpeg-IJG.txt) |
| LibTIFF (compiled into the OCR engine) | [libtiff](assets/licenses/libtiff-libtiff.txt) |
| libwebp (compiled into the OCR engine) | [BSD-3-Clause and patent grant (Google)](assets/licenses/libwebp-BSD-3-Clause-and-patent-grant.txt) |

The FZ and CAE default key words let TRACE open files in those two formats without asking for a key; a key supplied by the user for the session overrides them. They are numeric format data taken from the two public sources named in the table. The licence of neither source could be established without network access when this notice was written, and the OpenBoardView MIT licence is not claimed to cover an issue comment; their licence status is therefore open and is recorded here rather than assumed.

The PDF.js resources are copied unmodified from `node_modules/pdfjs-dist` into `dist/pdfjs/{cmaps,standard_fonts,wasm,iccs}/` at build time, together with the license files that ship in the same upstream folders (`LICENSE`, `LICENSE_*`), and are read from the application directory only: a PDF never causes a network request. The Liberation Sans fonts are separate font data files (not linked into TRACE's code); they are used by PDF.js to draw text of non-embedded Helvetica/Arial-family fonts, and their license text is preserved in full. The PDF.js worker (`pdf.worker`) is a separate Apache-2.0 JavaScript module. The QuickJS engine of PDF.js' document-scripting sandbox (`quickjs-eval.*`) is deliberately not shipped: document scripting is not supported.

The text recognition engine (Tesseract with Leptonica, libpng, zlib, libjpeg, LibTIFF and libwebp, compiled to WebAssembly by the tesseract.js-core project) and the English language data are copied unmodified from `node_modules/tesseract.js-core` and `node_modules/@tesseract.js-data/eng` into `dist/assets/` at build time; the two packages are development dependencies, so nothing else of them is shipped. They run in a dedicated worker with no network access and are read from the application directory only: nothing is downloaded at run time. The engine's own licence text is the `LICENSE` file of tesseract.js-core; the texts of the libraries compiled into it are the upstream licence statements, as also reproduced in Electron's `LICENSES.chromium.html`. This software is based in part on the work of the Independent JPEG Group.

The extracted Electron runtime includes its upstream license as `LICENSE.electron.txt`, alongside `LICENSES.chromium.html`. These notices cover Electron, Chromium and their included components and remain part of the portable EXE's payload.

Development tools are listed in `package.json` and locked in `pnpm-lock.yaml`; their original licenses remain in the installed packages. They are not required on an end user's computer.
