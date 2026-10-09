'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const { _electron } = require('playwright');

const MAIN_ENTRY = 'app.asar/electron/main.cjs';
const MAIN_LINE = 3;
const INSPECTOR_TIMEOUT_MS = 10000;

function withTimeout(promise, timeoutMs, message) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); })])
    .finally(() => clearTimeout(timer));
}

function mainFrameUrl(frame, scriptUrls = new Map()) {
  return String(frame?.url || scriptUrls.get(frame?.location?.scriptId) || '').replace(/\\/g, '/');
}

function isMainEntryFrame(frame, scriptUrls = new Map()) {
  return /(?:^|\/)app\.asar\/electron\/main\.cjs(?:$|[?#])/.test(mainFrameUrl(frame, scriptUrls));
}

function observerExpression() {
  return `(()=>{
    const e=require('electron');
    const crypto=require('node:crypto');
    const state=globalThis.__traceQaPreMain={installedBeforeReady:!e.app.isReady(),events:[],sessions:0,ready:false};
    globalThis.__traceQaEvents=state.events;
    globalThis.__traceQaResources=[];
    globalThis.__traceQaNetwork=[];
    globalThis.__traceQaErrors=[];
    globalThis.__traceQaExternalUrls=[];
    globalThis.__traceQaHoldEgress=false;
    const reportHost='trace-bug-report.trace-boardviewer.workers.dev';
    const reportPath='/v1/reports';
    const reportAttempts=[];
    const reportState={version:2,allowedCount:0,deniedCount:0,gateArms:0,gateFailures:0,responseArms:0,responseFailures:0};
    let reportGate=null;
    const responseCorrelations=new Map();
    const invalidResponseIds=new Map();
    const responseRecords=[];
    const heldResponses=new Map();
    const cancelOracles=new Map();
    const sendRequestTokens=new Map();
    let bugReportPrivacyPhase=false;
    const recordQaError=(type,details={})=>{
      if(!bugReportPrivacyPhase){globalThis.__traceQaErrors.push({type,...details});return}
      const safe={type,reportSensitive:true};
      if(Number.isSafeInteger(details.code))safe.code=details.code;
      globalThis.__traceQaErrors.push(safe);
    };
    let responseGeneration=0;
    const safeId=value=>typeof value==='string'&&value.length>=1&&value.length<=96&&/^[A-Za-z0-9._:-]+$/.test(value);
    const closeGate=(actionId,failed=false,preserveToken=false)=>{
      if(!reportGate)return false;
      if(actionId!==undefined&&actionId!==reportGate.actionId)return false;
      const closedAction=reportGate.actionId;
      clearTimeout(reportGate.timer);
      reportGate=null;
      if(!preserveToken)sendRequestTokens.delete(closedAction);
      if(failed)reportState.gateFailures++;
      return true;
    };
    const prepareTokenAtDispatch=request=>{
      try{
        if(!request||typeof request!=='object')return null;
        const descriptor=Object.getOwnPropertyDescriptor(request,'prepareId');
        return descriptor&&typeof descriptor.value==='string'&&descriptor.value.length>=1&&descriptor.value.length<=96
          &&/^[A-Za-z0-9._:-]+$/.test(descriptor.value)?descriptor.value:null;
      }catch{return null}
    };
    const responseRecord=(actionID,phase,statusCode=null,outcome='pending')=>({actionID,mode:'hold-and-cancel',phase,outcome,statusCode:[200,201].includes(statusCode)?statusCode:null});
    const takeResponseCorrelation=id=>{
      const correlation=responseCorrelations.get(id);
      if(correlation){clearTimeout(correlation.timer);responseCorrelations.delete(id)}
      return correlation||null;
    };
    const settleHeld=(entry,decision,outcome)=>{
      if(!entry||entry.settled)return false;
      entry.settled=true;clearTimeout(entry.timer);heldResponses.delete(entry.actionID);
      sendRequestTokens.delete(entry.actionID);
      try{entry.callback(decision)}finally{
        const record=responseRecords.find(item=>item.actionID===entry.actionID);
        if(record){record.phase=outcome==='cancelled'?'cancelled':'failed';record.outcome=outcome}
        if(outcome!=='cancelled')reportState.responseFailures++;
      }
      return true;
    };
    globalThis.__traceQaCancelBugReportResponse=actionID=>{
      const entry=heldResponses.get(actionID);
      return settleHeld(entry,{cancel:true},'cancelled');
    };
    const oracleForActiveHold=()=>{
      const actionID=heldResponses.keys().next().value;
      if(!actionID)return null;
      const held=heldResponses.get(actionID);
      if(!cancelOracles.has(actionID))cancelOracles.set(actionID,{actionID,cancelAccepted:false,sendTerminalUncertain:false,
        heldAtCancelAccepted:false,heldAtSendTerminal:false,cancelRequestMatchesSend:false,
        cancelOutcome:'not-observed',sendOutcome:'not-observed',generation:held.generation});
      return cancelOracles.get(actionID);
    };
    if(e.ipcMain&&typeof e.ipcMain.handle==='function'){
      const originalHandle=e.ipcMain.handle;
      e.ipcMain.handle=function(channel,listener){
        if(!['trace:bug-report-cancel','trace:bug-report-send'].includes(channel)||typeof listener!=='function')return originalHandle.call(this,channel,listener);
        const kind=channel==='trace:bug-report-cancel'?'cancel':'send';
        const wrapped=function(...args){
          const oracle=kind==='cancel'?oracleForActiveHold():null;
          const sendActionAtDispatch=kind==='send'&&reportGate?.responseMode==='hold-and-cancel'?reportGate.actionId:null;
          const prepareToken=prepareTokenAtDispatch(args[1]);
          if(sendActionAtDispatch){
            sendRequestTokens.set(sendActionAtDispatch,prepareToken);
          }
          if(kind==='cancel'&&!oracle){
            for(const [requestId,correlation] of [...responseCorrelations]){
              takeResponseCorrelation(requestId);invalidResponseIds.set(requestId,{session:correlation.session,actionID:correlation.actionID});
              sendRequestTokens.delete(correlation.actionID);
              if(correlation.responseMode==='hold-and-cancel'){
                responseRecords.push(responseRecord(correlation.actionID,'not-reached',null,'cancel-before-headers'));
                reportState.responseFailures++;
              }
            }
          }
          let result;
          try{result=listener.apply(this,args)}catch(error){
            if(kind==='cancel'&&oracle){oracle.cancelOutcome='rejected';oracle.cancelAccepted=false}
            if(kind==='send'&&sendActionAtDispatch){const currentOracle=oracleForActiveHold();if(currentOracle?.actionID===sendActionAtDispatch){currentOracle.sendOutcome='rejected';currentOracle.sendTerminalUncertain=false}sendRequestTokens.delete(sendActionAtDispatch);closeGate(sendActionAtDispatch,true)}
            throw error;
          }
          const capture=value=>{
            const currentOracle=kind==='send'?oracleForActiveHold():oracle;
            if(!currentOracle){if(kind==='send'&&sendActionAtDispatch)sendRequestTokens.delete(sendActionAtDispatch);return}
            if(kind==='cancel'){
              const held=heldResponses.has(currentOracle.actionID);
              const matches=typeof prepareToken==='string'&&sendRequestTokens.has(currentOracle.actionID)&&prepareToken===sendRequestTokens.get(currentOracle.actionID);
              const accepted=value&&value.status==='cancelled'&&value.uncertain===true;
              currentOracle.heldAtCancelAccepted=held;currentOracle.cancelRequestMatchesSend=matches;
              currentOracle.cancelAccepted=!!accepted&&held&&matches;
              currentOracle.cancelOutcome=currentOracle.cancelAccepted?'accepted':accepted&&!matches?'mismatched-request':accepted?'accepted-after-release':value&&value.status==='cancelled'?'accepted-not-uncertain':'no-op';
            }else{
              if(!sendActionAtDispatch)return;
              if(currentOracle.actionID!==sendActionAtDispatch){sendRequestTokens.delete(sendActionAtDispatch);return}
              const held=heldResponses.has(currentOracle.actionID);
              const uncertain=value&&value.status==='cancelled';
              currentOracle.heldAtSendTerminal=held;currentOracle.sendTerminalUncertain=!!uncertain&&held;
              currentOracle.sendOutcome=currentOracle.sendTerminalUncertain?'uncertain':uncertain?'uncertain-after-release':value&&typeof value.status==='string'?'other-terminal':'unknown';
            }
          };
          if(result&&typeof result.then==='function'){
            result.then(value=>{capture(value)},()=>{
              if(kind==='cancel'&&oracle){oracle.cancelOutcome='rejected';oracle.cancelAccepted=false}
              if(kind==='send'&&sendActionAtDispatch){const currentOracle=oracleForActiveHold();if(currentOracle?.actionID===sendActionAtDispatch){currentOracle.sendOutcome='rejected';currentOracle.sendTerminalUncertain=false}sendRequestTokens.delete(sendActionAtDispatch);closeGate(sendActionAtDispatch,true)}
            });
            return result;
          }
          capture(result);
          return result;
        };
        return originalHandle.call(this,channel,wrapped);
      };
    }
    globalThis.__traceQaArmBugReportSend=(input={})=>{
      if(reportGate){closeGate(undefined,true);return {ok:false,code:'gate-already-live'}};
      if(!input||typeof input!=='object'||Array.isArray(input)||Reflect.ownKeys(input).some(key=>!['actionId','sha256','byteCount','windowMs','responseMode'].includes(key))){reportState.gateFailures++;return {ok:false,code:'invalid-gate'}};
      const {actionId,sha256,byteCount,windowMs=15000,responseMode='normal'}=input;
      if(!safeId(actionId)||typeof sha256!=='string'||!/^[a-f0-9]{64}$/.test(sha256)||!Number.isInteger(byteCount)||byteCount<1||byteCount>16384||!Number.isInteger(windowMs)||windowMs<1||windowMs>30000||!['normal','hold-and-cancel'].includes(responseMode)){reportState.gateFailures++;return {ok:false,code:'invalid-gate'}};
      if(responseMode==='hold-and-cancel'&&reportState.responseArms!==0){reportState.gateFailures++;reportState.responseFailures++;return {ok:false,code:'response-latch-exhausted'}};
      const gate={actionId,sha256,byteCount,responseMode,expiresAt:Date.now()+windowMs,timer:null};
      gate.timer=setTimeout(()=>{if(reportGate===gate)closeGate(actionId,true)},windowMs);
      reportGate=gate;reportState.gateArms++;if(responseMode==='hold-and-cancel')reportState.responseArms++;
      return {ok:true,code:'armed'};
    };
    globalThis.__traceQaCloseBugReportSend=actionId=>closeGate(actionId,false);
    const reportUrl=url=>{try{const value=new URL(String(url));const host=value.hostname.toLowerCase();return host===reportHost||value.pathname===reportPath?{value,host,path:value.pathname}:null}catch{return null}};
    const reportBytes=details=>{
      const list=details&&details.uploadData;
      if(!Array.isArray(list)||list.length!==1)return null;
      const item=list[0];
      if(!item||typeof item!=='object'||Reflect.ownKeys(item).some(key=>key!=='bytes')||!(Buffer.isBuffer(item.bytes)||item.bytes instanceof Uint8Array))return null;
      const source=item.bytes;
      if(!Number.isInteger(source.byteLength)||source.byteLength<1||source.byteLength>16384)return null;
      const bytes=Buffer.from(source);
      return {bytes:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')};
    };
    const safeReportRecord=(details,gate,decision,body)=>({targetID:'bug-report-receiver',method:typeof details.method==='string'&&/^[A-Z]{1,12}$/.test(details.method)?details.method:null,
      bytes:body?.bytes??null,sha256:body?.sha256??null,actionID:gate?.actionId??null,decision});
    const observed=new WeakSet();
    const labels=new WeakMap();
    const originalFromPartition=e.session.fromPartition.bind(e.session);
    e.session.fromPartition=(partition,...args)=>{const value=originalFromPartition(partition,...args);labels.set(value,String(partition||'default'));return value};
    const attach=(value)=>{
      if(observed.has(value))return;
      observed.add(value);state.sessions++;
      const request=value.webRequest;
      const register=request.onBeforeRequest.bind(request);
      const registerHeaders=typeof request.onHeadersReceived==='function'?request.onHeadersReceived.bind(request):null;
      request.onBeforeRequest=(filter,listener)=>register(filter,(details,done)=>{
            const staleResponse=responseCorrelations.get(details?.id);
        if(staleResponse){
          takeResponseCorrelation(details.id);
          invalidResponseIds.set(details.id,{session:value,actionID:staleResponse.actionID});
          sendRequestTokens.delete(staleResponse.actionID);
          responseRecords.push(responseRecord(staleResponse.actionID,'failed',null,'mismatch'));
          reportState.responseFailures++;
          const held=heldResponses.get(staleResponse.actionID);
          if(held)settleHeld(held,{cancel:true},'mismatch');
        }
        const label=labels.get(value)||'session';
        const external=/^https?:/i.test(details.url);
        const report=reportUrl(details.url);
        let reportPermit=false;
        let reportRecord=null;
        let admittedActionId=null;
        let responseMode='normal';
        if(report){
          const body=reportBytes(details);
          const gate=reportGate;
          const valid=!!gate&&Date.now()<gate.expiresAt&&Number.isSafeInteger(details.id)&&details.id>0&&label==='trace-egress'&&report.host===reportHost&&report.path===reportPath&&details.method==='POST'&&
            details.url==='https://'+reportHost+reportPath&&!(typeof details.redirectURL==='string'&&details.redirectURL.length)&&body&&body.bytes===gate.byteCount&&body.sha256===gate.sha256;
          if(gate)closeGate(gate.actionId,!valid,valid);
          reportPermit=valid;
          if(valid){responseMode=gate.responseMode;admittedActionId=gate.actionId}
          reportRecord=safeReportRecord(details,valid?gate:null,valid?'allow':'cancel',body);
          if(valid){reportState.allowedCount++;reportAttempts.push(reportRecord);globalThis.__traceQaNetwork.push(reportRecord)}
          else{reportState.deniedCount++;reportAttempts.push(reportRecord);globalThis.__traceQaNetwork.push(reportRecord)}
        }
        if(label==='default'&&!report)globalThis.__traceQaResources.push(details.url);
        if(external&&!report)globalThis.__traceQaNetwork.push({session:label,url:details.url,method:details.method,cancelledBeforeNetwork:true,source:'Electron webRequest pre-main observer'});
        let finished=false;
        const finish=(decision={})=>{
          if(finished)return;
          finished=true;
          const redirect=decision&&Object.prototype.hasOwnProperty.call(decision,'redirectURL');
          const cancel=external&&(report?(!reportPermit||decision.cancel===true||redirect):true);
          if(report&&reportPermit&&(decision.cancel===true||redirect)){
            reportState.allowedCount--;
            reportState.deniedCount++;
            reportRecord.decision='cancel';
            reportRecord.actionID=null;
            sendRequestTokens.delete(admittedActionId);
          }
          if(report&&reportPermit&&decision.cancel!==true&&!redirect){
            const generation=++responseGeneration;
            const correlation={session:value,id:details.id,generation,actionID:reportRecord.actionID,
              bytes:reportRecord.bytes,sha256:reportRecord.sha256,responseMode,expiresAt:Date.now()+30000,timer:null};
            correlation.timer=setTimeout(()=>{
              if(responseCorrelations.get(details.id)!==correlation)return;
              takeResponseCorrelation(details.id);invalidResponseIds.set(details.id,{session:value,actionID:correlation.actionID});
              sendRequestTokens.delete(correlation.actionID);
              if(correlation.responseMode==='hold-and-cancel'){
                responseRecords.push(responseRecord(correlation.actionID,'not-reached',null,'correlation-timeout'));reportState.responseFailures++;
              }
            },30000);
            correlation.timer.unref?.();
            responseCorrelations.set(details.id,correlation);
          }
          done(external?{...decision,cancel}:decision);
        };
        if(label==='trace-egress'&&external&&globalThis.__traceQaHoldEgress){globalThis.__traceQaEgressRelease=()=>finish({cancel:true});return;}
        listener(details,finish);
      });
      request.onBeforeRequest({urls:['<all_urls>']},(details,callback)=>{
        callback({});
      });
      if(registerHeaders){
        request.onHeadersReceived=(filter,listener)=>{
          if(typeof filter==='function'&&listener===undefined){listener=filter;filter={urls:['<all_urls>']}}
          if(!filter)filter={urls:['<all_urls>']}
          if(typeof listener!=='function')listener=(_details,callback)=>callback({});
          return registerHeaders(filter,(details,done)=>{
          let completed=false;
          let heldActionID=null;
          const finishHeaders=(decision={})=>{
            if(completed)return;
            completed=true;
            const report=reportUrl(details?.url);
            if(!report){done(decision);return}
            const keys=decision&&typeof decision==='object'?Reflect.ownKeys(decision):[];
            const forbiddenRewrite=keys.some(key=>key!=='cancel');
            const correlation=responseCorrelations.get(details.id);
            if(!correlation){
              const invalid=invalidResponseIds.get(details.id);
              if(invalid?.session===value){sendRequestTokens.delete(invalid.actionID);responseRecords.push(responseRecord(invalid.actionID,'failed',details.statusCode,'mismatch'));reportState.responseFailures++;done({cancel:true});return}
              if(forbiddenRewrite){reportState.responseFailures++;done({cancel:true});return}
              done(decision);return
            }
            const exact=!!correlation&&correlation.session===value&&correlation.id===details.id&&
              details.url==='https://'+reportHost+reportPath&&details.method==='POST'&&Date.now()<correlation.expiresAt;
            if(!exact){
              if(correlation)takeResponseCorrelation(details.id);
              if(correlation)invalidResponseIds.set(details.id,{session:value,actionID:correlation.actionID});
              if(correlation)sendRequestTokens.delete(correlation.actionID);
              responseRecords.push(responseRecord(null,'not-reached',null,'mismatch'));
              reportState.responseFailures++;
              done({cancel:true});return;
            }
            takeResponseCorrelation(details.id);
            invalidResponseIds.set(details.id,{session:value,actionID:correlation.actionID});
            if(correlation.responseMode==='normal'){
              if(forbiddenRewrite){sendRequestTokens.delete(correlation.actionID);reportState.responseFailures++;done({cancel:true});return}
              sendRequestTokens.delete(correlation.actionID);done(decision);return
            }
            if(![200,201].includes(details.statusCode)){
              sendRequestTokens.delete(correlation.actionID);
              responseRecords.push(responseRecord(correlation.actionID,'failed',details.statusCode,'unexpected-status'));
              reportState.responseFailures++;
              done({cancel:true});return;
            }
            if(keys.some(key=>key!=='cancel')){
              sendRequestTokens.delete(correlation.actionID);
              responseRecords.push(responseRecord(correlation.actionID,'failed',details.statusCode,'response-override'));
              reportState.responseFailures++;
              done({cancel:true});return;
            }
            if(decision?.cancel===true){
              sendRequestTokens.delete(correlation.actionID);
              responseRecords.push(responseRecord(correlation.actionID,'cancelled',details.statusCode,'downstream-cancelled'));
              reportState.responseFailures++;
              done({cancel:true});return;
            }
            const record=responseRecord(correlation.actionID,'headers-held',details.statusCode,'pending');
            responseRecords.push(record);
            const entry={actionID:correlation.actionID,generation:correlation.generation,callback:done,settled:false,timer:null};
            entry.timer=setTimeout(()=>settleHeld(entry,{cancel:true},'timeout'),Math.min(5000,Math.max(1,correlation.expiresAt-Date.now())));
            heldResponses.set(entry.actionID,entry);
            heldActionID=entry.actionID;
          };
          try{listener(details,finishHeaders)}catch(error){
            const report=reportUrl(details?.url);
            if(report&&!completed){const correlation=takeResponseCorrelation(details.id);
              if(correlation)sendRequestTokens.delete(correlation.actionID);
              responseRecords.push(responseRecord(correlation?.actionID||null,'failed',null,'listener-error'));reportState.responseFailures++;done({cancel:true});completed=true}
            else if(report&&completed&&heldActionID){const held=heldResponses.get(heldActionID);
              if(held)settleHeld(held,{cancel:true},'listener-error')}
            else if(!completed){completed=true;done({})}
          }
        });
        };
        request.onHeadersReceived({urls:['<all_urls>']},(_details,callback)=>callback({}));
      }
    };
    globalThis.__traceQaSetBugReportPrivacy=active=>{bugReportPrivacyPhase=active===true;return bugReportPrivacyPhase};
    e.app.on('session-created',(...args)=>{const session=args.find(value=>value&&value.webRequest&&typeof value.webRequest.onBeforeRequest==='function');state.events.push('session-created');if(session)attach(session);else recordQaError('session-created-without-session')});
    e.app.on('web-contents-created',(_event,contents)=>{
      state.events.push('web-contents-created');
      contents.on('console-message',(_event,level,message)=>{if(level===3)recordQaError('console',{message:String(message).slice(0,1000)})});
      contents.on('did-fail-load',(_event,code,description,url)=>{if(code!==-3)recordQaError('load',{code,description,url})});
      contents.on('render-process-gone',(_event,details)=>recordQaError('render-process-gone',{details}));
    });
    e.app.on('render-process-gone',(_event,contents,details)=>recordQaError('app-render-process-gone',{details}));
    e.app.on('child-process-gone',(_event,details)=>recordQaError('child-process-gone',{details}));
    process.on('uncaughtExceptionMonitor',(error,origin)=>recordQaError('uncaught-exception',{origin,message:String(error&&error.stack||error).slice(0,3000)}));
    e.shell.openExternal=async url=>{globalThis.__traceQaExternalUrls.push(String(url))};
    e.app.on('ready',()=>{state.ready=true;state.events.push('ready');labels.set(e.session.defaultSession,'default')});
    const observerSummary=()=>({...reportState,attempts:reportAttempts.map(entry=>({...entry})),responses:responseRecords.map(entry=>({...entry})),cancelOracles:[...cancelOracles.values()].map(entry=>({...entry}))});
    e.app.on('will-quit',()=>{if(reportGate)closeGate(reportGate.actionId,true);for(const [requestId,correlation] of [...responseCorrelations]){takeResponseCorrelation(requestId);if(correlation.responseMode==='hold-and-cancel'){responseRecords.push(responseRecord(correlation.actionID,'not-reached',null,'shutdown'));reportState.responseFailures++}}invalidResponseIds.clear();for(const entry of [...heldResponses.values()])settleHeld(entry,{cancel:true},'shutdown');sendRequestTokens.clear();const snapshot={pid:process.pid,networkCount:globalThis.__traceQaNetwork.length,allExternalRequestsCancelled:globalThis.__traceQaNetwork.every(entry=>entry.cancelledBeforeNetwork===true||entry.targetID==='bug-report-receiver'&&entry.decision==='cancel'),errors:globalThis.__traceQaErrors.length,externalIntents:globalThis.__traceQaExternalUrls.length,sessions:state.sessions,ready:state.ready,reportObserver:observerSummary()};process.stderr.write('TRACE_QA_PREMAIN_FINAL '+JSON.stringify(snapshot)+'\\n')});
    globalThis.__traceQaPreMainSnapshot=()=>({installedBeforeReady:state.installedBeforeReady,ready:state.ready,events:[...state.events],network:[...globalThis.__traceQaNetwork],errors:[...globalThis.__traceQaErrors],external:[...globalThis.__traceQaExternalUrls],resources:[...globalThis.__traceQaResources],sessions:state.sessions,packaged:e.app.isPackaged,windows:e.BrowserWindow.getAllWindows().length,reportObserver:observerSummary()});
    return {installedBeforeReady:state.installedBeforeReady,ready:e.app.isReady(),windows:e.BrowserWindow.getAllWindows().length,sessions:state.sessions};
  })()`;
}

function reserveInspectorPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function waitForPortRelease(port, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const free = await new Promise((resolve, reject) => {
      const server = net.createServer();
      server.once('error', (error) => error.code === 'EADDRINUSE' ? resolve(false) : reject(error));
      server.listen(port, '127.0.0.1', () => server.close((error) => error ? reject(error) : resolve(true)));
    });
    if (free) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Loopback inspector port was not released after the packaged process exited');
}

function inspectorEndpoint(port, timeoutMs = INSPECTOR_TIMEOUT_MS, options = {}) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    let timer, request, settled = false;
    const diagnostics = options.diagnostics || {};
    const cancelTimer = options.clearTimer || clearTimeout;
    const finish = (error, endpoint) => {
      if (settled) return;
      settled = true;
      cancelTimer(timer);
      options.signal?.removeEventListener('abort', abort);
      const activeRequest = request;
      request = null;
      if (error) activeRequest?.destroy();
      if (error) reject(error); else resolve(endpoint);
    };
    const abort = () => finish(new Error('Inspector discovery stopped after packaged launch ended'));
    if (options.signal?.aborted) return abort();
    options.signal?.addEventListener('abort', abort, { once: true });
    const schedulePoll = () => {
      if (settled || options.signal?.aborted || timer) return;
      timer = (options.setTimer || setTimeout)(() => {
        timer = null;
        if (!settled && !options.signal?.aborted) poll();
      }, 50);
    };
    const poll = () => {
      if (settled || options.signal?.aborted) return;
      if (Date.now() >= deadline) {
        const detail = diagnostics.last ? `; last probe: ${JSON.stringify(diagnostics.last)}` : '';
        return finish(new Error(`Timed out waiting for the loopback inspector endpoint${detail}`));
      }
      const activeRequest = (options.get || http.get)({ hostname: '127.0.0.1', port, path: '/json/list', timeout: 500 }, (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => { if (!settled && !options.signal?.aborted) body += chunk; });
        const recordResponseFailure = (error) => {
          if (settled || options.signal?.aborted) return;
          diagnostics.last = { code: error.code || null, message: error.message };
          schedulePoll();
        };
        response.on('error', recordResponseFailure);
        response.on('aborted', () => recordResponseFailure(new Error('Inspector endpoint response was aborted')));
        response.on('end', () => {
          if (settled || options.signal?.aborted) return;
          try {
            const endpoint = JSON.parse(body).map((entry) => entry.webSocketDebuggerUrl).find(Boolean);
            if (endpoint) return finish(null, endpoint);
            diagnostics.last = { statusCode: response.statusCode, body: body.slice(0, 300) };
          } catch { diagnostics.last = { statusCode: response.statusCode, body: body.slice(0, 300) }; }
          schedulePoll();
        });
      });
      request = activeRequest;
      activeRequest.on('error', (error) => {
        if (settled || options.signal?.aborted) return;
        diagnostics.last = { code: error.code || null, message: error.message };
        schedulePoll();
      });
      activeRequest.on('timeout', () => { if (!settled) activeRequest.destroy(); });
    };
    poll();
  });
}

async function attachInspector(wsUrl, timeoutMs = INSPECTOR_TIMEOUT_MS) {
  const socket = new WebSocket(wsUrl);
  const pending = new Map();
  const scriptUrls = new Map();
  const pauses = [];
  const events = [];
  let sequence = 0;
  let rejectAll;
  const failed = new Promise((_, reject) => { rejectAll = reject; });
  failed.catch(() => {});
  const opened = new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('Could not connect to loopback inspector')), { once: true });
  });
  socket.addEventListener('message', (event) => {
    let message;
    try { message = JSON.parse(String(event.data)); } catch { return; }
    if (message.id) {
      const entry = pending.get(message.id);
      pending.delete(message.id);
      if (!entry) return;
      if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
      else entry.resolve(message.result || {});
      return;
    }
    events.push(message);
    if (message.method === 'Debugger.scriptParsed') scriptUrls.set(message.params.scriptId, message.params.url);
    if (message.method === 'Debugger.paused') pauses.push(message.params);
  });
  socket.addEventListener('close', () => {
    const error = new Error('Loopback inspector closed before the probe completed');
    for (const entry of pending.values()) entry.reject(error);
    rejectAll(error);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  try {
    await withTimeout(Promise.race([opened, failed]), timeoutMs, 'Timed out connecting to loopback inspector');
    const pauseWait = async () => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const pause = pauses.shift();
        if (pause) return pause;
        await Promise.race([new Promise((resolve) => setTimeout(resolve, 25)), failed]);
      }
      throw new Error('Timed out waiting for packaged main-entry breakpoint');
    };
    return { socket, events, scriptUrls, send, pauseWait, close: () => { if (socket.readyState < WebSocket.CLOSING) socket.close(); } };
  } catch (error) {
    socket.close();
    throw error;
  }
}

async function launchWithPreMainObservers(launchOptions, options = {}) {
  const launch = options.launch || ((value) => _electron.launch(value));
  const timeout = startupTimeout(launchOptions, options);
  const port = await reserveInspectorPort();
  const state = { app: null, child: null, stderr: '', exit: null, launchError: null, cleanupPromise: null, cleanupErrors: [] };
  const launchPromise = launch({ ...launchOptions,
    args: [`--inspect-brk=127.0.0.1:${port}`, ...(launchOptions.args || [])],
    chromiumSandbox: true,
  });
  const appPromise = Promise.resolve(launchPromise).then((value) => {
    state.app = value;
    try {
      state.child = value.process();
      state.child.stderr?.on('data', (chunk) => { state.stderr = (state.stderr + chunk.toString()).slice(-8000); });
      state.child.once('exit', (code, signal) => { state.exit = { code, signal: signal || null }; });
      state.child.once('error', (error) => { state.launchError = error; });
    } catch (error) { state.launchError = error; }
    return value;
  }, (error) => { state.launchError = error; throw error; });
  appPromise.catch(() => {});
  let inspector = null, completed = false, breakpointId = null;
  const cleanupOwnedApp = (app) => {
    if (state.cleanupPromise) return state.cleanupPromise;
    state.cleanupPromise = (async () => {
      const child = state.child;
      const timeoutMs = options.cleanupTimeoutMs ?? 3000;
      const failures = [];
      try {
        await withTimeout(Promise.resolve().then(() => app.close()), timeoutMs,
          `Playwright app.close() did not settle within ${timeoutMs} ms during failure cleanup`);
      } catch (error) {
        failures.push(error.message || String(error));
      }
      if (!child) {
        failures.push('owned child process was unavailable, so exit could not be confirmed');
      } else if (child.exitCode == null && child.signalCode == null) {
        try {
          await withTimeout(new Promise((resolve, reject) => {
            if (child.exitCode != null || child.signalCode != null) return resolve();
            const onExit = () => { cleanup(); resolve(); };
            const onError = (error) => { cleanup(); reject(error); };
            const cleanup = () => {
              child.removeListener('exit', onExit);
              child.removeListener('error', onError);
            };
            child.once('exit', onExit);
            child.once('error', onError);
          }), timeoutMs, `Owned packaged child exit was not confirmed within ${timeoutMs} ms`);
        } catch (error) {
          failures.push(error.message || String(error));
        }
      }
      if (child && child.exitCode == null && child.signalCode == null) {
        failures.push('owned packaged child remains live; cleanup did not confirm its exit');
      }
      if (failures.length) throw new Error(failures.join('; '));
    })();
    return state.cleanupPromise;
  };
  const discoveryAbort = new AbortController();
  let discoveryDiagnostics = {};
  try {
    const endpointResult = inspectorEndpoint(port, timeout, { signal: discoveryAbort.signal, diagnostics: discoveryDiagnostics });
    const launchEnded = appPromise.then((value) => new Promise((resolve) => {
      if (state.launchError) return resolve({ kind: 'process-error', error: state.launchError });
      if (state.exit) return resolve({ kind: 'exit', exit: state.exit });
      if (!state.child) return resolve({ kind: 'process-error', error: new Error('Playwright returned an app without a child process') });
      state.child.once('error', (error) => resolve({ kind: 'process-error', error }));
      state.child?.once('exit', (code, signal) => resolve({ kind: 'exit', exit: { code, signal: signal || null } }));
    }), (error) => ({ kind: 'rejection', error }));
    const first = await Promise.race([endpointResult.then((value) => ({ kind: 'endpoint', value })), launchEnded]);
    if (first.kind === 'rejection') {
      const detail = state.stderr ? `; stderr: ${state.stderr.trim().slice(-3000)}` : '';
      throw new Error(`Packaged application launch rejected before the inspector endpoint: ${first.error?.message || String(first.error)}${detail}`, { cause: first.error });
    }
    if (first.kind === 'exit') {
      const detail = state.stderr ? `; stderr: ${state.stderr.trim().slice(-3000)}` : '';
      throw new Error(`Packaged application exited before the inspector endpoint (code ${first.exit.code ?? 'unknown'}, signal ${first.exit.signal || 'none'})${detail}`);
    }
    if (first.kind === 'process-error') {
      const detail = state.stderr ? `; stderr: ${state.stderr.trim().slice(-3000)}` : '';
      throw new Error(`Packaged application process failed before the inspector endpoint: ${first.error?.message || String(first.error)}${detail}`, { cause: first.error });
    }
    const endpoint = first.value;
    assert.ok(endpoint.startsWith('ws://127.0.0.1:'), 'inspector endpoint is loopback-only');
    inspector = await attachInspector(endpoint, timeout);
    await inspector.send('Runtime.enable');
    await inspector.send('Debugger.enable');
    const breakpoint = await inspector.send('Debugger.setBreakpointByUrl', { lineNumber: MAIN_LINE - 1, urlRegex: 'app[.]asar[/\\\\]electron[/\\\\]main[.]cjs$' });
    breakpointId = breakpoint.breakpointId;
    await inspector.send('Runtime.runIfWaitingForDebugger');
    let pause, frame;
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      pause = await inspector.pauseWait();
      frame = pause.callFrames.find((candidate) => isMainEntryFrame(candidate, inspector.scriptUrls));
      if (frame) break;
      await inspector.send('Debugger.resume');
    }
    assert.ok(frame, 'breakpoint paused in the actual packaged electron/main.cjs entry');
    const url = mainFrameUrl(frame, inspector.scriptUrls);
    assert.equal(frame.location.lineNumber + 1, MAIN_LINE, 'breakpoint is on the approved first-require line');
    const before = await inspector.send('Debugger.evaluateOnCallFrame', { callFrameId: frame.callFrameId,
      expression: '({filename:__filename,ready:require("electron").app.isReady(),windows:require("electron").BrowserWindow.getAllWindows().length})', returnByValue: true });
    assert.ok(!before.exceptionDetails, 'packaged main identity can be read before resuming');
    assert.match(before.result.value.filename.replace(/\\/g, '/'), /app\.asar\/electron\/main\.cjs$/);
    assert.equal(before.result.value.ready, false, 'Electron has not reached app ready');
    assert.equal(before.result.value.windows, 0, 'the app has not created a window');
    const installed = await inspector.send('Debugger.evaluateOnCallFrame', { callFrameId: frame.callFrameId,
      expression: observerExpression(), returnByValue: true });
    assert.ok(!installed.exceptionDetails, `pre-main observers installed without an exception: ${JSON.stringify(installed.exceptionDetails || null)}`);
    assert.equal(installed.result.value.installedBeforeReady, true);
    assert.equal(installed.result.value.ready, false);
    assert.equal(installed.result.value.windows, 0);
    await inspector.send('Debugger.removeBreakpoint', { breakpointId });
    await inspector.send('Debugger.resume');
    const app = await withTimeout(appPromise, timeout, 'Playwright launch did not complete after resuming packaged main');
    completed = true;
    return { app, inspector, launchPromise, port, proof: { marker: MAIN_ENTRY, line: MAIN_LINE, url: MAIN_ENTRY,
      readyBeforeInstall: false, windowsBeforeInstall: 0, installedBeforeReady: true, launchPendingBeforeInstall: true,
      chromiumSandbox: true, breakpointId: breakpoint.breakpointId } };
  } catch (error) {
    discoveryAbort.abort();
    if (inspector) {
      if (breakpointId) await inspector.send('Debugger.removeBreakpoint', { breakpointId }).catch(() => {});
      await inspector.send('Debugger.resume').catch(() => {});
      inspector.close();
    }
    const closeLateApp = appPromise.then((app) => cleanupOwnedApp(app));
    let cleanupTimedOut = false;
    const cleanupOutcome = closeLateApp.then(() => ({ ok: true }), (cleanupError) => ({ error: cleanupError }));
    cleanupOutcome.then((outcome) => {
      if (cleanupTimedOut && outcome.error) {
        state.cleanupErrors.push(outcome.error.message || String(outcome.error));
        error.message += `; late cleanup failed: ${state.cleanupErrors.at(-1)}`;
      }
    });
    const cleanupTimeoutMs = options.cleanupTimeoutMs ?? 3000;
    const cleanupResult = await withTimeout(cleanupOutcome, cleanupTimeoutMs * 3 + 100,
      `Launch did not settle or owned cleanup did not finish within ${cleanupTimeoutMs * 3 + 100} ms`).catch((cleanupError) => {
        cleanupTimedOut = true;
        return { pendingError: cleanupError };
      });
    if (cleanupResult.error) {
      state.cleanupErrors.push(cleanupResult.error.message || String(cleanupResult.error));
      error.message += `; cleanup failed: ${state.cleanupErrors.at(-1)}`;
    } else if (cleanupResult.pendingError) {
      state.cleanupErrors.push(cleanupResult.pendingError.message || String(cleanupResult.pendingError));
      error.message += `; cleanup pending or failed: ${state.cleanupErrors.at(-1)}`;
    }
    const exit = state.exit ? `; process exit code ${state.exit.code ?? 'unknown'}${state.exit.signal ? ` signal ${state.exit.signal}` : ''}` : '';
    const stderr = state.stderr.trim() ? `; stderr: ${state.stderr.trim().slice(-3000)}` : '';
    if (error.message.includes('Timed out waiting for the loopback inspector endpoint')) {
      const detail = discoveryDiagnostics.last ? `; final probe: ${JSON.stringify(discoveryDiagnostics.last)}` : '';
      error.message += `${exit}${detail}${stderr}`;
    }
    error.cleanupErrors = state.cleanupErrors;
    throw error;
  } finally {
    discoveryAbort.abort();
    if (completed) inspector.close();
  }
}

function startupTimeout(launchOptions = {}, options = {}) {
  const timeout = options.timeout ?? launchOptions.timeout ?? INSPECTOR_TIMEOUT_MS;
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 10 * 60 * 1000) {
    throw new RangeError('Packaged startup timeout must be a positive finite value no greater than 10 minutes');
  }
  return timeout;
}

module.exports = Object.freeze({ MAIN_ENTRY, MAIN_LINE, mainFrameUrl, isMainEntryFrame, observerExpression, reserveInspectorPort,
  inspectorEndpoint, attachInspector, launchWithPreMainObservers, startupTimeout, waitForPortRelease, withTimeout });
