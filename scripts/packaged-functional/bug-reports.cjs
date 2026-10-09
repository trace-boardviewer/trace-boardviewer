'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');

const OBSERVER_SCHEMA = 'trace-packaged-bug-report-observer/2';
const REPORT_ID = 'bug-report-receiver';
const REPORT_URL = 'https://trace-bug-report.trace-boardviewer.workers.dev/v1/reports';
const SUPPORT_HOST = 'trace-support.trace-boardviewer.workers.dev';
const SUPPORT_SOURCE = 'Electron webRequest pre-main observer';
const LOCALE_TAGS = Object.freeze({ hu: 'hu-HU', en: 'en-GB', de: 'de-DE', fr: 'fr-FR', it: 'it-IT', sk: 'sk-SK', pl: 'pl-PL', uk: 'uk-UA' });
const REPORT_RECORD_KEYS = Object.freeze(['targetID', 'method', 'bytes', 'sha256', 'actionID', 'decision']);
const ACTION_KEYS = Object.freeze(['launch', 'actionID', 'reportId', 'bytes', 'sha256', 'acknowledgement']);
const RESPONSE_KEYS = Object.freeze(['actionID', 'mode', 'phase', 'outcome', 'statusCode']);
const CANCEL_ORACLE_KEYS = Object.freeze(['actionID', 'cancelAccepted', 'sendTerminalUncertain', 'heldAtCancelAccepted', 'heldAtSendTerminal', 'cancelRequestMatchesSend', 'cancelOutcome', 'sendOutcome', 'generation']);

function hasExactKeys(value, keys) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort());
}

function hasOnlyKeys(value, keys) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isReportRecord(value) {
  return hasExactKeys(value, REPORT_RECORD_KEYS)
    && value.targetID === REPORT_ID && value.method === 'POST'
    && Number.isSafeInteger(value.bytes) && value.bytes > 0 && value.bytes <= 16384
    && /^[a-f0-9]{64}$/.test(value.sha256 || '')
    && (value.actionID === null || typeof value.actionID === 'string' && /^[A-Za-z0-9._:-]{1,96}$/.test(value.actionID))
    && (value.decision === 'allow' || value.decision === 'cancel');
}

function observerCounts(value) {
  const keys = ['version', 'allowedCount', 'deniedCount', 'gateArms', 'gateFailures', 'responseArms', 'responseFailures'];
  if (!hasExactKeys(value, keys) || value.version !== 2) return null;
  if (keys.slice(1).some((key) => !Number.isSafeInteger(value[key]) || value[key] < 0 || value[key] > 100)) return null;
  return Object.fromEntries(keys.map((key) => [key, value[key]]));
}

function isResponseRecord(value) {
  return hasExactKeys(value, RESPONSE_KEYS)
    && typeof value.actionID === 'string' && /^[A-Za-z0-9._:-]{1,96}$/.test(value.actionID)
    && value.mode === 'hold-and-cancel' && ['headers-held','cancelled','failed','not-reached'].includes(value.phase)
    && ['pending','cancelled','timeout','shutdown','mismatch','unexpected-status','response-override','downstream-cancelled','listener-error','cancel-before-headers','correlation-timeout'].includes(value.outcome)
    && (value.statusCode === null || Number.isInteger(value.statusCode) && value.statusCode >= 100 && value.statusCode <= 599);
}

function isCancelOracle(value) {
  return hasExactKeys(value, CANCEL_ORACLE_KEYS)
    && typeof value.actionID === 'string' && /^[A-Za-z0-9._:-]{1,96}$/.test(value.actionID)
    && typeof value.cancelAccepted === 'boolean' && typeof value.sendTerminalUncertain === 'boolean'
    && typeof value.heldAtCancelAccepted === 'boolean' && typeof value.heldAtSendTerminal === 'boolean'
    && typeof value.cancelRequestMatchesSend === 'boolean'
    && ['not-observed','accepted','accepted-after-release','accepted-not-uncertain','mismatched-request','no-op','rejected'].includes(value.cancelOutcome)
    && ['not-observed','uncertain','uncertain-after-release','other-terminal','unknown','rejected'].includes(value.sendOutcome)
    && Number.isSafeInteger(value.generation) && value.generation > 0;
}

function isCancelledAttempt(attempt) {
  return attempt?.targetID === REPORT_ID
    ? attempt.decision === 'cancel'
    : attempt?.cancelledBeforeNetwork === true;
}

function isExpectedSupportDenial(attempt) {
  if (!attempt || typeof attempt !== 'object' || Array.isArray(attempt)) return false;
  if (!hasExactKeys(attempt, ['session', 'url', 'method', 'cancelledBeforeNetwork', 'source'])) return false;
  if (attempt.session !== 'trace-egress' || attempt.method !== 'GET' || attempt.cancelledBeforeNetwork !== true
    || attempt.source !== SUPPORT_SOURCE || typeof attempt.url !== 'string') return false;
  try {
    const url = new URL(attempt.url);
    return url.protocol === 'https:' && url.hostname === SUPPORT_HOST && url.port === ''
      && url.username === '' && url.password === '' && url.pathname === '/receipt'
      && url.search === '?claim=synthetic' && url.hash === '';
  } catch { return false; }
}

function reconcileBugReportNetworkEvidence(report, options = { scope: 'full-functional' }) {
  const problems = [];
  let scopeDescriptor;
  let optionKeys;
  try {
    optionKeys = options && typeof options === 'object' && !Array.isArray(options) ? Reflect.ownKeys(options) : [];
    scopeDescriptor = optionKeys.length === 1 && optionKeys[0] === 'scope' ? Object.getOwnPropertyDescriptor(options, 'scope') : null;
  } catch { scopeDescriptor = null; }
  if (!scopeDescriptor || !Object.hasOwn(scopeDescriptor, 'value')
    || !['full-functional', 'bug-report-supplemental'].includes(scopeDescriptor.value)) {
    return ['bug-report evidence scope options are missing, unexpected, or unsupported'];
  }
  const scope = scopeDescriptor.value;
  const contract = report?.bugReportObserver;
  if (!hasExactKeys(contract, ['schema', 'completed', 'actions', 'responses', 'localAcceptance', 'syntheticDelivery', 'finalObserver']) || contract.schema !== OBSERVER_SCHEMA
    || contract.completed !== true || !Array.isArray(contract.actions)) {
    return ['bug-report native scenario or observer action manifest is missing'];
  }
  if (contract.actions.length !== 3) problems.push('bug-report action count does not contain the exact three bounded sends');
  const expectedByAction = new Map();
  for (const action of contract.actions) {
    if (!hasExactKeys(action, ACTION_KEYS) || !Number.isSafeInteger(action.launch) || action.launch < 1
      || !/^[A-Za-z0-9._:-]{1,96}$/.test(action.actionID || '')
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(action.reportId || '')
      || !Number.isSafeInteger(action.bytes) || action.bytes < 1 || action.bytes > 16384
      || !/^[a-f0-9]{64}$/.test(action.sha256 || '') || !['received','uncertain'].includes(action.acknowledgement)) {
      problems.push('bug-report action evidence is not a closed, bounded terminal record');
      continue;
    }
    if (expectedByAction.has(action.actionID)) problems.push('bug-report action provenance IDs are duplicated');
    else expectedByAction.set(action.actionID, action);
  }
  const actions = [...expectedByAction.values()];
  if (actions.length === 3) {
    const [a,b,retry] = actions;
    if (a.acknowledgement !== 'received' || b.acknowledgement !== 'uncertain' || retry.acknowledgement !== 'received'
      || a.reportId === b.reportId || b.reportId !== retry.reportId || b.sha256 !== retry.sha256 || b.bytes !== retry.bytes
      || !(a.launch === b.launch && b.launch < retry.launch)) {
      problems.push('bug-report A/B/lost-ack retry identities or terminal outcomes do not match the fixed scenario');
    }
  }
  if (new Set(actions.map((action) => action.reportId)).size !== 2) problems.push('bug-report scenario must admit exactly two new report identities');
  if (!hasExactKeys(contract.localAcceptance, ['completed','localPostCount','localIntentCount','localActions','locales'])
    || contract.localAcceptance.completed !== true || contract.localAcceptance.localPostCount !== 0 || contract.localAcceptance.localIntentCount !== 0
    || contract.localAcceptance.localActions !== true || !isDeepStrictEqual(contract.localAcceptance.locales, ['hu','en','de','fr','it','sk','pl','uk'])) {
    problems.push('eight-locale local-only acceptance evidence is incomplete or not zero-egress');
  }
  if (!hasExactKeys(contract.syntheticDelivery, ['completed','injectedNativeEvent','sameDialogPreserved','originalContextPreserved','reopenContextChanged'])
    || contract.syntheticDelivery.completed !== true || contract.syntheticDelivery.injectedNativeEvent !== true
    || contract.syntheticDelivery.sameDialogPreserved !== true || contract.syntheticDelivery.originalContextPreserved !== true
    || contract.syntheticDelivery.reopenContextChanged !== true) problems.push('synthetic native board delivery did not preserve and then refresh report context as required');

  const launches = Array.isArray(report?.launches) ? report.launches : [];
  const observerAttempts = [];
  const launchCounts = new Map();
  for (const launch of launches) {
    if (launch?.reportObserverCaptureValid !== true) problems.push(`launch ${launch?.launch ?? 'unknown'} report-observer records did not pass closed-schema capture`);
    const info = launch?.reportObserver;
    if (!hasExactKeys(info, ['version', 'allowedCount', 'deniedCount', 'gateArms', 'gateFailures', 'responseArms', 'responseFailures', 'attempts', 'responses', 'cancelOracles', 'finalMarker'])) {
      problems.push(`launch ${launch?.launch ?? 'unknown'} report-observer evidence has unexpected or missing fields`);
      continue;
    }
    const { attempts, responses, cancelOracles, finalMarker, ...countsValue } = info || {};
    const counts = observerCounts(countsValue);
    if (!counts || !Array.isArray(attempts) || attempts.some((entry) => !isReportRecord(entry))
      || !Array.isArray(info.responses) || info.responses.some((entry) => !isResponseRecord(entry))
      || !Array.isArray(info.cancelOracles) || info.cancelOracles.some((entry) => !isCancelOracle(entry))) {
      problems.push(`launch ${launch?.launch ?? 'unknown'} lacks a complete safe report-observer snapshot`);
      continue;
    }
    if (counts.allowedCount !== attempts.filter((entry) => entry.decision === 'allow').length
      || counts.deniedCount !== attempts.filter((entry) => entry.decision === 'cancel').length
      || counts.allowedCount + counts.deniedCount !== attempts.length) problems.push(`launch ${launch.launch} report-observer counts do not match its safe attempts`);
    const markerCounts = finalMarker && { version: finalMarker.version, allowedCount: finalMarker.allowedCount, deniedCount: finalMarker.deniedCount,
      gateArms: finalMarker.gateArms, gateFailures: finalMarker.gateFailures, responseArms: finalMarker.responseArms, responseFailures: finalMarker.responseFailures };
    if (!hasExactKeys(finalMarker, ['version','allowedCount','deniedCount','gateArms','gateFailures','responseArms','responseFailures','attempts','responses','cancelOracles'])
      || !observerCounts(markerCounts) || !isDeepStrictEqual(markerCounts, counts)
      || !isDeepStrictEqual(finalMarker.attempts, attempts) || !isDeepStrictEqual(finalMarker.responses, info.responses)
      || !isDeepStrictEqual(finalMarker.cancelOracles, info.cancelOracles)) problems.push(`launch ${launch.launch} final observer marker is missing or conflicts with its snapshot`);
    if (!observerCounts(launch.startupObservation?.reportObserver)
      || !isDeepStrictEqual(observerCounts(launch.startupObservation.reportObserver), counts)) problems.push(`launch ${launch.launch} startup report-observer summary conflicts with its snapshot`);
    const actionsForLaunch = [...expectedByAction.values()].filter((entry) => entry.launch === launch.launch);
    if (counts.gateArms !== actionsForLaunch.length || counts.gateFailures !== 0) problems.push(`launch ${launch.launch} gate-arm or failure counts do not match explicit Send actions`);
    launchCounts.set(launch.launch, counts);
    observerAttempts.push(...attempts.map((entry) => ({ launch: launch.launch, entry })));
    const isTruthfullyCancelled = (launch.networkAttempts || []).every(isCancelledAttempt);
    if (launch.startupObservation?.cancelledRequests !== isTruthfullyCancelled) problems.push(`launch ${launch.launch} cancelled-request summary is not truthful`);
    if (launch.startupObservation?.finalNetworkCount !== launch.networkAttempts?.length) problems.push(`launch ${launch.launch} startup request count does not match its snapshot`);
  }

  const expectedRecords = [...expectedByAction.values()].map((action) => ({ launch: action.launch, entry: {
    targetID: REPORT_ID, method: 'POST', bytes: action.bytes, sha256: action.sha256, actionID: action.actionID, decision: 'allow',
  } }));
  if (!isDeepStrictEqual(observerAttempts.slice().sort((a, b) => a.entry.actionID?.localeCompare(b.entry.actionID || '') || a.launch - b.launch),
    expectedRecords.slice().sort((a, b) => a.entry.actionID.localeCompare(b.entry.actionID) || a.launch - b.launch))) {
    problems.push('observed report attempts do not exactly match the acknowledged explicit Send actions');
  }
  const globalNetwork = Array.isArray(report?.networkAttempts) ? report.networkAttempts : [];
  const globalReports = globalNetwork.filter((entry) => entry?.targetID === REPORT_ID);
  if (globalReports.some((entry) => !isReportRecord(entry))
    || !isDeepStrictEqual(globalReports.slice().sort((a, b) => a.actionID?.localeCompare(b.actionID || '')),
      expectedRecords.map(({ entry }) => entry).sort((a, b) => a.actionID.localeCompare(b.actionID)))) {
    problems.push('global report records are missing, unknown, denied, or mismatched');
  }
  const supportDenials = globalNetwork.filter((entry) => entry?.targetID !== REPORT_ID);
  if (supportDenials.length !== 1 || supportDenials.some((entry) => !isExpectedSupportDenial(entry))) {
    problems.push('external request evidence contains traffic beyond the one blocked support verification request and expected reports');
  }
  const aggregate = observerCounts(contract.finalObserver);
  const allCounts = [...launchCounts.values()];
  const expectedAggregate = { version: 2, allowedCount: expectedRecords.length, deniedCount: 0,
    gateArms: expectedRecords.length, gateFailures: 0, responseArms: 1, responseFailures: 0 };
  const summed = { version: 2, allowedCount: 0, deniedCount: 0, gateArms: 0, gateFailures: 0, responseArms: 0, responseFailures: 0 };
  for (const counts of allCounts) for (const key of Object.keys(summed)) if (key !== 'version') summed[key] += counts[key];
  if (!isDeepStrictEqual(summed, expectedAggregate)) problems.push('aggregate observer counters do not match the three-send/one-response-disruption budget');
  if (!aggregate || !isDeepStrictEqual(aggregate, expectedAggregate)) problems.push('final report-observer marker counts are missing or conflict with explicit sends');
  const responseRecords = launches.flatMap((launch) => launch.reportObserver?.responses || []);
  if (responseRecords.length !== 1 || !isResponseRecord(responseRecords[0]) || responseRecords[0].actionID !== actions[1]?.actionID
    || responseRecords[0].phase !== 'cancelled' || responseRecords[0].outcome !== 'cancelled' || ![200,201].includes(responseRecords[0].statusCode)) {
    problems.push('the exact B response latch did not end as one bounded cancelled 200/201 response');
  }
  if (!Array.isArray(contract.responses) || !isDeepStrictEqual(contract.responses, responseRecords)) problems.push('top-level response disruption records disagree with per-launch observer evidence');
  const cancelOracles = launches.flatMap((launch) => launch.reportObserver?.cancelOracles || []);
  if (cancelOracles.length !== 1 || !isCancelOracle(cancelOracles[0]) || cancelOracles[0].actionID !== actions[1]?.actionID
    || cancelOracles[0].cancelAccepted !== true || cancelOracles[0].sendTerminalUncertain !== true
    || cancelOracles[0].heldAtCancelAccepted !== true || cancelOracles[0].heldAtSendTerminal !== true || cancelOracles[0].cancelRequestMatchesSend !== true
    || cancelOracles[0].cancelOutcome !== 'accepted' || cancelOracles[0].sendOutcome !== 'uncertain') {
    problems.push('actual Cancel acceptance and uncertain send did not settle while the matching response remained held');
  }
  const intents = [];
  for (const launch of launches) {
    const current = launch.externalIntents;
    if (!Array.isArray(current) || current.some((intent) => intent !== 'https://donate.stripe.com/7sYaEZeET2op8PxaGE5EY00')
      || launch.startupObservation?.finalExternalIntents !== current.length) problems.push(`launch ${launch.launch} contains unexpected or unreconciled external intents`);
    else intents.push(...current);
  }
  const expectedIntentCount = scope === 'full-functional' ? 2 : 0;
  if (intents.length !== expectedIntentCount) problems.push(`the ${scope} scope requires exactly ${expectedIntentCount} support Stripe opens`);
  if (launchCounts.size !== launches.length) problems.push('one or more launches have no reconciled report-observer counts');
  return problems;
}

async function readObserver(ctx) {
  return ctx.main(() => {
    if (typeof globalThis.__traceQaPreMainSnapshot !== 'function') throw new Error('Pre-main observer helper is missing.');
    return globalThis.__traceQaPreMainSnapshot();
  });
}

async function openForm(page, trigger) {
  await page.locator(trigger).click();
  await page.waitForSelector('[data-testid=bug-report-dialog]', { timeout: 10000 });
}

async function waitForPageValue(page, predicate, label, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await page.evaluate(predicate)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function noReportRequests(ctx, before) {
  const after = await readObserver(ctx);
  assert.equal(after.reportObserver?.attempts?.length, before.reportAttempts, 'local report actions must not create a receiver request');
  assert.equal(after.external.length, before.externalIntents, 'local report actions must not open a browser or external link');
}

async function localeCatalog(locale) {
  const catalog = JSON.parse(await require('node:fs/promises').readFile(require('node:path').join(__dirname, '..', '..', 'electron', 'locales', locale, 'diagnostic.json'), 'utf8'));
  const keys = ['diagnostic.bugTitle','diagnostic.bugWhatHappened','diagnostic.bugReview','diagnostic.bugPrivacyDetails',
    'diagnostic.bugRetention','diagnostic.bugIncludeTechnical','diagnostic.bugTechnicalSummary','diagnostic.bugSendOnlyHint',
    'diagnostic.bugUnconfirmed','diagnostic.bugContinueEditing','diagnostic.bugHashBytes'];
  if (keys.some((key) => typeof catalog[key] !== 'string' || !catalog[key].trim())) throw new Error('Packaged bug-report locale catalog is incomplete.');
  return Object.fromEntries(keys.map((key) => [key, catalog[key]]));
}

async function readPreview(page) {
  const text = await page.locator('[data-testid=bug-report-preview]').textContent();
  let report;
  try { report = JSON.parse(text); } catch { throw new Error('Bug-report preview is not canonical JSON.'); }
  const bytes = Buffer.from(text, 'utf8');
  return { text, report, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
}

async function pendingDraftMatches(page, expected) {
  return page.evaluate(async (identity) => {
    const pending = await window.traceDesktop?.getBugReportDraft?.();
    const canonicalText = pending?.pending?.canonicalText;
    if (pending?.status !== 'available' || pending.pending?.report?.reportId !== identity.reportId
      || typeof canonicalText !== 'string' || pending.pending?.payloadHash !== identity.sha256) return false;
    const bytes = new TextEncoder().encode(canonicalText);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const hash = [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
    return bytes.byteLength === identity.bytes && hash === identity.sha256;
  }, expected);
}

async function assertNoReportActivity(ctx, before) {
  const now = await readObserver(ctx);
  assert.equal(now.reportObserver?.attempts?.length === before.attempts, true, 'local report actions leave receiver attempts unchanged');
  assert.equal(now.external?.length === before.intents, true, 'local report actions leave external intents unchanged');
}

async function localeUiProof(page, locale, strings) {
  return page.evaluate(({ locale, strings }) => {
    const dialog = document.querySelector('[data-testid=bug-report-dialog]');
    const field = dialog?.querySelector('.bug-report-field');
    const privacy = dialog?.querySelector('.bug-report-privacy');
    return {
      locale: document.documentElement.lang === locale,
      title: dialog?.querySelector('h2')?.textContent?.trim() === strings['diagnostic.bugTitle'],
      label: field?.querySelector('span')?.textContent?.trim() === strings['diagnostic.bugWhatHappened'],
      review: [...dialog.querySelectorAll('button')].some((button) => button.textContent?.trim() === strings['diagnostic.bugReview']),
      privacy: privacy?.querySelector('summary')?.textContent?.trim() === strings['diagnostic.bugPrivacyDetails'],
      retention: privacy?.textContent?.includes(strings['diagnostic.bugRetention']) === true,
      sendOnly: privacy?.textContent?.includes(strings['diagnostic.bugSendOnlyHint']) === true,
      includeLabel: dialog?.querySelector('.bug-report-check')?.textContent?.trim() === strings['diagnostic.bugIncludeTechnical'],
      technicalOff: !dialog?.querySelector('.bug-report-facts'),
      diagnosticsOff: dialog?.querySelector('[data-testid=bug-report-diagnostics]')?.checked === false,
    };
  }, { locale, strings });
}

async function run(ctx) {
  const page = ctx.getPage();
  const evidence = ctx.evidence;
  evidence.bugReportObserver = { schema: OBSERVER_SCHEMA, completed: false, actions: [], responses: [],
    localAcceptance: null, syntheticDelivery: null, finalObserver: null };
  let contextProof = null;

  await ctx.withWelcome(async () => {
    let welcome = ctx.getPage();
    assert.equal(await welcome.locator('[data-testid=support-notice]').count(), 0, 'fresh no-board profile with verification disabled has no startup support notice');
    const baseline = await readObserver(ctx);
    const before = { attempts: baseline.reportObserver?.attempts?.length ?? -1, intents: baseline.external?.length ?? -1 };
    await ctx.step('bug report local welcome, eight-locale controls, privacy and dismissal remain offline', async () => {
      const uiLocales = [];
      for (const locale of ['hu','en','de','fr','it','sk','pl','uk']) {
        await ctx.setLanguage(locale);
        const strings = await localeCatalog(locale);
        await welcome.setViewportSize({ width: locale === 'de' || locale === 'uk' ? 520 : 1280, height: 760 });
        await openForm(welcome, '[data-testid=report-bug-button]');
        await welcome.locator('[data-testid=bug-report-description]').fill(`Synthetic localized QA draft (${locale}).`);
        await welcome.locator('[data-testid=bug-report-diagnostics]').uncheck();
        const localProof = await localeUiProof(welcome, locale, strings);
        assert.equal(Object.values(localProof).every(Boolean), true, 'localized title, label, Review, privacy summary, retention and diagnostics-off state match the reviewed catalog');
        const layoutProof = await welcome.evaluate(() => {
          const dialog = document.querySelector('[data-testid=bug-report-dialog]');
          const selectors = ['[data-testid=bug-report-description]','[data-testid=bug-report-cancel]','[data-testid=bug-report-review]','.bug-report-privacy summary'];
          const boxes = selectors.map((selector) => document.querySelector(selector)?.getBoundingClientRect());
          const view = { width: window.innerWidth, height: window.innerHeight };
          const visible = boxes.every((box) => box && box.width > 0 && box.height > 0 && box.left >= 0 && box.right <= view.width && box.top < view.height);
          return !!dialog && visible && dialog.scrollHeight >= dialog.clientHeight && dialog.scrollWidth <= dialog.clientWidth + 1;
        });
        assert.equal(layoutProof, true, 'ordinary and narrow locale layouts expose visible controls without horizontal overflow');
        await welcome.locator('.bug-report-privacy summary').click();
        await welcome.locator('[data-testid=bug-report-review]').click();
        await welcome.waitForSelector('[data-testid=bug-report-preview]', { timeout: 10000 });
        const preview = await readPreview(welcome);
        assert.equal(preview.report?.schema === 'trace-bug-report/1' && preview.report.description === `Synthetic localized QA draft (${locale}).`
          && preview.report.diagnostics === null && preview.text === JSON.stringify(preview.report), true,
        'diagnostics-off canonical preview exactly projects the selected description and no technical object');
        await welcome.locator('[data-testid=bug-report-back]').click();
        await welcome.locator('[data-testid=bug-report-diagnostics]').check();
        const technicalSummary = await welcome.locator('.bug-report-facts').textContent();
        assert.equal(technicalSummary?.includes(strings['diagnostic.bugTechnicalSummary'])
          && await welcome.locator('[data-testid=bug-report-diagnostics]').isChecked(), true, 'diagnostics-on localized summary and selected control are visible');
        await welcome.locator('[data-testid=bug-report-review]').click();
        const enabledPreview = await readPreview(welcome);
        assert.equal(enabledPreview.report?.schema === 'trace-bug-report/1' && enabledPreview.report.description === `Synthetic localized QA draft (${locale}).`
          && !!enabledPreview.report.diagnostics && enabledPreview.text === JSON.stringify(enabledPreview.report), true,
        'diagnostics-on canonical preview exactly projects the selected description and optional technical summary');
        await welcome.keyboard.press('Escape');
        await welcome.waitForSelector('[data-testid=bug-report-dialog] [role=alertdialog]', { timeout: 10000 });
        const prompt = welcome.locator('[data-testid=bug-report-dialog] [role=alertdialog]');
        const promptButtons = prompt.locator('button:not([disabled])');
        const hasControls = await promptButtons.count() >= 2;
        let focusProof = { controls: hasControls, shiftWrap: false, forwardWrap: false };
        if (hasControls) {
          await promptButtons.first().focus();
          await welcome.keyboard.press('Shift+Tab');
          focusProof.shiftWrap = await promptButtons.last().evaluate((node) => document.activeElement === node);
          await promptButtons.last().focus();
          await welcome.keyboard.press('Tab');
          focusProof.forwardWrap = await promptButtons.first().evaluate((node) => document.activeElement === node);
        }
        assert.equal(focusProof.controls && focusProof.shiftWrap && focusProof.forwardWrap, true, 'dirty prompt traps reverse and forward keyboard focus');
        await prompt.getByRole('button', { name: strings['diagnostic.bugContinueEditing'], exact: true }).click();
        await welcome.waitForSelector('[data-testid=bug-report-dialog] [role=alertdialog]', { state: 'detached', timeout: 10000 });
        assert.equal(await welcome.locator('[data-testid=bug-report-description]').inputValue(), `Synthetic localized QA draft (${locale}).`, 'Continue editing keeps the local draft intact');
        await welcome.keyboard.press('Escape');
        await welcome.waitForSelector('[data-testid=bug-report-dialog] [role=alertdialog]', { timeout: 10000 });
        await welcome.locator('[data-testid=bug-report-leave]').click();
        await welcome.waitForSelector('[data-testid=bug-report-dialog]', { state: 'detached' });
        assert.equal(await welcome.evaluate(() => document.activeElement?.getAttribute('data-testid') === 'report-bug-button'), true, 'explicit leave returns focus to the invoking welcome control');
        await assertNoReportActivity(ctx, before);
        uiLocales.push(locale);
        await welcome.setViewportSize({ width: 1280, height: 760 });
      }
      await ctx.setLanguage('en');
      await openForm(welcome, '[data-testid=report-bug-button]');
      await welcome.locator('[data-testid=bug-report-description]').fill('Synthetic local draft for packaged acceptance.');
      await welcome.locator('[data-testid=bug-report-save-draft]').click();
      await waitForPageValue(welcome, async () => {
        const result = await window.traceDesktop?.getBugReportDraft?.();
        return result?.status === 'available' && result.draft?.description === 'Synthetic local draft for packaged acceptance.';
      }, 'local draft save');
      await welcome.locator('[data-testid=bug-report-cancel]').click();
      await welcome.waitForSelector('[data-testid=bug-report-dialog] [role=alertdialog]');
      await welcome.locator('[data-testid=bug-report-leave]').click();
      await welcome.waitForSelector('[data-testid=bug-report-dialog]', { state: 'detached' });
      await ctx.restart();
      welcome = ctx.getPage();
      await welcome.waitForSelector('[data-testid=welcome]', { timeout: 20000 });
      assert.equal(await welcome.locator('[data-testid=project-name]').count(), 0, 'normal restart keeps the fresh owned profile on Welcome with no active board');
      assert.equal(await welcome.locator('.recent-empty').count(), 1, 'normal restart has no restored board history');
      assert.equal(await welcome.locator('[data-testid=support-notice]').count(), 0, 'normal restart preserves disabled support verification');
      await waitForPageValue(welcome, () => !!window.traceDesktop?.getBugReportDraft, 'draft bridge after restart');
      await openForm(welcome, '[data-testid=report-bug-button]');
      await welcome.waitForFunction((expected) => document.querySelector('[data-testid=bug-report-description]')?.value === expected,
        'Synthetic local draft for packaged acceptance.', { timeout: 10000 });
      await welcome.locator('[data-testid=bug-report-discard-draft]').click();
      await waitForPageValue(welcome, async () => (await window.traceDesktop?.getBugReportDraft?.())?.status === 'empty', 'discarded local draft');
      await welcome.locator('[data-testid=bug-report-cancel]').click();
      await welcome.waitForSelector('[data-testid=bug-report-dialog] [role=alertdialog]', { timeout: 10000 });
      await welcome.locator('[data-testid=bug-report-leave]').click();
      await welcome.waitForSelector('[data-testid=bug-report-dialog]', { state: 'detached' });
      await assertNoReportActivity(ctx, before);
      return { locales: uiLocales.length, localPostCount: 0, localIntentCount: 0, draftRestart: true };
    });

    await ctx.step('bug report context remains mounted across a synthetic native board delivery', async () => {
      await ctx.setLanguage('en');
      await openForm(welcome, '[data-testid=report-bug-button]');
      await welcome.locator('[data-testid=bug-report-description]').fill('Synthetic context snapshot must stay stable while the board changes.');
      await welcome.locator('[data-testid=bug-report-review]').click();
      const dialog = welcome.locator('[data-testid=bug-report-dialog]');
      const dialogHandle = await dialog.elementHandle();
      const initial = await readPreview(welcome);
      const initialContextHash = crypto.createHash('sha256').update(JSON.stringify(initial.report.diagnostics ?? null)).digest('hex');
      const originalText = initial.text;
      await ctx.deliverSyntheticBoard(path.join(ctx.fixtureDir, 'SyntheticBoardWithExtraComponent.cad'));
      await ctx.waitBoard({ components: 4, pins: 8, nets: 2, target: path.join(ctx.fixtureDir, 'SyntheticBoardWithExtraComponent.cad') });
      assert.equal(await dialogHandle.evaluate((node) => node.isConnected && node === document.querySelector('[data-testid=bug-report-dialog]')),
        true, 'the same report dialog node remains mounted during main-process board delivery');
      const stillMounted = await readPreview(welcome);
      assert.equal(stillMounted.text === originalText && stillMounted.sha256 === initial.sha256 && stillMounted.bytes === initial.bytes,
        true, 'editing/review report identity and captured context remain byte-identical while another board arrives');
      const afterContextHash = crypto.createHash('sha256').update(JSON.stringify(stillMounted.report.diagnostics ?? null)).digest('hex');
      await welcome.keyboard.press('Escape');
      await welcome.waitForSelector('[data-testid=bug-report-dialog] [role=alertdialog]');
      await welcome.locator('[data-testid=bug-report-leave]').click();
      await welcome.waitForSelector('[data-testid=bug-report-dialog]', { state: 'detached' });
      await openForm(welcome, '[data-testid=report-bug-button]');
      await welcome.locator('[data-testid=bug-report-description]').fill('Synthetic reopened context after local board delivery.');
      await welcome.locator('[data-testid=bug-report-diagnostics]').check();
      await welcome.locator('[data-testid=bug-report-review]').click();
      await welcome.waitForSelector('[data-testid=bug-report-preview]', { timeout: 10000 });
      const reopened = await readPreview(welcome);
      const reopenedContextHash = crypto.createHash('sha256').update(JSON.stringify(reopened.report.diagnostics ?? null)).digest('hex');
      assert.equal(initialContextHash === afterContextHash, true, 'the open dialog retained its original diagnostic context');
      assert.equal(reopenedContextHash !== initialContextHash, true, 'a newly opened report captures the newly delivered board context');
      contextProof = { sameDialogPreserved: true, originalContextPreserved: true, reopenContextChanged: true };
      await dialogHandle.dispose();
      await welcome.keyboard.press('Escape');
      await welcome.waitForSelector('[data-testid=bug-report-dialog] [role=alertdialog]');
      await welcome.locator('[data-testid=bug-report-leave]').click();
      await welcome.waitForSelector('[data-testid=bug-report-dialog]', { state: 'detached' });
      await assertNoReportActivity(ctx, before);
      return { nativeEventInjected: true, contextStable: true, contextRefreshedOnReopen: true };
    });
  });

  await ctx.step('support reminder report action stays local and exposes privacy choices', async () => {
    const activePage = ctx.getPage();
    await ctx.dismissSupport();
    const before = await readObserver(ctx);
    const baseline = { attempts: before.reportObserver?.attempts?.length ?? -1, intents: before.external?.length ?? -1 };
    await activePage.locator('[data-testid=support-button]').click();
    await activePage.waitForSelector('[data-testid=support-notice]', { timeout: 10000 });
    await activePage.locator('[data-testid=support-bug]').click();
    await activePage.waitForSelector('[data-testid=bug-report-dialog]', { timeout: 10000 });
    await activePage.locator('[data-testid=bug-report-description]').fill('Synthetic path C:\\QA-SYNTHETIC\\demo.cad token=synthetic-value.');
    await activePage.locator('.bug-report-privacy-review button').first().click();
    const sanitized = await activePage.locator('[data-testid=bug-report-description]').inputValue();
    assert.equal(!/QA-SYNTHETIC|synthetic-value/.test(sanitized), true, 'user-selected privacy cleanup removes synthetic path and token text');
    await activePage.locator('[data-testid=bug-report-cancel]').click();
    await activePage.waitForSelector('[data-testid=bug-report-dialog] [role=alertdialog]', { timeout: 10000 });
    await activePage.locator('[data-testid=bug-report-leave]').click();
    await activePage.waitForSelector('[data-testid=bug-report-dialog]', { state: 'detached' });
    await assertNoReportActivity(ctx, baseline);
    evidence.bugReportObserver.localAcceptance = { completed: true, localPostCount: 0, localIntentCount: 0, localActions: true,
      locales: ['hu','en','de','fr','it','sk','pl','uk'] };
    evidence.bugReportObserver.syntheticDelivery = { completed: true, injectedNativeEvent: true, ...contextProof };
    return { supportActionLocal: true, privacyCleanup: true };
  });

  const sendAction = async ({ diagnostics, actionID, responseMode = 'normal', outcome }) => {
    const activePage = ctx.getPage();
    const baseline = await readObserver(ctx);
    await activePage.locator('[data-testid=support-button]').click();
    await activePage.waitForSelector('[data-testid=support-notice]', { timeout: 10000 });
    await activePage.locator('[data-testid=support-bug]').click();
    await activePage.waitForSelector('[data-testid=bug-report-dialog]', { timeout: 10000 });
    await activePage.locator('[data-testid=bug-report-description]').fill(diagnostics
      ? 'Synthetic report B with optional technical details enabled.' : 'Synthetic report A without technical details.');
    const diagnosticsControl = activePage.locator('[data-testid=bug-report-diagnostics]');
    if (diagnostics) await diagnosticsControl.check(); else await diagnosticsControl.uncheck();
    await activePage.locator('[data-testid=bug-report-review]').click();
    await activePage.waitForSelector('[data-testid=bug-report-preview]', { timeout: 10000 });
    const preview = await readPreview(activePage);
    const validIdentity = preview.report?.schema === 'trace-bug-report/1' && typeof preview.report.reportId === 'string';
    assert.equal(validIdentity, true, 'reviewed preview has a synthetic report identity');
    assert.equal(diagnostics ? !!preview.report.diagnostics : preview.report.diagnostics === null, true, 'reviewed preview matches the selected diagnostics mode');
    const language = await activePage.locator('html').getAttribute('lang');
    const hashCatalog = await localeCatalog(language);
    const formatter = new Intl.NumberFormat(LOCALE_TAGS[language]);
    const bytesLabel = hashCatalog['diagnostic.bugHashBytes'].replace('{hash}', preview.sha256).replace('{bytes}', formatter.format(preview.bytes));
    const hashSummary = await activePage.locator('.bug-report-hash').evaluate((node, expected) => node.textContent?.trim() === expected,
      bytesLabel);
    assert.equal(hashSummary, true, 'displayed hash and length correspond to exact canonical preview bytes');
    const armed = await ctx.main((_electronAPI, value) => globalThis.__traceQaArmBugReportSend?.({ actionId: value.actionID,
      sha256: value.sha256, byteCount: value.bytes, windowMs: 20000, responseMode: value.responseMode }),
    { actionID, sha256: preview.sha256, bytes: preview.bytes, responseMode });
    assert.equal(armed?.ok, true, 'private one-shot observer accepted the exact preview authorization');
    const action = { launch: evidence.launches.at(-1).launch, actionID, reportId: preview.report.reportId,
      bytes: preview.bytes, sha256: preview.sha256, acknowledgement: 'pending' };
    evidence.bugReportObserver.actions.push(action);
    const send = activePage.locator('[data-testid=bug-report-send]');
    assert.equal(await send.isDisabled(), false, 'actual Send button is enabled for this explicit action');
    try {
      await send.click();
      if (outcome === 'received') {
        await activePage.waitForFunction((id) => {
          const result = document.querySelector('[data-testid=bug-report-result]');
          const close = document.querySelector('[data-testid=bug-report-result-close]');
          return !!result?.textContent?.includes(id) && !!close && !close.disabled && !document.querySelector('[data-testid=bug-report-cancel]');
        }, preview.report.reportId, { timeout: 30000 });
        const observation = await readObserver(ctx);
        const matches = observation.reportObserver?.attempts?.filter((entry) => entry.actionID === actionID) || [];
        assert.equal(matches.length === 1 && matches[0].targetID === REPORT_ID && matches[0].method === 'POST'
          && matches[0].bytes === preview.bytes && matches[0].sha256 === preview.sha256 && matches[0].decision === 'allow', true,
        'observer record exactly matches the received report; acknowledgement and enabled terminal controls settled');
        action.acknowledgement = 'received';
      } else {
        const deadline = Date.now() + 4400;
        let held = false;
        while (Date.now() < deadline) {
          const snapshot = await readObserver(ctx);
          held = snapshot.reportObserver?.responses?.some((entry) => entry.actionID === actionID && entry.phase === 'headers-held') === true;
          if (held) break;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        assert.equal(held, true, 'exact response headers reached the bounded held state');
        const cancel = activePage.locator('[data-testid=bug-report-cancel]');
        assert.equal(await cancel.isEnabled(), true, 'actual production Cancel control is enabled while the send is pending');
        await cancel.click();
        const proofDeadline = Date.now() + 4000;
        let proof = false;
        while (Date.now() < proofDeadline) {
          const snapshot = await readObserver(ctx);
          const oracle = snapshot.reportObserver?.cancelOracles?.find((entry) => entry.actionID === actionID);
          proof = oracle?.cancelAccepted === true && oracle?.sendTerminalUncertain === true
            && oracle?.heldAtCancelAccepted === true && oracle?.heldAtSendTerminal === true
            && snapshot.reportObserver?.responses?.some((entry) => entry.actionID === actionID && entry.phase === 'headers-held');
          if (proof) break;
          await new Promise((resolve) => setTimeout(resolve, 40));
        }
        assert.equal(proof, true, 'real Cancel acceptance and send-promise uncertainty settled while the same response stayed held');
        const strings = await localeCatalog(await activePage.evaluate(() => document.documentElement.lang));
        await activePage.waitForFunction((expected) => {
          const result = document.querySelector('[data-testid=bug-report-result]');
          const close = document.querySelector('[data-testid=bug-report-result-close]');
          return result?.textContent?.includes(expected) === true && !!close && !close.disabled && !document.querySelector('[data-testid=bug-report-cancel]');
        }, strings['diagnostic.bugUnconfirmed'], { timeout: 10000 });
        const pendingProof = await pendingDraftMatches(activePage, { reportId: action.reportId, bytes: preview.bytes, sha256: preview.sha256 });
        assert.equal(pendingProof, true, 'normal draft-read bridge preserves the exact uncertain report identity and canonical bytes');
        action.acknowledgement = 'uncertain';
      }
      return { outcome, reportBytes: preview.bytes, reportSha256: preview.sha256 };
    } finally {
      if (responseMode === 'hold-and-cancel') {
        await ctx.main((_electronAPI, id) => globalThis.__traceQaCancelBugReportResponse?.(id) ?? false, actionID);
        const finalLatch = await readObserver(ctx);
        const record = finalLatch.reportObserver?.responses?.find((entry) => entry.actionID === actionID);
        if (record) evidence.bugReportObserver.responses.push({ actionID: record.actionID, mode: record.mode, phase: record.phase,
          outcome: record.outcome, statusCode: record.statusCode });
      }
      await ctx.main((_electronAPI, id) => globalThis.__traceQaCloseBugReportSend?.(id) ?? false, actionID);
    }
  };

  await ctx.step('bug report A explicit send receives the exact description-only report', async () => {
    await sendAction({ diagnostics: false, actionID: 'bug-report-send-a', outcome: 'received' });
    const activePage = ctx.getPage();
    await activePage.locator('[data-testid=bug-report-result-close]').click();
    await activePage.waitForSelector('[data-testid=bug-report-dialog]', { state: 'detached' });
    return { sends: 1, diagnostics: 'off', outcome: 'received' };
  });

  await ctx.step('bug report B actual Cancel settles uncertainty before bounded response fallback', async () => {
    await sendAction({ diagnostics: true, actionID: 'bug-report-send-b', responseMode: 'hold-and-cancel', outcome: 'uncertain' });
    const activePage = ctx.getPage();
    await activePage.locator('[data-testid=bug-report-result-close]').click();
    await activePage.waitForSelector('[data-testid=bug-report-dialog]', { state: 'detached' });
    const beforeRestart = await readObserver(ctx);
    const attemptsBeforeRestart = beforeRestart.reportObserver?.attempts?.length ?? -1;
    await ctx.restart();
    const restarted = ctx.getPage();
    await ctx.dismissSupport();
    const afterRestart = await readObserver(ctx);
    assert.equal(afterRestart.reportObserver?.attempts?.length, 0, 'normal restart does not automatically resend an uncertain report');
    await restarted.locator('[data-testid=support-button]').click();
    await restarted.waitForSelector('[data-testid=support-notice]', { timeout: 10000 });
    await restarted.locator('[data-testid=support-bug]').click();
    await restarted.waitForSelector('[data-testid=bug-report-dialog]', { timeout: 10000 });
    const originalDescription = 'Synthetic report B with optional technical details enabled.';
    await restarted.waitForFunction((expected) => document.querySelector('[data-testid=bug-report-description]')?.value === expected,
      originalDescription, { timeout: 10000 });
    await restarted.locator('[data-testid=bug-report-review]').click();
    await restarted.waitForSelector('[data-testid=bug-report-preview]', { timeout: 10000 });
    const retryPreview = await readPreview(restarted);
    const originalAction = evidence.bugReportObserver.actions.find((entry) => entry.actionID === 'bug-report-send-b');
    assert.equal(retryPreview.report?.reportId === originalAction.reportId && retryPreview.sha256 === originalAction.sha256
      && retryPreview.bytes === originalAction.bytes, true, 'uncertain retry preview exactly matches the existing UUID, hash and bytes');
    const retryActionID = 'bug-report-send-b-retry';
    const retryArmed = await ctx.main((_electronAPI, value) => globalThis.__traceQaArmBugReportSend?.({ actionId: value.actionID,
      sha256: value.sha256, byteCount: value.bytes, windowMs: 20000 }), { actionID: retryActionID, sha256: retryPreview.sha256, bytes: retryPreview.bytes });
    assert.equal(retryArmed?.ok, true, 'retry uses a fresh exact one-shot gate after normal restart');
    const retryRecord = { launch: evidence.launches.at(-1).launch, actionID: retryActionID, reportId: retryPreview.report.reportId,
      bytes: retryPreview.bytes, sha256: retryPreview.sha256, acknowledgement: 'pending' };
    evidence.bugReportObserver.actions.push(retryRecord);
    try {
      await restarted.locator('[data-testid=bug-report-retry]').click();
      await restarted.waitForFunction((id) => {
        const result = document.querySelector('[data-testid=bug-report-result]');
        const close = document.querySelector('[data-testid=bug-report-result-close]');
        return !!result?.textContent?.includes(id) && !!close && !close.disabled && !document.querySelector('[data-testid=bug-report-cancel]');
      }, retryPreview.report.reportId, { timeout: 30000 });
      const snapshot = await readObserver(ctx);
      const matches = snapshot.reportObserver?.attempts?.filter((entry) => entry.actionID === retryActionID) || [];
      assert.equal(matches.length === 1 && matches[0].decision === 'allow' && matches[0].bytes === retryRecord.bytes
        && matches[0].sha256 === retryRecord.sha256, true, 'retried request exactly matches the preserved pending report');
      retryRecord.acknowledgement = 'received';
    } finally {
      await ctx.main((_electronAPI, id) => globalThis.__traceQaCloseBugReportSend?.(id) ?? false, retryActionID);
    }
    await restarted.locator('[data-testid=bug-report-result-close]').click();
    await restarted.waitForSelector('[data-testid=bug-report-dialog]', { state: 'detached' });
    const final = await readObserver(ctx);
    const aggregate = { version: 2, allowedCount: 0, deniedCount: 0, gateArms: 0, gateFailures: 0, responseArms: 0, responseFailures: 0 };
    const priorClosed = evidence.launches.slice(0, -1).map((entry) => entry.reportObserver).filter(Boolean);
    for (const observer of [...priorClosed, final.reportObserver]) for (const key of Object.keys(aggregate)) if (key !== 'version') aggregate[key] += observer[key] || 0;
    evidence.bugReportObserver.finalObserver = aggregate;
    evidence.bugReportObserver.completed = true;
    assert.equal(attemptsBeforeRestart >= 1, true, 'pre-restart observer recorded the already committed uncertain POST');
    return { sends: 2, retry: true, uncertainNoAutosend: true };
  });

  const finalObserver = await readObserver(ctx);
  assert.equal(evidence.bugReportObserver.actions.length === 3, true, 'scenario records exactly the two new reports and one retry');
  assert.equal(finalObserver.reportObserver?.deniedCount, 0, 'no report mismatch or unauthorized request was observed');
  return { actions: 3, newReports: 2, responseDisruptions: 1, observerVersion: 2 };
}

module.exports = Object.freeze({ run, waitForPageValue, pendingDraftMatches, isReportRecord, observerCounts, isCancelledAttempt, isExpectedSupportDenial,
  isResponseRecord, isCancelOracle, reconcileBugReportNetworkEvidence, OBSERVER_SCHEMA, REPORT_ID, REPORT_URL, REPORT_RECORD_KEYS, ACTION_KEYS, RESPONSE_KEYS, CANCEL_ORACLE_KEYS });
