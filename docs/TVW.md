# TVW import

TRACE has an original TVW reader. Its record-description reference is
[teboviewformat, revision 0dde0a7](https://github.com/mmuman/teboviewformat/tree/0dde0a73ab61af81b284b7b1478783a691bbd1a6),
licensed under MIT by Paul Daniels. The notice is preserved in
[assets/licenses/teboviewformat-MIT.txt](../assets/licenses/teboviewformat-MIT.txt).
No external TVW parser implementation is included.

The reader requires duplicate net counts, the words 0, 0, 4, the Pascal text
`ProbeDB` and a closing byte (the low byte of the word that follows is 0x23 or
0x17 on the exports seen so far). The usual 69-byte prefix in front of the first
count is checked first, but a table with another prefix is found by the same
validated body. The reader then traverses every entry in the declared component table sequentially. Compact
metadata, an older height-word layout and two additional Pascal metadata fields
are supported. Numeric-leading references, placement origins outside asymmetric
body bounds, sparse BGA ordinals, package placeholders and unnamed test points
are preserved.

Each component pin has a source UID: **UID / 8 is its physical pad ordinal**.
A pin list names its layer by the **zero-based index into the full list of layer
headers**, in file order. Aux, silk, mask and inner headers count in that index
although their bodies are never read. The header type decides the side (1 is
TOP, 2 is BOTTOM); the TOP header sits at index 2 on some exports, the BOTTOM
header at 5, 7 or 13 on others. A number that selects another kind of layer, or
a number that no header provides, is never called TOP or BOTTOM: the import is
refused with a message that names the layer. Only the first established numbers
2 (TOP), 5 and 7 (BOTTOM) also resolve to the single TOP or BOTTOM layer when the
detected header list does not name them. That exact pad supplies the pin's
position, net, side and dimensions. Disk coordinates are Y/X in centimils (0.000254 mm). A net index of
-1 is intentionally unconnected. Generated numbers for unnamed test-point pins
are marked as generated identities.

Master-footprint order, `_B` name suffixes and nearest-pad coordinates do not
determine connectivity. Real exports can reverse serialized master order and
swap labeled pins on symmetric bottom footprints; the explicit UID link avoids
both errors. An invalid or unaligned UID, missing namespace, damaged declared
record or exceeded resource limit is rejected instead of silently dropping pins.

Original synthetic fixtures cover UID order, sides, sparse labels, metadata,
test points, dimensions, malformed boundaries, incorrect references and resource
limits. Selected real exports were independently traversed by the maintainer at their
raw record boundaries: every component entry and every pin reference agreed
with its declared physical pad. No sample is distributed.

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
