Observed legacy Allegro databases now receive a certain format diagnosis and
UNSUPPORTED_VARIANT with their exact binary layout identifier. Their writer
version is reported as a content-free header code. The reader requires documented
16.0–17.5 record layouts; older layouts need a GenCAD export from the original
software. The alternate 16.2 identifier 0x00130500 now uses its validated 16.2
layout.

Footprint layer codes outside the verified top/bottom values receive an explicit
export suggestion. Unknown layer semantics and alternate pad references are
refused before any board geometry is produced.
