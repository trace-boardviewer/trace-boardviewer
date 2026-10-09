'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const root = path.resolve(__dirname, '..');
const contractPath = path.join(root, 'shared/bug-report-contract.cjs');
const workerPath = path.join(root, 'services/bug-report-worker/worker.mjs');
const schemaPath = path.join(root, 'electron/diagnostic-schema.json');
const outputPath = path.join(root, 'services/bug-report-worker/bundle.mjs');
const contractImport = "import contract from '../../shared/bug-report-contract.cjs';";
const schemaRequire = "const diagnosticSchema = require('../electron/diagnostic-schema.json');";

const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
const contract = require(contractPath);
const vectors = JSON.parse(fs.readFileSync(path.join(root, 'shared/bug-report-contract.vectors.json'), 'utf8'));
for (const vector of vectors.vectors) {
  const canonical = contract.canonicalizeBugReport(vector.report);
  const digest = crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
  if (canonical !== vector.canonical || digest !== vector.sha256) throw new Error(`Canonical vector mismatch: ${vector.name}`);
}
let contractSource = fs.readFileSync(contractPath, 'utf8').replace(/\r\n/g, '\n');
if (!contractSource.includes(schemaRequire) || !contractSource.includes('module.exports = Object.freeze(')) {
  throw new Error('Contract bundler anchors are missing; refusing a partial output.');
}
contractSource = contractSource.replace(schemaRequire, `const diagnosticSchema = ${JSON.stringify(schema)};`);
const embeddedContract = `const contract = (() => { const module = { exports: {} };\n${contractSource}\nreturn module.exports; })();`;
let workerSource = fs.readFileSync(workerPath, 'utf8').replace(/\r\n/g, '\n');
if (!workerSource.startsWith(contractImport)) throw new Error('Worker contract import must remain the first line.');
workerSource = workerSource.replace(contractImport, embeddedContract);
const hash = crypto.createHash('sha256').update(workerSource, 'utf8').digest('hex');
if (process.argv.includes('--check')) {
  if (!fs.existsSync(outputPath) || fs.readFileSync(outputPath, 'utf8') !== workerSource) throw new Error('Worker bundle is stale; run the build command and review the resulting hash.');
} else fs.writeFileSync(outputPath, workerSource, 'utf8');
process.stdout.write(JSON.stringify({ output: path.relative(root, outputPath).replaceAll(path.sep, '/'), bytes: Buffer.byteLength(workerSource), sha256: hash }) + '\n');
