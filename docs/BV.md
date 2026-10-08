# Jet BV import

TRACE reads `.bv` boardviews stored in Jet databases. The reader is an original
bounded implementation using byte arrays and scalar table fields. Its record
offsets were checked against [mdb-reader 3.2.0](https://github.com/andipaetzold/mdb-reader),
whose [MIT notice](../assets/licenses/mdb-reader-MIT.txt) is retained. No database
library or global `Buffer` object is required.

The [BV2 text reader](BV2.md) shares the Layout, Pin and Nail board mapping while
checking its own CSV framing and schema. Jet BV keeps its declared row counts,
numeric test-point Type fields and unique source pin-ordinal checks.

The `Standard Jet DB` signature identifies the database. The reader follows the
catalog, table-definition chains and direct or indirect usage maps, checks every
page reference and row boundary, and requires every declared live row to be
present. Cyclic chains, duplicate page references, malformed fields and exceeded
byte or record budgets fail explicitly. Only the `Layout`, `Pin` and `Nail`
boardview schema is imported; a generic Access database without that schema is
refused.

- `Layout` supplies X/Y outline points, radius R and an optional Group column.
  Points retain source order. The tested files use a single Group value; multiple
  groups are refused because their contour interpretation has not been validated.
  Non-zero radii use straight segments and produce a warning.
- `Pin` supplies the component reference, explicit `(T)` / `(B)` side, numeric
  source ordinal, pin Name, X/Y coordinates, Layer and Net. Name is the pin
  identity: a BGA name such as `A1` is retained even when its ordinal is `17`.
  A missing name uses its source ordinal with a generated-identity marker.
  Components retain all their pins, including pins on both sides.
- `Nail` supplies separate test points. A `$25` identifier becomes `TP:25` with
  pin `25`; other names are preserved. X/Y and TB provide position and side, and
  NetName supplies connectivity. Rows that reuse an identifier remain separate
  test points, with a warning about the repeated identity. Type, Grid, NET and
  VirtualPinVia are checked as scalar fields and do not invent connections.

All coordinates are in inches, converted to millimetres by 25.4. Y remains up;
bottom-side coordinates are not mirrored. The exporter’s `UNCONNECTED`
placeholders are shown without a net and disclosed. Empty or null net names are
also unconnected.

A read-only local audit imported all 42 Jet4 paths, representing 30 distinct file
contents. Every Layout, Pin and Nail table cell matched an independent MIT
reader. Across the distinct contents, 252,189 component-pin rows and 56,193
test-point rows produced 308,382 pins in 114,740 components; 6,767 outline points
were checked. The imported positions, labels, nets, owners, sides and outline
points agreed with those source tables. An earlier snapshot also included an
AppleDouble metadata input, which was not claimed as a boardview. No sample
database is distributed.

Jet3 table framing, compressed Jet4 text, indirect usage maps and malformed
records are covered by original synthetic fixtures. Real-file evidence covers
the tested Jet4 schema only. Encrypted data pages, overflow rows, multiple Layout
groups, other Access engines and unsupported required scalar-column types are
refused explicitly.

The tables provide no physical pad sizes, component body sizes, package names or
values. Viewing estimates for pads and component bodies are disclosed by the
application. Outline arcs are not reproduced; the audited collection has zero
radius in every Layout row. Copper traces are not imported.

The diagnostic hook validates Jet header/catalog/table framing and reports only engine version, declared Layout/Pin/Nail counts and inch units. It records no table cells or user labels. Missing or damaged table definitions stop at the container stage; scalar record and board checks remain the parser's responsibility.
