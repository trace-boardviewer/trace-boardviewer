# Native Allegro BRD imports

The reader traverses keyed native databases with the documented 16.0–17.5
record layouts. Local validation covers 16.2, 16.4, 16.5, 16.6 and 17.2.
The alternate `0x00130500` identifier uses the validated 16.2 layout. Other
supported widths also have synthetic fixtures. Observed legacy 14.x/15.x and
newer layouts are recognized and refused with `UNSUPPORTED_VARIANT`.

The former adapter recognized this family and deliberately refused it at the
header. Native import now reads the complete database instead of requiring a
conversion. A name containing `locked` does not establish encryption; recognized
native database records do not require an activation or file-decryption key.

The import validates header fields, counts, versioned record widths, string
references, object types, list ownership and cycles. Declared object counts must
match all keyed records and strings. A zero terminator cannot hide an unparsed
nonzero suffix. The 64 MiB input cap and record/string budgets apply before
building the board.

Component identity, placement, rotation, values, package names, pin identity,
nets and pin geometry follow explicit references. Local pad coordinates use
footprint placement, rotation and bottom-side reflection. Through-hole pads
require a verified full copper stack before being shown on both sides. Placed
footprint layers other than the validated top/bottom codes remain unsupported.

Native outlines are retained; curved segments use chords. Custom pad shapes use
their declared rectangular extents. Component bodies are estimated from pads.
Tracks, copper fills, vias and general graphics are omitted with import warnings.
These limits are also listed in the generated support table.

The diagnostic hook shares the bounded database pass. It reports whitelisted
numeric version/unit codes, rounded counts, numeric tags and length buckets.
It never reports strings, references, nets, positions or source paths.

For a refused layout, export GenCAD from the original design software. A paired
native file and independent export is needed to verify another record width,
component-layer mapping or pad reference type; a damaged database needs a
complete original file rather than permissive parsing.

This is an original implementation based on
[the documented format facts](https://dev-docs.kicad.org/en/import-formats/allegro/)
and independently checked local record structures. No external parser code or
private board files are included in the repository.
