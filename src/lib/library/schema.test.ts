import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
describe('documented library schema', () => {
  it('executes schema v1 and rejects duplicate loose locations and archive entries', () => {
    const doc = readFileSync(new URL('../../../docs/LIBRARY_SCHEMA.md', import.meta.url), 'utf8');
    const sql = /```sql\n([\s\S]*?)\n```/.exec(doc)![1];
    const db = new DatabaseSync(':memory:');
    try {
      db.exec('PRAGMA foreign_keys=ON;'); db.exec(sql);
      db.exec("INSERT INTO root VALUES(1,'root1','/library','Bench','online',0,'{}'); INSERT INTO dir VALUES(1,1,NULL,'');");
      const addFile = db.prepare('INSERT INTO file(id,public_id,dir_id,name,container_id,entry_path,size,state,seen_scan) VALUES(?,?,1,?,?,?,?,?,1)');
      addFile.run(1, 'f1', 'a.zip', null, null, 100, 'indexed');
      expect(() => addFile.run(2, 'f2', 'a.zip', null, null, 100, 'indexed')).toThrow();
      addFile.run(3, 'f3', 'a.brd', 1, 'folder/a.brd', 10, 'indexed');
      expect(() => addFile.run(4, 'f4', 'a.brd', 1, 'folder/a.brd', 10, 'indexed')).toThrow();
      db.exec("INSERT INTO name_fts(rowid,name,path) VALUES(1,'a.zip','a.zip'); INSERT INTO text_fts(rowid,body) VALUES(4097,'synthetic part');");
      expect(db.prepare("SELECT count(*) AS n FROM text_fts WHERE text_fts MATCH 'synthetic'").get()!.n).toBe(1);
      db.exec('DELETE FROM name_fts WHERE rowid=1; DELETE FROM text_fts WHERE rowid=4097; DELETE FROM root WHERE id=1;');
      expect(db.prepare('SELECT count(*) AS n FROM file').get()!.n).toBe(0);
    } finally { db.close(); }
  });
});
