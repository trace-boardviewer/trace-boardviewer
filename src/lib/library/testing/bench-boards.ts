/*
 * Boards from the benchmark's seeded GenCAD generator (scripts/gen-synthetic-board.cjs). The generator streams a realistic board
 * (BGAs, QFNs, connectors, decoupling, rails, buses) as GenCAD text. This module reads that text back into a BoardModel, so such a
 * board can get revisions, part numbers and every other board format like a model board, and so a library holds the benchmark's
 * original GenCAD file as the first revision of its family.
 *
 * The generator is passed in (`BenchGenCad`), not imported: this folder stays free of the scripts folder, and a test or a script
 * decides which generator version it uses.
 */
import type { BoardModel, Part, PartClass } from './board-model.ts';
import { makeMpn } from './board-model.ts';
import type { Rng } from './rng.ts';

/** GenCAD text of a board with about `pins` pins; the same arguments give the same text. */
export type BenchGenCad = (pins: number, seed: number) => string;

/** Parts per pin of the benchmark generator's boards (385 parts for 1,500 pins). */
export const BENCH_PARTS_PER_PIN = 0.26;

const CLASSES: ReadonlySet<string> = new Set(['U', 'J', 'C', 'R', 'FB', 'L', 'D', 'TP']);

interface ShapePin { number: string; dx: number; dy: number }

/** Reads the generator's GenCAD text into a board. Part numbers are invented per device (all parts of one device carry one number). */
export function boardFromBenchGencad(text: string, rng: Rng): BoardModel {
  const shapes = new Map<string, ShapePin[]>();
  const devices = new Map<string, { value: string; pkg: string }>();
  const nets = new Map<string, string>();
  const rawParts: Array<{ ref: string; x: number; y: number; side: 'top' | 'bottom'; rotation: number; shape: string; device: string }> = [];
  let section = '', shape: ShapePin[] | null = null, device: { value: string; pkg: string } | null = null, current: (typeof rawParts)[number] | null = null, signal = '';
  let width = 0, height = 0;
  for (const line of text.split('\n')) {
    if (!line) continue;
    if (line.charCodeAt(0) === 36) { section = line.trim(); continue; } // "$"
    const words = line.trim().split(' ');
    const head = words[0];
    if (section === '$BOARD') {
      if (head === 'LINE' || head === 'ARC') for (let i = 1; i + 1 < words.length; i += 2) { width = Math.max(width, Number(words[i])); height = Math.max(height, Number(words[i + 1])); }
    } else if (section === '$SHAPES') {
      if (head === 'SHAPE') { shape = []; shapes.set(words[1], shape); }
      else if (head === 'PIN' && shape) shape.push({ number: words[1], dx: Number(words[3]), dy: Number(words[4]) });
    } else if (section === '$DEVICES') {
      if (head === 'DEVICE') { device = { value: '', pkg: '' }; devices.set(words[1], device); }
      else if (device && head === 'VALUE') device.value = words.slice(1).join(' ');
      else if (device && head === 'PACKAGE') device.pkg = words.slice(1).join(' ');
    } else if (section === '$COMPONENTS') {
      if (head === 'COMPONENT') { current = { ref: words[1], x: 0, y: 0, side: 'top', rotation: 0, shape: '', device: '' }; rawParts.push(current); }
      else if (current && head === 'PLACE') { current.x = Number(words[1]); current.y = Number(words[2]); }
      else if (current && head === 'LAYER') current.side = words[1] === 'BOTTOM' ? 'bottom' : 'top';
      else if (current && head === 'ROTATION') current.rotation = ((Math.round(Number(words[1]) / 90) % 4) + 4) % 4 * 90;
      else if (current && head === 'SHAPE') current.shape = words[1];
      else if (current && head === 'DEVICE') current.device = words[1];
    } else if (section === '$SIGNALS') {
      if (head === 'SIGNAL') signal = words.slice(1).join(' ');
      else if (head === 'NODE') nets.set(`${words[1]} ${words[2]}`, signal);
    }
  }
  if (!rawParts.length) throw new Error('the GenCAD text has no components');
  const mpns = new Map<string, string>();
  const parts: Part[] = rawParts.map(raw => {
    const prefix = /^[A-Z]+/.exec(raw.ref)?.[0] ?? 'U';
    const cls = (CLASSES.has(prefix) ? prefix : 'U') as PartClass;
    const info = devices.get(raw.device) ?? { value: '', pkg: '' };
    let mpn: string | null = null;
    if (cls === 'U' || cls === 'D') {
      mpn = mpns.get(raw.device) ?? null;
      if (!mpn) { mpn = makeMpn(rng.fork(`device/${raw.device}`)).exact; mpns.set(raw.device, mpn); }
    }
    const layout = shapes.get(raw.shape) ?? [];
    return {
      ref: raw.ref, cls, value: mpn ?? info.value, mpn, pkg: info.pkg || raw.shape, side: raw.side, x: raw.x, y: raw.y, rotation: raw.rotation as Part['rotation'],
      pins: layout.map(pin => ({ number: pin.number, dx: pin.dx, dy: pin.dy, net: nets.get(`${raw.ref} ${pin.number}`) ?? '' })),
    };
  });
  return { width: Math.ceil(width) || 1, height: Math.ceil(height) || 1, parts, benchText: text, benchDeviceValues: Object.fromEntries(mpns) };
}

/**
 * The generator's header names the board "synthetic-<pins>-s<seed>". A library file carries the board number and revision of its
 * family there instead (or keeps the generator's label when the format header is not meant to name the board), and the invented IC
 * part numbers replace the generator's own device values.
 */
export function patchBenchGencad(text: string, header: { drawing: string; revision: string; user: string } | null, deviceValues: Readonly<Record<string, string>>): string {
  const lines = text.split('\n');
  let devices = false, device = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (header && i < 12) {
      if (line.startsWith('USER ')) lines[i] = `USER "${header.user.replace(/"/g, ' ')}"`;
      else if (line.startsWith('DRAWING ')) lines[i] = `DRAWING "${header.drawing.replace(/"/g, ' ')}"\nREVISION "${header.revision.replace(/"/g, ' ')}"`;
    }
    if (line === '$DEVICES') devices = true;
    else if (line === '$ENDDEVICES') break;
    else if (devices) {
      if (line.startsWith('DEVICE ')) device = line.slice(7).trim();
      else if (line.startsWith('VALUE ') && Object.hasOwn(deviceValues, device)) lines[i] = `VALUE ${deviceValues[device]}`;
    }
  }
  return lines.join('\n');
}
