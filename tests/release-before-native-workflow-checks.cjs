'use strict';

// Focused static guard for the 1.3.1 publish-first release exception. This parses the real shared workflow but never builds or launches an app.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const workflowPath = path.join(ROOT, '.github', 'workflows', 'windows.yml');
const builderManifest = require.resolve('electron-builder/package.json', { paths: [ROOT] });
const libDirectory = path.dirname(require.resolve('app-builder-lib/package.json', { paths: [path.dirname(builderManifest)] }));
const yaml = require(require.resolve('js-yaml', { paths: [libDirectory] }));
const workflowText = fs.readFileSync(workflowPath, 'utf8').replace(/\r\n/g, '\n');
const workflow = yaml.load(workflowText);

const step = (jobName, name) => {
  const found = workflow.jobs[jobName]?.steps?.find((entry) => entry.name === name);
  assert.ok(found, `step ${JSON.stringify(name)} exists in ${jobName}`);
  return found;
};
const nativeIf = (jobName) => jobName === 'portable-isolation' || jobName === 'portable-startup-measurement'
  ? "needs.build.outputs.native_acceptance == 'true'"
  : "steps.metadata.outputs.native_acceptance == 'true'";
const assertEnabled = (jobName, name) => {
  const condition = step(jobName, name).if || '';
  assert.ok(condition.includes(nativeIf(jobName)), `${jobName}/${name} is guarded by the actual native_acceptance output`);
};
const assertUngated = (candidate, jobName, name) => {
  const found = candidate.jobs[jobName]?.steps?.find((entry) => entry.name === name);
  assert.ok(found, `step ${JSON.stringify(name)} exists in ${jobName}`);
  const condition = found.if || '';
  assert.ok(!condition.includes('native_acceptance'), `${jobName}/${name} remains enabled for 1.3.1 automatic pushes`);
};
const acceptsNative = (version, eventName) => !(version === '1.3.1' && eventName === 'push');

function assertReleaseGuards(candidate) {
  const guardedSteps = [
    ['build', 'Run packaged functional QA against the manifest-linked Windows payload'],
    ['build', 'Validate packaged functional QA evidence manifest'],
    ['build', 'Upload packaged functional QA evidence'],
    ['portable-isolation', 'Check portable instance isolation'],
    ['portable-isolation', 'Show Portable instance isolation summary'],
    ['portable-isolation', 'Upload isolation evidence'],
    ['portable-startup-measurement', 'Measure startup race and second-instance leftovers'],
    ['portable-startup-measurement', 'Show startup measurement summary'],
    ['portable-startup-measurement', 'Upload startup measurement'],
    ['mac', 'Run the packaged-app smoke test'],
    ['mac', 'Run packaged functional QA against the extracted ZIP payload'],
    ['mac', 'Validate macOS packaged functional QA evidence manifest'],
    ['mac', 'Show macOS smoke summary'],
    ['mac', 'Upload macOS smoke evidence'],
    ['mac', 'Upload macOS packaged functional QA evidence'],
    ['linux', 'Smoke-test the .deb under the stock user-namespace restriction (S1, sandbox on through its AppArmor profile)'],
    ['linux', 'Run packaged functional QA against the installed DEB under S1 sandbox policy'],
    ['linux', 'Show packaged functional QA summary'],
    ['linux', 'Validate Linux DEB packaged functional QA evidence manifest'],
    ['linux', 'Upload packaged functional QA evidence'],
    ['linux', 'Smoke-test the AppImage under the stock restriction (S2, no sandbox, the consent dialog is answered)'],
    ['linux', 'Allow unprivileged user namespaces (the default of Fedora, Debian, Arch and older Ubuntu releases)'],
    ['linux', 'Smoke-test the AppImage with user namespaces allowed (S3, sandbox on)'],
    ['linux', 'Run packaged functional QA against the AppImage under S3 sandbox policy'],
    ['linux', 'Verify and upload AppImage functional evidence'],
    ['linux', 'Upload AppImage packaged functional QA evidence'],
    ['linux', 'Smoke-test the unpacked app with user namespaces allowed (S4, sandbox on)'],
    ['linux', 'Show Linux smoke summary'],
    ['linux', 'Upload Linux smoke evidence'],
    ['linux', 'Stop leftover app processes'],
  ];
  for (const [jobName, name] of guardedSteps) {
    const found = candidate.jobs[jobName]?.steps?.find((entry) => entry.name === name);
    assert.ok(found, `step ${JSON.stringify(name)} exists in ${jobName}`);
    assert.ok((found.if || '').includes(nativeIf(jobName)), `${jobName}/${name} retains its native acceptance gate`);
  }

  for (const jobName of ['build', 'mac', 'linux']) {
    const metadata = candidate.jobs[jobName].steps.find((entry) => entry.id === 'metadata');
    assert.ok(metadata?.run?.includes("'1.3.1'"), `${jobName} derives the gate from the actual release version`);
    assert.ok(metadata?.run?.includes("'push'"), `${jobName} derives the gate from the actual event`);
    assert.equal(metadata.env?.TRACE_EVENT_NAME, '${{ github.event_name }}', `${jobName} passes the actual event to release metadata`);
    assert.ok(candidate.jobs[jobName].outputs?.native_acceptance === '${{ steps.metadata.outputs.native_acceptance }}', `${jobName} publishes the metadata gate as a job output`);
  }
  assert.equal(candidate.jobs.build.steps.find((entry) => entry.id === 'metadata').run.includes('TRACE_EVENT_NAME -ne'), true,
    'Windows enables native acceptance for manual, PR, and all non-1.3.1 events');

  const portableRun = candidate.jobs['portable-isolation'].steps.find((entry) => entry.name === 'Check portable instance isolation');
  assert.equal(portableRun.if, "needs.build.outputs.native_acceptance == 'true'", 'portable runtime job consumes the real build output');
  assert.ok(candidate.jobs['portable-isolation'].steps.some((entry) => entry.name === 'Verify the downloaded EXE is the uploaded payload' && !entry.if), 'downloaded artifact checksum verification remains unconditional');
  assert.ok(candidate.jobs['portable-isolation'].steps.some((entry) => entry.name === 'Verify the downloaded payload manifest' && !entry.if), 'downloaded manifest verification remains unconditional');
  assert.ok(candidate.jobs['portable-isolation'].steps.some((entry) => entry.name === 'Record deferred portable runtime acceptance' && entry.if === "needs.build.outputs.native_acceptance == 'false'"), 'deferred run writes an explicit job summary');

  const windowsFuse = candidate.jobs.build.steps.find((entry) => entry.name === 'Inspect configured Electron fuse bytes in the Windows payload');
  assert.ok(windowsFuse && !windowsFuse.if && windowsFuse.run.includes("inspectFuses(process.argv[1])") && windowsFuse.run.includes('release/win-unpacked/TRACE Boardviewer.exe'), 'Windows inspects the actual built executable statically even when runtime acceptance is deferred');
  const macExtract = candidate.jobs.mac.steps.find((entry) => entry.name === 'Extract the checksummed macOS ZIP for packaged functional QA');
  const macFuse = candidate.jobs.mac.steps.find((entry) => entry.name === 'Inspect configured Electron fuse bytes in the checksummed macOS ZIP');
  assert.ok(macExtract && !macExtract.if && macExtract.run.includes('shasum -a 256 -c'), 'macOS extracts and verifies the exact package checksum unconditionally');
  assert.ok(macFuse && !macFuse.if && macFuse.run.includes('inspectFuses(process.argv[1])') && macFuse.run.includes('TRACE_FUNCTIONAL_APP/Contents/MacOS/TRACE Boardviewer'), 'macOS inspects the executable extracted from that verified ZIP without launching it');

  for (const [jobName, names] of Object.entries({
    build: ['Run parser and geometry tests', 'Run desktop boundary and persistence tests', 'Build portable Windows EXE', 'Generate EXE checksum', 'Generate payload manifest of the unpacked app', 'Inspect configured Electron fuse bytes in the Windows payload', 'Upload portable EXE and checksum', 'Upload payload manifest'],
    mac: ['Run the static macOS packaging checks', 'Run TypeScript checks', 'Run parser and geometry tests', 'Run desktop boundary and persistence tests', 'Build the renderer', 'Build the unsigned macOS app', 'Extract the checksummed macOS ZIP for packaged functional QA', 'Inspect configured Electron fuse bytes in the checksummed macOS ZIP', 'Scan the app bundle for private names and paths', 'Upload macOS zip and checksum'],
    linux: ['Run the static Linux packaging checks', 'Run parser and geometry tests', 'Run desktop boundary and persistence tests', 'Build the renderer', 'Build the Linux packages', 'Check the packages statically (S0)', 'Scan the packages for private names and paths', 'Upload Linux packages and checksums'],
  })) for (const name of names) {
    const found = candidate.jobs[jobName].steps.find((entry) => entry.name === name);
    assert.ok(found, `${jobName}/${name} exists`);
    assertUngated(candidate, jobName, name);
  }
  assert.deepEqual(candidate.jobs['draft-release'].needs, ['build', 'portable-isolation', 'mac', 'linux'], 'the release draft keeps all four package/integrity prerequisites');
}

test('only the 1.3.1 automatic push defers packaged native acceptance', () => {
  assert.equal(acceptsNative('1.3.1', 'push'), false);
  assert.equal(acceptsNative('1.3.1', 'workflow_dispatch'), true, 'manual runs retain native tests');
  assert.equal(acceptsNative('1.3.1', 'pull_request'), true, 'pull requests retain their existing behavior');
  assert.equal(acceptsNative('1.3.2', 'push'), true, 'future stable versions retain native tests');
  assert.equal(acceptsNative('1.3.1-rc.1', 'push'), true, 'future/suffixed releases retain native tests');
  assertReleaseGuards(workflow);
});

test('negative controls catch a missing native guard and a skipped source build', () => {
  const missingGuard = structuredClone(workflow);
  missingGuard.jobs.mac.steps.find((entry) => entry.name === 'Run the packaged-app smoke test').if = undefined;
  assert.throws(() => assertReleaseGuards(missingGuard), /retains its native acceptance gate/);

  const futureDisabled = structuredClone(workflow);
  const linuxMetadata = futureDisabled.jobs.linux.steps.find((entry) => entry.id === 'metadata');
  linuxMetadata.run = linuxMetadata.run.replace("'1.3.1'", "'1.3.2'");
  assert.throws(() => assertReleaseGuards(futureDisabled), /derives the gate from the actual release version/);

  const sourceBuildSkipped = structuredClone(workflow);
  sourceBuildSkipped.jobs.mac.steps.find((entry) => entry.name === 'Build the unsigned macOS app').if = "steps.metadata.outputs.native_acceptance == 'true'";
  assert.throws(() => assertReleaseGuards(sourceBuildSkipped));
});
