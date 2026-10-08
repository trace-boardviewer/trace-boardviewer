# Board rendering

BoardCanvas owns pointer and keyboard input, camera animation and persistence, pane layout, and scheduling. It redraws the base surface when board display state changes; hover, measurement and selection markers use a separate overlay surface.

The pure board-scene module adds render geometry to the shared BoardIndex. Pass the workspace index through the canvas index prop; otherwise boardIndexOf supplies the cached index. Id maps, part kinds, side pad lists and net groups retain their shared identities. The scene derives body dimensions, label anchors, per-side spatial indices and the fallback board outline. Renderer paths are lazy and belong to the backend.

BoardPane in board-view describes a canvas rectangle, its view transform, side and optional hidden layers. Its conversion helpers handle rectangle offsets, rotation, mirroring and device scale. Multiple panes share one scene and are drawn in list order; input chooses the last pane under the pointer.

BoardRenderer exposes scene, size, feature layers, surface rendering, status, cache invalidation and disposal. Canvas2DBoardRenderer implements the contract with ordered background, outline, connections, bodies, pads and labels on the base surface; hover, selection, measurement and compass on the overlay surface. Add a BoardLayer with a surface and numeric order through the canvas layers prop. Feature layers receive the pane frame and run inside save/restore, including when a layer throws. Keep the array stable and replace it when feature data changes.

The backend reports per-layer and whole-surface timings. Canvas context recovery invalidates renderer caches. A later GPU backend can use the same scene, panes and render state while retaining Canvas2D overlays.

## Validation harness

harness/board-canvas.html runs the canvas alone. scripts/qa-board-render.cjs captures exact RGBA, hashes and PNGs for both surfaces at device scale factors 1 and 2. It drives real pointer, wheel and keyboard events and records selection callbacks. The compare option fails for any pixel or callback mismatch. The scenarios option selects a comma-separated subset without changing defaults.

Timing uses the same 1440 by 960 viewport and deterministic synthetic boards as the performance suite. Use the electron runtime and fence option to include raster completion. Draw callback timings alone are not comparable to the production performance suite's fenced budget numbers. Keep production budgets in scripts/qa-performance.cjs; the isolated harness helps attribute costs to layers.
