import { createContext, useContext } from 'react';
import type { ReactNode } from 'react';

/**
 * Content a host (the workspace Schematic tab) wants drawn OVER the schematic stage, such as the board-candidate banner
 * (W-fin-crossprobe-01). The overlay is absolutely positioned inside the stage, so the stage and the canvas keep their size:
 * the sheet is not re-fitted and the pointer stays on the wire it just clicked. The default (no host) is no overlay.
 */
export const SchematicOverlayContext = createContext<ReactNode>(null);
export const useSchematicOverlay = (): ReactNode => useContext(SchematicOverlayContext);
