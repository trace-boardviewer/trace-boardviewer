import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** Host load around a benchmark run (scripts/perf-host.cjs, plain Node). */
interface Count { node: number; electron: number; browser: number; total: number }
interface Proc { pid: number; name: string }
interface During { elapsedS: number; machineBusyPercent: number; ownBusyPercent: number | null; otherBusyPercent: number | null }
interface Host { before?: { cpuBusyPercent?: number }; after?: { cpuBusyPercent?: number }; duringRun?: Partial<During> }
const lib = createRequire(import.meta.url)(join(__dirname, '..', '..', 'scripts', 'perf-host.cjs')) as {
  QUIET_PERCENT: number;
  parseTasklist(text: string): Proc[];
  parsePs(text: string): Proc[];
  baseName(name: string): string;
  countProcesses(list: Proc[], own?: number[]): Count;
  listProcesses(): Promise<Proc[] | null>;
  otherProcesses(): Promise<Count | null>;
  cpuTimes(cpus?: Array<{ times: Record<string, number> }>): { busy: number; total: number };
  busyPercent(before: { busy: number; total: number }, after: { busy: number; total: number }): number;
  sampleBusyPercent(ms?: number): Promise<number>;
  waitUntilQuiet(seconds: number, options?: { threshold?: number; needed?: number; sample?: (ms: number) => Promise<number> }): Promise<{ waitedS: number; quiet: boolean; lastPercent: number }>;
  startLoadMeter(): { stop(applicationSeconds: number | null): During };
  loadPercent(host: Host): number | null;
  classifyConditions(hosts: Host[], override?: string | null): string;
};

const TASKLIST = [
  '"System Idle Process","0","Services","0","8 K"',
  '"node.exe","4100","Console","1","95,212 K"',
  '"node.exe","4200","Console","1","45,000 K"',
  '"electron.exe","5100","Console","1","120,000 K"',
  '"chrome.exe","6100","Console","1","210,000 K"',
  '"msedgewebview2.exe","6200","Console","1","90,000 K"',
  '"node_repl.exe","7000","Console","1","10,000 K"',
  '',
  'INFO: not a process line',
].join('\r\n');

describe('process lists', () => {
  it('reads the CSV of tasklist and ignores other lines', () => {
    const list = lib.parseTasklist(TASKLIST);
    expect(list).toHaveLength(7);
    expect(list[1]).toEqual({ pid: 4100, name: 'node.exe' });
    expect(lib.parseTasklist('')).toEqual([]);
  });

  it('reads the output of ps with names that contain spaces', () => {
    const list = lib.parsePs(['    1 /sbin/launchd', '  345 Electron Helper (Renderer)', '12 node', 'garbage'].join('\n'));
    expect(list).toEqual([{ pid: 1, name: 'launchd' }, { pid: 345, name: 'Electron Helper (Renderer)' }, { pid: 12, name: 'node' }]);
  });

  it('names processes without directory, extension or case', () => {
    expect(lib.baseName('Electron.exe')).toBe('electron');
    expect(lib.baseName('C:\\tools\\Node.EXE')).toBe('node');
    expect(lib.baseName('/usr/bin/Chromium')).toBe('chromium');
  });

  it('counts node, electron and browser processes and leaves out its own', () => {
    const list = lib.parseTasklist(TASKLIST);
    expect(lib.countProcesses(list)).toEqual({ node: 2, electron: 1, browser: 2, total: 7 });
    expect(lib.countProcesses(list, [4100])).toEqual({ node: 1, electron: 1, browser: 2, total: 6 });
    expect(lib.countProcesses(list, [4100, 5100, 99999])).toEqual({ node: 1, electron: 0, browser: 2, total: 5 });
    expect(lib.countProcesses([{ pid: 1, name: 'Electron Helper (GPU)' }])).toEqual({ node: 0, electron: 1, browser: 0, total: 1 });
    expect(lib.countProcesses([])).toEqual({ node: 0, electron: 0, browser: 0, total: 0 });
  });

  it('lists the processes of this machine, including this one, when the platform tool exists', async () => {
    const list = await lib.listProcesses();
    if (list) expect(list.some(item => item.pid === process.pid)).toBe(true);
    const others = await lib.otherProcesses();
    if (others) {
      expect(others.total).toBeGreaterThan(0);
      expect(others.node).toBeGreaterThanOrEqual(0);
    }
  }, 60_000);
});

describe('processor share', () => {
  const cpu = (user: number, sys: number, idle: number) => ({ times: { user, nice: 0, sys, idle, irq: 0 } });

  it('sums busy and total time over the logical processors', () => {
    expect(lib.cpuTimes([cpu(10, 5, 85), cpu(20, 10, 70)])).toEqual({ busy: 45, total: 200 });
    expect(lib.cpuTimes([])).toEqual({ busy: 0, total: 0 });
  });

  it('turns two readings into whole percent', () => {
    expect(lib.busyPercent({ busy: 100, total: 1000 }, { busy: 400, total: 2000 })).toBe(30);
    expect(lib.busyPercent({ busy: 0, total: 0 }, { busy: 0, total: 0 })).toBe(0);
    expect(lib.busyPercent({ busy: 5, total: 10 }, { busy: 3, total: 20 })).toBe(0);
  });

  it('measures a short sample of the real machine inside 0 to 100 percent', async () => {
    const value = await lib.sampleBusyPercent(50);
    expect(value).toBeGreaterThanOrEqual(0);
    expect(value).toBeLessThanOrEqual(100);
  });

  it('measures a stretch of time with and without the application seconds', () => {
    const unknown = lib.startLoadMeter().stop(null);
    expect(unknown.ownBusyPercent).toBeNull();
    expect(unknown.otherBusyPercent).toBeNull();
    expect(unknown.machineBusyPercent).toBeGreaterThanOrEqual(0);
    const meter = lib.startLoadMeter();
    const known = meter.stop(0);
    expect(known.ownBusyPercent).not.toBeNull();
    expect(known.otherBusyPercent).not.toBeNull();
    expect(known.otherBusyPercent!).toBeLessThanOrEqual(known.machineBusyPercent);
    expect(known.elapsedS).toBeGreaterThanOrEqual(0);
  });
});

describe('waiting for a quiet machine', () => {
  const samples = (values: number[]) => { let index = 0; return async () => values[Math.min(index++, values.length - 1)]; };

  it('returns once the machine stayed at or below the threshold for enough samples in a row', async () => {
    const result = await lib.waitUntilQuiet(30, { threshold: 15, needed: 3, sample: samples([60, 10, 40, 15, 5, 14]) });
    expect(result).toMatchObject({ quiet: true, lastPercent: 14 });
  });

  it('gives up after the time and reports that the machine never calmed down', async () => {
    const result = await lib.waitUntilQuiet(0, { threshold: 15, needed: 3, sample: samples([80]) });
    expect(result).toMatchObject({ quiet: false, lastPercent: 80 });
  });
});

describe('conditions of a report', () => {
  const host = (before: number, after: number, other?: number): Host => ({ before: { cpuBusyPercent: before }, after: { cpuBusyPercent: after }, ...(other === undefined ? {} : { duringRun: { otherBusyPercent: other } }) });

  it('takes the worst load of a run: before, after or during', () => {
    expect(lib.loadPercent(host(5, 9, 3))).toBe(9);
    expect(lib.loadPercent(host(5, 9, 30))).toBe(30);
    expect(lib.loadPercent({})).toBeNull();
  });

  it('calls a run quiet only when every size saw little other load', () => {
    expect(lib.classifyConditions([host(3, 4, 2), host(6, 5, 1)])).toBe('quiet');
    expect(lib.classifyConditions([host(3, 4, 2), host(6, 40, 1)])).toBe('under load, indicative');
    expect(lib.classifyConditions([host(3, 4, lib.QUIET_PERCENT)])).toBe('quiet');
    expect(lib.classifyConditions([host(3, 4, lib.QUIET_PERCENT + 1)])).toBe('under load, indicative');
  });

  it('does not call a run quiet when nothing was measured, and keeps the words of the person', () => {
    expect(lib.classifyConditions([])).toBe('under load, indicative');
    expect(lib.classifyConditions([{}])).toBe('under load, indicative');
    expect(lib.classifyConditions([host(1, 1)], '  under load, indicative  ')).toBe('under load, indicative');
    expect(lib.classifyConditions([host(90, 90)], 'night run')).toBe('night run');
    expect(lib.classifyConditions([host(90, 90)], '   ')).toBe('under load, indicative');
  });
});
