'use strict';
// Run once in a private directory. Only the public verification key belongs in the application.
const fs = require('node:fs');
const path = require('node:path');
const { generateKeyPairSync } = require('node:crypto');
const directory = process.argv[2];
if (!directory || !path.isAbsolute(directory)) throw new Error('Choose an absolute private output directory.');
fs.mkdirSync(directory, { recursive: true });
const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
fs.writeFileSync(path.join(directory, 'receipt-private-jwk.json'), JSON.stringify(privateKey.export({ format: 'jwk' })), { flag: 'wx', mode: 0o600 });
fs.writeFileSync(path.join(directory, 'receipt-public-jwk.json'), JSON.stringify(publicKey.export({ format: 'jwk' })), { flag: 'wx' });
console.log('Receipt key files created. Keep the private file out of repositories and logs.');
