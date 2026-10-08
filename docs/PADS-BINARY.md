# PADS native binary boards

TRACE identifies native PADS PowerPCB SDB `.pcb` databases with version `0x2026` or `0x2027`. These files have the fixed `00 FF` magic and are different from PADS ASCII `.asc` exports. TRACE checks the bounded directory and document framing and reports `UNSUPPORTED_VARIANT`; it does not import their geometry yet.

## Actual KiCad conversion trials

Read-only trials on 2026-10-08 attempted all 21 distinct investigated native databases with CLI runtimes extracted from two official signed Windows packages. Neither build produced a converted board:

| Tested build | Native PADS result |
| --- | --- |
| Stable 10.0.7 | All 21 failed with exit code 2, `No plugin found for file type 'UNKNOWN (18)'`. |
| Development 10.99.0.5036.g32b73c9ccc, x86-64 lite | All 21 selected **PADS Binary**, then failed with exit code 3, `Invalid PADS board-setup reference-text size`. |

The [stable PCB Editor manual](https://docs.kicad.org/10.0/en/pcbnew/pcbnew.html#_importing_boards_from_other_eda_tools) lists PADS binary import, but the [10.0.7 build configuration](https://github.com/KiCad/kicad-source-mirror/blob/10.0.7/pcbnew/pcb_io/pads/CMakeLists.txt) compiles only the ASCII PADS plugin. The [tested development configuration](https://github.com/KiCad/kicad-source-mirror/blob/32b73c9ccc/pcbnew/pcb_io/pads/CMakeLists.txt) includes the binary plugin. Its observed rejection is a parser field-validation error; it does not establish that the source designs are damaged. Original inputs were unchanged by hash, size and modification time. No installer was executed or runtime bundled into TRACE.

## Obtain an original ASCII export

PADS Layout is the native authoring program. Ask the design provider, or someone with a compatible PADS Layout installation, for a PADS ASCII `.asc` export from the same unchanged design. [KiCad's PCB Editor manual](https://docs.kicad.org/10.0/en/pcbnew/pcbnew.html#_pads) describes the **File → Export** route, and its [PADS ASCII format documentation](https://dev-docs.kicad.org/en/import-formats/pads/index.html) describes the imported fields. The ASCII export route has not been tested on these designs because matching exports and a PADS Layout installation were unavailable.

1. In KiCad's PCB Editor, choose **File → Import → Non-KiCad Board File** and select the exported PADS ASCII file.
2. Review layer mapping, component placement, pin positions, bottom-side orientation, net assignments and importer warnings.
3. Save a separate `.kicad_pcb` file and open it in TRACE. Keep the original native database unchanged.

KiCad can also export GenCAD through **File → Export → GenCAD** after successful import. A PADS ASCII file is not TRACE's unrelated three-file ASC boardview format. Direct native import may be worth retrying in a future KiCad build with a confirmed importer fix; neither tested build provides a working conversion for this collection.

For viewing the native file outside TRACE, Siemens offers the free [PADS Standard/Plus Viewer](https://resources.sw.siemens.com/et-EE/download-pads-standard-plus-viewer/). Its official page lists VX.2.18, Windows 11 and support for PADS Layout databases. This viewer has not been tested on the investigated files, and an ASCII export capability has not been verified; use PADS Layout or the design provider for the requested matched export.

### Command line

For an actual PADS ASCII export, KiCad provides an [official headless import command](https://docs.kicad.org/10.0/en/cli/cli.html#_pcb_import):

```text
kicad-cli pcb import --format pads --output converted.kicad_pcb --report-format json --report-file import-report.json original.asc
kicad-cli pcb export gencad --output converted.cad converted.kicad_pcb
```

Only a successful first command creates the board TRACE can read; the second is optional. Use distinct output paths and inspect the import report. `--format pads` selects the ASCII importer, not native binary. The native audit used `--format auto`, with the failures recorded above. A direct `pcb export gencad original.pcb` does not perform PADS import: the export job's default loader selects KiCad board formats. These routing facts were checked in the [10.0.7 job handler](https://github.com/KiCad/kicad-source-mirror/blob/10.0.7/pcbnew/pcbnew_jobs_handler.cpp), [CLI format selection](https://github.com/KiCad/kicad-source-mirror/blob/10.0.7/kicad/cli/command_pcb_import.cpp) and [default board loader](https://github.com/KiCad/kicad-source-mirror/blob/10.0.7/pcbnew/python/scripting/pcbnew_scripting_helpers.cpp). A KiCad runtime is required. Windows was tested; these private designs were not tested with Linux or macOS builds.

## Diagnostic evidence and remaining work

The content-free diagnostic identifies the version, controller count, declared placement and net-record counts, and byte lengths of the flat-controller prefix. It never treats the terminal storage pool as a live pin count: that pool also contains saved controller state. The hook verifies the native footer at EOF and its bounded container-array back-pointer. Later paged-controller payloads and nonempty embedded document containers are not decoded.

An original investigation checked 21 distinct databases. Their fixed modern record widths and connection endpoint references were consistent, but pin geometry could not be independently verified from the native terminal arrays. Saved endpoint coordinates, customized decals and retained terminal-controller state need more evidence. TRACE therefore refuses native geometry instead of using an uncertain mapping.

Useful evidence for adding an original native reader is a native database paired with an ASCII export from the same unchanged design, or an independently verified KiCad conversion. The pair must establish physical pin identities, local terminal coordinates, component rotation and mirror semantics, unit scale, pad layers, through holes and net membership. A level-2 TRACE diagnostic helps identify framing differences but does not contain the coordinates or names needed to prove these semantics.

Format facts were read from [KiCad's public native-format description](https://github.com/KiCad/kicad-source-mirror/blob/58f2ea92194aad0bc1161bb8177d1dc428ef8ebc/pcbnew/pcb_io/pads/pads_binary.ksy). TRACE's framing implementation is original MIT code; no GPL parser implementation is included or translated.

## BRD_V1.0

TRACE also recognizes the exact 16-byte `BRD_V1.0` header followed by an opaque boardview payload. Its writer and encoding have not been identified. It is reported as `UNSUPPORTED_VARIANT` without asking for an FZ or XZZ key. Native support needs the writer's format specification or a matched readable export; request GenCAD or another supported boardview export from the program that produced the file.
