'use strict';

/*
 * Deterministic synthetic board generator: writes GenCAD 1.4 text that TRACE reads with its normal GenCAD adapter, so
 * performance can be measured without a private board.
 *
 *   node scripts/gen-synthetic-board.cjs --pins=100k [--seed=1] [--out=board.cad]
 *   node scripts/gen-synthetic-board.cjs --sizes=10k,50k,100k,250k,1m --out-dir=test-results/synthetic-boards
 *
 * Why GenCAD: shape instancing keeps a board compact (about 40 bytes per pin including its net record), so 1,000,000 pins
 * (the adapter limit) fit inside the 64 MiB import limit; BVR3 writes seven lines per pin (about 100 bytes) and cannot
 * reach that size.
 *
 * Design
 *  - Seeded (mulberry32 over an integer hash) and integer-first: the same seed and pin count always give the same bytes.
 *  - Two phases. The plan phase decides the modules (an anchor part with its passives around it) and packs them onto a
 *    board; it holds only one small record per module. The write phase then streams the text through a sink in chunks of
 *    about 0.5 MiB, one module at a time; the only per-pin state is a few typed arrays (about 40 bytes per pin), so peak
 *    memory stays flat in the size of the output.
 *  - A module is a BGA, QFN/QFP/SOIC/SOT IC or connector with decoupling caps, resistors, ferrites, inductors, diodes and
 *    test points around it (rings on the anchor's side) and under it (grid on the opposite side); a few islands of larger
 *    0603 parts stand alone. About 40 % of the pins belong to passives, 40 % to BGAs (64 to 2,500 balls), the rest to small
 *    ICs and connectors; about 30 % of the pins and half of the parts are on the bottom.
 *  - Nets: one large GND net (about 30 % of the pins), 10 to 80 power rails (about 15 % of the pins, a skewed size
 *    distribution), signal nets of 2 to 5 pins (a few buses up to 16 pins) built from spatial neighbours first and from the
 *    leftovers second, and about 3 % unconnected pins. Through-hole headers show their pins on both sides.
 */

const fs = require('node:fs');
const path = require('node:path');

const GENERATOR = 'trace-synthetic-board';
const GENERATOR_VERSION = 1;
const FORMAT = 'GENCAD 1.4';

/** The named sizes of the benchmark. */
const SIZES = Object.freeze({ '10k': 10_000, '50k': 50_000, '100k': 100_000, '250k': 250_000, '1m': 1_000_000 });

/** What the GenCAD adapter accepts (src/lib/gencad.ts GENCAD_LIMITS, 64 MiB import limit); a unit test keeps these equal to the adapter's. */
const LIMITS = Object.freeze({ components: 250_000, pins: 1_000_000, geometryPoints: 8_000_000, lines: 8_000_000, bytes: 64 * 1024 * 1024 });

const SEED_DEFAULT = 1;
/** Where generated boards are cached (ignored by git). */
const DEFAULT_DIR = path.resolve(__dirname, '..', 'test-results', 'synthetic-boards');
const CHUNK_CHARS = 1 << 19;
const PIN_INDEX_RANGE = 1 << 20; // a pin index is below this (1,000,000 pins); the sort key packs the spatial cell above it

function parseSize(text) {
  const value = String(text).trim().toLowerCase();
  if (Object.hasOwn(SIZES, value)) return SIZES[value];
  const match = /^(\d+(?:\.\d+)?)([km]?)$/.exec(value);
  if (!match) throw new RangeError(`Pin count "${text}" is not a number such as 10000, 100k or 1m.`);
  const pins = Math.round(Number(match[1]) * (match[2] === 'm' ? 1_000_000 : match[2] === 'k' ? 1_000 : 1));
  if (!Number.isSafeInteger(pins) || pins < 2 || pins > LIMITS.pins) throw new RangeError(`Pin count ${pins} is outside 2 to ${LIMITS.pins}.`);
  return pins;
}

function sizeLabel(pins) {
  for (const [label, value] of Object.entries(SIZES)) if (value === pins) return label;
  return String(pins);
}

// ---------------------------------------------------------------------------------------------------------------
// Random numbers and formatting (integer arithmetic only, so every platform produces the same stream)
// ---------------------------------------------------------------------------------------------------------------

function hash32(a, b, c) {
  let h = Math.imul((a >>> 0) ^ 0x9e3779b9, 0x85ebca6b);
  h ^= h >>> 15;
  h = Math.imul(h ^ ((b >>> 0) + 0x7f4a7c15), 0xc2b2ae35);
  h ^= h >>> 13;
  h = Math.imul(h ^ ((c >>> 0) + 0x165667b1), 0x27d4eb2f);
  h ^= h >>> 16;
  return h >>> 0;
}

/** mulberry32: returns a function giving floats in [0, 1). */
function rng(seed) {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const below = (rand, n) => Math.floor(rand() * n);

/** Cumulative table for a weighted pick; `pickWeighted` gives an index. */
function cumulative(weights) {
  let total = 0;
  const table = weights.map(weight => (total += weight));
  return { table, total };
}
function pickWeighted(rand, cum) {
  const x = rand() * cum.total;
  let low = 0, high = cum.table.length - 1;
  while (low < high) { const mid = (low + high) >> 1; if (cum.table[mid] > x) high = mid; else low = mid + 1; }
  return low;
}

/** Millimetres with at most three decimals (micrometre resolution), no exponent, no negative zero. */
function mm(value) {
  const rounded = Math.round(value * 1000) / 1000;
  return rounded === 0 ? '0' : String(rounded);
}

// ---------------------------------------------------------------------------------------------------------------
// Footprint catalog
// ---------------------------------------------------------------------------------------------------------------

const BGA_ROWS = 'ABCDEFGHJKLMNPRTUVWY';
function rowLabel(row) {
  let n = row, text = '';
  do { text = BGA_ROWS[n % BGA_ROWS.length] + text; n = Math.floor(n / BGA_ROWS.length) - 1; } while (n >= 0);
  return text;
}

const padRect = (w, h) => ({ name: `PR${mm(w)}x${mm(h)}`, type: 'RECTANGULAR', w, h });
const padRound = d => ({ name: `PC${mm(d)}`, type: 'ROUND', d });
const stackFor = (pad, through = false, drill = 0) => ({ name: `${through ? 'ST' : 'SS'}_${pad.name}`, pad, through, drill });

/**
 * A footprint. `stacks` lists the padstacks the pins use; `stackOf[i]` names the one of pin i. `role` is how the anchor's pins are
 * split into ground, power, no-connect and signal pins (see roleOf). `halfW`/`halfH` are the half extents of the body with its pads.
 */
function makeShape(spec) {
  const count = spec.numbers.length;
  const stackOf = new Uint8Array(count);
  if (spec.epIndex !== undefined) stackOf[spec.epIndex] = 1;
  let halfW = 0, halfH = 0;
  for (let i = 0; i < count; i++) {
    const pad = spec.stacks[stackOf[i]].pad;
    const w = pad.type === 'ROUND' ? pad.d : (spec.rotated?.[i] ? pad.h : pad.w);
    const h = pad.type === 'ROUND' ? pad.d : (spec.rotated?.[i] ? pad.w : pad.h);
    halfW = Math.max(halfW, Math.abs(spec.xs[i]) + w / 2);
    halfH = Math.max(halfH, Math.abs(spec.ys[i]) + h / 2);
  }
  const bodyW = spec.bodyW ?? 2 * halfW + 0.4, bodyH = spec.bodyH ?? 2 * halfH + 0.4;
  return {
    name: spec.name, kind: spec.kind, family: spec.family, count, numbers: spec.numbers, xs: spec.xs, ys: spec.ys,
    rotated: spec.rotated, stacks: spec.stacks, stackOf, through: spec.through === true, epIndex: spec.epIndex,
    halfW: Math.max(halfW, bodyW / 2), halfH: Math.max(halfH, bodyH / 2), bodyW, bodyH,
    role: spec.role, rows: spec.rows, cols: spec.cols, devices: [],
  };
}

function passive(name, padW, padH, pitch) {
  const pad = padRect(padW, padH);
  return makeShape({
    name, kind: 'passive', family: 'passive', numbers: ['1', '2'], xs: [-pitch / 2, pitch / 2], ys: [0, 0], stacks: [stackFor(pad)],
    bodyW: pitch + padW + 0.2, bodyH: padH + 0.2,
  });
}

function testPoint(name) {
  return makeShape({ name, kind: 'testpoint', family: 'passive', numbers: ['1'], xs: [0], ys: [0], stacks: [stackFor(padRound(0.9))], bodyW: 1.3, bodyH: 1.3 });
}

/** Two rows of pins, pin 1 at the bottom left, numbered along the bottom row and back along the top row (SOIC, TSSOP, SOT, edge connectors). */
function dualRow(name, kind, family, count, pitch, span, padW, padH, role) {
  const bottom = Math.ceil(count / 2), top = count - bottom;
  const numbers = [], xs = [], ys = [];
  for (let i = 0; i < bottom; i++) { numbers.push(String(i + 1)); xs.push((i - (bottom - 1) / 2) * pitch); ys.push(-span / 2); }
  for (let i = 0; i < top; i++) { numbers.push(String(bottom + i + 1)); xs.push(((top - 1) / 2 - i) * pitch); ys.push(span / 2); }
  return makeShape({ name, kind, family, numbers, xs, ys, stacks: [stackFor(padRect(padW, padH))], role });
}

function singleRow(name, count, pitch, padW, padH) {
  const numbers = [], xs = [], ys = [];
  for (let i = 0; i < count; i++) { numbers.push(String(i + 1)); xs.push((i - (count - 1) / 2) * pitch); ys.push(0); }
  return makeShape({ name, kind: 'conn', family: 'fpc', numbers, xs, ys, stacks: [stackFor(padRect(padW, padH))], bodyW: (count - 1) * pitch + 3, bodyH: padH + 2.4, role: 'conn' });
}

/** Pin header 2 x n, through-hole: a round pad on every layer, so both sides show the pins. */
function header(name, columns) {
  const pad = padRound(1.7);
  const numbers = [], xs = [], ys = [];
  for (let i = 0; i < columns; i++) {
    const x = (i - (columns - 1) / 2) * 2.54;
    numbers.push(String(2 * i + 1)); xs.push(x); ys.push(-1.27);
    numbers.push(String(2 * i + 2)); xs.push(x); ys.push(1.27);
  }
  return makeShape({ name, kind: 'conn', family: 'header', numbers, xs, ys, stacks: [stackFor(pad, true, 1)], through: true, bodyW: columns * 2.54 + 0.4, bodyH: 5.4, role: 'conn' });
}

/** Four rows of pins counter-clockwise from the top left (QFP, QFN), pads on the left and right sides turned 90 degrees; optional exposed pad. */
function quad(name, family, count, pitch, padW, padH, ep) {
  const side = count / 4;
  const span = (side - 1) * pitch + 1.2;
  const pad = padRect(padH, padW); // long along x: the left and right sides use it as is, the top and bottom sides are turned
  const numbers = [], xs = [], ys = [], rotated = [];
  const along = i => (i - (side - 1) / 2) * pitch;
  for (let i = 0; i < side; i++) { numbers.push(String(i + 1)); xs.push(-span / 2); ys.push(-along(i)); rotated.push(false); }
  for (let i = 0; i < side; i++) { numbers.push(String(side + i + 1)); xs.push(along(i)); ys.push(-span / 2); rotated.push(true); }
  for (let i = 0; i < side; i++) { numbers.push(String(2 * side + i + 1)); xs.push(span / 2); ys.push(along(i)); rotated.push(false); }
  for (let i = 0; i < side; i++) { numbers.push(String(3 * side + i + 1)); xs.push(-along(i)); ys.push(span / 2); rotated.push(true); }
  const stacks = [stackFor(pad)];
  let epIndex;
  if (ep) { epIndex = numbers.length; numbers.push('EP'); xs.push(0); ys.push(0); rotated.push(false); stacks.push(stackFor(padRect(ep, ep))); }
  return makeShape({ name, kind: 'ic', family, numbers, xs, ys, rotated, stacks, epIndex, role: 'ic' });
}

function bga(rows, cols, pitch) {
  const pad = padRound(pitch / 2);
  const numbers = [], xs = [], ys = [];
  for (let r = 0; r < rows; r++) {
    const label = rowLabel(r);
    for (let c = 0; c < cols; c++) { numbers.push(label + (c + 1)); xs.push((c - (cols - 1) / 2) * pitch); ys.push(((rows - 1) / 2 - r) * pitch); }
  }
  return makeShape({ name: `BGA${rows * cols}_${mm(pitch)}`, kind: 'bga', family: 'bga', numbers, xs, ys, stacks: [stackFor(pad)], bodyW: cols * pitch + 0.6, bodyH: rows * pitch + 0.6, role: 'bga', rows, cols });
}

const PASSIVE_SHAPES = Object.freeze({
  '0201': passive('FP_0201', 0.3, 0.3, 0.62),
  '0402': passive('FP_0402', 0.5, 0.55, 1.0),
  '0603': passive('FP_0603', 0.8, 0.95, 1.6),
});
const TEST_POINT = testPoint('FP_TP');

const IC_SHAPES = Object.freeze([
  dualRow('SOT23_3', 'ic', 'sot', 3, 0.95, 2.2, 0.6, 0.7, 'ic'),
  dualRow('SOT23_5', 'ic', 'sot', 5, 0.95, 2.2, 0.6, 0.7, 'ic'),
  dualRow('SOT23_6', 'ic', 'sot', 6, 0.95, 2.2, 0.6, 0.7, 'ic'),
  dualRow('SOIC8', 'ic', 'soic', 8, 1.27, 5.4, 0.6, 1.5, 'ic'),
  dualRow('SOIC16', 'ic', 'soic', 16, 1.27, 5.4, 0.6, 1.5, 'ic'),
  dualRow('TSSOP20', 'ic', 'tssop', 20, 0.65, 5.8, 0.4, 1.5, 'ic'),
  dualRow('TSSOP28', 'ic', 'tssop', 28, 0.65, 5.8, 0.4, 1.5, 'ic'),
  quad('QFN16', 'qfn', 16, 0.5, 0.25, 0.7, 1.7),
  quad('QFN24', 'qfn', 24, 0.5, 0.25, 0.7, 2.6),
  quad('QFN32', 'qfn', 32, 0.5, 0.25, 0.7, 3.4),
  quad('QFN48', 'qfn', 48, 0.5, 0.25, 0.7, 5.2),
  quad('QFN64', 'qfn', 64, 0.5, 0.25, 0.7, 7.2),
  quad('QFP48', 'qfp', 48, 0.5, 0.25, 1.4),
  quad('QFP64', 'qfp', 64, 0.5, 0.25, 1.4),
  quad('QFP100', 'qfp', 100, 0.5, 0.25, 1.4),
  quad('QFP144', 'qfp', 144, 0.5, 0.25, 1.4),
  quad('QFP208', 'qfp', 208, 0.5, 0.25, 1.4),
]);

const CONNECTOR_SHAPES = Object.freeze([
  ...[12, 20, 30, 40, 50, 60].map(n => singleRow(`FPC${n}`, n, 0.5, 0.3, 1.6)),
  ...[60, 100, 144, 204, 288].map(n => dualRow(`EDGE${n}`, 'conn', 'edge', n, 0.85, 4, 0.5, 2, 'conn')),
  ...[2, 3, 5, 8, 10, 15, 20].map(n => header(`HDR2X${n}`, n)),
]);

const BGA_SHAPES = Object.freeze([
  [0.4, 8, 8], [0.5, 10, 10], [0.5, 12, 12], [0.65, 14, 14], [0.65, 16, 16], [0.8, 12, 20], [0.8, 18, 18], [0.8, 20, 20], [0.8, 16, 24],
  [0.8, 22, 22], [0.8, 25, 25], [0.8, 28, 28], [0.8, 30, 30], [0.8, 20, 36], [0.8, 32, 32], [0.8, 34, 34], [0.8, 28, 40], [0.8, 36, 36],
  [0.8, 39, 39], [0.8, 41, 41], [1, 44, 44], [1, 47, 47], [1, 50, 50],
].map(([pitch, rows, cols]) => bga(rows, cols, pitch)));

const ANCHORS = Object.freeze({ bga: BGA_SHAPES, ic: IC_SHAPES, conn: CONNECTOR_SHAPES });
const MIN_PINS = Object.freeze({ bga: Math.min(...BGA_SHAPES.map(s => s.count)), ic: Math.min(...IC_SHAPES.map(s => s.count)), conn: Math.min(...CONNECTOR_SHAPES.map(s => s.count)) });

/** Device records (VALUE / PART / PACKAGE) of the passives and, per anchor shape, a few part numbers. */
const PASSIVE_TYPES = Object.freeze([
  { prefix: 'C', weight: 55, role: 'cap', packages: [['0201', 25], ['0402', 55], ['0603', 20]], values: ['100nF', '10nF', '1uF', '10uF', '22uF', '100pF', '2.2uF', '4.7uF', '47uF', '1nF'] },
  { prefix: 'R', weight: 33, role: 'res', packages: [['0201', 20], ['0402', 60], ['0603', 20]], values: ['10k', '0R', '100k', '4.7k', '1k', '22R', '33R', '47k', '2.2k', '100R', '220R', '49.9R'] },
  { prefix: 'FB', weight: 4, role: 'fb', packages: [['0402', 40], ['0603', 60]], values: ['600R', '120R', '1k'] },
  { prefix: 'L', weight: 4, role: 'ind', packages: [['0402', 55], ['0603', 45]], values: ['1uH', '2.2uH', '4.7uH', '10uH'] },
  { prefix: 'D', weight: 4, role: 'diode', packages: [['0402', 60], ['0603', 40]], values: ['ESD', 'BAT54', 'LED'] },
].map(type => {
  const small = type.packages.filter(([pkg]) => pkg !== '0603');
  return { ...type, packageTable: cumulative(type.packages.map(item => item[1])), small, smallTable: cumulative(small.map(item => item[1])) };
}));
const PASSIVE_TYPE_TABLE = cumulative(PASSIVE_TYPES.map(type => type.weight));
const deviceName = (type, value, pkg) => `${type.prefix}_${value}_${pkg}`;

const ANCHOR_FAMILY_VALUE = Object.freeze({ bga: ['SOC', 'MEM', 'FPGA', 'PMIC'], sot: ['LDO', 'SW', 'LOGIC'], soic: ['FLASH', 'DRV'], tssop: ['MUX', 'BUF'], qfn: ['PMIC', 'PHY', 'MCU'], qfp: ['MCU', 'CODEC'], fpc: ['FPC'], edge: ['SLOT'], header: ['HDR'] });
for (const shape of [...BGA_SHAPES, ...IC_SHAPES, ...CONNECTOR_SHAPES]) {
  const values = ANCHOR_FAMILY_VALUE[shape.family];
  shape.devices = [0, 1].map(k => ({ name: `${shape.name}_${String.fromCharCode(65 + k)}`, value: `${values[k % values.length]}${shape.count}`, part: `SYN-${shape.name}-${String.fromCharCode(65 + k)}`, package: shape.name }));
}
const ANCHOR_PREFIX = Object.freeze({ bga: 'U', ic: 'U', conn: 'J' });

// ---------------------------------------------------------------------------------------------------------------
// Module layout: an anchor part with passives in rings around it (anchor side) and in a grid under it (far side)
// ---------------------------------------------------------------------------------------------------------------

// 0201 and 0402 parts sit in rings and under the anchor; the larger 0603 parts (power stages, pull-up fields) sit in their own islands.
const RING_GAP = 0.3, RING_STEP = 1.7, SLOT = 0.85, FAR_GX = 1.7, FAR_GY = 0.8, BIG_GX = 2.8, BIG_GY = 1.5, MODULE_MARGIN = 0.8, BOARD_EDGE = 5, CORNER_RADIUS = 5;
const ASPECT = 1.4, PACK_WASTE = 1.1;
const ROTATIONS = [0, 90, 180, 270];

function gridLayout(count, cols, gx, gy) {
  const rows = Math.ceil(count / cols);
  const xs = new Float64Array(count), ys = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    xs[i] = ((i % cols) - (cols - 1) / 2) * gx;
    ys[i] = (Math.floor(i / cols) - (rows - 1) / 2) * gy;
  }
  return { xs, ys, rots: new Int16Array(count), hx: cols * gx / 2, hy: rows * gy / 2 };
}

/** `count` slots on concentric rectangular rings around a (aw x ah) body; each part's long axis points away from the body. */
function ringLayout(aw, ah, count) {
  const xs = new Float64Array(count), ys = new Float64Array(count), rots = new Int16Array(count);
  let filled = 0, ring = 0, hx = aw / 2, hy = ah / 2;
  while (filled < count) {
    hx = aw / 2 + RING_GAP + RING_STEP / 2 + ring * RING_STEP;
    hy = ah / 2 + RING_GAP + RING_STEP / 2 + ring * RING_STEP;
    const ns = Math.max(1, Math.floor(2 * hx / SLOT));
    const ewLength = Math.max(0, 2 * hy - RING_STEP);
    const ew = Math.floor(ewLength / SLOT);
    const put = (x, y, rot) => { if (filled < count) { xs[filled] = x; ys[filled] = y; rots[filled] = rot; filled++; } };
    for (let i = 0; i < ns; i++) put(-hx + (i + 0.5) * 2 * hx / ns, hy, 90);
    for (let i = 0; i < ew; i++) put(hx, ewLength / 2 - (i + 0.5) * ewLength / ew, 0);
    for (let i = 0; i < ns; i++) put(hx - (i + 0.5) * 2 * hx / ns, -hy, 90);
    for (let i = 0; i < ew; i++) put(-hx, -ewLength / 2 + (i + 0.5) * ewLength / ew, 0);
    ring++;
  }
  return { xs, ys, rots, hx: hx + RING_STEP / 2, hy: hy + RING_STEP / 2 };
}

/** Positions of everything of a module relative to its centre, and its half extents. Called by both phases and always equal. */
function layoutModule(module) {
  const shape = module.shape;
  const turned = module.rot === 90 || module.rot === 270;
  const aw = shape ? (turned ? 2 * shape.halfH : 2 * shape.halfW) : 0, ah = shape ? (turned ? 2 * shape.halfW : 2 * shape.halfH) : 0;
  const nearCount = module.n2 - module.nFar + module.nTp;
  let near = null, far = null, hx = aw / 2, hy = ah / 2;
  if (nearCount > 0) {
    near = shape ? ringLayout(aw, ah, nearCount) : gridLayout(nearCount, Math.max(1, Math.ceil(Math.sqrt(nearCount * BIG_GY / BIG_GX))), BIG_GX, BIG_GY);
    hx = Math.max(hx, near.hx); hy = Math.max(hy, near.hy);
  }
  if (module.nFar > 0) {
    far = gridLayout(module.nFar, Math.max(2, Math.floor((aw + 3) / FAR_GX)), FAR_GX, FAR_GY);
    hx = Math.max(hx, far.hx); hy = Math.max(hy, far.hy);
  }
  return { aw, ah, near, far, hw: hx + MODULE_MARGIN, hh: hy + MODULE_MARGIN };
}

// ---------------------------------------------------------------------------------------------------------------
// Plan: the modules of the board, their sizes and their place on it
// ---------------------------------------------------------------------------------------------------------------

/** Share of the pins per anchor kind (the rest, about 40 %, are passives and test points), the average anchor size used to turn pins into module counts, and passives per anchor pin. */
const KIND_SHARE = Object.freeze({ bga: 0.42, ic: 0.1, conn: 0.06, none: 0.05 });
const KIND_AVERAGE = Object.freeze({ bga: 450, ic: 40, conn: 60, none: 240 });
const PASSIVES_PER_PIN = Object.freeze({ bga: 0.28, ic: 0.55, conn: 0.12 });
const FAR_SHARE = Object.freeze({ bga: 0.55, ic: 0.2, conn: 0.1 });
const BOTTOM_ANCHOR_SHARE = Object.freeze({ bga: 0.15, ic: 0.25, conn: 0.12 });
const FILLER_PINS = 1500, ISLAND_MIN = 80, ISLAND_SPREAD = 320;
const MAX_BGA_SHARE = 0.22;

function buildPlan(pins, seed) {
  const rand = rng(hash32(seed, 0x504c414e, pins));
  const remainingTarget = { bga: KIND_SHARE.bga * pins, ic: KIND_SHARE.ic * pins, conn: KIND_SHARE.conn * pins, none: KIND_SHARE.none * pins };
  const used = { bga: 0, ic: 0, conn: 0, none: 0 };
  const modules = [];
  const usedShapes = new Set();
  let remaining = pins, components = 0;
  /** A passives-only island (power stages, pull-up fields; 0603 parts allowed) of `count` pins. */
  const island = count => {
    used.none += count;
    return { index: modules.length, kind: 'none', shape: null, rot: 0, side: rand() < 0.5 ? 'top' : 'bottom', n2: count >> 1, nTp: count & 1, nFar: 0, pins: count };
  };
  /** An anchor part of `kind` with its passives; never more pins than `remaining`. */
  const anchorModule = kind => {
    const cap = kind === 'bga' ? Math.max(MIN_PINS.bga, Math.floor(MAX_BGA_SHARE * pins)) : Infinity;
    const choices = ANCHORS[kind].filter(shape => shape.count <= remaining && shape.count <= cap);
    const shape = choices[pickWeighted(rand, cumulative(choices.map(item => 1 / Math.sqrt(item.count))))];
    let n2 = Math.round(shape.count * PASSIVES_PER_PIN[kind] * (0.6 + 0.8 * rand()));
    let nTp = rand() < 0.25 ? 1 + below(rand, 2) : 0;
    if (shape.count + 2 * n2 + nTp > remaining) {
      nTp = Math.min(nTp, remaining - shape.count);
      n2 = Math.floor((remaining - shape.count - nTp) / 2);
    }
    const left = remaining - (shape.count + 2 * n2 + nTp);
    if (left < 3) { n2 += left >> 1; nTp += left & 1; } // a sliver of pins is not worth a module of its own
    const nFar = Math.min(n2, Math.round(n2 * FAR_SHARE[kind] * (0.7 + 0.6 * rand())));
    const bottomShare = shape.through ? 0 : BOTTOM_ANCHOR_SHARE[kind];
    used[kind] += shape.count;
    usedShapes.add(shape);
    return { index: modules.length, kind, shape, rot: kind === 'bga' ? 0 : ROTATIONS[below(rand, 4)], side: rand() < bottomShare ? 'bottom' : 'top', n2, nTp, nFar, pins: shape.count + 2 * n2 + nTp };
  };
  while (remaining > 0) {
    const kinds = [], weights = [];
    for (const kind of ['bga', 'ic', 'conn', 'none']) {
      const deficit = remainingTarget[kind] - used[kind];
      if (deficit > 0 && (kind === 'none' || MIN_PINS[kind] <= remaining)) { kinds.push(kind); weights.push(deficit / KIND_AVERAGE[kind]); }
    }
    let module;
    if (!kinds.length) module = island(Math.min(remaining, FILLER_PINS));
    else {
      const kind = kinds[pickWeighted(rand, cumulative(weights))];
      module = kind === 'none' ? island(Math.min(remaining, ISLAND_MIN + below(rand, ISLAND_SPREAD))) : anchorModule(kind);
    }
    components += (module.shape ? 1 : 0) + module.n2 + module.nTp;
    modules.push(module);
    remaining -= module.pins;
  }
  if (components > LIMITS.components) throw new RangeError(`The plan needs ${components} components; the GenCAD adapter accepts ${LIMITS.components}.`);

  let area = 0, widest = 0;
  for (const module of modules) {
    const layout = layoutModule(module);
    module.hw = layout.hw; module.hh = layout.hh;
    area += 4 * layout.hw * layout.hh;
    widest = Math.max(widest, 2 * layout.hw);
  }
  // Shelf packing, tallest modules first; the file keeps the module order.
  const rowWidth = Math.max(widest, Math.sqrt(area * PACK_WASTE * ASPECT));
  const order = modules.map((_, i) => i).sort((a, b) => modules[b].hh - modules[a].hh || a - b);
  let x = 0, y = 0, rowHeight = 0, usedWidth = 0;
  for (const i of order) {
    const module = modules[i];
    if (x > 0 && x + 2 * module.hw > rowWidth) { y += rowHeight; x = 0; rowHeight = 0; }
    module.cx = BOARD_EDGE + x + module.hw;
    module.cy = BOARD_EDGE + y + module.hh;
    x += 2 * module.hw;
    usedWidth = Math.max(usedWidth, x);
    rowHeight = Math.max(rowHeight, 2 * module.hh);
  }
  const width = usedWidth + 2 * BOARD_EDGE, height = y + rowHeight + 2 * BOARD_EDGE;
  return { pins, seed, modules, usedShapes: [...usedShapes], components, width, height };
}

// ---------------------------------------------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------------------------------------------

class Out {
  constructor(sink) { this.sink = sink; this.parts = []; this.size = 0; this.bytes = 0; this.lines = 0; this.chunks = 0; this.maxChunk = 0; }
  line(text) {
    this.parts.push(text);
    this.size += text.length + 1;
    this.lines++;
    if (this.size >= CHUNK_CHARS) this.flush();
  }
  flush() {
    if (!this.parts.length) return;
    const text = `${this.parts.join('\n')}\n`;
    this.parts.length = 0;
    this.size = 0;
    this.bytes += text.length; // ASCII only
    this.chunks++;
    this.maxChunk = Math.max(this.maxChunk, text.length);
    this.sink.write(text);
  }
}

const MIRROR_SIDE = 'MIRRORY FLIP';
const SIGNAL_PREFIX = ['SPI', 'DQ', 'GPIO', 'PCIE', 'I2C', 'CLK', 'ADC', 'USB'];
const RAIL_NAMES = ['VDD_3V3', 'VDD_5V0', 'VDD_1V8', 'VDD_1V2', 'VDD_1V0', 'VCORE', 'VDDQ', 'VBAT', 'VBUS', 'VDD_2V5', 'VDD_0V9', 'VPP', 'VREF', 'AVDD_1V8', 'AVDD_3V3', 'VDD_PLL', 'VCCIO', 'VCCSA', 'VCCIN', 'V12_MAIN'];
const NET_CAP_TABLE = cumulative([40, 28, 19, 13]); // signal net sizes 2 to 5
const BUS_SHARE = 0.03;
const WINDOW = 24, LEFTOVER_WINDOW = 64;

/** Pin roles of an anchor pin: 0 no connect, 1 ground, 2 power, 3 signal. */
function roleOf(shape, index, rand) {
  if (index === shape.epIndex) return 1;
  let ground, power, none;
  if (shape.role === 'bga') {
    const row = Math.floor(index / shape.cols), col = index % shape.cols;
    const depth = Math.min(row, col, shape.rows - 1 - row, shape.cols - 1 - col) / (Math.min(shape.rows, shape.cols) / 2);
    ground = 0.22 + 0.5 * depth; power = 0.04 + 0.2 * depth; none = 0.08 * (1 - depth);
  } else if (shape.role === 'conn') { ground = 0.34; power = 0.1; none = 0.02; }
  else { ground = 0.14; power = 0.12; none = 0.03; }
  const x = rand();
  return x < ground ? 1 : x < ground + power ? 2 : x < ground + power + none ? 0 : 3;
}

/** Roles of the two pins of a passive (1 ground, 2 power, 3 signal; a power pin takes the rail given by the module). */
function passiveRoles(type, rand, roles) {
  switch (type.role) {
    case 'cap': { const x = rand(); if (x < 0.68) { roles[0] = 2; roles[1] = 1; } else if (x < 0.78) { roles[0] = 3; roles[1] = 1; } else { roles[0] = 3; roles[1] = 3; } break; }
    case 'res': { const x = rand(); if (x < 0.1) { roles[0] = 2; roles[1] = 3; } else if (x < 0.22) { roles[0] = 1; roles[1] = 3; } else { roles[0] = 3; roles[1] = 3; } break; }
    case 'fb': if (rand() < 0.5) { roles[0] = 2; roles[1] = 2; } else { roles[0] = 3; roles[1] = 3; } break;
    case 'ind': if (rand() < 0.7) { roles[0] = 3; roles[1] = 2; } else { roles[0] = 3; roles[1] = 3; } break;
    default: if (rand() < 0.5) { roles[0] = 3; roles[1] = 1; } else { roles[0] = 3; roles[1] = 3; }
  }
}

function railCount(pins) { return Math.min(80, Math.max(10, 10 + Math.floor(Math.sqrt(pins) / 16))); }
const railName = index => (index < RAIL_NAMES.length ? RAIL_NAMES[index] : `${RAIL_NAMES[index % RAIL_NAMES.length]}_${Math.floor(index / RAIL_NAMES.length)}`);

function morton(x, y) {
  let key = 0;
  for (let bit = 0; bit < 12; bit++) key += (((x >> bit) & 1) * 2 + ((y >> bit) & 1)) * 4 ** bit;
  return key;
}

/**
 * Writes the board to `sink` ({ write(text) }) and returns its summary. Everything is derived from `options.pins` and
 * `options.seed`; nothing else (no clock, no environment) reaches the output.
 */
function generateGenCad(options, sink) {
  const pins = typeof options.pins === 'string' ? parseSize(options.pins) : options.pins;
  if (!Number.isInteger(pins) || pins < 2 || pins > LIMITS.pins) throw new RangeError(`Pin count must be an integer from 2 to ${LIMITS.pins}.`);
  const seed = options.seed === undefined ? SEED_DEFAULT : options.seed >>> 0;
  const plan = buildPlan(pins, seed);
  const out = new Out(sink);
  const label = `synthetic-${sizeLabel(pins)}-s${seed}`;

  // --- header, board outline
  out.line('$HEADER'); out.line('GENCAD 1.4'); out.line(`USER "${GENERATOR} ${GENERATOR_VERSION}"`); out.line(`DRAWING "${label}"`);
  out.line('UNITS MM'); out.line('ORIGIN 0 0'); out.line('$ENDHEADER');
  const { width, height } = plan, R = CORNER_RADIUS;
  out.line('$BOARD');
  out.line(`LINE ${mm(R)} 0 ${mm(width - R)} 0`);
  out.line(`ARC ${mm(width - R)} 0 ${mm(width)} ${mm(R)} ${mm(width - R)} ${mm(R)}`);
  out.line(`LINE ${mm(width)} ${mm(R)} ${mm(width)} ${mm(height - R)}`);
  out.line(`ARC ${mm(width)} ${mm(height - R)} ${mm(width - R)} ${mm(height)} ${mm(width - R)} ${mm(height - R)}`);
  out.line(`LINE ${mm(width - R)} ${mm(height)} ${mm(R)} ${mm(height)}`);
  out.line(`ARC ${mm(R)} ${mm(height)} 0 ${mm(height - R)} ${mm(R)} ${mm(height - R)}`);
  out.line(`LINE 0 ${mm(height - R)} 0 ${mm(R)}`);
  out.line(`ARC 0 ${mm(R)} ${mm(R)} 0 ${mm(R)} ${mm(R)}`);
  out.line('$ENDBOARD');

  // --- pads, padstacks, shapes (only the footprints the board uses)
  const shapes = [...Object.values(PASSIVE_SHAPES), TEST_POINT, ...plan.usedShapes];
  const pads = new Map(), stacks = new Map();
  for (const shape of shapes) for (const stack of shape.stacks) { pads.set(stack.pad.name, stack.pad); stacks.set(stack.name, stack); }
  out.line('$PADS');
  for (const pad of [...pads.values()].sort((a, b) => (a.name < b.name ? -1 : 1))) {
    out.line(`PAD ${pad.name} ${pad.type} -1`);
    out.line(pad.type === 'ROUND' ? `CIRCLE 0 0 ${mm(pad.d / 2)}` : `RECTANGLE ${mm(-pad.w / 2)} ${mm(-pad.h / 2)} ${mm(pad.w)} ${mm(pad.h)}`);
  }
  out.line('$ENDPADS');
  out.line('$PADSTACKS');
  for (const stack of [...stacks.values()].sort((a, b) => (a.name < b.name ? -1 : 1))) {
    out.line(`PADSTACK ${stack.name} ${mm(stack.drill)}`);
    out.line(`PAD ${stack.pad.name} ${stack.through ? 'ALL' : 'TOP'} 0 0`);
  }
  out.line('$ENDPADSTACKS');
  out.line('$SHAPES');
  for (const shape of shapes) {
    out.line(`SHAPE ${shape.name}`);
    out.line(`INSERT ${shape.through ? 'TH' : 'SMD'}`);
    out.line(`RECTANGLE ${mm(-shape.bodyW / 2)} ${mm(-shape.bodyH / 2)} ${mm(shape.bodyW)} ${mm(shape.bodyH)}`);
    const layer = shape.through ? 'ALL' : 'TOP';
    for (let i = 0; i < shape.count; i++) out.line(`PIN ${shape.numbers[i]} ${shape.stacks[shape.stackOf[i]].name} ${mm(shape.xs[i])} ${mm(shape.ys[i])} ${layer} ${shape.rotated?.[i] ? 90 : 0} 0`);
  }
  out.line('$ENDSHAPES');

  // --- devices
  out.line('$DEVICES');
  const writeDevice = device => {
    out.line(`DEVICE ${device.name}`); out.line(`PART ${device.part}`); out.line(`VALUE ${device.value}`); out.line(`PACKAGE ${device.package}`);
  };
  for (const type of PASSIVE_TYPES) for (const [pkg] of type.packages) for (const value of type.values) {
    writeDevice({ name: deviceName(type, value, pkg), part: `SYN-${type.prefix}-${value}-${pkg}`, value, package: pkg });
  }
  writeDevice({ name: 'TP_TP', part: 'SYN-TP', value: 'TP', package: 'FP_TP' });
  for (const shape of plan.usedShapes) for (const device of shape.devices) writeDevice(device);
  out.line('$ENDDEVICES');

  // --- components; the nets are decided while the parts are written and written afterwards from typed arrays
  const rails = railCount(pins);
  const railTable = cumulative(Array.from({ length: rails }, (_, i) => 1 / (i + 2)));
  const pinNet = new Int32Array(pins).fill(-1); // -1 no connect, -2 signal pin waiting for its net, 0 GND, 1..rails power, above: signal nets
  const partOfPin = new Uint32Array(pins);
  const maxParts = plan.components;
  const partShape = new Array(maxParts);
  const partPrefix = new Uint8Array(maxParts);
  const partNo = new Uint32Array(maxParts);
  const partStart = new Uint32Array(maxParts + 1);
  const signalKeys = new Float64Array(pins);
  let signalCount = 0, partCount = 0, pinCursor = 0;
  const prefixes = ['U', 'J', 'C', 'R', 'FB', 'L', 'D', 'TP'];
  const prefixIndex = { U: 0, J: 1, C: 2, R: 3, FB: 4, L: 5, D: 6, TP: 7 };
  const counters = new Uint32Array(prefixes.length);
  const stats = {
    byKind: { bga: { components: 0, pins: 0 }, ic: { components: 0, pins: 0 }, connector: { components: 0, pins: 0 }, passive: { components: 0, pins: 0 }, testpoint: { components: 0, pins: 0 } },
    topComponents: 0, bottomComponents: 0, topPins: 0, bottomPins: 0, bothPins: 0, largestBga: null,
  };
  const roles = new Uint8Array(2);
  out.line('$COMPONENTS');

  for (const module of plan.modules) {
    const rand = rng(hash32(seed, 0x4d4f4455, module.index));
    const layout = layoutModule(module);
    const nearSide = module.side, farSide = nearSide === 'top' ? 'bottom' : 'top';
    const railSet = [pickWeighted(rand, railTable), pickWeighted(rand, railTable), pickWeighted(rand, railTable)];
    const railOf = () => { const x = rand(); return 1 + railSet[x < 0.6 ? 0 : x < 0.9 ? 1 : 2]; };

    /** Writes one part and decides the nets of its pins. `placeX/Y/rot` are board coordinates and degrees. */
    const emit = (prefix, shape, device, side, x, y, rot, kindKey, assign) => {
      const pi = prefixIndex[prefix];
      const number = ++counters[pi];
      const ref = prefix + number;
      const mirrored = side === 'bottom';
      out.line(`COMPONENT ${ref}`);
      out.line(`PLACE ${mm(x)} ${mm(y)}`);
      out.line(`LAYER ${mirrored ? 'BOTTOM' : 'TOP'}`);
      out.line(`ROTATION ${rot}`);
      out.line(`SHAPE ${shape.name} ${mirrored ? MIRROR_SIDE : '0 0'}`);
      out.line(`DEVICE ${device}`);
      const part = partCount++;
      partShape[part] = shape; partPrefix[part] = pi; partNo[part] = number; partStart[part] = pinCursor;
      const kindStats = stats.byKind[kindKey];
      kindStats.components++; kindStats.pins += shape.count;
      if (shape.through) stats.bothPins += shape.count; else if (mirrored) stats.bottomPins += shape.count; else stats.topPins += shape.count;
      if (mirrored) stats.bottomComponents++; else stats.topComponents++;
      const cos = rot === 0 ? 1 : rot === 180 ? -1 : 0, sin = rot === 90 ? 1 : rot === 270 ? -1 : 0;
      for (let i = 0; i < shape.count; i++) {
        const index = pinCursor++;
        partOfPin[index] = part;
        const role = assign(i);
        if (role === 1) pinNet[index] = 0;
        else if (role === 2) pinNet[index] = railOf();
        else if (role === 3) {
          pinNet[index] = -2;
          const lx = mirrored ? -shape.xs[i] : shape.xs[i], ly = shape.ys[i];
          const wx = x + lx * cos - ly * sin, wy = y + lx * sin + ly * cos;
          const cellX = Math.min(4095, Math.max(0, Math.floor(wx / 1.2))), cellY = Math.min(4095, Math.max(0, Math.floor(wy / 1.2)));
          signalKeys[signalCount++] = morton(cellX, cellY) * PIN_INDEX_RANGE + index;
        }
      }
      return ref;
    };
    const big = module.kind === 'none';
    const passiveSpec = () => {
      const type = PASSIVE_TYPES[pickWeighted(rand, PASSIVE_TYPE_TABLE)];
      const pkg = big ? type.packages[pickWeighted(rand, type.packageTable)][0] : type.small[pickWeighted(rand, type.smallTable)][0];
      const value = type.values[below(rand, type.values.length)];
      return { type, shape: PASSIVE_SHAPES[pkg], device: deviceName(type, value, pkg) };
    };

    if (module.shape) {
      const shape = module.shape;
      const device = shape.devices[below(rand, 2)].name;
      const ref = emit(ANCHOR_PREFIX[module.kind], shape, device, nearSide, module.cx, module.cy, module.rot, module.kind === 'conn' ? 'connector' : module.kind, i => roleOf(shape, i, rand));
      // The largest BGA on the top side (any side when none is on top): the dense spot the benchmark zooms into.
      if (module.kind === 'bga' && (!stats.largestBga || (nearSide === 'top' && stats.largestBga.side !== 'top') || (nearSide === stats.largestBga.side && shape.count > stats.largestBga.pins))) {
        stats.largestBga = { ref, shape: shape.name, pins: shape.count, side: nearSide, x: Number(mm(module.cx)), y: Number(mm(module.cy)) };
      }
    }
    const nearPassives = module.n2 - module.nFar;
    for (let k = 0; k < nearPassives + module.nTp; k++) {
      const x = module.cx + layout.near.xs[k], y = module.cy + layout.near.ys[k];
      const rot = (layout.near.rots[k] + (rand() < 0.5 ? 180 : 0)) % 360;
      if (k < nearPassives) {
        const spec = passiveSpec();
        emit(spec.type.prefix, spec.shape, spec.device, nearSide, x, y, rot, 'passive', i => { if (i === 0) passiveRoles(spec.type, rand, roles); return roles[i]; });
      } else {
        emit('TP', TEST_POINT, 'TP_TP', nearSide, x, y, 0, 'testpoint', () => { const r = rand(); return r < 0.55 ? 3 : r < 0.8 ? 1 : 2; });
      }
    }
    for (let k = 0; k < module.nFar; k++) {
      const x = module.cx + layout.far.xs[k], y = module.cy + layout.far.ys[k];
      const spec = passiveSpec();
      emit(spec.type.prefix, spec.shape, spec.device, farSide, x, y, rand() < 0.5 ? 0 : 180, 'passive', i => { if (i === 0) passiveRoles(spec.type, rand, roles); return roles[i]; });
    }
  }
  partStart[partCount] = pinCursor;
  out.line('$ENDCOMPONENTS');
  if (pinCursor !== pins || partCount !== plan.components) throw new Error(`Internal error: planned ${pins} pins and ${plan.components} parts, wrote ${pinCursor} and ${partCount}.`);

  // --- signal nets: spatial neighbours first, the leftovers (matched across the board) second
  const netRand = rng(hash32(seed, 0x4e455453, pins));
  const keys = signalKeys.subarray(0, signalCount).sort();
  const maxNets = rails + 1 + (signalCount >> 1) + 2;
  let nextNet = rails + 1;
  const memberPins = [], memberParts = [];
  const netCap = () => (netRand() < BUS_SHARE ? 6 + below(netRand, 11) : 2 + pickWeighted(netRand, NET_CAP_TABLE));
  const flushNet = () => {
    if (nextNet >= maxNets) throw new Error('Internal error: too many nets.');
    for (const pin of memberPins) pinNet[pin] = nextNet;
    nextNet++;
  };
  const sortedPin = i => keys[i] % PIN_INDEX_RANGE;
  const done = new Uint8Array(signalCount);
  const leftovers = [];
  for (let i = 0; i < signalCount; i++) {
    if (done[i]) continue;
    done[i] = 1;
    const first = sortedPin(i);
    memberPins.length = 0; memberParts.length = 0;
    memberPins.push(first); memberParts.push(partOfPin[first]);
    const cap = netCap();
    for (let j = i + 1; j < signalCount && j <= i + WINDOW && memberPins.length < cap; j++) {
      if (done[j]) continue;
      const pin = sortedPin(j), part = partOfPin[pin];
      if (memberParts.includes(part)) continue;
      done[j] = 1; memberPins.push(pin); memberParts.push(part);
    }
    if (memberPins.length >= 2) flushNet(); else leftovers.push(first);
  }
  for (let i = leftovers.length - 1; i > 0; i--) { const j = below(netRand, i + 1); const t = leftovers[i]; leftovers[i] = leftovers[j]; leftovers[j] = t; }
  const taken = new Uint8Array(leftovers.length);
  for (let i = 0; i < leftovers.length; i++) {
    if (taken[i]) continue;
    taken[i] = 1;
    memberPins.length = 0; memberParts.length = 0;
    memberPins.push(leftovers[i]); memberParts.push(partOfPin[leftovers[i]]);
    const cap = netCap();
    for (let j = i + 1; j < leftovers.length && j <= i + LEFTOVER_WINDOW && memberPins.length < cap; j++) {
      if (taken[j]) continue;
      const part = partOfPin[leftovers[j]];
      if (memberParts.includes(part)) continue;
      taken[j] = 1; memberPins.push(leftovers[j]); memberParts.push(part);
    }
    if (memberPins.length >= 2) flushNet(); else pinNet[leftovers[i]] = -1;
  }

  // --- net table
  const netTotal = nextNet;
  const netPinCount = new Uint32Array(netTotal + 1);
  let connected = 0;
  for (let p = 0; p < pins; p++) {
    const net = pinNet[p];
    if (net === -2) throw new Error('Internal error: a signal pin has no net.');
    if (net >= 0) { netPinCount[net + 1]++; connected++; }
  }
  const netStart = new Uint32Array(netTotal + 1);
  for (let n = 0; n < netTotal; n++) netStart[n + 1] = netStart[n] + netPinCount[n + 1];
  const fill = netStart.slice(0, netTotal);
  const netPins = new Uint32Array(connected);
  for (let p = 0; p < pins; p++) { const net = pinNet[p]; if (net >= 0) netPins[fill[net]++] = p; }

  const netStats = { gndPins: netStart[1] - netStart[0], railNets: 0, railPins: 0, signalNets: 0, signalPins: 0, largestSignalNet: 0, noConnectPins: pins - connected, sizeHistogram: { 2: 0, 3: 0, 4: 0, 5: 0, '6+': 0 } };
  let netNumber = 0;
  const nameOf = net => (net === 0 ? 'GND' : net <= rails ? railName(net - 1) : `${SIGNAL_PREFIX[(net - rails - 1) % SIGNAL_PREFIX.length]}_${net - rails}`);
  let largestRail = { name: '', pins: 0 };
  out.line('$SIGNALS');
  for (let net = 0; net < netTotal; net++) {
    const count = netStart[net + 1] - netStart[net];
    if (!count) continue;
    netNumber++;
    if (net === 0) { /* ground */ } else if (net <= rails) { netStats.railNets++; netStats.railPins += count; if (count > largestRail.pins) largestRail = { name: nameOf(net), pins: count }; }
    else { netStats.signalNets++; netStats.signalPins += count; netStats.largestSignalNet = Math.max(netStats.largestSignalNet, count); netStats.sizeHistogram[count >= 6 ? '6+' : count]++; }
    out.line(`SIGNAL ${nameOf(net)}`);
    for (let k = netStart[net]; k < netStart[net + 1]; k++) {
      const pin = netPins[k], part = partOfPin[pin];
      out.line(`NODE ${prefixes[partPrefix[part]]}${partNo[part]} ${partShape[part].numbers[pin - partStart[part]]}`);
    }
  }
  out.line('$ENDSIGNALS');
  out.flush();

  let points = 0;
  for (let part = 0; part < partCount; part++) points += 2 * 5 + 4 * partShape[part].count; // body outline twice plus four pad corners per pin
  const summary = {
    generator: GENERATOR, version: GENERATOR_VERSION, format: FORMAT, name: label, seed, requestedPins: pins,
    pins: pinCursor, components: partCount, nets: netNumber, connectedPins: connected, noConnectPins: netStats.noConnectPins,
    kinds: stats.byKind,
    sides: { topComponents: stats.topComponents, bottomComponents: stats.bottomComponents, topPins: stats.topPins, bottomPins: stats.bottomPins, throughHolePins: stats.bothPins },
    netStats: { ...netStats, gndShare: netStats.gndPins / pins, railShare: netStats.railPins / pins, largestRail },
    board: { widthMm: Number(mm(width)), heightMm: Number(mm(height)), pinsPerMm2: Number((pins / (width * height)).toFixed(4)), modules: plan.modules.length },
    shapes: shapes.length, geometryPoints: points, lines: out.lines, bytes: out.bytes, chunks: out.chunks, largestChunk: out.maxChunk,
    probe: {
      gnd: 'GND', rail: largestRail.name, bga: stats.largestBga,
      search: counters[prefixIndex.C] ? `C${Math.max(1, counters[prefixIndex.C] >> 1)}` : 'U1',
      component: counters[prefixIndex.R] ? `R${Math.max(1, counters[prefixIndex.R] >> 1)}` : 'U1',
    },
  };
  assertWithinLimits(summary);
  return summary;
}

function assertWithinLimits(summary) {
  const problems = [];
  if (summary.components > LIMITS.components) problems.push(`${summary.components} components > ${LIMITS.components}`);
  if (summary.pins > LIMITS.pins) problems.push(`${summary.pins} pins > ${LIMITS.pins}`);
  if (summary.geometryPoints > LIMITS.geometryPoints) problems.push(`${summary.geometryPoints} geometry points > ${LIMITS.geometryPoints}`);
  if (summary.lines > LIMITS.lines) problems.push(`${summary.lines} lines > ${LIMITS.lines}`);
  if (summary.bytes >= LIMITS.bytes) problems.push(`${summary.bytes} bytes >= ${LIMITS.bytes}`);
  if (problems.length) throw new RangeError(`The board is beyond what TRACE imports: ${problems.join('; ')}.`);
}

/** Sync file writer: the generator never holds more than one chunk of text. */
function writeGenCadFile(file, options) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const fd = fs.openSync(file, 'w');
  try {
    return generateGenCad(options, {
      write(text) {
        const buffer = Buffer.from(text, 'latin1');
        for (let offset = 0; offset < buffer.length;) offset += fs.writeSync(fd, buffer, offset, buffer.length - offset);
      },
    });
  } finally { fs.closeSync(fd); }
}

/** The board of a size in a directory: reused when its summary says it was made by this generator version with this seed. */
function ensureBoard(dir, options) {
  const pins = typeof options.pins === 'string' ? parseSize(options.pins) : options.pins;
  const seed = options.seed === undefined ? SEED_DEFAULT : options.seed >>> 0;
  const base = path.join(dir, `synthetic-${sizeLabel(pins)}-s${seed}`);
  const file = `${base}.cad`, sidecar = `${base}.json`;
  try {
    const summary = JSON.parse(fs.readFileSync(sidecar, 'utf8'));
    if (summary.generator === GENERATOR && summary.version === GENERATOR_VERSION && summary.seed === seed && summary.requestedPins === pins && fs.statSync(file).size === summary.bytes) return { file, summary, reused: true };
  } catch { /* generate below */ }
  const summary = writeGenCadFile(file, { pins, seed });
  fs.writeFileSync(sidecar, `${JSON.stringify(summary, null, 2)}\n`);
  return { file, summary, reused: false };
}

function cli(argv) {
  const argument = name => { const hit = argv.find(item => item.startsWith(`--${name}=`)); return hit ? hit.slice(name.length + 3) : undefined; };
  if (argv.includes('--help') || argv.length === 0) {
    console.log('Usage: node scripts/gen-synthetic-board.cjs --pins=<n|10k|50k|100k|250k|1m> [--seed=1] --out=<file.cad>\n       node scripts/gen-synthetic-board.cjs --sizes=10k,100k --out-dir=<dir> [--seed=1]');
    return 0;
  }
  const seed = argument('seed') === undefined ? SEED_DEFAULT : Number(argument('seed'));
  if (!Number.isInteger(seed) || seed < 0) { console.error('--seed must be a non-negative integer.'); return 2; }
  const report = (summary, file, ms) => console.log(`${file}: ${summary.pins} pins, ${summary.components} parts, ${summary.nets} nets, ${(summary.bytes / 1048576).toFixed(1)} MiB, ${ms} ms`);
  try {
    if (argument('sizes')) {
      const dir = path.resolve(argument('out-dir') || DEFAULT_DIR);
      for (const size of argument('sizes').split(',')) {
        const started = Date.now();
        const { file, summary, reused } = ensureBoard(dir, { pins: parseSize(size), seed });
        report(summary, `${file}${reused ? ' (reused)' : ''}`, Date.now() - started);
      }
      return 0;
    }
    if (!argument('pins') || !argument('out')) { console.error('Give --pins and --out (or --sizes and --out-dir); --help shows usage.'); return 2; }
    const started = Date.now();
    const summary = writeGenCadFile(path.resolve(argument('out')), { pins: parseSize(argument('pins')), seed });
    report(summary, argument('out'), Date.now() - started);
    if (argv.includes('--json')) console.log(JSON.stringify(summary, null, 2));
    return 0;
  } catch (error) { console.error(error.message); return 1; }
}

module.exports = { GENERATOR, GENERATOR_VERSION, SIZES, LIMITS, DEFAULT_DIR, parseSize, sizeLabel, generateGenCad, writeGenCadFile, ensureBoard, buildPlan };

if (require.main === module) process.exitCode = cli(process.argv.slice(2));
