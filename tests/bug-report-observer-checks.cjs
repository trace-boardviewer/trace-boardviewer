'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const crypto = require('node:crypto');
const inspector = require('../scripts/packaged-functional-inspector.cjs');

const ENDPOINT = 'https://trace-bug-report.trace-boardviewer.workers.dev/v1/reports';
const ACTION = 'bug-reports.explicit-send-1';
const RECEIVER_CANARY = 'PRIVATE-REPORT-CANARY-DO-NOT-EMIT';

function fixture() {
  const appListeners = new Map();
  const processListeners = new Map();
  const sessions = new Map();
  const ipcHandlers = new Map();
  const makeWebRequest=()=>({ listener:null,headers:null,
    onBeforeRequest(filter,listener){this.listener=listener},
    onHeadersReceived(filter,listener){this.headers=listener} });
  const electron = {
    app: {
      isReady: () => false,
      isPackaged: true,
      on(name, listener) { const list = appListeners.get(name) || []; list.push(listener); appListeners.set(name, list); },
    },
    session: {
      fromPartition(partition) {
        if (!sessions.has(partition)) sessions.set(partition, { webRequest: makeWebRequest() });
        return sessions.get(partition);
      },
      defaultSession: { webRequest: makeWebRequest() },
    },
    ipcMain:{handle(channel,listener){ipcHandlers.set(channel,listener)}},
    BrowserWindow: { getAllWindows: () => [] },
    shell: { openExternal: async () => {} },
  };
  const writes = [];
  const fakeProcess = { pid: 42, on(name, listener) { processListeners.set(name, listener); }, stderr: { write(value) { writes.push(String(value)); } } };
  const sandbox = { require(name) { if (name === 'electron') return electron; if (name === 'node:crypto') return crypto; throw new Error('unexpected module'); },
    process: fakeProcess, Buffer, URL, Date, setTimeout, clearTimeout, console };
  vm.runInNewContext(inspector.observerExpression(), sandbox, { timeout: 1000 });
  const appEvent = (name, ...args) => { for (const listener of appListeners.get(name) || []) listener(...args); };
  appEvent('session-created', sessions.get('default') || electron.session.fromPartition('default'));
  appEvent('session-created', electron.session.fromPartition('trace-egress'));
  appEvent('ready');
  const api = vm.runInNewContext('({arm:globalThis.__traceQaArmBugReportSend,close:globalThis.__traceQaCloseBugReportSend,cancelResponse:globalThis.__traceQaCancelBugReportResponse,setPrivacy:globalThis.__traceQaSetBugReportPrivacy,snapshot:globalThis.__traceQaPreMainSnapshot})', sandbox);
  function register(partition, listener) { electron.session.fromPartition(partition).webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, listener); }
  function registerHeaders(partition, listener) { electron.session.fromPartition(partition).webRequest.onHeadersReceived({ urls: ['<all_urls>'] }, listener); }
  function registerHeadersSingle(partition, listener) { electron.session.fromPartition(partition).webRequest.onHeadersReceived(listener); }
  function registerHeadersRemoval(partition) { electron.session.fromPartition(partition).webRequest.onHeadersReceived(null); }
  function request({ url = ENDPOINT, method = 'POST', session = 'trace-egress', uploadData, redirectURL, id = 1 } = {}) {
    const details = { id, url, method, ...(uploadData === undefined ? {} : { uploadData }), ...(redirectURL === undefined ? {} : { redirectURL }) };
    const callback = electron.session.fromPartition(session).webRequest.listener;
    const decisions = [];
    callback(details, (decision) => decisions.push(decision || {}));
    return decisions.at(-1) || {};
  }
  const arm = (body, options = {}) => JSON.parse(JSON.stringify(api.arm({ actionId: ACTION, sha256: crypto.createHash('sha256').update(body).digest('hex'), byteCount: body.length, ...options })));
  const snapshot = () => JSON.parse(JSON.stringify(api.snapshot()));
  function headers(details={}){
    const {url=ENDPOINT,method='POST',session='trace-egress',id=1,statusCode=200}=details;
    const listener=electron.session.fromPartition(session).webRequest.headers;
    const decisions=[];
    listener(Object.hasOwn(details,'__actualDetails')?details.__actualDetails:{id,url,method,statusCode},decision=>decisions.push(JSON.parse(JSON.stringify(decision||{}))));
    return decisions;
  }
  const invoke=(channel,...args)=>ipcHandlers.get(channel).apply(electron.ipcMain,[{},...args]);
  const invokeWithEvent=(channel,event,...args)=>ipcHandlers.get(channel).apply(electron.ipcMain,[event,...args]);
  const registerReportHandlers=({cancel,send}={})=>{
    if(cancel)electron.ipcMain.handle('trace:bug-report-cancel',cancel);
    if(send)electron.ipcMain.handle('trace:bug-report-send',send);
  };
  return { appEvent, api, register, registerHeaders, registerHeadersSingle, registerHeadersRemoval, request, headers, invoke, invokeWithEvent,
    registerReportHandlers, arm, snapshot, writes, sandbox, processListeners };
}

const body = Buffer.from(JSON.stringify({ schema: 'trace-bug-report/1', description: RECEIVER_CANARY }));
const bytesItem = (value = body) => [{ bytes: value }];

test('observer defaults to deny-all and omits report URL, query, body and canaries from every snapshot', () => {
  const qa = fixture();
  const denied = qa.request({ url: `${ENDPOINT}?private=${RECEIVER_CANARY}`, uploadData: bytesItem() });
  assert.equal(denied.cancel, true);
  const data = qa.snapshot();
  assert.equal(data.reportObserver.version, 2);
  assert.deepEqual(data.reportObserver.attempts[0], { targetID: 'bug-report-receiver', method: 'POST', bytes: body.length,
    sha256: crypto.createHash('sha256').update(body).digest('hex'), actionID: null, decision: 'cancel' });
  assert.deepEqual(data.network[0], data.reportObserver.attempts[0]);
  assert.deepEqual(Object.keys(data.network[0]).sort(), ['actionID', 'bytes', 'decision', 'method', 'sha256', 'targetID'].sort());
  assert.equal(JSON.stringify(data).includes(RECEIVER_CANARY), false);
  assert.equal(JSON.stringify(data).includes('?private='), false);
  assert.equal(JSON.stringify(data).includes('description'), false);
});

test('one exact explicit-send gate allows exactly one canonical POST and auto-disarms', () => {
  const qa = fixture();
  assert.deepEqual(qa.arm(body), { ok: true, code: 'armed' });
  const first = qa.request({ uploadData: bytesItem(), id: 1 });
  assert.equal(first.cancel, false);
  const second = qa.request({ uploadData: bytesItem(), id: 2 });
  assert.equal(second.cancel, true);
  const data = qa.snapshot();
  assert.equal(data.reportObserver.version, 2);
  assert.deepEqual({allowedCount:data.reportObserver.allowedCount,deniedCount:data.reportObserver.deniedCount,gateArms:data.reportObserver.gateArms,gateFailures:data.reportObserver.gateFailures}, { allowedCount: 1, deniedCount: 1, gateArms: 1, gateFailures: 0 });
  assert.deepEqual(data.reportObserver.attempts, [
      { targetID: 'bug-report-receiver', method: 'POST', bytes: body.length, sha256: crypto.createHash('sha256').update(body).digest('hex'), actionID: ACTION, decision: 'allow' },
      { targetID: 'bug-report-receiver', method: 'POST', bytes: body.length, sha256: crypto.createHash('sha256').update(body).digest('hex'), actionID: null, decision: 'cancel' },
    ]);
  assert.equal(qa.api.close(ACTION), false, 'consumption closes the gate');
  qa.appEvent('will-quit');
  assert.match(qa.writes.join(''), /"allExternalRequestsCancelled":false/, 'the legacy marker stays truthful after an allowed request');
});

test('last Electron listener still applies deny-all and the exact one-shot gate', () => {
  const qa = fixture();
  qa.register('trace-egress', (_details, finish) => finish({ cancel: false }));
  assert.equal(qa.request({ uploadData: bytesItem() }).cancel, true, 'late permissive listener still passes through the wrapper');
  const qa2 = fixture();
  assert.deepEqual(qa2.arm(body), { ok: true, code: 'armed' });
  qa2.register('trace-egress', (_details, finish) => finish({ cancel: false }));
  assert.equal(qa2.request({ uploadData: bytesItem() }).cancel, false, 'only the exact armed request is permitted');
  assert.equal(qa2.request({ uploadData: bytesItem(), id: 2 }).cancel, true, 'a later listener cannot re-use the permission');
});

test('downstream cancel and redirect callbacks consume the one-shot gate once and never authorize response correlation', () => {
  for (const decision of [{ cancel: true }, { redirectURL: 'https://other.invalid/' }]) {
    const qa = fixture();
    assert.equal(qa.arm(body, { responseMode: 'hold-and-cancel' }).ok, true);
    let calls = 0;
    qa.register('trace-egress', (_details, finish) => { calls++; finish(decision); finish({}); });
    assert.equal(qa.request({ uploadData: bytesItem(), id: 92 }).cancel, true);
    assert.equal(calls, 1);
    const denied = qa.request({ uploadData: bytesItem(), id: 93 });
    assert.equal(denied.cancel, true, 'the consumed gate cannot be reused');
    qa.registerHeaders('trace-egress', (_details, finish) => finish({}));
    assert.deepEqual(qa.headers({ id: 92, statusCode: 200 }), [{}], 'a denied before-request callback does not hold or alter a later unrelated headers event');
    assert.equal(qa.snapshot().reportObserver.responses.length, 0, 'downstream cancel or redirect creates no response correlation');
    assert.equal(qa.snapshot().reportObserver.attempts[0].decision, 'cancel');
    assert.equal(qa.snapshot().reportObserver.attempts[0].actionID, null);
  }
});

test('headers latch holds only the exact admitted response and records real accepted Cancel plus uncertain send before fallback', async () => {
  const qa=fixture();
  const cancelResult={status:'cancelled',uncertain:true};
  const sendResult={status:'cancelled',error:'network'};
  let resolveSend;
  const sendPromise=new Promise(resolve=>{resolveSend=resolve});
  qa.registerReportHandlers({cancel(){resolveSend(sendResult);return cancelResult},send(){return sendPromise}});
  assert.equal(qa.arm(body,{responseMode:'hold-and-cancel'}).ok,true);
  const actualSend=qa.invoke('trace:bug-report-send',{prepareId:'opaque'});
  assert.equal(actualSend,sendPromise,'the production send handler remains pending while the receiver response is outstanding');
  assert.equal(qa.request({uploadData:bytesItem(),id:88}).cancel,false);
  qa.registerHeaders('trace-egress',(_details,finish)=>finish({}));
  const held=qa.headers({id:88,statusCode:200});
  assert.deepEqual(held,[],'the Electron response callback stays held before actual UI cancellation');
  assert.equal(qa.snapshot().reportObserver.responses[0].phase,'headers-held');
  assert.equal(qa.invoke('trace:bug-report-cancel',{prepareId:'opaque'}),cancelResult,'cancel bridge outcome is forwarded unchanged');
  assert.equal(await actualSend,sendResult,'the same production send promise resolves only after cancellation');
  const oracle=qa.snapshot().reportObserver.cancelOracles[0];
  assert.deepEqual(oracle,{actionID:ACTION,cancelAccepted:true,sendTerminalUncertain:true,heldAtCancelAccepted:true,heldAtSendTerminal:true,
    cancelRequestMatchesSend:true,cancelOutcome:'accepted',sendOutcome:'uncertain',generation:oracle.generation});
  assert.ok(Number.isSafeInteger(oracle.generation));
  assert.equal(qa.api.cancelResponse(ACTION),true,'finally releases the held response as cleanup');
  assert.deepEqual(held,[{cancel:true}]);
  assert.equal(qa.api.cancelResponse(ACTION),false,'the held Electron callback is settled exactly once');
  const snapshot=qa.snapshot();
  assert.equal(snapshot.reportObserver.responses[0].outcome,'cancelled');
  assert.equal(snapshot.reportObserver.allowedCount,1,'a response cancellation does not erase the admitted POST');
  assert.equal(JSON.stringify(snapshot).includes('opaque'),false);
  assert.equal(JSON.stringify(snapshot).includes('responseHeaders'),false);
  qa.appEvent('will-quit');
  assert.match(qa.writes.join(''),/"allExternalRequestsCancelled":false/);
});

test('IPC wrappers preserve original receiver and argument identity while retaining only the dispatch-time primitive token', async () => {
  const qa=fixture();
  const sendEvent={kind:'send-event'};
  const cancelEvent={kind:'cancel-event'};
  const sendRequest={prepareId:'opaque-original-token',metadata:'PRIVATE_IPC_CANARY'};
  let sendInvocation, cancelInvocation, resolveSend;
  const sendPromise=new Promise(resolve=>{resolveSend=resolve});
  qa.registerReportHandlers({
    send(event,request){sendInvocation={receiver:this,event,request};return sendPromise},
    cancel(event,request){cancelInvocation={receiver:this,event,request};resolveSend({status:'cancelled',error:'private'});return {status:'cancelled',uncertain:true}},
  });
  assert.equal(qa.arm(body,{responseMode:'hold-and-cancel'}).ok,true);
  const actualSend=qa.invokeWithEvent('trace:bug-report-send',sendEvent,sendRequest);
  assert.equal(actualSend,sendPromise);
  sendRequest.prepareId='mutated-after-dispatch';
  sendRequest.metadata='changed-after-dispatch';
  assert.equal(qa.request({uploadData:bytesItem(),id:120}).cancel,false);
  qa.registerHeaders('trace-egress',(_details,finish)=>finish({}));
  assert.deepEqual(qa.headers({id:120,statusCode:200}),[]);
  const cancelRequest={prepareId:'opaque-original-token'};
  qa.invokeWithEvent('trace:bug-report-cancel',cancelEvent,cancelRequest);
  await actualSend;
  const oracle=qa.snapshot().reportObserver.cancelOracles[0];
  assert.equal(oracle.cancelRequestMatchesSend,true,'the private matching token was copied before the request object changed');
  assert.equal(oracle.cancelAccepted,true);
  assert.equal(sendInvocation.receiver,qa.sandbox.require('electron').ipcMain);
  assert.equal(sendInvocation.event,sendEvent);
  assert.equal(sendInvocation.request,sendRequest);
  assert.equal(cancelInvocation.receiver,qa.sandbox.require('electron').ipcMain);
  assert.equal(cancelInvocation.event,cancelEvent);
  assert.equal(cancelInvocation.request,cancelRequest);
  assert.equal(qa.api.cancelResponse(ACTION),true);
  const serialized=JSON.stringify(qa.snapshot())+qa.writes.join('');
  assert.equal(serialized.includes('opaque-original-token'),false);
  assert.equal(serialized.includes('PRIVATE_IPC_CANARY'),false);
  const expression=inspector.observerExpression();
  assert.match(expression,/sendRequestTokens\.delete\(staleResponse\.actionID\)/,
    'stale same-ID correlation immediately drops its opaque token even when no response is held');
  assert.ok(expression.indexOf('prepareTokenAtDispatch(args[1])') < expression.indexOf('listener.apply(this,args)'),
    'the validated primitive is copied before production IPC forwarding');
  const captureStart=expression.indexOf('const capture=value=>');
  const captureEnd=expression.indexOf('if(result&&typeof result.then',captureStart);
  assert.doesNotMatch(expression.slice(captureStart,captureEnd),/\bargs\b/,
    'asynchronous observation closures do not capture the IPC argument array');
});

test('onHeadersReceived preserves Electron last-listener-wins semantics while keeping the observer as final wrapper', () => {
  const qa=fixture();
  assert.equal(qa.arm(body,{responseMode:'hold-and-cancel'}).ok,true);
  qa.request({uploadData:bytesItem(),id:87});
  let firstCalls=0,lastCalls=0;
  qa.registerHeaders('trace-egress',(_details,finish)=>{firstCalls++;finish({cancel:true})});
  qa.registerHeaders('trace-egress',(_details,finish)=>{lastCalls++;finish({})});
  const decisions=qa.headers({id:87,statusCode:200});
  assert.equal(firstCalls,0,'an earlier Electron listener is replaced by the later listener');
  assert.equal(lastCalls,1,'only Electron’s effective last listener runs');
  assert.deepEqual(decisions,[],'the observer holds the effective listener result at the final callback boundary');
  assert.equal(qa.api.cancelResponse(ACTION),true);
});

test('headers preserve actual details getters and never read response metadata or body fields', () => {
  const qa = fixture();
  qa.arm(body, { responseMode: 'hold-and-cancel' });
  qa.request({ uploadData: bytesItem(), id: 94 });
  let calls = 0;
  qa.registerHeaders('trace-egress', (_details, finish) => { calls++; finish({}); });
  const details = { id: 94, url: ENDPOINT, method: 'POST', statusCode: 200 };
  for (const key of ['responseHeaders', 'statusLine', 'body', 'originUrl', 'referrer']) {
    Object.defineProperty(details, key, { get() { throw new Error('FORBIDDEN_HEADER_GETTER_' + key); } });
  }
  assert.doesNotThrow(() => qa.headers({ id: 94, __actualDetails: details }));
  assert.equal(calls, 1);
  assert.equal(qa.api.cancelResponse(ACTION), true);
});

test('header callback is invoked at most once after callback-then-throw or throw-before-callback', () => {
  for (const report of [true, false]) {
    const qa = fixture();
    if (report) { qa.arm(body); qa.request({ uploadData: bytesItem(), id: 95 }); }
    qa.registerHeaders('trace-egress', (_details, finish) => { finish({}); throw new Error('listener throw'); });
    assert.deepEqual(qa.headers({ id: 95, statusCode: 200 }), [{}], 'callback-then-throw does not invoke Electron callback a second time');
  }
  const before = fixture();
  before.arm(body);
  before.request({ uploadData: bytesItem(), id: 96 });
  before.registerHeaders('trace-egress', () => { throw new Error('before callback'); });
  assert.deepEqual(before.headers({ id: 96, statusCode: 200 }), [{ cancel: true }]);

  const held = fixture();
  held.arm(body, { responseMode: 'hold-and-cancel' });
  held.request({ uploadData: bytesItem(), id: 101 });
  held.registerHeaders('trace-egress', (_details, finish) => { finish({}); throw new Error('after hold'); });
  assert.deepEqual(held.headers({ id: 101, statusCode: 200 }), [{ cancel: true }], 'a held callback followed by a throw is cancelled once by failure cleanup');
  assert.equal(held.snapshot().reportObserver.responses[0].outcome, 'listener-error');
});

test('normal and held receiver responses reject downstream header/status rewrites without inspecting values', () => {
  for (const responseMode of ['normal', 'hold-and-cancel']) {
    const qa = fixture();
    qa.arm(body, { responseMode });
    qa.request({ uploadData: bytesItem(), id: responseMode === 'normal' ? 97 : 98 });
    const rewrite = {};
    Object.defineProperty(rewrite, 'responseHeaders', { get() { throw new Error('FORBIDDEN_RESPONSE_HEADER_VALUE'); } });
    qa.registerHeaders('trace-egress', (_details, finish) => finish(rewrite));
    const result = qa.headers({ id: responseMode === 'normal' ? 97 : 98, statusCode: 200 });
    assert.deepEqual(result, [{ cancel: true }]);
    assert.equal(qa.api.cancelResponse(ACTION), false);
  }
});

test('ordinary non-report header decisions preserve the downstream receiver and value unchanged', () => {
  const qa = fixture();
  const decision = { responseHeaders: [{ name: 'x-ordinary', value: 'kept' }] };
  qa.registerHeaders('trace-egress', (_details, finish) => finish(decision));
  const listener = qa.sandbox.require('electron').session.fromPartition('trace-egress').webRequest.headers;
  let forwarded;
  listener({ id: 100, url: 'https://example.invalid/ordinary', method: 'GET', statusCode: 200 }, (value) => { forwarded = value; });
  assert.strictEqual(forwarded, decision);
});

test('send terminal failure before network admission closes the gate and transient token', async () => {
  const qa = fixture();
  qa.registerReportHandlers({ send: () => Promise.reject(new Error('private send terminal canary')) });
  qa.arm(body, { responseMode: 'hold-and-cancel' });
  await assert.rejects(() => qa.invoke('trace:bug-report-send', { prepareId: 'opaque-private-id' }));
  assert.equal(qa.request({ uploadData: bytesItem(), id: 99 }).cancel, true);
  assert.equal(qa.snapshot().reportObserver.gateFailures, 1);
  assert.equal(JSON.stringify(qa.snapshot()).includes('opaque-private-id'), false);
});

test('report privacy phase keeps fatal error counts and classes but drops report text, paths and stacks', () => {
  const qa = fixture();
  qa.api.setPrivacy(true);
  const handlers = new Map();
  const contents = { on(name, callback) { handlers.set(name, callback); } };
  qa.appEvent('web-contents-created', {}, contents);
  handlers.get('console-message')({}, 3, 'PRIVATE_REPORT_TEXT_C:\\local\\secret.json');
  handlers.get('did-fail-load')({}, -105, 'PRIVATE_REPORT_DESCRIPTION', 'file:///C:/secret/report.json');
  handlers.get('render-process-gone')({}, { reason: 'crashed with PRIVATE_REPORT_STACK' });
  qa.processListeners.get('uncaughtExceptionMonitor')(new Error('PRIVATE_REPORT_STACK C:\\secret\\input.json'), 'uncaughtException');
  const snapshot = qa.snapshot();
  assert.deepEqual(snapshot.errors.map((entry) => entry.type), ['console', 'load', 'render-process-gone', 'uncaught-exception']);
  assert.equal(snapshot.errors.every((entry) => entry.reportSensitive === true), true);
  assert.equal(snapshot.errors.find((entry) => entry.type === 'load').code, -105, 'safe numeric error class remains available');
  assert.equal(JSON.stringify(snapshot.errors).includes('PRIVATE_REPORT'), false);
  assert.equal(JSON.stringify(snapshot.errors).includes('secret.json'), false);
});

test('one-argument and removal forms of onHeadersReceived retain a safe completion handler', () => {
  const single=fixture();
  assert.equal(single.arm(body,{responseMode:'hold-and-cancel'}).ok,true);
  single.request({uploadData:bytesItem(),id:83});
  let calls=0;
  single.registerHeadersSingle('trace-egress',(_details,finish)=>{calls++;finish({})});
  assert.deepEqual(single.headers({id:83,statusCode:200}),[]);
  assert.equal(calls,1);
  assert.equal(single.api.cancelResponse(ACTION),true);

  const removed=fixture();
  assert.equal(removed.arm(body,{responseMode:'hold-and-cancel'}).ok,true);
  removed.request({uploadData:bytesItem(),id:82});
  removed.registerHeadersRemoval('trace-egress');
  assert.deepEqual(removed.headers({id:82,statusCode:200}),[],'removal leaves the observer callback in place');
  assert.equal(removed.api.cancelResponse(ACTION),true);
});

test('IPC wrappers preserve receiver, argument identity, promise value and rejection', async () => {
  const qa=fixture();
  const marker={prepareId:'opaque'};
  const result={status:'cancelled',uncertain:true};
  let receiver=null,args=null,underlyingPromise=null;
  qa.registerReportHandlers({cancel:function(...input){receiver=this;args=input;underlyingPromise=Promise.resolve(result);return underlyingPromise},send:()=>new Promise(()=>{})});
  assert.equal(qa.arm(body,{responseMode:'hold-and-cancel'}).ok,true);
  qa.invoke('trace:bug-report-send',marker);
  qa.request({uploadData:bytesItem(),id:81});
  qa.registerHeaders('trace-egress',(_details,finish)=>finish({}));
  qa.headers({id:81,statusCode:200});
  const actualPromise=qa.invoke('trace:bug-report-cancel',marker);
  assert.equal(actualPromise,underlyingPromise,'the observer returns the original handler promise without wrapping its result');
  assert.equal(await actualPromise,result);
  assert.equal(args.length,2);
  assert.equal(args[1],marker,'forwarded IPC argument identity is unchanged');
  assert.ok(receiver,'the production listener receives the IPC receiver');
  assert.equal(qa.snapshot().reportObserver.cancelOracles[0].cancelAccepted,true);
  qa.api.cancelResponse(ACTION);

  const rejected=fixture();
  const rejection=new Error('private rejection canary');
  rejected.registerReportHandlers({cancel:()=>Promise.reject(rejection),send:()=>new Promise(()=>{})});
  await assert.rejects(()=>rejected.invoke('trace:bug-report-cancel',marker),(error)=>error===rejection);
});

test('response latch timeout and shutdown each settle the held Electron callback once and clean their correlation', () => {
  const timeout=fixture();
  assert.equal(timeout.arm(body,{responseMode:'hold-and-cancel'}).ok,true);
  timeout.request({uploadData:bytesItem(),id:86});
  const timers=[];const cleared=[];
  timeout.sandbox.setTimeout=(callback,ms)=>{const id=timers.length+1;timers.push({id,callback,ms});return id};
  timeout.sandbox.clearTimeout=(id)=>cleared.push(id);
  timeout.registerHeaders('trace-egress',(_details,finish)=>finish({}));
  const timeoutDecision=timeout.headers({id:86,statusCode:200});
  assert.equal(timeoutDecision.length,0);
  assert.equal(timers[0].ms<=5000,true,'response hold deadline is bounded to five seconds');
  timers[0].callback();
  assert.deepEqual(timeoutDecision,[{cancel:true}]);
  assert.equal(timeout.snapshot().reportObserver.responses[0].outcome,'timeout');
  assert.equal(timeout.api.cancelResponse(ACTION),false);
  assert.ok(cleared.includes(timers[0].id),'timeout clears its timer handle');

  const shutdown=fixture();
  assert.equal(shutdown.arm(body,{responseMode:'hold-and-cancel'}).ok,true);
  shutdown.request({uploadData:bytesItem(),id:85});
  shutdown.registerHeaders('trace-egress',(_details,finish)=>finish({}));
  const shutdownDecision=shutdown.headers({id:85,statusCode:201});
  shutdown.appEvent('will-quit');
  assert.deepEqual(shutdownDecision,[{cancel:true}]);
  assert.equal(shutdown.api.cancelResponse(ACTION),false);
  assert.equal(shutdown.snapshot().reportObserver.responses[0].outcome,'shutdown');
});

test('a second request reusing the held response ID invalidates its cancellation-only correlation', () => {
  const qa=fixture();
  assert.equal(qa.arm(body,{responseMode:'hold-and-cancel'}).ok,true);
  assert.equal(qa.request({uploadData:bytesItem(),id:84}).cancel,false);
  assert.equal(qa.request({uploadData:bytesItem(Buffer.from('changed')),id:84}).cancel,true);
  qa.registerHeaders('trace-egress',(_details,finish)=>finish({}));
  assert.deepEqual(qa.headers({id:84,statusCode:200}),[{cancel:true}]);
  assert.equal(qa.snapshot().reportObserver.responses[0].outcome,'mismatch');
  assert.equal(qa.api.cancelResponse(ACTION),false);
});

test('response latch rejects no-op, rejected, and mismatched production Cancel actions', async () => {
  for(const mode of ['noop','rejected','mismatched']){
    const qa=fixture();
    qa.registerReportHandlers({cancel(){if(mode==='rejected')throw new Error('private receiver canary');return mode==='mismatched'?{status:'cancelled',uncertain:true}:{status:'stale-preview'}},
      send(){return new Promise(()=>{})}});
    assert.equal(qa.arm(body,{responseMode:'hold-and-cancel'}).ok,true);
    qa.invoke('trace:bug-report-send',{prepareId:'opaque'});
    assert.equal(qa.request({uploadData:bytesItem(),id:89}).cancel,false);
    qa.registerHeaders('trace-egress',(_details,finish)=>finish({}));
    const held=qa.headers({id:89,statusCode:201});
    assert.equal(held.length,0);
    if(mode==='rejected')assert.throws(()=>qa.invoke('trace:bug-report-cancel',{prepareId:'opaque'}),/private receiver canary/);
    else qa.invoke('trace:bug-report-cancel',{prepareId:mode==='mismatched'?'different':'opaque'});
    const oracle=qa.snapshot().reportObserver.cancelOracles[0];
    assert.equal(oracle.cancelAccepted,false);
    assert.equal(oracle.sendTerminalUncertain,false);
    if(mode==='mismatched'){
      assert.equal(oracle.cancelRequestMatchesSend,false);
      assert.equal(oracle.cancelOutcome,'mismatched-request');
    }
    assert.equal(qa.api.cancelResponse(ACTION),true,'forced release is cleanup only and cannot change the failed oracle');
    assert.equal(qa.snapshot().reportObserver.responses[0].outcome,'cancelled');
    assert.equal(JSON.stringify(qa.snapshot()).includes('private receiver canary'),false);
  }
});

test('an acknowledgement that already won remains received and cannot be rewritten to uncertainty', async () => {
  const qa=fixture();
  qa.registerReportHandlers({cancel(){return {status:'stale-preview'}},send(){return Promise.resolve({status:'received',reportId:'synthetic-id'})}});
  assert.equal(qa.arm(body,{responseMode:'hold-and-cancel'}).ok,true);
  const sendPromise=qa.invoke('trace:bug-report-send',{prepareId:'opaque'});
  qa.request({uploadData:bytesItem(),id:94});
  qa.registerHeaders('trace-egress',(_details,finish)=>finish({}));
  qa.headers({id:94,statusCode:200});
  await sendPromise;
  qa.invoke('trace:bug-report-cancel',{prepareId:'opaque'});
  const oracle=qa.snapshot().reportObserver.cancelOracles[0];
  assert.equal(oracle.sendTerminalUncertain,false);
  assert.equal(oracle.sendOutcome,'other-terminal','a completed acknowledgement remains a different terminal result');
  assert.equal(qa.api.cancelResponse(ACTION),true,'cleanup cancels the held callback without changing the acknowledgement observation');
});

test('pre-header actual Cancel and response listener exceptions fail closed and remove cancellation-only state', () => {
  const beforeHeaders=fixture();
  beforeHeaders.registerReportHandlers({cancel(){return {status:'cancelled',uncertain:true}}});
  assert.equal(beforeHeaders.arm(body,{responseMode:'hold-and-cancel'}).ok,true);
  beforeHeaders.registerReportHandlers({send:()=>new Promise(()=>{})});
  beforeHeaders.invoke('trace:bug-report-send',{prepareId:'opaque'});
  beforeHeaders.request({uploadData:bytesItem(),id:95});
  beforeHeaders.invoke('trace:bug-report-cancel',{prepareId:'opaque'});
  const snapshot=beforeHeaders.snapshot();
  assert.equal(snapshot.reportObserver.responses[0].outcome,'cancel-before-headers');
  assert.equal(snapshot.reportObserver.responseFailures,1);

  const thrown=fixture();
  assert.equal(thrown.arm(body,{responseMode:'hold-and-cancel'}).ok,true);
  thrown.request({uploadData:bytesItem(),id:96});
  thrown.registerHeaders('trace-egress',()=>{throw new Error('private header-listener canary')});
  assert.deepEqual(thrown.headers({id:96,statusCode:200}),[{cancel:true}]);
  assert.equal(thrown.snapshot().reportObserver.responses[0].outcome,'listener-error');
  assert.equal(JSON.stringify(thrown.snapshot()).includes('private header-listener canary'),false);
  assert.equal(thrown.api.cancelResponse(ACTION),false);
});

test('normal report responses pass through untouched and do not install a response hold', () => {
  const qa=fixture();
  assert.equal(qa.arm(body).ok,true);
  assert.equal(qa.request({uploadData:bytesItem(),id:97}).cancel,false);
  let called=0;
  qa.registerHeaders('trace-egress',(_details,finish)=>{called++;finish({})});
  assert.deepEqual(qa.headers({id:97,statusCode:200}),[{}]);
  assert.equal(called,1);
  assert.deepEqual(qa.snapshot().reportObserver.responses,[]);
});

test('response latch rejects altered request identity/status, duplicate headers, downstream overrides and one-shot reuse', () => {
  const qa=fixture();
  assert.equal(qa.arm(body,{responseMode:'hold-and-cancel'}).ok,true);
  assert.equal(qa.request({uploadData:bytesItem(),id:90}).cancel,false);
  qa.registerHeaders('trace-egress',(_details,finish)=>finish({}));
  const mismatch=qa.headers({id:90,url:`${ENDPOINT}?altered=1`,statusCode:200});
  assert.deepEqual(mismatch,[{cancel:true}]);
  assert.equal(qa.api.cancelResponse(ACTION),false);
  assert.equal(qa.arm(body,{responseMode:'hold-and-cancel'}).ok,false,'response disruption is one-shot per process');

  const method=fixture();
  method.arm(body,{responseMode:'hold-and-cancel'});method.request({uploadData:bytesItem(),id:98});
  method.registerHeaders('trace-egress',(_details,finish)=>finish({}));
  assert.deepEqual(method.headers({id:98,method:'GET',statusCode:200}),[{cancel:true}],'method mismatch cannot reach the real response body');

  const session=fixture();
  session.arm(body,{responseMode:'hold-and-cancel'});session.request({uploadData:bytesItem(),id:99});
  assert.deepEqual(session.headers({id:99,session:'default',statusCode:200}),[{cancel:true}],'session mismatch cannot reuse cancellation-only correlation');

  const status=fixture();
  assert.equal(status.arm(body,{responseMode:'hold-and-cancel'}).ok,true);
  status.request({uploadData:bytesItem(),id:91});
  status.registerHeaders('trace-egress',(_details,finish)=>finish({}));
  assert.deepEqual(status.headers({id:91,statusCode:302}),[{cancel:true}]);
  assert.equal(status.snapshot().reportObserver.responses[0].outcome,'unexpected-status');

  const override=fixture();
  assert.equal(override.arm(body,{responseMode:'hold-and-cancel'}).ok,true);
  override.request({uploadData:bytesItem(),id:92});
  override.registerHeaders('trace-egress',(_details,finish)=>finish({responseHeaders:{'x-private':['canary']}}));
  assert.deepEqual(override.headers({id:92,statusCode:200}),[{cancel:true}]);
  assert.equal(JSON.stringify(override.snapshot()).includes('canary'),false);

  const duplicate=fixture();
  duplicate.arm(body,{responseMode:'hold-and-cancel'});duplicate.request({uploadData:bytesItem(),id:100});
  duplicate.registerHeaders('trace-egress',(_details,finish)=>finish({}));
  assert.deepEqual(duplicate.headers({id:100,statusCode:200}),[]);
  assert.deepEqual(duplicate.headers({id:100,statusCode:200}),[{cancel:true}],'duplicate response event cannot reuse the same correlation');
  assert.equal(duplicate.api.cancelResponse(ACTION),true);
  assert.ok(duplicate.snapshot().reportObserver.responseFailures>0);
});

test('header inspection never reads response headers, status line, origin or body fields', () => {
  const qa=fixture();
  assert.equal(qa.arm(body,{responseMode:'hold-and-cancel'}).ok,true);
  qa.request({uploadData:bytesItem(),id:93});
  qa.registerHeaders('trace-egress',(_details,finish)=>finish({}));
  const details={id:93,url:ENDPOINT,method:'POST',statusCode:200};
  for(const key of ['responseHeaders','statusLine','referrer','uploadData'])Object.defineProperty(details,key,{get(){throw new Error(`read ${key}`)}});
  assert.deepEqual(qa.headers(details),[]);
  assert.equal(qa.api.cancelResponse(ACTION),true);
});

test('gate rejects wrong session, method, URL shape, redirects, digest and byte count', () => {
  const badRequests = [
    { session: 'default' }, { method: 'GET' }, { url: `${ENDPOINT}?q=x` }, { url: `${ENDPOINT}#fragment` },
    { url: `${ENDPOINT}/extra` }, { url: 'http://trace-bug-report.trace-boardviewer.workers.dev/v1/reports' },
    { url: `https://malicious.invalid/v1/reports?${RECEIVER_CANARY}` },
    { redirectURL: 'https://elsewhere.invalid/' }, { uploadData: bytesItem(Buffer.from('different')) },
  ];
  for (const [index, options] of badRequests.entries()) {
    const qa = fixture();
    assert.equal(qa.arm(body).ok, true);
    assert.equal(qa.request({ uploadData: bytesItem(), id: 10 + index, ...options }).cancel, true, JSON.stringify(options));
    assert.equal(qa.snapshot().reportObserver.allowedCount, 0);
    assert.equal(qa.snapshot().reportObserver.deniedCount, 1);
  }
});

test('same physical request ID never reuses permission after host, path, query, fragment, method, session, bytes or deadline change', async () => {
  const qa = fixture();
  assert.equal(qa.arm(body).ok, true);
  assert.equal(qa.request({ uploadData: bytesItem(), id: 42 }).cancel, false);
  const altered = [
    { url: 'https://evil.invalid/v1/reports' },
    { url: 'https://trace-bug-report.trace-boardviewer.workers.dev/v1/other' },
    { url: `${ENDPOINT}?changed=1` },
    { url: `${ENDPOINT}#changed` },
    { method: 'GET' },
    { session: 'default' },
    { uploadData: bytesItem(Buffer.from('changed')) },
  ];
  for (const [index, change] of altered.entries()) {
    assert.equal(qa.request({ uploadData: bytesItem(), id: 42, ...change }).cancel, true, `changed replay ${index}`);
  }
  assert.equal(qa.snapshot().reportObserver.allowedCount, 1);
  assert.equal(qa.snapshot().reportObserver.deniedCount, altered.length);

  const expired = fixture();
  assert.equal(expired.arm(body, { windowMs: 5 }).ok, true);
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(expired.request({ uploadData: bytesItem(), id: 42 }).cancel, true, 'expired ID cannot inherit prior authorization');
});

test('a downstream redirect response cancels the report and updates evidence', () => {
  const qa = fixture();
  assert.equal(qa.arm(body).ok, true);
  qa.register('trace-egress', (_details, finish) => finish({ redirectURL: 'https://elsewhere.invalid/' }));
  assert.equal(qa.request({ uploadData: bytesItem(), id: 43 }).cancel, true);
  assert.equal(qa.snapshot().reportObserver.allowedCount, 0);
  assert.equal(qa.snapshot().reportObserver.deniedCount, 1);
  assert.equal(qa.snapshot().reportObserver.attempts[0].decision, 'cancel');
});

test('report upload shape accepts only one bounded in-memory bytes item', () => {
  const invalid = [undefined, [], [{ file: '/private/path' }], [{ blobUUID: 'private-blob' }], [{ bytes: body }, { bytes: body }],
    [{ bytes: body.toString('utf8') }], [{ bytes: Buffer.alloc(16385) }], [{ bytes: new Uint8Array(16385) }], [{ bytes: Buffer.alloc(0) }], [{ bytes: body, file: 'private-name' }]];
  for (const [index, uploadData] of invalid.entries()) {
    const qa = fixture();
    assert.equal(qa.arm(body).ok, true);
    assert.equal(qa.request({ uploadData, id: 30 + index }).cancel, true, `invalid uploadData case ${index}`);
    assert.equal(JSON.stringify(qa.snapshot()).includes('/private/path'), false);
    assert.equal(JSON.stringify(qa.snapshot()).includes('private-blob'), false);
    assert.equal(JSON.stringify(qa.snapshot()).includes('private-name'), false);
  }
  const hiddenFile = { bytes: body };
  Object.defineProperty(hiddenFile, 'file', { value: 'private-hidden-name', enumerable: false });
  const qa = fixture();
  assert.equal(qa.arm(body).ok, true);
  assert.equal(qa.request({ uploadData: [hiddenFile], id: 80 }).cancel, true, 'non-enumerable file fields are rejected');
  assert.equal(JSON.stringify(qa.snapshot()).includes('private-hidden-name'), false);
});

test('invalid gates, rearming, expiry and explicit close fail closed', async () => {
  const invalid = fixture();
  assert.equal(invalid.api.arm({ actionId: 'bad id', sha256: '0'.repeat(64), byteCount: body.length }).ok, false);
  assert.equal(invalid.request({ uploadData: bytesItem() }).cancel, true);
  const unknown = fixture();
  assert.equal(unknown.api.arm({ actionId: ACTION, sha256: crypto.createHash('sha256').update(body).digest('hex'),
    byteCount: body.length, privateBody: 'synthetic' }).ok, false, 'the arm API rejects unknown keys');

  const rearm = fixture();
  assert.equal(rearm.arm(body).ok, true);
  assert.deepEqual(rearm.arm(body), { ok: false, code: 'gate-already-live' });
  assert.equal(rearm.request({ uploadData: bytesItem() }).cancel, true, 'rearming invalidates the first live authorization');

  const expired = fixture();
  assert.equal(expired.arm(body, { windowMs: 5 }).ok, true);
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(expired.request({ uploadData: bytesItem() }).cancel, true);
  assert.equal(expired.snapshot().reportObserver.gateFailures, 1);

  const closed = fixture();
  assert.equal(closed.arm(body).ok, true);
  assert.equal(closed.api.close(ACTION), true);
  assert.equal(closed.request({ uploadData: bytesItem() }).cancel, true);
});

test('only fixed safe report fields reach marker, error and ordinary observer channels', () => {
  const qa = fixture();
  const payload = Buffer.from(`description:${RECEIVER_CANARY};path:C:\\private\\board`);
  qa.request({ url: `${ENDPOINT}?${RECEIVER_CANARY}`, uploadData: [{ bytes: payload, file: 'C:\\private\\board' }], id: 90 });
  qa.appEvent('will-quit');
  const marker = qa.writes.join('');
  assert.match(marker, /"allExternalRequestsCancelled":true/);
  assert.match(marker, /"reportObserver":\{"version":2,"allowedCount":0,"deniedCount":1,"gateArms":0,"gateFailures":0,"responseArms":0,"responseFailures":0,/);
  for (const channel of [marker, JSON.stringify(qa.snapshot())]) {
    assert.equal(channel.includes(RECEIVER_CANARY), false);
    assert.equal(channel.includes('C:\\private\\board'), false);
    assert.equal(channel.includes('uploadData'), false);
  }
});
