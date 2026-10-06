# Third-party notices

TRACE's original source and artwork are covered by the root `LICENSE`. The application includes the following separately licensed components. Exact upstream license texts are preserved in `assets/licenses/` and included in the portable application archive.

| Component | License text |
| --- | --- |
| React and React DOM | [MIT](assets/licenses/react-LICENSE.txt) |
| cfb (development dependency, not part of the application; only the tests use it, to build synthetic OLE containers — the Altium reader is original code) | [Apache-2.0](assets/licenses/cfb-Apache-2.0.txt) |
| fast-xml-parser (EAGLE XML) | [MIT](assets/licenses/fast-xml-parser-MIT.txt) |
| fflate (project export in the main process, gzip prefix scan for ODB++ recognition) | [MIT](assets/licenses/fflate-MIT.txt) |
| DES tables/algorithm used for XZZ record decryption (following dhuertas/DES) | [MIT](assets/licenses/des-dhuertas-MIT.txt) |
| OpenBoardView (file-format reference for BDV/BVR/ASC/BRD semantics; no code is copied) | [MIT](assets/licenses/openboardview-MIT.txt) |
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

The PDF.js resources are copied unmodified from `node_modules/pdfjs-dist` into `dist/pdfjs/{cmaps,standard_fonts,wasm,iccs}/` at build time, together with the license files that ship in the same upstream folders (`LICENSE`, `LICENSE_*`), and are read from the application directory only: a PDF never causes a network request. The Liberation Sans fonts are separate font data files (not linked into TRACE's code); they are used by PDF.js to draw text of non-embedded Helvetica/Arial-family fonts, and their license text is preserved in full. The PDF.js worker (`pdf.worker`) is a separate Apache-2.0 JavaScript module. The QuickJS engine of PDF.js' document-scripting sandbox (`quickjs-eval.*`) is deliberately not shipped: document scripting is not supported.

The extracted Electron runtime includes its upstream license as `LICENSE.electron.txt`, alongside `LICENSES.chromium.html`. These notices cover Electron, Chromium and their included components and remain part of the portable EXE's payload.

Development tools are listed in `package.json` and locked in `pnpm-lock.yaml`; their original licenses remain in the installed packages. They are not required on an end user's computer.
