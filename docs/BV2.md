# BV2 text import

TRACE reads `.bv2` boardviews whose first section is `#Layout#`. They are
comma-separated text exports of the Layout, Nail and Pin tables used by
[Jet BV](BV.md). Both readers share the same original board mapping. No database
dependency is required.

All three sections are required, including a Nail section with no rows. Their
column headers and every row's field count are checked:

| Section | Columns |
| --- | --- |
| `#Layout#` | `X,Y,R` with an optional `Group` column |
| `#Nail#` | `Nail,X,Y,Type,Grid,TB,Net,NetName` |
| `#Pin#` | `Part,TB,Pin,Name,X,Y,Layer,Netname` |

Quoted fields retain commas, doubled quotes and embedded line breaks. LF, CRLF
and CR records are accepted, as are UTF-8, Windows-1252 and valid UTF-16 text.
Byte-order marks are supported. Stray or unfinished quotes, missing sections,
duplicate sections, unknown headers and exceeded byte, field or row limits fail
explicitly. The export declares no row counts or terminal marker, so the reader
cannot establish completeness beyond its available, fully framed records.

Coordinates are in inches, converted to millimetres by 25.4. Y stays up and
bottom-side coordinates are not mirrored. `(T)` and `(B)` supply explicit pin and
test-point sides. Component sides follow all their pins. Pin `Name` provides the
pin identity and `Netname` supplies connectivity. Numeric `Pin` values are
checked but can repeat within a component in this text variant; duplicate names
on the same component and side are refused. Missing names use source ordinals
with a generated-identity marker. Jet BV retains its separate ordinal check.

Nail rows become separate test points, with `NetName` providing connectivity.
Repeated Nail labels are retained and disclosed. Type accepts integer annotations,
positive decimal `MIL` annotations and `NO_PROBE`. These annotations do not supply
pad dimensions or a probe-availability model; `NO_PROBE` rows remain electrical
points and produce a warning. Grid and numeric-text Net annotations do not create
connections. The text export has no VirtualPinVia column. Exporter `UNCONNECTED`
placeholders are shown without a net and disclosed.

A read-only audit imported both available text exports, representing two distinct
contents. Every Layout, Pin and Nail cell matched an independent CSV traversal.
The 12,385 component-pin rows and 2,427 Nail rows produced 14,812 pins in 5,394
components; all 254 outline points retained source order. Positions, identities,
nets, owners and sides agreed with those source records. No sample is distributed;
the committed fixtures are original synthetic text.

The tested exports use a single Layout Group and zero outline radius. Multiple
groups are refused because their contour interpretation has not been validated.
Non-zero radii use straight segments and produce a warning. The tables provide
no physical component bodies, pad geometry, package names or values. The
application discloses its viewing estimates. Copper traces are not imported.
