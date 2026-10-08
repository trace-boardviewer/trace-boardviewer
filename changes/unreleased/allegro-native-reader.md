Native Allegro BRD databases now import components, pin numbers, electrical nets,
pad positions and dimensions, component values and packages, and board outlines.
The reader validates keyed record framing, counts and references, and rejects
damaged or unsupported layouts. Local validation covers 16.2, 16.4, 16.5, 16.6 and
17.2; the other 16.0–17.5 layouts have synthetic tests.

Component bodies remain estimated from pads. Curved outlines use straight chords
and custom pad shapes use rectangular extents. Tracks, copper fills and vias are
not imported. The existing 64 MiB input limit remains in force.
