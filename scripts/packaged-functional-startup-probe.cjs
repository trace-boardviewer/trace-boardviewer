'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { fileSha, inspectFuses } = require('./packaged-functional-qa.cjs');
const { launchWithPreMainObservers, waitForPortRelease, withTimeout } = require('./packaged-functional-inspector.cjs');

const EXPECTED_EXE = '3f1bdd39b4252f2374a2acd0fe2e751213afc29ee1344339bd45091036e6eadd';
const EXPECTED_ASAR = '7817dec05f00fd37717eda54e05ee4d519a9e53e4966418697f06b7b533c8b71';
const ROOT = path.resolve(__dirname, '..');

async function main(argv = process.argv.slice(2)) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index], value = argv[index + 1];
    if (!['--executable', '--asar', '--out'].includes(key) || !value || values.has(key)) throw new Error('Use --executable <file> --asar <file> --out <file>.');
    values.set(key, path.resolve(value));
  }
  if (values.size !== 3 || [...values.values()].some((value) => !path.isAbsolute(value))) throw new Error('All probe paths are required and must be absolute.');
  const executable = values.get('--executable'), asar = values.get('--asar'), out = values.get('--out');
  const report = { schema: 'trace-packaged-startup-probe/1', startedAt: new Date().toISOString(), status: 'fail', expected: { executableSha256: EXPECTED_EXE, asarSha256: EXPECTED_ASAR } };
    let app = null, child = null, profileRoot = null, forced = false, stderr = '';
  try {
    assert.equal(process.platform, 'win32', 'this bounded artifact probe is the original Windows package run');
    report.artifact = { executableSha256: await fileSha(executable), asarSha256: await fileSha(asar), fuses: await inspectFuses(executable) };
    assert.equal(report.artifact.executableSha256, EXPECTED_EXE, 'the exact original Windows executable is tested');
    assert.equal(report.artifact.asarSha256, EXPECTED_ASAR, 'the exact original ASAR is tested');
    await fs.mkdir(path.dirname(out), { recursive: true });
    profileRoot = await fs.mkdtemp(path.join(path.dirname(out), '.profile-'));
    const profile = path.join(profileRoot, 'profile');
    await fs.mkdir(profile);
    await fs.writeFile(path.join(profile, 'config.json'), JSON.stringify({ updateCheck: false }));
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.VITE_DEV_SERVER_URL;
    const launched = await launchWithPreMainObservers({ executablePath: executable, args: ['--user-data-dir=' + profile], env, timeout: 60000 }, { timeout: 60000 });
    app = launched.app;
    child = app.process();
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    await app.firstWindow();
    const identity = await app.evaluate(({ app: electronApp }) => ({ isPackaged: electronApp.isPackaged, pid: process.pid, executable: process.execPath, appPath: electronApp.getAppPath() }));
    assert.equal(identity.isPackaged, true);
    assert.equal(await fileSha(identity.executable), EXPECTED_EXE);
    assert.equal(await fileSha(identity.appPath), EXPECTED_ASAR);
    const snapshot = await app.evaluate(() => globalThis.__traceQaPreMainSnapshot());
    assert.equal(snapshot.installedBeforeReady, true);
    assert.equal(snapshot.ready, true);
    assert.equal(snapshot.packaged, true);
    assert.ok(snapshot.windows > 0);
    assert.ok(snapshot.sessions >= 1);
    assert.ok(snapshot.network.every((request) => request.cancelledBeforeNetwork === true));
    assert.equal(snapshot.errors.length, 0, 'startup and window observers recorded no fatal or renderer errors');
    report.startup = launched.proof;
    report.runtime = { isPackaged: identity.isPackaged, executableSha256: await fileSha(identity.executable), asarSha256: await fileSha(identity.appPath) };
    report.observation = { installedBeforeReady: snapshot.installedBeforeReady, ready: snapshot.ready, windows: snapshot.windows,
      sessions: snapshot.sessions, events: snapshot.events, cancelledExternalRequests: snapshot.network.length,
      allExternalRequestsCancelled: snapshot.network.every((request) => request.cancelledBeforeNetwork === true), errors: snapshot.errors.length,
      externalIntents: snapshot.external.length };
    const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
    await app.evaluate(({ app: electronApp }) => electronApp.quit());
    report.exit = await withTimeout(exited, 10000, 'Packaged app did not exit after quit').catch(() => null);
    if (!report.exit) {
      await app.close();
      report.exit = await withTimeout(exited, 3000, 'Packaged app did not exit after Playwright close').catch(() => null);
    }
    app = null;
    if (!report.exit) {
      forced = true;
      child.kill();
      throw new Error('Packaged app did not exit after close within the probe bound');
    }
    assert.equal(report.exit.code, 0, 'original packaged app exits normally');
    assert.equal(report.exit.signal, null);
    assert.equal(forced, false);
    report.startup.inspectorPort = launched.port;
    report.startup.inspectorPortReleased = await waitForPortRelease(launched.port);
    const marker = stderr.match(/TRACE_QA_PREMAIN_FINAL (\{[^\r\n]+\})/)?.[1];
    assert.ok(marker, 'pre-main observers recorded state from the will-quit event');
    report.willQuit = JSON.parse(marker);
    assert.equal(report.willQuit.pid, identity.pid);
    assert.equal(report.willQuit.allExternalRequestsCancelled, true);
    assert.equal(report.willQuit.errors, 0);
    assert.equal(report.willQuit.externalIntents, 0);
    assert.deepEqual(await inspectFuses(executable), report.artifact.fuses, 'packaged fuse values remain unchanged');
    report.sourceSha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim();
    report.status = 'pass';
  } catch (error) {
    report.failure = { message: error.message, stack: String(error.stack || error) };
  } finally {
    if (app) await app.close().catch(() => {});
    await fs.mkdir(path.dirname(out), { recursive: true });
    await fs.writeFile(out, JSON.stringify(report, null, 2) + '\n');
    if (profileRoot) {
      for (let attempt = 0; attempt < 5; attempt++) {
        try { await fs.rm(profileRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); break; }
        catch (error) { if (attempt === 4) report.profileCleanupError = error.message; else await new Promise((resolve) => setTimeout(resolve, 250)); }
      }
      if (report.profileCleanupError) await fs.writeFile(out, JSON.stringify(report, null, 2) + '\n');
    }
  }
  if (report.status !== 'pass') throw new Error('Packaged startup probe failed; private report was written.');
  return report;
}

if (require.main === module) main().then((report) => console.log(JSON.stringify({ status: report.status, startup: report.startup, observation: report.observation, exit: report.exit }, null, 2)))
  .catch((error) => { console.error(error.message || error); process.exitCode = 1; });

module.exports = Object.freeze({ main, EXPECTED_EXE, EXPECTED_ASAR });
