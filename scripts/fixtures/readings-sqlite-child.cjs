'use strict';

const { isMainThread, parentPort, workerData } = require('node:worker_threads');
const { probe } = require('./readings-sqlite-probe.cjs');
if (!isMainThread) parentPort.postMessage(probe(workerData.directory, 'worker', workerData.count));
else process.parentPort.on('message', ({ data }) => {
  process.parentPort.postMessage(probe(data.directory, 'utility', data.count));
});
