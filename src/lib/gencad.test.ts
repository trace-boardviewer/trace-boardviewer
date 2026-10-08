import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { GENCAD_LIMITS, GenCadParseError, parseGenCad } from './gencad';
import { formatIssue, LANGUAGES } from './i18n';
import { catching, expectCostAtMost, expectScaling } from '../test-support/timing';

interface FixtureOptions {
  units?: string; board?: string; pads?: string; stacks?: string; shape?: string;
  component?: string; devices?: string; signals?: string;
}

function fixture(options: FixtureOptions = {}): string {
  return `$HEADER
GENCAD 1.4
UNITS ${options.units ?? 'MM'}
ORIGIN 0 0
$ENDHEADER
$BOARD
${options.board ?? 'RECTANGLE 0 0 40 30'}
$ENDBOARD
$PADS
${options.pads ?? 'PAD P ROUND -1\nCIRCLE 0 0 0.2'}
$ENDPADS
$PADSTACKS
${options.stacks ?? 'PADSTACK PS 0\nPAD P TOP 0 0'}
$ENDPADSTACKS
$SHAPES
SHAPE S
${options.shape ?? 'RECTANGLE -2 -1 4 2\nPIN 1 PS -1 0 TOP 0 0\nPIN 2 PS 1 0 TOP 0 0'}
$ENDSHAPES
$COMPONENTS
${options.component ?? 'COMPONENT R1\nPLACE 10 20\nLAYER TOP\nROTATION 0\nSHAPE S 0 0\nDEVICE D'}
$ENDCOMPONENTS
$DEVICES
${options.devices ?? 'DEVICE D\nVALUE "10 kOhm"\nPACKAGE "0402"'}
$ENDDEVICES
$SIGNALS
${options.signals ?? 'SIGNAL GND\nNODE R1 1\nSIGNAL "POWER 3V3"\nNODE R1 2'}
$ENDSIGNALS
`;
}

const parse = (options?: FixtureOptions) => parseGenCad(fixture(options), 'test.cad');

describe('parseGenCad', () => {
  it('imports placements, dimensions, device metadata and bidirectional net membership', () => {
    const board = parse();
    expect(board.name).toBe('test'); expect(board.format).toBe('GENCAD 1.4'); expect(board.units).toBe('mm');
    expect(board.components).toHaveLength(1); expect(board.pins).toHaveLength(2); expect(board.nets).toHaveLength(2);
    const component = board.components[0];
    expect(component).toMatchObject({ ref: 'R1', value: '10 kOhm', package: '0402', side: 'top', position: { x: 10, y: 20 } });
    expect(component.bounds).toEqual({ minX: 8, minY: 19, maxX: 12, maxY: 21 });
    expect(board.pins[0]).toMatchObject({ componentId: component.id, number: '1', x: 9, y: 20, net: 'GND', radius: 0.2, shape: 'round' });
    expect(component.pinIds).toEqual(board.pins.map(pin => pin.id));
    for (const net of board.nets) expect(net.pinIds).toEqual(board.pins.filter(pin => pin.net === net.name).map(pin => pin.id));
    expect(board.warnings).toEqual([]);
  });

  it.each([
    ['MM', 1], ['INCH', 25.4], ['THOU', 0.0254], ['MIL', 0.0254], ['MILS', 0.0254], ['USER 1000', 0.0254], ['USER 2000', 0.0127],
  ])('converts %s file units to canonical millimetres', (unit, multiplier) => {
    const board = parse({ units: unit });
    expect(board.pins[0].x).toBeCloseTo(9 * multiplier, 10);
    expect(board.pins[0].y).toBeCloseTo(20 * multiplier, 10);
    expect(board.bounds.maxX).toBeCloseTo(40 * multiplier, 10);
    expect(board.outline[2].y).toBeCloseTo(30 * multiplier, 10);
  });

  it('treats header ORIGIN as metadata instead of adding a second coordinate offset', () => {
    const text = fixture().replace('ORIGIN 0 0', 'ORIGIN 500 900');
    expect(parseGenCad(text, 'board.cad').pins[0]).toMatchObject({ x: 9, y: 20 });
  });

  it.each([
    ['TOP', '0', 0, 12, 23], ['BOTTOM', '0', 0, 12, 23],
    ['TOP', '0', 90, 7, 22], ['BOTTOM', '0', 90, 7, 22],
    ['BOTTOM', 'MIRRORX', 90, 13, 22], ['TOP', 'MIRRORY', 90, 7, 18],
    ['TOP', 'MIRRORXY', 0, 8, 17], ['TOP', '0', -90, 13, 18],
  ])('applies %s / %s / %s° before translation', (layer, mirror, angle, x, y) => {
    const board = parse({
      shape: 'PIN 1 PS 2 3 TOP 0 0',
      component: `COMPONENT R1\nPLACE 10 20\nLAYER ${layer}\nROTATION ${angle}\nSHAPE S ${mirror} 0`,
      signals: 'SIGNAL GND\nNODE R1 1',
    });
    expect(board.pins[0].x).toBeCloseTo(x, 10); expect(board.pins[0].y).toBeCloseTo(y, 10);
    expect(board.pins[0].side).toBe(layer.toLowerCase());
    expect(board.components[0].rotation).toBe(((angle % 360) + 360) % 360);
  });

  it('keeps a rotated circular pad round and preserves its radius', () => {
    const board = parse({ component: 'COMPONENT R1\nPLACE 10 20\nLAYER TOP\nROTATION 45\nSHAPE S 0 0' });
    expect(board.pins[0].radius).toBeCloseTo(0.2, 10);
    expect(board.pins[0].width).toBeCloseTo(0.4, 10);
  });

  it('composes padstack rotation, pin rotation and component transform in that order', () => {
    const board = parse({
      pads: 'PAD P ROUND -1\nCIRCLE 1 2 0.2', stacks: 'PADSTACK PS 0\nPAD P TOP 90 0',
      shape: 'PIN 1 PS 2 3 TOP 90 0',
      component: 'COMPONENT R1\nPLACE 10 20\nLAYER TOP\nROTATION 90\nSHAPE S MIRRORX 0',
      signals: 'SIGNAL GND\nNODE R1 1',
    });
    // pad (1,2) -> stack (-2,1) -> pin (1,1) -> mirror (1,-1) -> rotation (1,1).
    expect(board.pins[0].x).toBeCloseTo(11, 10); expect(board.pins[0].y).toBeCloseTo(21, 10);
  });

  it('uses RECTANGLE local dimensions and a separate rotation', () => {
    const board = parse({
      pads: 'PAD P RECTANGULAR -1\nRECTANGLE -1 -0.5 2 1',
      shape: 'RECTANGLE -2 -1 4 2\nPIN 1 PS 0 0 TOP 90 0',
      signals: 'SIGNAL GND\nNODE R1 1',
    });
    expect(board.components[0].bounds).toEqual({ minX: 8, minY: 19, maxX: 12, maxY: 21 });
    expect(board.pins[0].width).toBeCloseTo(2, 10); expect(board.pins[0].height).toBeCloseTo(1, 10);
    expect(board.pins[0].rotation).toBeCloseTo(90, 10);
    expect(board.pins[0].shape).toBe('rect');
  });

  it.each([
    [15, '0', 30, '0', 45, '0', 90],
    [15, 'MIRRORX', 35, 'MIRRORY', 25, 'MIRRORX', 185],
    [0, 'MIRRORY', 0, '0', 45, '0', 225],
  ])('composes rectangular pad orientation through stack, pin and component mirrors', (stackAngle, stackMirror, pinAngle, pinMirror, componentAngle, componentMirror, expected) => {
    const board = parse({
      pads: 'PAD P RECTANGULAR -1\nRECTANGLE -2 -0.5 4 1',
      stacks: `PADSTACK PS 0\nPAD P TOP ${stackAngle} ${stackMirror}`,
      shape: `RECTANGLE -3 -3 6 6\nPIN 1 PS 0 0 TOP ${pinAngle} ${pinMirror}`,
      component: `COMPONENT R1\nPLACE 10 20\nLAYER TOP\nROTATION ${componentAngle}\nSHAPE S ${componentMirror} 0`,
      signals: 'SIGNAL GND\nNODE R1 1',
    });
    expect(board.pins[0]).toMatchObject({ x: 10, y: 20, width: 4, height: 1, radius: 0.5, shape: 'rect' });
    expect(board.pins[0].rotation).toBeCloseTo(expected, 10);
    expect(board.warnings).toEqual([]);
  });

  it('includes the true corners of an oblique rectangular pad in component bounds', () => {
    const board = parse({
      pads: 'PAD P RECTANGULAR -1\nRECTANGLE -2 -0.5 4 1',
      shape: 'RECTANGLE -0.1 -0.1 0.2 0.2\nPIN 1 PS 0 0 TOP 45 0',
      signals: 'SIGNAL GND\nNODE R1 1',
    });
    const extent = 2.5 / Math.sqrt(2);
    expect(board.pins[0]).toMatchObject({ width: 4, height: 1, shape: 'rect', radius: 0.5 });
    expect(board.pins[0].rotation).toBeCloseTo(45, 10);
    expect(board.components[0].bounds.minX).toBeCloseTo(10 - extent, 10);
    expect(board.components[0].bounds.maxY).toBeCloseTo(20 + extent, 10);
    expect(board.warnings).toEqual([]);
  });

  it.each([['TOP', '0', 0.2], ['TOP', 'FLIP', 0.5], ['BOTTOM', '0', 0.5], ['BOTTOM', 'FLIP', 0.2]])('selects %s / %s padstack layers without moving coordinates', (layer, flip, radius) => {
    const options = {
      pads: 'PAD PT ROUND -1\nCIRCLE 0 0 0.2\nPAD PB ROUND -1\nCIRCLE 0 0 0.5',
      stacks: 'PADSTACK PS 0.1\nPAD PT TOP 0 0\nPAD PB BOTTOM 0 0',
      component: `COMPONENT R1\nPLACE 10 20\nLAYER ${layer}\nROTATION 0\nSHAPE S 0 ${flip}`,
    };
    const board = parse(options);
    expect(board.pins[0]).toMatchObject({ x: 9, y: 20, side: 'both', radius });
  });

  it('warns about polygon pad approximations even when polygons use only LINE records', () => {
    const board = parse({ pads: 'PAD P POLYGON -1\nLINE -1 -1 1 -1\nLINE 1 -1 0 1\nLINE 0 1 -1 -1' });
    expect(board.warnings).toContainEqual({ key: 'parse.warning.approximatedPads', params: { count: 2 } });
  });

  it('keeps POLYGON declarations approximate even if their geometry contains a rectangle', () => {
    const board = parse({ pads: 'PAD P POLYGON -1\nRECTANGLE -2 -0.5 4 1', stacks: 'PADSTACK PS 0\nPAD P TOP 45 0' });
    expect(board.pins[0].rotation).toBe(0);
    expect(board.pins[0].width).toBeCloseTo(5 / Math.sqrt(2), 10);
    expect(board.warnings).toContainEqual({ key: 'parse.warning.approximatedPads', params: { count: 2 } });
  });

  it('marks through-hole pads visible on both board sides', () => {
    const board = parse({ stacks: 'PADSTACK PS 0.2\nPAD P ALL 0 0' });
    expect(board.pins.every(pin => pin.side === 'both')).toBe(true);
  });

  it.each([
    ['TOP', 'TOP', 'TOP', 'top'], ['BOTTOM', 'TOP', 'TOP', 'bottom'],
    ['TOP', 'BOTTOM', 'TOP', 'bottom'], ['BOTTOM', 'BOTTOM', 'TOP', 'top'],
    ['TOP', 'TOP', 'BOTTOM', 'bottom'], ['BOTTOM', 'TOP', 'BOTTOM', 'top'],
    ['TOP', 'BOTTOM', 'BOTTOM', 'top'], ['TOP', 'TOP', 'ALL', 'both'],
  ])('maps component %s, stack %s, PIN %s using the repair-export mounting-side convention', (componentLayer, stackLayer, pinLayer, side) => {
    const board = parse({
      stacks: `PADSTACK PS 0\nPAD P ${stackLayer} 0 0`,
      shape: `PIN 1 PS 0 0 ${pinLayer} 0 0`,
      component: `COMPONENT R1\nPLACE 10 20\nLAYER ${componentLayer}\nROTATION 0\nSHAPE S 0 0`,
      signals: 'SIGNAL GND\nNODE R1 1',
    });
    expect(board.pins[0]).toMatchObject({ x: 10, y: 20, radius: 0.2, side });
  });

  it('uses BOTTOM PIN stack orientation when selecting a multi-layer pad geometry', () => {
    const board = parse({
      pads: 'PAD PT ROUND -1\nCIRCLE 0 0 0.2\nPAD PB ROUND -1\nCIRCLE 0 0 0.5',
      stacks: 'PADSTACK PS 0.1\nPAD PT TOP 0 0\nPAD PB BOTTOM 0 0',
      shape: 'PIN 1 PS 0 0 BOTTOM 0 0',
      signals: 'SIGNAL GND\nNODE R1 1',
    });
    expect(board.pins[0]).toMatchObject({ side: 'both', radius: 0.5 });
  });

  it('prefers exact outer-layer pads over ALL entries and never substitutes an inner layer', () => {
    const board = parse({
      pads: 'PAD P ROUND -1\nCIRCLE 0 0 0.2\nPAD PI ROUND -1\nCIRCLE 0 0 2',
      stacks: 'PADSTACK PS 0.1\nPAD PI INNER1 0 0\nPAD PI ALL 0 0\nPAD P TOP 0 0',
    });
    expect(board.pins.every(pin => pin.side === 'both' && pin.radius === 0.2)).toBe(true);
  });

  it('recognizes BOTH stack layers as visible on both sides', () => {
    const board = parse({ stacks: 'PADSTACK PS 0\nPAD P BOTH 0 0' });
    expect(board.pins.every(pin => pin.side === 'both' && pin.radius === 0.2)).toBe(true);
  });

  it('connects all physical pads sharing a logical pin number, and deduplicates repeated nodes', () => {
    const board = parse({
      shape: 'PIN 1 PS -1 0 TOP 0 0\nPIN 1 PS 1 0 TOP 0 0',
      signals: 'SIGNAL GND\nNODE R1 1\nNODE R1 1\nSIGNAL GND\nNODE R1 1',
    });
    expect(new Set(board.pins.map(pin => pin.id)).size).toBe(2);
    expect(board.pins.every(pin => pin.net === 'GND')).toBe(true);
    expect(board.nets).toHaveLength(1); expect(board.nets[0].pinIds).toHaveLength(2);
  });

  it('retains unconnected pins and warns about dangling NODE references', () => {
    const board = parse({ signals: 'SIGNAL GND\nNODE R1 1\nNODE MISSING 4\nNODE R1 999' });
    expect(board.pins[1].net).toBe(''); expect(board.nets[0].pinIds).toHaveLength(1);
    expect(board.warnings).toContainEqual({ key: 'parse.warning.danglingNodes', params: { count: 2, examples: 'MISSING.4, R1.999' } });
  });

  it('supports BOM, CRLF, scientific notation, quoted names and literal # characters', () => {
    let text = fixture({
      component: 'COMPONENT "R 1#"\nPLACE 1e1 2e1\nLAYER TOP\nROTATION 0\nSHAPE S 0 0\nDEVICE "device with spaces"',
      devices: 'DEVICE "device with spaces"\nPART "A \\"quoted\\" resistor"',
      signals: 'SIGNAL "POWER +3V3"\nNODE "R 1#" 1',
    });
    text = '\uFEFF' + text.replace(/\n/g, '\r\n');
    const board = parseGenCad(text, 'C:\\my boards\\test.cad');
    expect(board.name).toBe('test'); expect(board.components[0].ref).toBe('R 1#');
    expect(board.components[0].value).toBe('A "quoted" resistor');
    expect(board.pins[0]).toMatchObject({ x: 9, y: 20, net: 'POWER +3V3' });
  });

  it('keeps the board name empty when the file name has none, so the UI can show its own localized fallback', () => {
    expect(parseGenCad(fixture(), '.cad').name).toBe('');
    expect(parseGenCad(fixture(), 'C:\\boards\\').name).toBe('');
  });

  it('preserves long unquoted PART metadata including // delimiters', () => {
    const board = parse({ devices: 'DEVICE D\nPART CAP 1000P 50V (0402)//VENDOR/PART-123' });
    expect(board.components[0].value).toBe('CAP 1000P 50V (0402)//VENDOR/PART-123');
  });

  it('infers usable display markers and component centers when geometry is absent', () => {
    const board = parse({
      pads: 'PAD P ROUND -1\nCIRCLE 0 0 0', shape: 'PIN 1 PS 30 40 TOP 0 0\nPIN 2 PS 32 40 TOP 0 0',
      component: 'COMPONENT R1\nPLACE 0 0\nLAYER BOTTOM\nROTATION 0\nSHAPE S 0 0', board: '',
    });
    expect(board.components[0].position).toEqual({ x: 31, y: 40 });
    expect(board.pins[0]).toMatchObject({ x: 30, y: 40, side: 'bottom', radius: 0, width: 0, height: 0 });
    expect(board.components[0].outline).toHaveLength(5); expect(board.outline).toHaveLength(5);
    expect(board.warnings).toHaveLength(3);
    expect(board.warnings).toContainEqual({ key: 'parse.warning.fallbackPads', params: { count: 2 } });
    expect(board.warnings).toContainEqual({ key: 'parse.warning.fallbackComponents', params: { count: 1 } });
  });

  it('preserves a zero-size pad offset without inventing physical dimensions', () => {
    const board = parse({
      pads: 'PAD P ROUND -1\nCIRCLE 3 4 0', shape: 'PIN 1 PS 2 3 TOP 0 0',
      component: 'COMPONENT R1\nPLACE 10 20\nLAYER TOP\nROTATION 90\nSHAPE S MIRRORX 0',
      signals: 'SIGNAL GND\nNODE R1 1',
    });
    expect(board.pins[0].x).toBeCloseTo(17, 10); expect(board.pins[0].y).toBeCloseTo(25, 10);
    expect(board.pins[0]).toMatchObject({ radius: 0, width: 0, height: 0 });
    expect(board.components[0].bounds.maxX).toBeGreaterThan(board.pins[0].x);
  });

  it('joins unordered reversed board segments without inventing connections to cutouts', () => {
    const board = parse({ board: 'LINE 40 30 0 30\nLINE 0 0 40 0\nLINE 0 0 0 30\nLINE 40 0 40 30\nCIRCLE 20 15 2' });
    expect(board.outline).toHaveLength(5);
    expect(board.bounds).toEqual({ minX: 0, minY: 0, maxX: 40, maxY: 30 });
    expect(board.warnings).toContainEqual({ key: 'parse.warning.boardCutouts' });
  });

  it('samples counter-clockwise arcs and includes their cardinal extrema', () => {
    const board = parse({ board: 'ARC 0 -10 0 10 0 0\nLINE 0 10 0 -10' });
    expect(board.outline.length).toBeGreaterThan(20);
    expect(Math.max(...board.outline.map(p => p.x))).toBeCloseTo(10, 10);
    expect(Math.min(...board.outline.map(p => p.y))).toBeCloseTo(-10, 10);
    expect(Math.max(...board.outline.map(p => p.y))).toBeCloseTo(10, 10);
  });

  it('does not depend on section order and ignores unrelated optional sections', () => {
    const text = fixture();
    const chunks = text.match(/\$([A-Z]+)\n[\s\S]*?\$END\1\n/g)!;
    const board = parseGenCad(chunks.reverse().join('') + '$ROUTES\nROUTE GND\nLAYER TOP\nLINE 0 0 1 1\n$ENDROUTES\n', 'test.cad');
    expect(board.pins).toHaveLength(2); expect(board.pins[0].net).toBe('GND');
  });

  it.each([
    ['empty input', '', 'parse.error.empty'],
    ['binary input', 'GENCAD\0', 'parse.error.binary'],
    ['foreign format', 'BRDOUT 2', 'parse.error.dataOutsideSection'],
    ['missing section end', fixture().replace('$ENDCOMPONENTS', ''), 'parse.error.missingSectionEnd'],
    ['wrong section end', fixture().replace('$ENDPADS', '$ENDSHAPES'), 'parse.error.mismatchedSectionEnd'],
    ['missing units', fixture().replace('UNITS MM\n', ''), 'parse.error.unitsMissing'],
    ['unknown units', fixture({ units: 'PIXEL' }), 'parse.error.unsupportedUnit'],
    ['zero USER denominator', fixture({ units: 'USER 0' }), 'parse.error.userUnitDivisor'],
    ['negative USER denominator', fixture({ units: 'USER -1000' }), 'parse.error.userUnitDivisor'],
    ['wrong version', fixture().replace('GENCAD 1.4', 'GENCAD 9.0'), 'parse.error.requiresGencad14'],
    ['invalid numeric field', fixture().replace('PLACE 10 20', 'PLACE NaN 20'), 'parse.error.badNumber'],
    ['overflow', fixture().replace('PLACE 10 20', 'PLACE 1e999 20'), 'parse.error.coordinateRange'],
    ['overflow in geometry size', fixture().replace('CIRCLE 0 0 0.2', 'CIRCLE 0 0 1e12'), 'parse.error.sizeRangeMm'],
    ['bad origin metadata', fixture().replace('ORIGIN 0 0', 'ORIGIN NaN 0'), 'parse.error.badNumber'],
    ['missing coordinate', fixture().replace('PLACE 10 20', 'PLACE 10'), 'parse.error.missingField'],
    ['missing placement', fixture().replace('PLACE 10 20\n', ''), 'parse.error.missingPlace'],
    ['missing shape', fixture().replace('SHAPE S 0 0', 'SHAPE missing 0 0'), 'parse.error.shapeNotFound'],
    ['unknown mirror', fixture().replace('SHAPE S 0 0', 'SHAPE S MAGIC 0'), 'parse.error.unknownMirror'],
    ['unknown board side', fixture().replace('LAYER TOP', 'LAYER NARNIA'), 'parse.error.unknownComponentSide'],
    ['unknown PIN layer', fixture({ shape: 'PIN 1 PS 0 0 NARNIA 0 0' }), 'parse.error.unknownPinLayer', { layer: 'NARNIA' }],
    ['unknown stack layer', fixture({ stacks: 'PADSTACK PS 0\nPAD P NARNIA 0 0' }), 'parse.error.unknownStackLayer', { layer: 'NARNIA' }],
    ['unsupported inner PIN', fixture({ shape: 'PIN 1 PS 0 0 INNER1 0 0' }), 'parse.error.innerLayerPin'],
    ['unsupported inner-only stack', fixture({ stacks: 'PADSTACK PS 0\nPAD P INNER1 0 0' }), 'parse.error.innerOnlyPadstack'],
    ['negative radius', fixture().replace('CIRCLE 0 0 0.2', 'CIRCLE 0 0 -0.2'), 'parse.error.negativeRadius'],
    ['malformed arc', fixture({ board: 'ARC 1 0 0 2 0 0' }), 'parse.error.invalidArc'],
    ['unterminated string', fixture().replace('VALUE "10 kOhm"', 'VALUE "10 kOhm'), 'parse.error.unterminatedQuote'],
    ['duplicate reference', fixture({ component: 'COMPONENT R1\nPLACE 0 0\nSHAPE S 0 0\nCOMPONENT R1\nPLACE 0 0\nSHAPE S 0 0' }), 'parse.error.missingOrDuplicateComponent'],
    ['conflicting net assignment', fixture({ signals: 'SIGNAL GND\nNODE R1 1\nSIGNAL POWER\nNODE R1 1' }), 'parse.error.pinMultipleNets'],
    ['orphan NODE', fixture({ signals: 'NODE R1 1' }), 'parse.error.nodeWithoutSignal'],
    ['no pins', fixture({ shape: 'RECTANGLE 0 0 1 1' }), 'parse.error.noPins'],
  ])('rejects %s with an actionable, structured error', (_label, text, key, params) => {
    let thrown: unknown;
    try { parseGenCad(text, 'bad.cad'); } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(GenCadParseError);
    const issue = (thrown as GenCadParseError).issue;
    expect(issue.key).toBe(key);
    if (params) expect(issue.params).toMatchObject(params);
    // The same failure is renderable in every language without leftover placeholders.
    for (const language of LANGUAGES) expect(formatIssue(language, issue)).not.toMatch(/\{\w+\}/);
  });
});

describe('output budget and contour robustness', () => {
  /** One shape with `shapePins` pins placed `placements` times: a small text that expands bilinearly. */
  const instanced = (shapePins: number, placements: number) => {
    const records = ['$HEADER', 'GENCAD 1.4', 'UNITS MM', '$ENDHEADER', '$PADS', 'PAD P RECTANGULAR -1', 'RECTANGLE -0.1 -0.1 0.2 0.2', '$ENDPADS',
      '$PADSTACKS', 'PADSTACK PS 0', 'PAD P TOP 0 0', '$ENDPADSTACKS', '$SHAPES', 'SHAPE S'];
    for (let index = 0; index < shapePins; index++) records.push(`PIN ${index + 1} PS 0 0 TOP 0 0`);
    records.push('$ENDSHAPES', '$COMPONENTS');
    for (let index = 0; index < placements; index++) records.push(`COMPONENT U${index + 1}`, 'PLACE 0 0', 'SHAPE S 0 0');
    records.push('$ENDCOMPONENTS');
    return records.join('\n') + '\n';
  };

  it('rejects shape instancing whose planned pin count exceeds the budget before expanding it (B22)', () => {
    expect(GENCAD_LIMITS).toEqual({ components: 250_000, pins: 1_000_000, geometryPoints: 8_000_000, lines: 8_000_000 });
    expect(parseGenCad(instanced(8, 8), 'control.cad').pins).toHaveLength(64);
    let thrown: unknown;
    try { parseGenCad(instanced(5000, 201), 'expansion.cad'); } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(GenCadParseError);
    expect((thrown as GenCadParseError).issue.key).toBe('parse.error.tooManyRecords');
    // 126 KiB of text planning 1,005,000 pins must fail during preflight, not after allocating them: the refusal costs less than reading the same text
    // and expanding a fifth of it (100,000 pins, within the budget); expanding all of it first costs about ten times that.
    const refused = instanced(5000, 201), expanded = instanced(5000, 20);
    expect(parseGenCad(expanded, 'expanded.cad').pins).toHaveLength(100_000);
    expectCostAtMost('refusing 1,005,000 planned pins', catching(() => parseGenCad(refused, 'expansion.cad')), () => parseGenCad(expanded, 'expanded.cad'), 1);
  });

  it('reads a file of more than half a million physical lines and 200,000 round pads: the line cap no longer stops the documented budgets', () => {
    // 100,000 two-pin components of six records each are 600,000 lines of component records before the fixed sections;
    // the round pad is resolved once, so 200,000 pins plan 800,000 body points, not a sampled circle each.
    const count = 100_000;
    const components = Array.from({ length: count }, (_, index) => `COMPONENT U${index}\nPLACE ${index % 500} ${Math.floor(index / 500)}\nLAYER TOP\nROTATION 0\nSHAPE S 0 0\nDEVICE D`).join('\n');
    const text = fixture({ component: components, signals: 'SIGNAL GND\nNODE U0 1\nSIGNAL VCC\nNODE U99999 2' });
    expect(text.split('\n').length).toBeGreaterThan(500_000);
    const board = parseGenCad(text, 'wide.cad');
    expect(board.components).toHaveLength(count);
    expect(board.pins).toHaveLength(2 * count);
    expect(board.pins[0]).toMatchObject({ shape: 'round', radius: 0.2 });
    expect(board.nets.map(net => [net.name, net.pinIds.length])).toEqual([['GND', 1], ['VCC', 1]]);
  });

  it('plans outlines, bodies and pad corners against the geometry budget before expanding any placement', () => {
    const body = Array.from({ length: 1000 }, (_, index) => `LINE ${index} 0 ${index + 1} 0`).join('\n');
    const placed = (count: number) => fixture({ shape: `${body}\nPIN 1 PS 0 0 TOP 0 0`, component: Array.from({ length: count }, (_, index) => `COMPONENT U${index}\nPLACE 0 0\nLAYER TOP\nSHAPE S 0 0`).join('\n'), signals: 'SIGNAL GND\nNODE U0 1' });
    expect(parseGenCad(placed(10), 'bodies.cad').components).toHaveLength(10);
    // 2,000 body points placed twice per component: 2,001 placements plan 8,004,000 points, above the 8,000,000 budget.
    let thrown: unknown;
    try { parseGenCad(placed(2001), 'bodies.cad'); } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(GenCadParseError);
    expect((thrown as GenCadParseError).issue.key).toBe('parse.error.tooManyRecords');
    // Refusing the plan costs less than expanding a fifth of it (400 placements, 1.6 million points, within the budget); expanding all of it first costs about five times that.
    const refused = placed(2001), expanded = placed(400);
    expect(parseGenCad(expanded, 'bodies.cad').components).toHaveLength(400);
    expectCostAtMost('refusing 8,004,000 planned points', catching(() => parseGenCad(refused, 'bodies.cad')), () => parseGenCad(expanded, 'bodies.cad'), 1);
  });

  it('still refuses a file above the line cap before reading any record', () => {
    const flood = `$HEADER\n${'\n'.repeat(GENCAD_LIMITS.lines)}$ENDHEADER\n`;
    let thrown: unknown;
    try { parseGenCad(flood, 'flood.cad'); } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(GenCadParseError);
    expect((thrown as GenCadParseError).issue.key).toBe('parse.error.tooManyRecords');
    // The refusal is the split into lines and a length test: it costs about as much as the plain split of the same text and not a multiple of it.
    expectCostAtMost('refusing a flood of lines', catching(() => parseGenCad(flood, 'flood.cad')), () => flood.split(/\r\n|\n|\r/), 3);
  });

  it('chains an outline of thousands of identical segments in time that grows linearly (the fuzzer found 6,000 of them to take hours)', () => {
    const board = (count: number) => fixture({ board: `ARC 0 -10 0 10 0 0\n${'LINE 0 10 0 -10\n'.repeat(count)}` });
    const reference = parseGenCad(board(1), 'coincident.cad').outline;
    expect(reference.length).toBeGreaterThan(8);
    for (const count of [2, 50, 500]) {
      const result = parseGenCad(board(count), 'coincident.cad');
      expect(result.outline, `${count} copies`).toEqual(reference);
      expect(result.warnings.map(warning => warning.key), `${count} copies`).toContain('parse.warning.boardCutouts');
    }
    expectScaling('coincident outline segments', [250, 1000, 4000], count => { const text = board(count); return () => parseGenCad(text, 'coincident.cad'); });
    expectScaling('coincident segments of a shape', [250, 1000, 4000], count => { const text = fixture({ shape: `ARC 0 -10 0 10 0 0\n${'LINE 0 10 0 -10\n'.repeat(count)}PIN 1 PS 0 0 TOP 0 0` }); return () => parseGenCad(text, 'coincident.cad'); });
  });

  it('chains a long outline listed in any order to one closed contour in linear time, and a pile of segments at one corner is left without an outline', () => {
    // A square perimeter of n unit segments, shuffled and half of them reversed.
    const square = (n: number) => {
      const side = n / 4, lines: string[] = [];
      for (let i = 0; i < side; i++) lines.push(`LINE ${i} 0 ${i + 1} 0`, `LINE ${side} ${i} ${side} ${i + 1}`, `LINE ${side - i} ${side} ${side - i - 1} ${side}`, `LINE 0 ${side - i} 0 ${side - i - 1}`);
      let seed = 20260517;
      for (let i = lines.length - 1; i > 0; i--) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; const j = seed % (i + 1); [lines[i], lines[j]] = [lines[j], lines[i]]; }
      return lines.map((line, i) => { if (i % 2) return line; const a = line.split(' '); return `LINE ${a[3]} ${a[4]} ${a[1]} ${a[2]}`; });
    };
    const small = parseGenCad(fixture({ board: square(400).join('\n') }), 'square.cad');
    expect(small.outline).toHaveLength(401);
    expect(small.warnings.map(warning => warning.key)).not.toContain('parse.warning.missingBoardOutline');
    expectScaling('long outline', [2000, 8000, 32_000], n => { const text = fixture({ board: square(n).join('\n') }); return () => parseGenCad(text, 'square.cad'); });
    // More than the work budget of the chaining: thousands of segments at one corner and thousands more 0.000012 mm away from it, which are
    // neighbours in the hash but not the same point. No outline is built, the bounding box is drawn, and it costs no more than a clean outline of as many segments (within a factor).
    const pile = fixture({ board: `${'LINE 0 0 5 5\n'.repeat(3000)}${'LINE -0.000012 0 9 9\n'.repeat(3000)}` });
    const drawn = parseGenCad(pile, 'pile.cad');
    expect(drawn.warnings.map(warning => warning.key)).toContain('parse.warning.missingBoardOutline');
    expect(drawn.outline).toHaveLength(5);
    const clean = fixture({ board: square(6000).join('\n') });
    expectCostAtMost('a pile of segments at one corner', () => parseGenCad(pile, 'pile.cad'), () => parseGenCad(clean, 'square.cad'), 20);
  });

  const rectangle = ['LINE 0 0 40 0', 'LINE 40 0 40 30', 'LINE 40 30 0 30', 'LINE 0 30 0 0'];
  const reversed = rectangle.map(line => { const a = line.split(' '); return `LINE ${a[3]} ${a[4]} ${a[1]} ${a[2]}`; });
  it.each([
    ['ordered', rectangle],
    ['reversed', reversed],
    ['shuffled and partially reversed', [reversed[2], rectangle[0], reversed[3], rectangle[1]]],
    ['leading dangling branch', ['LINE -5 0 0 0', ...rectangle]],
    ['leading reversed dangling branch', ['LINE 0 0 -5 0', ...rectangle]],
    ['trailing dangling branch', [...rectangle, 'LINE -5 0 0 0']],
    ['leading branch before a pre-closed RECTANGLE', ['LINE -5 0 0 0', 'RECTANGLE 0 0 40 30']],
    ['two-segment spur sharing a corner', ['LINE 0 0 -5 0', 'LINE -5 0 -5 5', ...rectangle]],
    ['outer rectangle with a reversed inner cutout', [...rectangle, 'LINE 10 10 10 15', 'LINE 10 15 15 15', 'LINE 15 15 15 10', 'LINE 15 10 10 10']],
    ['two disjoint panels', [...rectangle, 'RECTANGLE 50 50 5 5']],
  ])('keeps the largest closed board contour with %s edges (B20)', (_label, lines) => {
    const board = parse({ board: lines.join('\n') });
    expect(board.warnings.map(warning => warning.key)).not.toContain('parse.warning.missingBoardOutline');
    const xs = board.outline.map(p => p.x), ys = board.outline.map(p => p.y);
    expect([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]).toEqual([0, 0, 40, 30]);
  });

  it('discloses pruned branches and inner contours instead of drawing them', () => {
    expect(parse({ board: [...rectangle, 'LINE -5 0 0 0'].join('\n') }).warnings).toContainEqual({ key: 'parse.warning.boardCutouts' });
    expect(parse({ board: rectangle.join('\n') }).warnings).not.toContainEqual({ key: 'parse.warning.boardCutouts' });
  });

  it('still reports an open chain as a missing outline instead of fabricating a closure', () => {
    const board = parse({ board: 'LINE 0 0 40 0\nLINE 40 0 40 30' });
    expect(board.warnings).toContainEqual({ key: 'parse.warning.missingBoardOutline' });
  });
});

// The user's board stays outside the project and is never bundled or committed.
const externalBoardPath = process.env.TRACE_TEST_BOARD;
describe.skipIf(!externalBoardPath)('external production GENCAD board', () => {
  it('imports the supplied production board with all pins and net links', () => {
    const board = parseGenCad(readFileSync(externalBoardPath!, 'utf8'), 'external-board.cad');
    expect(board.components.length).toBeGreaterThan(0); expect(board.pins.length).toBeGreaterThan(0);
    const expected = process.env.TRACE_EXPECT_COUNTS;
    if (expected) {
      const counts = expected.split(',').map(Number);
      expect(counts).toHaveLength(3);
      expect(counts.every(n => Number.isInteger(n) && n >= 0)).toBe(true);
      expect([board.components.length, board.pins.length, board.nets.length]).toEqual(counts);
    }
    expect(Object.values(board.bounds).every(Number.isFinite)).toBe(true);
    expect(board.bounds.maxX).toBeGreaterThan(board.bounds.minX);
    expect(board.bounds.maxY).toBeGreaterThan(board.bounds.minY);
    expect(board.pins.every(p => Number.isFinite(p.x) && Number.isFinite(p.y))).toBe(true);
    const componentIds = new Set(board.components.map(c => c.id));
    const pins = new Map(board.pins.map(p => [p.id, p]));
    expect(componentIds.size).toBe(board.components.length);
    expect(pins.size).toBe(board.pins.length);
    expect(board.pins.every(p => componentIds.has(p.componentId))).toBe(true);
    for (const net of board.nets) {
      expect(net.pinIds.every(id => pins.get(id)?.net === net.name)).toBe(true);
    }
  });
});
