'use strict';

const { app, utilityProcess } = require('electron');
const { Worker } = require('node:worker_threads');
const fs = require('node:fs');
const path = require('node:path');
const { probe } = require('./readings-sqlite-probe.cjs');
const directory = process.argv[1];
app.setPath('userData', path.join(directory, 'profile'));

app.whenReady().then(async () => {
  const count = 20000;
  const results = [probe(directory, 'main', count)];
  const childFile = path.join(__dirname, 'readings-sqlite-child.cjs');
  results.push(await new Promise(resolve => {
    const worker = new Worker(childFile, { workerData: { directory, count } });
    worker.once('message', resolve);
    worker.once('error', error => resolve({ context: 'worker', ok: false, error: { message: error.message } }));
  }));
  results.push(await new Promise(resolve => {
    const child = utilityProcess.fork(childFile, [], { stdio: 'pipe', serviceName: 'SQLite feature probe' });
    child.once('message', data => { resolve(data); child.kill(); });
    child.once('exit', code => resolve({ context: 'utility', ok: false, error: { message: `Exit ${code}` } }));
    child.postMessage({ directory, count });
  }));
  fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(results, null, 2));
  app.exit(results.every(item => item.ok) ? 0 : 1);
}).catch(error => {
  fs.writeFileSync(path.join(directory, 'error.txt'), error.stack);
  app.exit(2);
});
