/** Colours of the board canvas per theme; the renderers and the canvas hover card read them from here. */
export const BOARD_PALETTES = {
  dark: {
    background: '#0d131b', grid: '#263644', board: '#142a28', boardLine: '#659487',
    body: '#475b56', bodyLine: '#a2b5a6', chip: '#354b5d', chipLine: '#96b3c7',
    connector: '#5e5a49', connectorLine: '#bcb69a', chipInset: '#6e8799',
    pad: '#d6ddc8', label: '#e4eadf', labelBacking: '#0e191ed9', labelHalo: '#0e191e',
    hoverLine: '#e4ead7', hoverGlow: '#dde7cb4d', amberGlow: '#efb75170', netFill: '#285157',
    amber: '#efb751', amberFill: '#66502e', cyan: '#56d4cf', text: '#e8eff5', card: '#141d28', muted: '#8fa3b3',
  },
  light: {
    background: '#edf1ed', grid: '#cad4cc', board: '#e0e9df', boardLine: '#6d8879',
    body: '#a8b9ac', bodyLine: '#536f60', chip: '#a5b7c2', chipLine: '#4d6a80',
    connector: '#c8bda0', connectorLine: '#837653', chipInset: '#70899b',
    pad: '#365b4a', label: '#263f39', labelBacking: '#f6f9f0ed', labelHalo: '#f6f9f0',
    hoverLine: '#304f47', hoverGlow: '#365b4a45', amberGlow: '#a9752460', netFill: '#badfd9',
    amber: '#9b650d', amberFill: '#f3d79a', cyan: '#008a89', text: '#1b2b32', card: '#fcfcf8', muted: '#586b73',
  },
} as const;

export type BoardTheme = keyof typeof BOARD_PALETTES;
export type BoardPalette = { readonly [K in keyof typeof BOARD_PALETTES.dark]: string };
