/** Handwritten synthetic records only; no exported board data. */
export function syntheticTeboIct(eol = '\n'): { geometry: string; program: string } {
  const geometry = ['!Tebo-ict v3.0', '!HP3070', '!original synthetic fixture', 'scale 1;', 'units inches;', '', 'OUTLINE', '0, 0', '2, 0', '2, 1', '0, 1;', '', 'NODE GND NO_ACCESS;', 'NODE POWER   ;', 'OTHER', 'ALTERNATES', '0.25, -0.125 U1.A1 TOP NO_PROBE;', '0.5, 0.125 U1.B2 MANDATORY;', '1.0, 0.25 R1.1 TOP NO_PROBE;', '1.5, 0.25 R1.2 NO_PROBE;', 'DEVICES', 'R1 BOTTOM;', 'END', ''].join(eol);
  const program = ['!Tebo-ict v3.0', '!synthetic program preface is not a board model', 'HEADING', 'synthetic;', 'PIN_MAP', 'END', 'CONNECTIONS', 'GND', 'U1.A1', 'R1.1;', 'POWER', 'U1.B2 R1.2;', 'NODES', 'GND;', 'POWER;', 'DEVICES', '!component test metadata is intentionally not imported', 'END', ''].join(eol);
  return { geometry, program };
}
