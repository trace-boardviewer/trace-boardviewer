'use strict';

// Synthetic SQLite feature/throughput probe, shared by main, utility and worker processes.
const { performance } = require('node:perf_hooks');

function probe(directory, context, count = 20000) {
  const result = { context, versions: { electron: process.versions.electron, node: process.versions.node }, rows: count };
  let db;
  try {
    const { DatabaseSync } = require('node:sqlite');
    const path = require('node:path');
    const fs = require('node:fs');
    const filename = path.join(directory, `${context}.sqlite`);
    db = new DatabaseSync(filename);
    result.sqlite = db.prepare('SELECT sqlite_version() AS v').get().v;
    result.fts5Compiled = db.prepare("SELECT sqlite_compileoption_used('ENABLE_FTS5') AS enabled").get().enabled;
    result.journal = db.prepare('PRAGMA journal_mode=WAL').get().journal_mode;
    db.exec('PRAGMA synchronous=NORMAL');
    db.exec("CREATE VIRTUAL TABLE words USING fts5(body); CREATE VIRTUAL TABLE tri USING fts5(body, tokenize='trigram');" +
      "CREATE VIRTUAL TABLE lean USING fts5(body, content='', tokenize='trigram');" +
      "CREATE VIRTUAL TABLE mutable USING fts5(body, content='', contentless_delete=1, tokenize='trigram')");
    const body = 'Regulator capacitor connector circuit voltage resistance board revision service reference. '.repeat(3);
    const tables = {};
    for (const table of ['words', 'tri', 'lean', 'mutable']) {
      const insert = db.prepare(`INSERT INTO ${table}(rowid, body) VALUES (?, ?)`);
      const start = performance.now();
      db.exec('BEGIN');
      for (let i = 1; i <= count; i++) insert.run(i, `${body} component${i} net${i % 97} unique${i}`);
      db.exec('COMMIT');
      const insertMs = performance.now() - start;
      const query = db.prepare(`SELECT rowid FROM ${table} WHERE ${table} MATCH ? LIMIT 10`);
      const samples = [];
      for (let i = 0; i < 500; i++) {
        const at = performance.now();
        const rows = query.all(`unique${1 + (i * 37) % count}`);
        if (rows.length === 0) throw new Error(`${table}: missing inserted row`);
        samples.push(performance.now() - at);
      }
      samples.sort((a, b) => a - b);
      tables[table] = { insertMs, insertsPerSecond: count / (insertMs / 1000), queryMedianMs: samples[250], queryP95Ms: samples[475] };
    }
    result.tables = tables;
    result.trigramSubstring = db.prepare("SELECT rowid FROM tri WHERE tri MATCH 'nector' LIMIT 1").get().rowid === 1;
    result.trigramLike = db.prepare("SELECT count(*) AS n FROM tri WHERE body LIKE '%nector%'").get().n;
    result.contentlessReturnsNull = db.prepare('SELECT body FROM lean WHERE rowid=1').get().body === null;
    result.contentlessMatch = db.prepare("SELECT count(*) AS n FROM lean WHERE lean MATCH 'nector'").get().n;
    result.contentlessLike = db.prepare("SELECT count(*) AS n FROM lean WHERE body LIKE '%nector%'").get().n;
    db.prepare("INSERT INTO lean(lean, rowid, body) VALUES ('delete', ?, ?)").run(1, `${body} component1 net1 unique1`);
    result.contentlessDeleteCommand = !db.prepare('SELECT rowid FROM lean WHERE rowid=1').get();
    db.prepare('UPDATE mutable SET body=? WHERE rowid=?').run('replacement marker', 1);
    result.contentlessUpdate = db.prepare("SELECT rowid FROM mutable WHERE mutable MATCH 'replacement'").get().rowid === 1;
    db.prepare('DELETE FROM mutable WHERE rowid=?').run(1);
    result.contentlessDelete = !db.prepare('SELECT rowid FROM mutable WHERE rowid=1').get();
    result.shortTrigramMatches = db.prepare("SELECT count(*) AS n FROM tri WHERE tri MATCH 'ne'").get().n;
    db.exec("INSERT INTO tri(rowid,body) VALUES (1000000,'Áram mérés capacitor');");
    result.unicodeTrigram = db.prepare("SELECT rowid FROM tri WHERE tri MATCH 'mérés'").get().rowid === 1000000;
    result.integrity = db.prepare('PRAGMA integrity_check').get().integrity_check;
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.close();
    db = null;
    result.databaseBytes = fs.statSync(filename).size;
    result.ok = true;
  } catch (error) {
    result.ok = false;
    result.error = { code: error.code, message: error.message };
  } finally {
    if (db) db.close();
  }
  return result;
}

module.exports = { probe };
