'use strict';
const { spawn } = require('node:child_process');
const path = require('node:path');
const project = path.resolve(__dirname, '..');
const vite = spawn(process.execPath, [path.join(project, 'node_modules/vite/bin/vite.js')], { cwd: project, stdio: 'inherit', windowsHide: true });
let desktop = null;
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  desktop?.kill(); vite.kill();
  process.exitCode = code;
}
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
vite.on('exit', code => stop(code || 0));
(async () => {
  for (let attempt = 0; attempt < 80; attempt++) {
    if (stopping) return;
    try {
      const response = await fetch('http://127.0.0.1:5173');
      if (!response.ok) throw new Error('Not ready');
      desktop = spawn(require('electron'), [project, ...process.argv.slice(2)], { cwd: project, stdio: 'inherit', env: { ...process.env, VITE_DEV_SERVER_URL: 'http://127.0.0.1:5173' }, windowsHide: false });
      desktop.on('exit', code => stop(code || 0));
      return;
    } catch { await new Promise(resolve => setTimeout(resolve, 250)); }
  }
  console.error('A fejlesztői kiszolgáló nem indult el.'); stop(1);
})();
