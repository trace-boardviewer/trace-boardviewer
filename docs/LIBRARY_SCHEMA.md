# Library schema v1

The service alone owns `<userData>/library/library.db`, including WAL/SHM. Main owns atomic `library-settings.json` and `library-decisions.json`, separate from application config. Roots are dialog-picked realpaths in the settings file; the database is derived and rebuildable. No user file is copied or changed. These SQL definitions specify the SQLite backend; the storage-engine interface may use the approved fallback with identical logical relations.

## Tables and indexes

Enable `foreign_keys=ON`, `journal_mode=WAL`, `synchronous=NORMAL`; use a 64 MiB page cache, transactions of at most 500 files, and stage outputs/state in one transaction. Text enums follow `model.ts`; IPC uses opaque string IDs, with the store mapping internal integer row IDs to stable public IDs (never paths).

```sql
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE root(id INTEGER PRIMARY KEY, public_id TEXT NOT NULL UNIQUE,
  path TEXT NOT NULL UNIQUE, label TEXT NOT NULL, state TEXT NOT NULL,
  network INTEGER NOT NULL CHECK(network IN (0,1)), options TEXT NOT NULL) STRICT;
CREATE TABLE dir(id INTEGER PRIMARY KEY, root_id INTEGER NOT NULL REFERENCES root ON DELETE CASCADE,
  parent_id INTEGER REFERENCES dir ON DELETE CASCADE, name TEXT NOT NULL) STRICT;
CREATE UNIQUE INDEX dir_child ON dir(root_id,parent_id,name) WHERE parent_id IS NOT NULL;
CREATE UNIQUE INDEX dir_top ON dir(root_id) WHERE parent_id IS NULL;
CREATE TABLE content(id INTEGER PRIMARY KEY, public_id TEXT NOT NULL UNIQUE,
  quick BLOB NOT NULL, sha256 BLOB UNIQUE, size INTEGER NOT NULL,
  kind TEXT, format TEXT, variant TEXT, confidence INTEGER, needs_key TEXT,
  problem TEXT, attempts INTEGER NOT NULL DEFAULT 0) STRICT;
CREATE INDEX content_quick ON content(quick,size);
CREATE TABLE file(id INTEGER PRIMARY KEY, public_id TEXT NOT NULL UNIQUE,
  dir_id INTEGER NOT NULL REFERENCES dir ON DELETE CASCADE, name TEXT NOT NULL,
  container_id INTEGER REFERENCES file ON DELETE CASCADE, entry_path TEXT,
  size INTEGER NOT NULL, mtime_ms INTEGER, file_key TEXT,
  content_id INTEGER REFERENCES content ON DELETE SET NULL,
  state TEXT NOT NULL, seen_scan INTEGER NOT NULL, missing_since INTEGER,
  CHECK((container_id IS NULL) = (entry_path IS NULL))) STRICT;
CREATE UNIQUE INDEX file_loose ON file(dir_id,name) WHERE container_id IS NULL;
CREATE UNIQUE INDEX file_entry ON file(container_id,entry_path) WHERE container_id IS NOT NULL;
CREATE INDEX file_content ON file(content_id);
CREATE INDEX file_scan ON file(dir_id,seen_scan);
CREATE INDEX file_container ON file(container_id);
CREATE TABLE stage(content_id INTEGER NOT NULL REFERENCES content ON DELETE CASCADE,
  stage TEXT NOT NULL, version INTEGER NOT NULL, state TEXT NOT NULL, error TEXT,
  at INTEGER NOT NULL, PRIMARY KEY(content_id,stage)) STRICT, WITHOUT ROWID;
CREATE TABLE board(content_id INTEGER PRIMARY KEY REFERENCES content ON DELETE CASCADE,
  adapter TEXT, variant TEXT, parts INTEGER, pins INTEGER, nets INTEGER, sides TEXT,
  fingerprint BLOB, fp_version INTEGER, minhash BLOB, refs BLOB,
  title TEXT, revision TEXT, drawing TEXT, company TEXT, date TEXT,
  width_mm REAL, height_mm REAL, components BLOB, passives BLOB, truncated TEXT) STRICT;
CREATE INDEX board_fingerprint ON board(fp_version,fingerprint);
CREATE TABLE document(content_id INTEGER PRIMARY KEY REFERENCES content ON DELETE CASCADE,
  format TEXT, doc_type TEXT, pages INTEGER, text_layer TEXT, ocr TEXT,
  title TEXT, producer TEXT, refs BLOB, refs_minhash BLOB, page_hashes BLOB,
  truncated TEXT) STRICT;
CREATE TABLE image(content_id INTEGER PRIMARY KEY REFERENCES content ON DELETE CASCADE,
  width INTEGER NOT NULL, height INTEGER NOT NULL) STRICT;
CREATE TABLE term(id INTEGER PRIMARY KEY, kind TEXT NOT NULL, norm TEXT NOT NULL,
  base TEXT, family TEXT, category TEXT, UNIQUE(kind,norm)) STRICT;
CREATE INDEX term_base ON term(base);
CREATE INDEX term_family ON term(family);
CREATE TABLE posting(term_id INTEGER NOT NULL REFERENCES term ON DELETE CASCADE,
  content_id INTEGER NOT NULL REFERENCES content ON DELETE CASCADE,
  source TEXT NOT NULL, tier INTEGER NOT NULL, refs TEXT, additional_refs INTEGER NOT NULL DEFAULT 0,
  pages BLOB, PRIMARY KEY(term_id,content_id,source)) STRICT, WITHOUT ROWID;
CREATE INDEX posting_content ON posting(content_id);
CREATE TABLE identifier(id INTEGER PRIMARY KEY,
  content_id INTEGER REFERENCES content ON DELETE CASCADE,
  file_id INTEGER REFERENCES file ON DELETE CASCADE, kind TEXT NOT NULL,
  norm TEXT NOT NULL, raw TEXT, source TEXT NOT NULL, confidence INTEGER NOT NULL,
  page INTEGER, pattern TEXT, CHECK((content_id IS NULL) != (file_id IS NULL))) STRICT;
CREATE INDEX identifier_norm ON identifier(kind,norm);
CREATE INDEX identifier_content ON identifier(content_id);
CREATE INDEX identifier_file ON identifier(file_id);
CREATE TABLE grp(id TEXT PRIMARY KEY, label TEXT, vendor TEXT, model TEXT,
  board_number TEXT, device_type TEXT, updated INTEGER, tags TEXT) STRICT;
CREATE TABLE member(group_id TEXT NOT NULL REFERENCES grp ON DELETE CASCADE,
  content_id INTEGER NOT NULL REFERENCES content ON DELETE CASCADE,
  role TEXT NOT NULL, revision TEXT, tier TEXT NOT NULL, evidence TEXT NOT NULL,
  PRIMARY KEY(group_id,content_id)) STRICT, WITHOUT ROWID;
CREATE INDEX member_content ON member(content_id);
CREATE TABLE suggestion(a INTEGER NOT NULL REFERENCES content ON DELETE CASCADE,
  b INTEGER NOT NULL REFERENCES content ON DELETE CASCADE, kind TEXT NOT NULL,
  score REAL NOT NULL, evidence TEXT NOT NULL, CHECK(a < b),
  PRIMARY KEY(a,b,kind)) STRICT, WITHOUT ROWID;
CREATE INDEX suggestion_b ON suggestion(b);
CREATE TABLE revision(group_id TEXT NOT NULL REFERENCES grp ON DELETE CASCADE,
  content_id INTEGER NOT NULL REFERENCES content ON DELETE CASCADE,
  label TEXT NOT NULL, scheme TEXT NOT NULL, ordinal INTEGER, basis TEXT NOT NULL,
  added_parts INTEGER, removed_parts INTEGER, changed_values INTEGER,
  PRIMARY KEY(group_id,content_id)) STRICT, WITHOUT ROWID;
CREATE TABLE duplicate_set(id TEXT PRIMARY KEY, kind TEXT NOT NULL, evidence TEXT NOT NULL) STRICT;
CREATE TABLE duplicate_file(set_id TEXT NOT NULL REFERENCES duplicate_set ON DELETE CASCADE,
  file_id INTEGER NOT NULL REFERENCES file ON DELETE CASCADE,
  PRIMARY KEY(set_id,file_id)) STRICT, WITHOUT ROWID;
CREATE TABLE duplicate_content(set_id TEXT NOT NULL REFERENCES duplicate_set ON DELETE CASCADE,
  content_id INTEGER NOT NULL REFERENCES content ON DELETE CASCADE,
  PRIMARY KEY(set_id,content_id)) STRICT, WITHOUT ROWID;
CREATE VIRTUAL TABLE name_fts USING fts5(name,path,content='',contentless_delete=1,tokenize='trigram');
CREATE VIRTUAL TABLE text_fts USING fts5(body,content='',contentless_delete=1);
```

This expands the condensed schema with stable public IDs, component/passive/image summaries, explicit revisions/duplicate membership and foreign-key cleanup. Partial unique indexes fix SQLite's NULL-distinct behavior for loose files and root directories. The store enforces parent-directory/root consistency and acyclic container links, since foreign keys alone cannot do so. A file belongs to one root; content is deduplicated globally only after full-hash confirmation, never by quick key alone.

`meta` holds `schema_version=1`, each extractor/knowledge/sniff/group stage version, clean shutdown and scan generation/checkpoints. `stage` records pending/running/done/failed/skipped; extractor changes rerun only their stage and downstream dependants. `file.seen_scan` makes rescans incremental; missing rows stay 30 days; an offline root never marks all its rows missing. SHA-256 is 32 bytes, quick key is 16 bytes; workspace keys use original bytes or the existing complete-file-set identity. ZIP entries retain container identity and normalized entry path separately from loose-file paths.

Refs are sorted distinct front-coded strings deflated by the trusted service, not a decompression blob accepted from the indexer. MinHash is 128 little-endian u32 values (512 bytes). Summary components/passives use compact versioned blobs within type caps. Page hashes are packed 32-byte SHA-256 values. Posting pages are sorted varints; refs keep at most eight labels plus `additional_refs`. Never store passive-per-ref postings, library-wide refdes postings, every signal net, thumbnails or full document bytes.

Group member evidence stores typed evidence codes, confidence/coverage facts and identifier/page sources; no opaque prose from a parser. Revisions order only within one scheme. Exact copies share content; other-format/resaved/name-clash sets are distinct relations. User corrections remain in main's JSON file and are replayed after rebuild; any materialized decision table is disposable, never the only copy of user data.

## FTS ownership and full text

`name_fts.rowid = file.id`; insert/update/delete alongside file transactions. Name/path values contain normalized relative labels only. Short (one/two character) substrings use a bounded literal fallback because trigram MATCH cannot answer them. Always bind parameters and escape FTS syntax; never pass user text straight to MATCH.

`text_fts.rowid = content_id * 4096 + page`, page 1–2000; use SQLite INTEGER/BigInt arithmetic and enforce representable content IDs. Full text is opt-in per root. Include it only when at least one associated root enables it; filter query hits to the allowed roots, and purge rows when the last associated enabled root is disabled/removed. FTS contentless tables have no foreign-key cascade: explicit deletes for file/content/root removal belong in the same transaction. Garbage-collect unreferenced contents/terms/groups/duplicates and their FTS rows. Full-text page payloads are bounded by the transport budget; extraction must mark truncation.

## Budget and migrations

Without full text, database plus steady WAL must stay ≤1 GB per 100,000 files. The planning estimate is about 0.75 GB: directories/files 21 MB, contents/stages 26 MB, boards 150 MB, documents 90 MB, terms 120 MB, postings 270 MB, identifiers 24 MB, name FTS 42 MB, groups/relations 19 MB. This is a budget, not a measured result. Store/scale tests must measure the expanded schema, checkpoint and compact as needed, and prioritize identifiers/summary tiers if the hard budget would be exceeded. Full text has a separate per-root estimate and consent; do not enable it to fill spare space.

Forward-only numbered migrations run each in one transaction. Copy only the application's own database to `library.db.v<N>.bak` before migration (one backup retained); this is not a copy of an original user document. Refuse a newer schema without overwriting it. A failed migration or integrity check may rebuild the derived index and replay decisions; retain at most one damaged database. Clear `clean_shutdown` at open, run `quick_check` after an unclean close, finish the current batch and checkpoint on a bounded two-second shutdown. Increment poison attempts before indexer dispatch, reset on success, and stop automatic retries after two reader crashes. Deleting the index stops the service first and touches only its profile directory; root list/corrections default to preserved.
