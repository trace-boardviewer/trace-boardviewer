'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { validateEvidenceManifest, verifyScreenshotManifest } = require('./packaged-functional-qa.cjs');

async function validate(reportPath, screenshotDirectory) {
  const report = JSON.parse(await fs.readFile(reportPath, 'utf8'));
  const problems = validateEvidenceManifest(report, report.screenshotManifest);
  try { await verifyScreenshotManifest(screenshotDirectory, report.screenshotManifest); }
  catch (error) { problems.push(`screenshot verification failed: ${error.message}`); }
  return problems;
}

async function main(argv = process.argv.slice(2)) {
  const values = new Map();
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i], value = argv[i + 1];
    if (!['--report', '--screenshots'].includes(key) || !value || values.has(key)) throw new Error('Use --report <file> --screenshots <directory>.');
    values.set(key, value);
  }
  if (values.size !== 2) throw new Error('Both report and screenshot directory are required.');
  const report = path.resolve(values.get('--report'));
  const screenshots = path.resolve(values.get('--screenshots'));
  const problems = await validate(report, screenshots);
  if (problems.length) throw new Error('Functional QA evidence is incomplete: ' + problems.join('; '));
  console.log('Packaged functional QA evidence manifest verified.');
}

if (require.main === module) main().catch((error) => { console.error(error.message || error); process.exitCode = 1; });
module.exports = Object.freeze({ validate, main });
