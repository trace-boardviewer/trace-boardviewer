'use strict';

// Offline Windows spike. Builds an isolated application using the installed Electron and current production fuses.
// No renderer, network, dependency install or production executable/configuration changes.
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');

async function dependency(name, file) {
  const modules = path.join(root, 'node_modules', '.pnpm');
  const prefix = `${name.replace('/', '+')}@`;
  const entries = (await fs.readdir(modules)).filter(item => item.startsWith(prefix));
  if (entries.length !== 1) throw new Error(`Expected one installed ${name}`);
  return require(path.join(modules, entries[0], 'node_modules', name, file));
}

(async () => {
  if (process.platform !== 'win32') throw new Error('This packaging probe targets Windows.');
  const directory = path.join(root, 'test-results', `readings-sqlite-${Date.now()}`);
  const runtime = path.join(directory, 'runtime');
  const source = path.join(directory, 'app');
  await fs.mkdir(source, { recursive: true });
  await fs.cp(path.join(root, 'node_modules', 'electron', 'dist'), runtime, { recursive: true });
  for (const name of ['main', 'child', 'probe']) {
    await fs.copyFile(path.join(__dirname, 'fixtures', `readings-sqlite-${name}.cjs`), path.join(source, `readings-sqlite-${name}.cjs`));
  }
  await fs.writeFile(path.join(source, 'package.json'), JSON.stringify({ name: 'sqlite-feature-probe', version: '1.0.0', main: 'readings-sqlite-main.cjs' }));
  const asar = await dependency('@electron/asar', 'lib/asar.js');
  const archive = path.join(runtime, 'resources', 'app.asar');
  // Worker threads require a real entry file; utilityProcess also loads the same unpacked script.
  await asar.createPackageWithOptions(source, archive, { unpack: '*.cjs' });
  await fs.unlink(path.join(runtime, 'resources', 'default_app.asar'));
  const executable = path.join(runtime, 'electron.exe');
  const { addWinAsarIntegrity } = await dependency('app-builder-lib', 'out/electron/electronWin.js');
  const { computeData } = await dependency('app-builder-lib', 'out/asar/integrity.js');
  await addWinAsarIntegrity(executable, await computeData({ resourcesPath: path.join(runtime, 'resources'), resourcesRelativePath: 'resources' }));
  const { flipFuses, getCurrentFuseWire, FuseVersion, FuseV1Options } = await dependency('@electron/fuses', 'dist/index.js');
  const settings = require('../package.json').build.electronFuses;
  const names = {
    runAsNode: 'RunAsNode', enableCookieEncryption: 'EnableCookieEncryption',
    enableNodeOptionsEnvironmentVariable: 'EnableNodeOptionsEnvironmentVariable', enableNodeCliInspectArguments: 'EnableNodeCliInspectArguments',
    enableEmbeddedAsarIntegrityValidation: 'EnableEmbeddedAsarIntegrityValidation', onlyLoadAppFromAsar: 'OnlyLoadAppFromAsar',
    grantFileProtocolExtraPrivileges: 'GrantFileProtocolExtraPrivileges',
  };
  const config = { version: FuseVersion.V1 };
  for (const [key, name] of Object.entries(names)) config[FuseV1Options[name]] = settings[key];
  await flipFuses(executable, config);
  const wire = await getCurrentFuseWire(executable);
  await fs.writeFile(path.join(directory, 'fuses.json'), JSON.stringify({ configured: settings, wire }, null, 2));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  const child = spawn(executable, [directory], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  child.stdout.on('data', chunk => { logs += chunk; });
  child.stderr.on('data', chunk => { logs += chunk; });
  const timeout = setTimeout(() => child.kill(), 120000);
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  clearTimeout(timeout);
  await fs.writeFile(path.join(directory, 'runtime.log'), logs);
  process.stdout.write(`Evidence: ${path.relative(root, directory)}; exit: ${code}\n`);
  const result = await fs.readFile(path.join(directory, 'result.json'), 'utf8');
  process.stdout.write(`${result}\n`);
  process.exitCode = code === 0 ? 0 : 1;
})().catch(error => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
