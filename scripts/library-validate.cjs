/* Emit the standalone validation source as CommonJS; no compiler or runtime dependency. */
const fs = require('node:fs');
const path = require('node:path');
const { stripTypeScriptTypes } = require('node:module');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'src/lib/library/validate.ts'), 'utf8');
const names = [...source.matchAll(/^export (?:function|const) (\w+)/gm)].map(match => match[1]);
const output = '/* Generated from src/lib/library/validate.ts by scripts/library-validate.cjs. */\n' +
  stripTypeScriptTypes(source, { mode: 'strip' }).replace(/^export /gm, '').replace(/[ \t]+$/gm, '') + '\nmodule.exports = { ' + names.join(', ') + ' };\n';
const target = path.join(root, 'electron/library/validate.cjs');
if (process.argv.includes('--check')) {
  if (!fs.existsSync(target) || fs.readFileSync(target, 'utf8') !== output) { process.stderr.write('Library validator twin is stale.\n'); process.exitCode = 1; }
} else { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, output); }
