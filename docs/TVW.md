# TVW import

TRACE has an original TVW reader. Its record-description reference is
[teboviewformat, revision 0dde0a7](https://github.com/mmuman/teboviewformat/tree/0dde0a73ab61af81b284b7b1478783a691bbd1a6),
licensed under MIT by Paul Daniels. The notice is preserved in
[assets/licenses/teboviewformat-MIT.txt](../assets/licenses/teboviewformat-MIT.txt).
No external TVW parser implementation is included.

The reader requires duplicate net counts and a complete probe-registry footer:
bounded signed origin coordinates, kind 4, a Pascal registry name, a positive
probe size and a bounded pack count. Registry names, origins and probe sizes may
vary. Empty net names and an empty net table are supported. The compact
zero-origin `ProbeDB` footer with a closing word of 0x23 or 0x17 remains supported.
The usual 69-byte prefix in front of the first count is checked first, but a table
with another prefix is found by the same validated body.

Every entry in the declared component table is traversed sequentially. Compact
metadata, an older height-word layout and two additional Pascal metadata fields
are supported. Compact components may have two pin groups, each naming its own
layer; pins from both groups are retained and a component spanning both sides is
marked as such. Numeric-leading references, `@` and `+` prefixes, embedded spaces,
placement origins outside asymmetric body bounds, sparse BGA ordinals, package
placeholders and unnamed test points are preserved. Unnamed one-pin test points
may have a package name or an unspecified classification.

Each component pin has a source UID: **UID / 8 is its physical pad ordinal**.
A pin list names its layer by the **zero-based index into the full list of layer
headers**, in file order. Aux, silk, mask, inner and complete empty layer slots
count in that index although their bodies are never read. The header type decides the side (1 is
TOP, 2 is BOTTOM); the TOP header sits at index 2 on some exports, the BOTTOM
header at 5, 7 or 13 on others. A number that selects another kind of layer, or
a number outside the supported namespaces, is refused with a message that names
the layer. The established legacy numbers 2 (TOP), 5 and 7 (BOTTOM) also resolve
to the single TOP or BOTTOM layer only when no header occupies that index. They
cannot override an aux, silk, mask or other nonphysical header. That exact pad
supplies the pin's position, net, side and dimensions. Disk coordinates are Y/X
in centimils (0.000254 mm). A net index of
-1 is intentionally unconnected. Generated numbers for unnamed test-point pins
are marked as generated identities.

A complete zero-sized round aperture definition is accepted when the physical
pad supplies positive dimensions. Unexposed copper pads may use the brief record
without an exposed-area payload; their aperture supplies the dimensions. Pad
record boundaries and all physical coordinates remain bounded and validated.

Master-footprint order, `_B` name suffixes and nearest-pad coordinates do not
determine connectivity. Real exports can reverse serialized master order and
swap labeled pins on symmetric bottom footprints; the explicit UID link avoids
both errors. An invalid or unaligned UID, missing namespace, damaged declared
record or exceeded resource limit is rejected instead of silently dropping pins.

Original synthetic fixtures cover UID order, two pin groups, sides, empty layer
slots, sparse labels, metadata, test points, dimensions, malformed boundaries,
incorrect references and resource limits. A local collection audit imported 770
of 774 paths, representing 567 of 571 distinct file contents. Across the imported
distinct contents, all 1,471,044 declared component entries and 5,188,059 pin
references were independently traversed at their raw record boundaries. Counts,
source pad positions, net links, labels, component fields and sides agreed with
the import; dimensions also agreed with the decoded physical geometry. No sample
is distributed.

The four remaining distinct inputs comprised two records with physical
dimensions or coordinates outside the supported bounds, one document-layer-only
export with no supported TOP/BOTTOM layer, and one input without a complete
recognized net table. AppleDouble metadata companions found in an earlier
snapshot were identified separately; they are absent from this audit's final
input set. These structural limits remain explicit rejections; this audit does
not establish that every TVW dialect is supported.

Still refused, with a precise message, because the available record facts are
not enough to read them safely: an export whose layer headers use a prefix other
than the known one, an AppleDouble companion file (a `._` name; macOS writes
these next to the real file and they are not boardviews) and any record that
does not fit the known component framing. Every declared count is bounded and
the searches are linear.

Board outlines and copper traces are not imported. The application infers a
viewing boundary from imported objects and discloses that fallback. Custom pad
shapes use their declared bounding boxes; rounded or composite geometry is not
fully reproduced. Validation applies to tested export variants, not every
possible TVW dialect.
