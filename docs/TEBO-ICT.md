# Tebo ICT companion-pair import

TRACE reads the validated `!Tebo-ict v3.0` export pair: extensionless `BOARD`
and `BOARD_XY` in one directory. File roles are matched case-insensitively.
Either entry opens the same complete board. `BOARD.ict` and `BOARD_XY.ict` are
also accepted named aliases; these aliases have synthetic coverage, while the
real-file audit used the extensionless names. Both files are required.

`BOARD_XY` supplies explicit inch units, `scale 1`, a semicolon-terminated
OUTLINE, NODE declarations, physical `Ref.Pin` points in OTHER ALTERNATES,
BOTTOM device declarations and a final END. `BOARD` supplies semicolon-delimited
CONNECTIONS and its own NODES table. NODE declaration order never assigns nets to
physical points. The reader joins each physical `Ref.Pin` identity to its explicit
CONNECTIONS entry and requires a complete bijection. Both node tables and the
connection groups must declare exactly the same nets. Duplicate identities,
conflicting connections, missing peers and incomplete relevant sections fail
explicitly.

Coordinates are converted from inches to millimetres by 25.4. They remain Y-up;
bottom access does not mirror coordinates. TOP marks top physical-pin access;
omitted TOP follows the HP3070 bottom-access convention. Explicit BOTTOM device
declarations set component sides even when a component has a top-access pin.
For components without such a declaration, sides follow all their physical pins;
mixed sides display the component on both sides. This derivation is disclosed.

The supported physical records end in `NO_PROBE` or `MANDATORY`. NODE declarations
can carry `NO_ACCESS`. These annotations are checked, and electrical points stay
in the model. Probe availability and fixture hardware are not modeled. Pads and
component bodies have no imported physical dimensions and use the application's
disclosed viewing estimates. Program test-device metadata, package names, values
and copper traces are not imported.

A read-only audit checked all four available entry paths, representing two
duplicate pairs and two distinct contents. Both opening orders produced the same
3,303 components, 10,805 pins, 2,452 nets and 74 outline points. Independent source
traversals checked every physical identity, coordinate, side and probe annotation,
each explicit pin-to-net connection, both node tables, device-side declarations,
component ownership and outline order. No mismatch or input mutation was found.
There were 8,185 top and 2,620 bottom pin-access records, 10,437 NO_PROBE records,
368 MANDATORY records and 2,129 NO_ACCESS node annotations. No sample is distributed;
all committed fixtures are original synthetic text.

The reader deliberately supports this validated pair grammar. Other scales or
units, quoted identities, node-scoped alternatives, device outlines, additional
probe flags and other versions are refused. The source declares no expected row
counts; full identity agreement and terminal framing establish consistency of the
available pair, rather than completeness against an external design. Ancillary
program preface and test-device records are not interpreted or structurally
validated beyond the required section order and final END. Inputs are bounded to
64 MiB together, two million lines per file, 8,192 characters per field, 32,768
characters per line, 200,000 outline points, 250,000 components and one million
pins. Content-free diagnostics use the existing generic text hook vocabulary.
