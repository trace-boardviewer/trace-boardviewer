# Mentor Neutral imports

The reader imports the documented Boardstation `BOARD`, `B_UNITS`, `COMP` and
`C_PIN` subset. Selected real exports were checked. A separate comparison checked source references, electrical
nets, absolute coordinates, declared units and explicit top/bottom sides.

`B_UNITS` selects inches, mils or millimetres. Component centers and rotations
are retained where placed; BOM-only parts require positioned pins to be drawable.
Pin coordinates are already absolute. `$NONE$` means disconnected. Other net
names retain their identity, including a leading slash.

Bodies and pads are estimated. Native outline, tracks, vias and ancillary
properties are omitted with an import warning. Nonzero board offset/orientation
and other units remain recognized with `UNSUPPORTED_VARIANT` until independently
validated. Conflicting identities, coordinates or sides produce `INVALID_FORMAT`.

The reader checks the 64 MiB byte limit before text decoding. Counts, records and
line lengths are bounded. A component side consisting of one NUL byte can be
recovered only from agreeing explicit sides on its pins, with a warning. NUL in
unused properties is disclosed; NUL in other consumed fields is rejected. The
adapter recognizes a short complete board header even when these narrowly
recoverable records fall within its initial sniff window.

The implementation is original. Record meanings were checked against the
[published format description](https://github.com/AlexeyInwerp/BoardRipper/blob/main/docs/formats/MENTOR_NEUTRAL_FORMAT.md)
and local exports. No external parser code or private board samples are included.
