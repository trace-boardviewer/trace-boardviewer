# Unisoft F2B reader

TRACE reads archive versions 6 and 8 with component payload versions 7, 8 and 9.
It imports component references, numeric and alphabetic pin labels, board-coordinate
pin positions, electrical nets and placed-pin sides. Component bodies and pad sizes
are estimated from pins. Tracks, vias, native outlines, BOM values and annotations
are omitted and disclosed in the import warnings.

This is an original implementation. Format facts were established by following
counted records and keyed MFC references, then comparing the vendor's public
`YOURPCB.F2B` and `YOURPCB.FBA` sample pair. The comparison covered 1,103 component
pins: all coordinates and electrical nets matched. The exported FBA specification
states that XY coordinates are inches and identifies top, bottom and SMD fields.
The F2B header's resolution converts source coordinates with `25.4 / resolution`.
The paired export validates top SMD, bottom SMD and through-hole pin records.
The bottom through-hole flag is inferred from the matching bottom-layer field
and the consistent top/bottom pairing in local archives. Known layer fields
must agree with each pin-side code, including the full-stack through-hole field,
and pins within a component must agree on
the component's mounting side.
Local archives additionally exercise alphabetic labels, lower coordinate resolution
and the older component payload layout.

The reader validates these structures in order:

1. The fixed header and first `CTraceList` signature.
2. Counted 28-byte trace rows and the explicit trace-list terminator.
3. Versioned pin rows and MFC class/object references. New class definitions and
   existing object references share the archive's index space.
4. Versioned component payloads, their six strings and fixed version-specific tails.
   Component pin counts must agree with actual ownership.
5. Component and name dictionaries. Component references must match the object
   graph; every live net and alphabetic pin label must resolve.
6. Saved document settings, the version-3 part-number dictionary and counted
   display settings, through the exact end of the archive.

Every count, string length, class name and extent is bounded before allocation.
Unknown archive, class or payload versions are refused with `UNSUPPORTED_VARIANT`.
Unicode MFC strings and extended object references are also refused pending
independent layout validation. Damaged references, mismatched counts, truncation
and trailing bytes produce `INVALID_FORMAT`. The existing 64 MiB input limit applies.

The diagnostic hook reports only whitelisted versions, rounded counts and numeric
block tags/length buckets. It consumes strings for framing and never reports
references, nets, coordinates, source paths, BOM text or annotation content.

For a refused variant, export the original board to GenCAD or a net-and-XY format
from Unisoft. A paired F2B and original export would allow another archive/payload
version, Unicode string layout or extended reference layout to be validated.

Sources: [Unisoft sample download and tutorial](https://www.unisoft-cim.com/view-markup_download.htm),
[Unisoft XML export specification](https://www.unisoft-cim.com/exports_xml-definition.html),
[Microsoft CArchive documentation](https://learn.microsoft.com/en-us/cpp/mfc/reference/carchive-class?view=msvc-170).

No downloaded samples, local board files or identifiable fragments are included
in the repository; automated fixtures are synthetic.
