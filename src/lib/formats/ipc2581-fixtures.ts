/*
 * Original TRACE module (MIT). Writer side of the IPC-2581 tests: builds small synthetic IPC-2581 documents from a plain
 * description, laid out like the files open tools write (Content, LogisticHeader, HistoryRecord, Bom, Ecad with
 * CadHeader and one or more Steps). No real board, vendor file or specification text is used. Test-only: nothing in
 * the application imports it.
 */

export interface FixturePin { number?: string; name?: string; x: number; y: number; type?: string; electricalType?: string; rotation?: number; mirror?: boolean; shape?: string; user?: string; inline?: string }
export interface FixturePackage { name: string; pins: FixturePin[]; outline?: Array<[number, number]>; extra?: string }
export interface FixtureComponent { ref?: string; pkg: string; x: number; y: number; rotation?: number; mirror?: boolean; layer?: string; mountType?: string; part?: string; scale?: number; xOffset?: number; yOffset?: number }
export interface FixtureNet { name: string; pins: Array<[string, string]> }
export interface FixtureCopperPad { x: number; y: number; ref: string; pin: string; rotation?: number; shape?: string; padstack?: string }
export interface FixtureCopper { layer: string; net?: string; pads: FixtureCopperPad[]; traces?: number }
export interface FixtureLayer { name: string; fn: string; side?: string }
export interface FixtureBomItem { refs: string[]; value?: string; packageRef?: string; populate?: boolean; measured?: [string, string] }
export interface FixtureStep {
  name: string; type?: string; packages: FixturePackage[]; components: FixtureComponent[];
  logicalNets?: FixtureNet[]; physicalNets?: Array<{ name: string; points: Array<[number, number]> }>; copper?: FixtureCopper[];
  /** Outer contour; null leaves the Profile out. Each point may carry an arc to it: [x, y, centerX, centerY, clockwise]. */
  profile?: Array<[number, number] | [number, number, number, number, boolean]> | null;
  cutouts?: Array<Array<[number, number]>>;
  /** Board-outline layer features (raw XML inside one Set/Features), written on the layer named OUTLINE. */
  outlineFeatures?: string;
  padstacks?: string;
  extra?: string;
}
export interface FixtureBoard {
  revision?: string | null;
  namespace?: boolean;
  /** Prefix for every element name (namespace-prefixed documents), e.g. "ipc". */
  prefix?: string;
  units?: string | null;
  dictionaryUnits?: string;
  functionMode?: string;
  prolog?: string;
  dictionary?: Record<string, string>;
  userDictionary?: Record<string, string>;
  layers?: FixtureLayer[] | null;
  bom?: FixtureBomItem[] | null;
  steps: FixtureStep[];
  stepRefs?: string[];
  /** Raw XML appended inside the root after Ecad (for hostile or unusual content). */
  tail?: string;
}

export const DEFAULT_LAYERS: FixtureLayer[] = [
  { name: 'TOP', fn: 'CONDUCTOR', side: 'TOP' },
  { name: 'BOTTOM', fn: 'CONDUCTOR', side: 'BOTTOM' },
  { name: 'SILK_TOP', fn: 'SILKSCREEN', side: 'TOP' },
  { name: 'OUTLINE', fn: 'BOARD_OUTLINE', side: 'ALL' },
];
export const DEFAULT_DICTIONARY: Record<string, string> = {
  RECT_1: '<RectCenter width="1.0" height="0.6"/>',
  CIRCLE_1: '<Circle diameter="1.6"/>',
  SQUARE_1: '<RectCenter width="1.6" height="1.6"/>',
};

const escape = (value: string): string => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const fmt = (value: number): string => Number.isInteger(value) ? `${value}.0` : String(value);

/** One IPC-2581 document as text. */
export function ipc2581Xml(board: FixtureBoard): string {
  const p = board.prefix ? `${board.prefix}:` : '';
  const tag = (name: string, attrs: Record<string, string | number | boolean | undefined> = {}, body?: string): string => {
    const list = Object.entries(attrs).filter(([, value]) => value !== undefined).map(([key, value]) => ` ${key}="${typeof value === 'number' ? fmt(value) : escape(String(value))}"`).join('');
    return body === undefined ? `<${p}${name}${list}/>` : `<${p}${name}${list}>${body}</${p}${name}>`;
  };
  const revision = board.revision === undefined ? 'C' : board.revision;
  const ns = board.namespace === false ? {} : board.prefix ? { [`xmlns:${board.prefix}`]: 'http://webstds.ipc.org/2581' } : { xmlns: 'http://webstds.ipc.org/2581' };
  const layers = board.layers === null ? [] : board.layers ?? DEFAULT_LAYERS;
  const dictionary = board.dictionary ?? DEFAULT_DICTIONARY;
  const units = board.units === undefined ? 'MILLIMETER' : board.units;
  const dictionaryUnits = board.dictionaryUnits ?? units ?? undefined;
  const poly = (points: FixtureStep['profile'] & object, element = 'Polygon'): string => tag(element, {}, points.map((point, index) => {
    if (index === 0) return tag('PolyBegin', { x: point[0], y: point[1] });
    return point.length === 5 ? tag('PolyStepCurve', { x: point[0], y: point[1], centerX: point[2], centerY: point[3], clockwise: point[4] }) : tag('PolyStepSegment', { x: point[0], y: point[1] });
  }).join(''));
  const step = (s: FixtureStep): string => {
    const packages = s.packages.map(pkg => tag('Package', { name: pkg.name, type: 'OTHER', pinOne: '1' }, [
      pkg.outline ? tag('Outline', {}, poly([...pkg.outline, pkg.outline[0]]) + tag('LineDesc', { lineWidth: 0.1, lineEnd: 'ROUND' })) : '',
      tag('PickupPoint', { x: 0, y: 0 }),
      tag('SilkScreen', {}, tag('Marking', { markingUsage: 'NONE' }, tag('UserSpecial', {}, tag('Line', { startX: -1, startY: 1, endX: 1, endY: 1 }, tag('LineDesc', { lineWidth: 0.12 }))))),
      pkg.extra ?? '',
      ...pkg.pins.map(pin => tag('Pin', { number: pin.number, name: pin.name, type: pin.type ?? 'SURFACE', electricalType: pin.electricalType ?? 'ELECTRICAL' }, [
        pin.rotation !== undefined || pin.mirror ? tag('Xform', { rotation: pin.rotation, mirror: pin.mirror || undefined }) : '',
        tag('Location', { x: pin.x, y: pin.y }),
        pin.inline ?? (pin.user ? tag('UserPrimitiveRef', { id: pin.user }) : pin.shape === '' ? '' : tag('StandardPrimitiveRef', { id: pin.shape ?? 'RECT_1' })),
      ].join(''))),
    ].join(''))).join('');
    const components = s.components.map(c => tag('Component', { refDes: c.ref, packageRef: c.pkg, part: c.part ?? `${c.pkg}_PART`, layerRef: c.layer ?? (c.mirror ? 'BOTTOM' : 'TOP'), mountType: c.mountType ?? 'SMT' },
      (c.rotation !== undefined || c.mirror || c.scale !== undefined || c.xOffset !== undefined || c.yOffset !== undefined ? tag('Xform', { rotation: c.rotation, mirror: c.mirror || undefined, scale: c.scale, xOffset: c.xOffset, yOffset: c.yOffset }) : '') + tag('Location', { x: c.x, y: c.y }))).join('');
    const logical = (s.logicalNets ?? []).map(net => tag('LogicalNet', { name: net.name }, net.pins.map(([ref, pin]) => tag('PinRef', { componentRef: ref, pin })).join(''))).join('');
    const physical = s.physicalNets?.length ? tag('PhyNetGroup', { name: 'PHY' }, s.physicalNets.map(net => tag('PhyNet', { name: net.name }, net.points.map(([x, y]) => tag('PhyNetPoint', { x, y, layerRef: 'TOP', netNode: 'END', exposure: 'EXPOSED' })).join(''))).join('')) : '';
    const copper = (s.copper ?? []).map(set => tag('LayerFeature', { layerRef: set.layer }, tag('Set', { net: set.net }, [
      ...set.pads.map(pad => tag('Pad', { padstackDefRef: pad.padstack }, (pad.rotation !== undefined ? tag('Xform', { rotation: pad.rotation }) : '') + tag('Location', { x: pad.x, y: pad.y }) + (pad.shape === '' ? '' : tag('StandardPrimitiveRef', { id: pad.shape ?? 'RECT_1' })) + tag('PinRef', { componentRef: pad.ref, pin: pad.pin }))),
      set.traces ? tag('Features', {}, tag('UserSpecial', {}, Array.from({ length: set.traces }, (_, index) => tag('Line', { startX: index, startY: 0, endX: index + 1, endY: 0 }, tag('LineDesc', { lineWidth: 0.2 }))).join(''))) : '',
    ].join('')))).join('');
    const profile = s.profile === null ? '' : tag('Profile', {}, poly(s.profile ?? [[0, 0], [50, 0], [50, 40], [0, 40], [0, 0]]) + (s.cutouts ?? []).map(cut => poly([...cut, cut[0]], 'Cutout')).join(''));
    const outline = s.outlineFeatures ? tag('LayerFeature', { layerRef: 'OUTLINE' }, tag('Set', {}, tag('Features', {}, s.outlineFeatures))) : '';
    return tag('Step', { name: s.name, type: s.type ?? 'BOARD' }, [s.padstacks ?? '', tag('Datum', { x: 0, y: 0 }), profile, packages, components, logical, physical, copper, outline, s.extra ?? ''].join(''));
  };
  const bom = board.bom === null || !board.bom?.length ? '' : tag('Bom', { name: 'BOM_1' }, tag('BomHeader', { assembly: 'ASSY', revision: '1.0' }, tag('StepRef', { name: board.steps[0]?.name ?? 'board' })) + board.bom.map(item => tag('BomItem', { OEMDesignNumberRef: `${item.refs[0]}_ITEM`, quantity: item.refs.length, category: 'ELECTRICAL' }, [
    ...item.refs.map(ref => tag('RefDes', { name: ref, packageRef: item.packageRef ?? 'PKG', populate: item.populate === false ? 'false' : 'true', layerRef: 'TOP' })),
    tag('Characteristics', { category: 'ELECTRICAL' }, (item.value !== undefined ? tag('Textual', { definitionSource: 'SYNTHETIC', textualCharacteristicName: 'Value', textualCharacteristicValue: item.value }) : '')
      + (item.measured ? tag('Measured', { measuredCharacteristicName: 'RESISTANCE', measuredCharacteristicValue: item.measured[0], engineeringUnitOfMeasure: item.measured[1] }) : '')),
  ].join(''))).join(''));
  const content = tag('Content', { roleRef: 'Owner' }, [
    tag('FunctionMode', { mode: board.functionMode ?? 'ASSEMBLY', level: revision === 'B' ? '3' : undefined }),
    ...(board.stepRefs ?? board.steps.map(s => s.name)).map(name => tag('StepRef', { name })),
    ...layers.map(layer => tag('LayerRef', { name: layer.name })),
    tag('DictionaryStandard', { units: dictionaryUnits }, Object.entries(dictionary).map(([id, body]) => tag('EntryStandard', { id }, body)).join('')),
    board.userDictionary ? tag('DictionaryUser', { units: dictionaryUnits }, Object.entries(board.userDictionary).map(([id, body]) => tag('EntryUser', { id }, body)).join('')) : '',
    tag('DictionaryLineDesc', { units: dictionaryUnits }, tag('EntryLineDesc', { id: 'LINE_1' }, tag('LineDesc', { lineWidth: 0.1, lineEnd: 'ROUND' }))),
  ].join(''));
  const header = tag('LogisticHeader', {}, tag('Role', { id: 'Owner', roleFunction: 'SENDER' }) + tag('Enterprise', { id: 'NONE', code: 'NONE' }) + tag('Person', { name: 'NONE', enterpriseRef: 'NONE', roleRef: 'Owner' }));
  const history = tag('HistoryRecord', { number: '1', origination: '2026-01-01T00:00:00', software: 'synthetic writer', lastChange: '2026-01-01T00:00:00' }, tag('FileRevision', { fileRevisionId: '1', comment: '', label: '' }, tag('SoftwarePackage', { name: 'synthetic', revision: '1', vendor: 'none' }, tag('Certification', { certificationStatus: 'SELFTEST' }))));
  const ecad = tag('Ecad', { name: 'Design' }, (units === null ? '' : tag('CadHeader', { units }, tag('Spec', { name: 'S1' }, tag('General', { type: 'MATERIAL' }, tag('Property', { text: 'COPPER' }))))) + tag('CadData', {}, [
    ...layers.map(layer => tag('Layer', { name: layer.name, layerFunction: layer.fn, side: layer.side, polarity: 'POSITIVE' })),
    tag('Stackup', { name: 'STACK', overallThickness: 1.6 }, tag('StackupGroup', { name: 'G', thickness: 1.6 }, layers.map((layer, index) => tag('StackupLayer', { layerOrGroupRef: layer.name, thickness: 0.035, sequence: index })).join(''))),
    ...board.steps.map(step),
  ].join('')));
  const root = tag('IPC-2581', { revision: revision ?? undefined, ...ns }, [content, header, history, bom, ecad, board.tail ?? ''].join('\n'));
  return `${board.prolog ?? '<?xml version="1.0" encoding="UTF-8"?>\n'}${root}\n`;
}

/** A canonical two-sided test board: two top resistors (one rotated 90°), a bottom-side mirrored capacitor and a through-hole connector. */
export function canonicalBoard(overrides: Partial<FixtureBoard> = {}, stepOverrides: Partial<FixtureStep> = {}): FixtureBoard {
  return {
    bom: [{ refs: ['R1', 'R2'], value: '10k', packageRef: 'R0603' }, { refs: ['C1'], value: '100nF', packageRef: 'C0402' }, { refs: ['J1'], value: 'CONN_2', packageRef: 'HDR2' }],
    steps: [{
      name: 'board',
      packages: [
        { name: 'R0603_1', outline: [[-1.5, -0.8], [1.5, -0.8], [1.5, 0.8], [-1.5, 0.8]], pins: [{ number: '1', x: -0.8, y: 0 }, { number: '2', x: 0.8, y: 0 }] },
        { name: 'C0402_2', outline: [[-1, -0.5], [1, -0.5], [1, 0.5], [-1, 0.5]], pins: [{ number: '1', x: -0.5, y: 0 }, { number: '2', x: 0.5, y: 0.25 }] },
        { name: 'HDR2_3', outline: [[-1.5, -1.5], [4, -1.5], [4, 1.5], [-1.5, 1.5]], pins: [{ number: '1', x: 0, y: 0, type: 'THRU', shape: 'SQUARE_1' }, { number: '2', x: 2.54, y: 0, type: 'THRU', shape: 'CIRCLE_1' }] },
      ],
      components: [
        { ref: 'R1', pkg: 'R0603_1', x: 10, y: 10 },
        { ref: 'R2', pkg: 'R0603_1', x: 20, y: 10, rotation: 90 },
        { ref: 'C1', pkg: 'C0402_2', x: 30, y: 20, rotation: 90, mirror: true },
        { ref: 'J1', pkg: 'HDR2_3', x: 5, y: 30, mountType: 'THMT' },
      ],
      logicalNets: [
        { name: 'VCC', pins: [['R1', '1'], ['J1', '1'], ['C1', '1']] },
        { name: 'GND', pins: [['R2', '2'], ['J1', '2'], ['C1', '2']] },
        { name: 'MID', pins: [['R1', '2'], ['R2', '1']] },
      ],
      ...stepOverrides,
    }],
    ...overrides,
  };
}

/** A larger synthetic board for timing tests: `count` components of `pinsPerPart` pins in a grid, every pin on a conductor pad with a net, plus trace noise. */
export function gridBoard(count: number, pinsPerPart: number, tracesPerNet = 4): FixtureBoard {
  const pins = Array.from({ length: pinsPerPart }, (_, index) => ({ number: String(index + 1), x: (index % 8) * 0.5 - 1.75, y: Math.floor(index / 8) * 0.5 }));
  const components: FixtureComponent[] = [], copper: FixtureCopper[] = [];
  const nets = new Map<string, FixtureCopperPad[]>();
  for (let index = 0; index < count; index++) {
    const x = (index % 100) * 6 + 5, y = Math.floor(index / 100) * 6 + 5, ref = `U${index + 1}`;
    components.push({ ref, pkg: 'GRID', x, y, rotation: (index % 4) * 90 });
    pins.forEach((pin, pinIndex) => {
      const [c, s] = [[1, 0], [0, 1], [-1, 0], [0, -1]][index % 4];
      const net = `N${(index * pinsPerPart + pinIndex) % Math.max(1, Math.floor(count * pinsPerPart / 3))}`;
      const list = nets.get(net) ?? []; list.push({ x: x + pin.x * c - pin.y * s, y: y + pin.x * s + pin.y * c, ref, pin: pin.number }); nets.set(net, list);
    });
  }
  for (const [net, pads] of nets) copper.push({ layer: 'TOP', net, pads, traces: tracesPerNet });
  return { bom: null, steps: [{ name: 'grid', packages: [{ name: 'GRID', pins, outline: [[-2.5, -0.5], [2.5, -0.5], [2.5, 4], [-2.5, 4]] }], components, copper, profile: [[0, 0], [610, 0], [610, Math.ceil(count / 100) * 6 + 10], [0, Math.ceil(count / 100) * 6 + 10], [0, 0]] }] };
}
