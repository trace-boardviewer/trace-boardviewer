'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { runInNewContext } = require('node:vm');
const {
  isReportRecord, isCancelledAttempt, isExpectedSupportDenial, reconcileBugReportNetworkEvidence,
  waitForPageValue, pendingDraftMatches,
  OBSERVER_SCHEMA, REPORT_ID,
} = require('../scripts/packaged-functional/bug-reports.cjs');
const { collectShutdownEvidence } = require('../scripts/packaged-functional-qa.cjs');

test('async draft bridge polling awaits page.evaluate booleans with bounded true and false outcomes', async () => {
  let ready = false;
  const page = { evaluate: async (predicate) => await predicate() };
  setTimeout(() => { ready = true; }, 15);
  assert.equal(await waitForPageValue(page, async () => ready, 'synthetic async bridge', 300), true);
  await assert.rejects(() => waitForPageValue(page, async () => false, 'synthetic false bridge', 20), /Timed out waiting/);
});

test('uncertain draft bridge projects only exact UUID/hash/byte equality to the QA host', async () => {
  const canonicalText = JSON.stringify({ reportId: '3b241e0b-b013-4a53-8f1d-000000000001', description: 'PRIVATE_PENDING_DESCRIPTION' });
  const sha256 = crypto.createHash('sha256').update(canonicalText).digest('hex');
  const result = { status: 'available', draft: null, pending: { report: { reportId: '3b241e0b-b013-4a53-8f1d-000000000001' }, canonicalText, payloadHash: sha256 } };
  const page = { evaluate: (predicate, identity) => runInNewContext(`(${predicate.toString()})(identity)`, {
    identity, window: { traceDesktop: { getBugReportDraft: async () => result } }, crypto: crypto.webcrypto, TextEncoder,
  }) };
  const expected = { reportId: result.pending.report.reportId, bytes: Buffer.byteLength(canonicalText), sha256 };
  assert.equal(await pendingDraftMatches(page, expected), true);
  assert.equal(await pendingDraftMatches(page, { ...expected, bytes: expected.bytes + 1 }), false);
  assert.equal(JSON.stringify(expected).includes(canonicalText), false, 'canonical text remains in the renderer and never crosses the bridge into evidence assertions');
});

test('installed Playwright 1.62.1 confirms waitForFunction resolves to a handle, not a primitive boolean', () => {
  const packageRoot = path.resolve(__dirname, '..', 'node_modules', '.pnpm');
  const coreEntry = fs.readdirSync(packageRoot).find((entry) => /^playwright-core@1\.62\.1(?:_|$)/.test(entry));
  assert.ok(coreEntry, 'the installed Playwright core package is available');
  const core = path.join(packageRoot, coreEntry, 'node_modules', 'playwright-core');
  assert.equal(JSON.parse(fs.readFileSync(path.join(core, 'package.json'), 'utf8')).version, '1.62.1');
  const types = fs.readFileSync(path.join(core, 'types', 'types.d.ts'), 'utf8');
  assert.match(types, /waitForFunction<R>\(pageFunction: PageFunction<void, R>, arg\?: any, options\?: PageWaitForFunctionOptions\): Promise<SmartHandle<R>>/);
  assert.match(fs.readFileSync(path.join(core, 'lib', 'coreBundle.js'), 'utf8'), /return JSHandle2\.from\(result2\.handle\)/);
});

const action = Object.freeze({ launch: 2, actionID: 'bug-report-send-1', reportId: '3b241e0b-b013-4a53-8f1d-000000000001',
  bytes: 64, sha256: 'a'.repeat(64), acknowledgement: 'received' });
const uncertain = Object.freeze({ launch: 2, actionID: 'bug-report-send-2', reportId: '3b241e0b-b013-4a53-8f1d-000000000002',
  bytes: 65, sha256: 'b'.repeat(64), acknowledgement: 'uncertain' });
const retry = Object.freeze({ ...uncertain, launch: 3, actionID: 'bug-report-send-3', acknowledgement: 'received' });
const allowed = (item) => Object.freeze({ targetID: REPORT_ID, method: 'POST', bytes: item.bytes, sha256: item.sha256,
  actionID: item.actionID, decision: 'allow' });
const allowedRecord = allowed(action);
const support = Object.freeze({ session: 'trace-egress', url: 'https://trace-support.trace-boardviewer.workers.dev/receipt?claim=synthetic',
  method: 'GET', cancelledBeforeNetwork: true, source: 'Electron webRequest pre-main observer' });
const counts = (overrides = {}) => ({ version: 2, allowedCount: 0, deniedCount: 0, gateArms: 0, gateFailures: 0, responseArms: 0, responseFailures: 0, ...overrides });

const response = Object.freeze({ actionID: uncertain.actionID, mode: 'hold-and-cancel', phase: 'cancelled', outcome: 'cancelled', statusCode: 200 });
const cancelOracle = Object.freeze({ actionID: uncertain.actionID, cancelAccepted: true, sendTerminalUncertain: true,
  heldAtCancelAccepted: true, heldAtSendTerminal: true, cancelRequestMatchesSend: true,
  cancelOutcome: 'accepted', sendOutcome: 'uncertain', generation: 3 });
const localAcceptance = Object.freeze({ completed: true, localPostCount: 0, localIntentCount: 0, localActions: true,
  locales: ['hu','en','de','fr','it','sk','pl','uk'] });
const syntheticDelivery = Object.freeze({ completed: true, injectedNativeEvent: true, sameDialogPreserved: true,
  originalContextPreserved: true, reopenContextChanged: true });

function makeEvidence() {
  const launch = (number, networkAttempts = [], attempts = [], values = counts(), responses = [], cancelOracles = [], externalIntents = []) => ({
    launch: number,
    reportObserverCaptureValid: true,
    networkAttempts,
    externalIntents,
    reportObserver: { ...values, attempts, responses, cancelOracles,
      finalMarker: { ...counts(values), attempts, responses, cancelOracles } },
    startupObservation: { finalNetworkCount: networkAttempts.length,
      finalExternalIntents: externalIntents.length, cancelledRequests: networkAttempts.every(isCancelledAttempt), reportObserver: counts(values) },
  });
  const launches = [launch(1, [support], [], counts(), [], [], ['https://donate.stripe.com/7sYaEZeET2op8PxaGE5EY00','https://donate.stripe.com/7sYaEZeET2op8PxaGE5EY00']),
    launch(2, [allowed(action), allowed(uncertain)], [allowed(action), allowed(uncertain)], counts({ allowedCount: 2, gateArms: 2, responseArms: 1 }), [response], [cancelOracle]),
    launch(3, [allowed(retry)], [allowed(retry)], counts({ allowedCount: 1, gateArms: 1 }))];
  const aggregate=counts({allowedCount:3,gateArms:3,responseArms:1});
  return {
    launches,
    networkAttempts: launches.flatMap((entry) => entry.networkAttempts),
    bugReportObserver: { schema: OBSERVER_SCHEMA, completed: true, actions: [action,uncertain,retry], responses: [response],
      localAcceptance, syntheticDelivery, finalObserver: aggregate },
  };
}

test('closed report evidence accepts one exact acknowledged Send and the existing blocked support check', () => {
  const evidence = makeEvidence();
  assert.deepEqual(reconcileBugReportNetworkEvidence(evidence), []);
  assert.equal(isReportRecord(allowedRecord), true);
  assert.equal(isExpectedSupportDenial(support), true);
  assert.equal(JSON.stringify(evidence).includes('description'), false);
  assert.equal(JSON.stringify(evidence).includes('report body'), false);
});

test('supplemental scope keeps the support denial sentinel and exact reports but requires zero intents', () => {
  const evidence = makeEvidence();
  for (const launch of evidence.launches) {
    launch.externalIntents = [];
    launch.startupObservation.finalExternalIntents = 0;
  }
  assert.deepEqual(reconcileBugReportNetworkEvidence(evidence, { scope: 'bug-report-supplemental' }), []);
  assert.ok(reconcileBugReportNetworkEvidence(evidence, { scope: 'unexpected' }).some((problem) => /scope options/.test(problem)));
  assert.ok(reconcileBugReportNetworkEvidence(evidence, {}).some((problem) => /scope options/.test(problem)));
  assert.ok(reconcileBugReportNetworkEvidence(evidence, { scope: 'full-functional', extra: true }).some((problem) => /scope options/.test(problem)));
  const hiddenExtra = { scope: 'full-functional' };
  Object.defineProperty(hiddenExtra, 'hidden', { value: true });
  assert.ok(reconcileBugReportNetworkEvidence(evidence, hiddenExtra).some((problem) => /scope options/.test(problem)));
  const symbolExtra = { scope: 'full-functional', [Symbol('extra')]: true };
  assert.ok(reconcileBugReportNetworkEvidence(evidence, symbolExtra).some((problem) => /scope options/.test(problem)));
  evidence.launches[2].externalIntents = ['https://donate.stripe.com/7sYaEZeET2op8PxaGE5EY00'];
  evidence.launches[2].startupObservation.finalExternalIntents = 1;
  assert.ok(reconcileBugReportNetworkEvidence(evidence, { scope: 'bug-report-supplemental' }).some((problem) => /exactly 0 support Stripe/.test(problem)));
});

test('A and B must be admitted in the same launch and retry later', () => {
  const evidence = makeEvidence();
  evidence.bugReportObserver.actions[0] = { ...action, launch: 1 };
  assert.ok(reconcileBugReportNetworkEvidence(evidence).some((problem) => /A\/B\/lost-ack retry identities/.test(problem)));
});

test('missing scenario, Send action, or final observer marker fails closed', () => {
  const missingScenario = makeEvidence();
  delete missingScenario.bugReportObserver;
  assert.ok(reconcileBugReportNetworkEvidence(missingScenario).some((problem) => /scenario or observer action manifest is missing/.test(problem)));

  const noSend = makeEvidence();
  noSend.bugReportObserver.actions = [];
  noSend.bugReportObserver.finalObserver = counts();
  noSend.launches[2] = { ...noSend.launches[2], networkAttempts: [], reportObserver: { ...counts(), attempts: [], finalMarker: counts() },
    startupObservation: { finalNetworkCount: 0, cancelledRequests: true, reportObserver: counts() } };
  noSend.networkAttempts = noSend.launches.flatMap((entry) => entry.networkAttempts);
  assert.ok(reconcileBugReportNetworkEvidence(noSend).some((problem) => /exact three bounded sends/.test(problem)));

  const missingMarker = makeEvidence();
  missingMarker.launches[2].reportObserver.finalMarker = null;
  assert.ok(reconcileBugReportNetworkEvidence(missingMarker).some((problem) => /final observer marker is missing/.test(problem)));
});

test('report body, extra fields, changed hash, target or action cannot pass safe evidence checks', () => {
  for (const mutated of [
    { ...allowedRecord, targetID: 'unknown-receiver' },
    { ...allowedRecord, reportBody: 'synthetic private body' },
    { ...allowedRecord, responseHeaders: { 'set-cookie': ['private'] } },
  ]) assert.equal(isReportRecord(mutated), false);

  const evidence = makeEvidence();
  evidence.launches[2].networkAttempts[0] = { ...allowedRecord, sha256: 'b'.repeat(64) };
  evidence.networkAttempts = evidence.launches.flatMap((entry) => entry.networkAttempts);
  assert.notDeepEqual(reconcileBugReportNetworkEvidence(evidence), []);
});

test('an unarmed denied attempt from an unknown session invalidates the expected report trace', () => {
  const evidence = makeEvidence();
  const denied = { targetID: REPORT_ID, method: 'POST', bytes: action.bytes, sha256: action.sha256,
    actionID: null, decision: 'cancel' };
  evidence.launches[1].networkAttempts = [denied];
  evidence.launches[1].reportObserver = { ...counts({ deniedCount: 1 }), attempts: [denied], finalMarker: counts({ deniedCount: 1 }) };
  evidence.launches[1].startupObservation = { finalNetworkCount: 1, cancelledRequests: true, reportObserver: counts({ deniedCount: 1 }) };
  evidence.networkAttempts = evidence.launches.flatMap((entry) => entry.networkAttempts);
  assert.notDeepEqual(reconcileBugReportNetworkEvidence(evidence), []);
});

test('only the exact fixed support verification denial is accepted as unrelated traffic', () => {
  for (const url of ['https://elsewhere.invalid/receipt', 'https://trace-support.trace-boardviewer.workers.dev/other',
    'http://trace-support.trace-boardviewer.workers.dev/receipt',
    'https://trace-support.trace-boardviewer.workers.dev/receipt?claim=other',
    'https://user@trace-support.trace-boardviewer.workers.dev/receipt?claim=synthetic']) {
    assert.equal(isExpectedSupportDenial({ ...support, url }), false);
  }
  assert.equal(isExpectedSupportDenial({ ...support, body: 'unexpected evidence field' }), false);
  assert.equal(isCancelledAttempt({ ...allowedRecord, decision: 'allow' }), false);
  assert.equal(isCancelledAttempt({ ...allowedRecord, decision: 'cancel' }), true);
});

test('evidence reconciliation rejects observer schema extensions instead of dropping fields', () => {
  const evidence = makeEvidence();
  evidence.launches[0].reportObserver.rawUrl = 'https://private.invalid/?token=synthetic';
  assert.ok(reconcileBugReportNetworkEvidence(evidence).some((problem) => /unexpected or missing fields/.test(problem)));

  const marker = makeEvidence();
  marker.launches[2].reportObserver.finalMarker.rawBody = 'synthetic report text';
  assert.ok(reconcileBugReportNetworkEvidence(marker).some((problem) => /final observer marker is missing or conflicts/.test(problem)));
});

test('shutdown marker remains truthful for one allowed report and rejects conflicting counts', async () => {
  const v=counts({allowedCount:1,gateArms:1});
  const launchRecord = { launch: 3, identity: { pid: 77 }, startup: { inspectorPort: 45123 }, networkAttempts: [allowedRecord],
    reportObserver: { ...v, attempts: [allowedRecord], responses: [], cancelOracles: [], finalMarker: null },
    pageErrorStart: 0, consoleErrorStart: 0, cspErrorStart: 0 };
  const marker = { pid: 77, networkCount: 1, allExternalRequestsCancelled: false, errors: 0, ready: true, externalIntents: 0, sessions: 1,
    reportObserver: { ...v, attempts: [allowedRecord], responses: [], cancelOracles: [] } };
  const problems = await collectShutdownEvidence({ launchRecord, readStderr: () => '', pageErrors: [], consoleErrors: [], cspErrors: [],
    findMarker: async () => marker, releasePort: async () => true });
  assert.deepEqual(problems, []);
  assert.equal(launchRecord.startupObservation.willQuitCaptured, true);
  assert.deepEqual(launchRecord.reportObserver.finalMarker, marker.reportObserver);

  const mismatch = structuredClone(launchRecord);
  const mismatchProblems = await collectShutdownEvidence({ launchRecord: mismatch, readStderr: () => '', pageErrors: [], consoleErrors: [], cspErrors: [],
    findMarker: async () => ({ ...marker, reportObserver: { ...marker.reportObserver, allowedCount: 0 } }), releasePort: async () => true });
  assert.ok(mismatchProblems.some((problem) => /final report observer marker does not match/.test(problem)));
});
