'use strict';

/*
 * Turns a synthetic benchmark report (JSON) into Markdown tables and compares two reports. No browser, no Electron.
 *
 *   node scripts/perf-report.cjs <report.json> [--out=<file.md>]
 *   node scripts/perf-report.cjs <report.json> --compare=<earlier-report.json> [--out=<file.md>]
 *
 * The benchmark writes <label>.md next to <label>.json with the first form.
 */

const fs = require('node:fs');
const path = require('node:path');
const budgets = require('./perf-budget.cjs');

const SIZE_ORDER = budgets.SIZE_NAMES;

/** Number with `digits` decimals, or "-" when there is none. */
function fmt(value, digits = 1) {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : '-';
}
/** "mean / p95" of a statistics object. */
const meanP95 = (stat, digits = 1) => (stat && stat.n ? `${fmt(stat.mean, digits)} / ${fmt(stat.p95, digits)}` : '-');
const at = (object, dotted) => budgets.valueAt(object, dotted);
const sizesOf = report => [...(report.sizes || [])].sort((a, b) => SIZE_ORDER.indexOf(a.size) - SIZE_ORDER.indexOf(b.size));
const table = (head, rows, left = []) => [`| ${head.join(' | ')} |`, `| ${head.map((_, i) => (i === 0 || left.includes(i) ? '---' : '---:')).join(' | ')} |`, ...rows.map(row => `| ${row.join(' | ')} |`)].join('\n');
const sizeCell = result => (result.status === 'ok' ? `**${result.size}**` : `**${result.size}** (failed)`);

/** Metrics shown by the comparison: [label, dotted path, unit, decimals]. Lower is better for all of them. */
const COMPARE_METRICS = [
  ['First paint', 'load.firstPaintMs', 'ms', 0],
  ['Pan, fit view, frame p95', 'frameCost.pan.fit.total.p95', 'ms', 1],
  ['Zoom, fit view, frame p95', 'frameCost.zoom.fit.total.p95', 'ms', 1],
  ['Pan, 20 px/mm, frame p95', 'frameCost.pan.detail.total.p95', 'ms', 1],
  ['Zoom, 20 px/mm, frame p95', 'frameCost.zoom.detail.total.p95', 'ms', 1],
  ['Pan, fit view, draw callback p95', 'pan.fit.draw.p95', 'ms', 1],
  ['Zoom, fit view, draw callback p95', 'zoom.fit.draw.p95', 'ms', 1],
  ['Hover handler p95', 'hover.fit.pointerMoveMs.p95', 'ms', 2],
  ['Search keystroke p95', 'search.keystrokeMs.p95', 'ms', 1],
  ['Select GND net, first draw', 'selectNet.firstDrawMs', 'ms', 0],
  ['JS heap after load', 'memory.afterLoad.heap.usedMB', 'MB', 0],
  ['Renderer peak working set', 'memory.afterInteraction.processes.rendererPeakWorkingSetMB', 'MB', 0],
];

function loadCell(host) {
  if (!host) return '-';
  const during = host.duringRun, processes = host.before?.processes, free = host.before?.freeMemoryGB;
  const parts = [];
  if (during && typeof during.otherBusyPercent === 'number') parts.push(`${during.otherBusyPercent} % other during the run`);
  parts.push(`${host.before?.cpuBusyPercent ?? '-'} % busy before, ${host.after?.cpuBusyPercent ?? '-'} % after`);
  if (processes) parts.push(`${processes.node} node, ${processes.electron} electron, ${processes.browser} browser of ${processes.total} processes`);
  if (typeof free === 'number') parts.push(`${free} GB free`);
  return parts.join('; ');
}

function formatMarkdown(report) {
  const sizes = sizesOf(report);
  const machine = report.machine || {}, application = report.application || {};
  const lines = [];
  const gpu = (application.gpuDevices || []).find(device => device.active) || null;
  lines.push(`# ${report.label}: synthetic benchmark (${report.runtime})`, '');
  lines.push(`- Conditions: **${report.conditions || 'not recorded'}**`);
  lines.push(`- Date: ${report.startedAt || '?'} to ${report.finishedAt || '?'}; revision ${report.revision || '?'}; package ${report.packageVersion || '?'}; generator ${report.generator ? `${report.generator.name} ${report.generator.version}, seed ${report.generator.seed}` : '?'}`);
  lines.push(`- Machine: ${machine.cpuModel || '?'}, ${machine.logicalCpus || '?'} logical processors, ${machine.memoryGB || '?'} GB memory, ${machine.platform || '?'} ${machine.osRelease || ''} ${machine.arch || ''}`);
  lines.push(`- Graphics: ${gpu ? gpu.deviceString : 'not recorded'}${application.glRenderer ? `; renderer ${application.glRenderer}` : ''}`);
  lines.push(`- Application: ${application.electron ? `Electron ${application.electron}, ` : ''}Chromium ${application.chrome || '?'}; viewport ${report.settings ? `${report.settings.viewport.width}x${report.settings.viewport.height}` : '?'}, device scale factor ${report.settings ? report.settings.deviceScaleFactor : '?'}${report.settings && report.settings.quick ? ', quick mode (fewer samples)' : ''}`);
  lines.push('');
  lines.push('## Host load per run', '');
  lines.push(table(['Size', 'Load around the run'], sizes.map(result => [sizeCell(result), loadCell(result.host)]), [1]));
  lines.push('');
  lines.push('## Open and memory', '');
  lines.push(table(['Size', 'Pins', 'Parts', 'Nets', 'First paint ms', 'Read ms', 'Worker ms', 'Scene + draw ms', 'JS heap MB', 'Renderer peak MB'], sizes.map(result => [
    sizeCell(result), String(result.pins ?? '-'), String(result.board?.components ?? '-'), String(result.board?.nets ?? '-'),
    fmt(at(result, 'load.firstPaintMs'), 0), fmt(at(result, 'load.readAndHandoffMs'), 0), fmt(at(result, 'load.workerRoundTripMs'), 0), fmt(at(result, 'load.sceneAndFirstDrawMs'), 0),
    fmt(at(result, 'memory.afterLoad.heap.usedMB'), 0), fmt(at(result, 'memory.afterInteraction.processes.rendererPeakWorkingSetMB'), 0),
  ])));
  lines.push('');
  lines.push('## Frame cost, ms (mean / p95): the draw callback plus the wait for the pixels', '');
  const cost = (result, phase, view) => meanP95(at(result, `frameCost.${phase}.${view}.total`));
  lines.push(table(['Size', 'Pan, fit', 'Zoom, fit', 'Pan, 20 px/mm', 'Zoom, 20 px/mm', 'Pan, fit, GND selected'], sizes.map(result => [
    sizeCell(result), cost(result, 'pan', 'fit'), cost(result, 'zoom', 'fit'), cost(result, 'pan', 'detail'), cost(result, 'zoom', 'detail'), cost(result, 'pan', 'gnd'),
  ])));
  lines.push('');
  lines.push('## Draw callback only, ms (mean / p95): what the page JavaScript pays, without the GPU wait', '');
  const draw = (result, phase, view) => meanP95(at(result, `${phase}.${view}.draw`));
  lines.push(table(['Size', 'Pan, fit', 'Zoom, fit', 'Pan, 20 px/mm', 'Zoom, 20 px/mm', 'Pan, fit, GND selected', 'Zoom, fit, GND selected'], sizes.map(result => [
    sizeCell(result), draw(result, 'pan', 'fit'), draw(result, 'zoom', 'fit'), draw(result, 'pan', 'detail'), draw(result, 'zoom', 'detail'), draw(result, 'pan', 'gnd'), draw(result, 'zoom', 'gnd'),
  ])));
  lines.push('');
  lines.push('## Interaction', '');
  lines.push(table(['Size', 'Hover handler p95 ms', 'Search keystroke p95 ms', 'Select GND to first draw ms', 'GND pins', 'Idle draws in 2 s'], sizes.map(result => [
    sizeCell(result), fmt(at(result, 'hover.fit.pointerMoveMs.p95'), 2), fmt(at(result, 'search.keystrokeMs.p95'), 1), fmt(at(result, 'selectNet.firstDrawMs'), 0), String(at(result, 'selectNet.pins') ?? '-'), String(at(result, 'idle.draws') ?? '-'),
  ])));
  if (report.budget && Array.isArray(report.budget.rows)) {
    lines.push('', `## Budgets (${report.budget.file}, report only unless strict)`, '');
    lines.push(table(['Result', 'Size', 'Budget', 'Measured', 'Maximum'], report.budget.rows.map(row => [
      row.status === 'pass' ? 'PASS' : row.status === 'fail' ? 'FAIL' : row.status === 'no-data' ? 'NO DATA' : 'skipped', row.size, row.label,
      row.value === null ? '-' : `${fmt(row.value, row.unit === 'ms' && row.value < 100 ? 2 : 0)} ${row.unit}`, `${row.max} ${row.unit}`,
    ])));
    lines.push('', `${report.budget.pass} pass, ${report.budget.fail} fail, ${report.budget.noData} no data, ${report.budget.notMeasured} skipped.`);
  }
  const failed = sizes.filter(result => result.status !== 'ok');
  if (failed.length) lines.push('', '## Failed runs', '', ...failed.map(result => `- ${result.size}: ${result.error || 'no reason recorded'}`));
  return `${lines.join('\n')}\n`;
}

/** Ratio table of two reports (second against first): below 1 is faster or smaller than the first. */
function compareReports(first, second) {
  const bySize = report => new Map(sizesOf(report).filter(result => result.status === 'ok').map(result => [result.size, result]));
  const a = bySize(first), b = bySize(second);
  const common = SIZE_ORDER.filter(size => a.has(size) && b.has(size));
  const lines = [`# Comparison: ${second.label} against ${first.label}`, '', `- ${first.label}: ${first.conditions || 'conditions not recorded'}, ${first.startedAt || '?'}`, `- ${second.label}: ${second.conditions || 'conditions not recorded'}, ${second.startedAt || '?'}`, '- Ratio = second / first; below 1.00 is faster or smaller. Runs under different load are only roughly comparable.', ''];
  if (!common.length) return `${lines.join('\n')}No board size was measured in both reports.\n`;
  const rows = [];
  for (const [label, metric, unit, digits] of COMPARE_METRICS) {
    for (const size of common) {
      const x = at(a.get(size), metric), y = at(b.get(size), metric);
      if (typeof x !== 'number' || typeof y !== 'number') continue;
      rows.push([label, size, `${fmt(x, digits)} ${unit}`, `${fmt(y, digits)} ${unit}`, x > 0 ? (y / x).toFixed(2) : '-']);
    }
  }
  lines.push(table(['Metric', 'Size', first.label, second.label, 'Ratio'], rows));
  return `${lines.join('\n')}\n`;
}

function cli(argv) {
  const argument = name => { const hit = argv.find(item => item.startsWith(`--${name}=`)); return hit ? hit.slice(name.length + 3) : undefined; };
  const input = argv.find(item => !item.startsWith('--'));
  if (!input || argv.includes('--help')) { console.log('Usage: node scripts/perf-report.cjs <report.json> [--compare=<earlier-report.json>] [--out=<file.md>]'); return input ? 0 : 2; }
  try {
    const report = JSON.parse(fs.readFileSync(path.resolve(input), 'utf8'));
    const other = argument('compare');
    const text = other ? compareReports(JSON.parse(fs.readFileSync(path.resolve(other), 'utf8')), report) : formatMarkdown(report);
    if (argument('out')) fs.writeFileSync(path.resolve(argument('out')), text); else process.stdout.write(text);
    return 0;
  } catch (error) { console.error(error.message); return 1; }
}

module.exports = { COMPARE_METRICS, fmt, formatMarkdown, compareReports };

if (require.main === module) process.exitCode = cli(process.argv.slice(2));
