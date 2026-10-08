/* Generated from src/lib/library/validate.ts by scripts/library-validate.cjs. */
/** Standalone validation source. Regenerate the CommonJS twin with scripts/library-validate.cjs. */


const VALIDATION_LIMITS = Object.freeze({ depth: 24, nodes: 1_000_000, text: 16 * 1024 * 1024, refs: 250_000, terms: 20_000, components: 20_000, passives: 5_000, rails: 2_000, pages: 2_000, inputBytes: 256 * 1024 * 1024 });


const optional = new WeakSet       ();
const opt = (check       )        => { const wrapped        = v => v === undefined || check(v); optional.add(wrapped); return wrapped; };
const bool        = v => typeof v === 'boolean';
const num = (min        , max        , integer = true)        => v => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max && (!integer || Number.isSafeInteger(v));
const count = num(0, Number.MAX_SAFE_INTEGER), fraction = num(0, 1, false), confidence = num(0, 100);
const str = (max        , min = 0)        => v => typeof v === 'string' && v.length >= min && v.length <= max && !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(v);
const one = (...values                    )        => v => values.includes(v);
const id        = v => typeof v === 'string' && v.length >= 1 && v.length <= 64 && /^[A-Za-z0-9_-]+$/.test(v) && !['__proto__', 'constructor', 'prototype'].includes(v);
const hash        = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const arr = (check       , max        , min = 0)        => v => Array.isArray(v) && v.length >= min && v.length <= max && v.every(check);
const unique = (check       , max        , min = 0)        => v => arr(check, max, min)(v) && new Set(v             ).size === (v             ).length;
const obj = (fields        )        => v => {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const data = v                           ;
  return Object.keys(data).every(k => Object.hasOwn(fields, k)) && Object.entries(fields).every(([k, check]) => Object.hasOwn(data, k) ? check(data[k]) : optional.has(check));
};
const union = (...checks         )        => v => checks.some(check => check(v));
const kinds = one('board', 'board-archive', 'schematic', 'pdf', 'image', 'archive', 'spreadsheet', 'firmware', 'text', 'unknown');
const roles = one('board', 'schematic', 'board-pdf', 'datasheet', 'service-manual', 'bom', 'photo', 'thermal', 'firmware', 'other');
const states = one('identified', 'pending', 'indexed', 'unknown', 'unsupported', 'encrypted', 'damaged', 'skipped', 'link', 'no-access', 'locked', 'missing');
const errors = one('invalid-request', 'unsupported-version', 'not-found', 'outside-root', 'file-changed', 'root-offline', 'no-access', 'locked', 'unknown-format', 'unsupported-format', 'encrypted', 'too-large', 'timeout', 'reader-crash', 'damaged', 'cancelled', 'nested-archive', 'unsafe-entry', 'storage-full', 'newer-schema', 'internal');
const stages = one('enumerate', 'identity', 'sniff', 'name', 'summary', 'knowledge', 'ocr', 'group', 'full-text');
const performance = one('gentle', 'normal', 'use-more');
const source = one('folder', 'name', 'archive', 'header', 'pdf-metadata', 'outline', 'title-block', 'schematic', 'ocr', 'user');
/** Normalized relative paths only. Filesystem code still must realpath/lstat and recheck containment. */
function isRelativeLibraryPath(value         )                  {
  if (typeof value !== 'string' || !value || value.length > 4096 || /[\\:\x00-\x1f]/.test(value) || value.startsWith('/')) return false;
  return value.split('/').every(part => part !== '' && part !== '.' && part !== '..' && !/[. ]$/.test(part) && !/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part));
}
const relative        = isRelativeLibraryPath;
const basename        = v => relative(v) && !(v          ).includes('/');
const absolute        = v => typeof v === 'string' && v.length <= 4096 && !/[\x00-\x1f]/.test(v) && !v.startsWith('\\\\?\\') && !v.startsWith('\\\\.\\') && (v.startsWith('/') && v.length > 1 || /^[A-Za-z]:[\\/]/.test(v) && !v.slice(2).includes(':') || /^\\\\[^\\/:]+\\[^\\/:]+(?:\\[^:]+)?$/.test(v));
/** Reject accessors, polluted prototypes, cycles, symbols and work beyond the transport budget before schema traversal. */
function safeTree(value         )          {
  const pending                                                      = [{ value, depth: 0 }];
  const seen = new Set        ();
  let nodes = 0, text = 0, bytes = 0;
  while (pending.length) {
    const item = pending.pop() ;
    if (item.exit) { seen.delete(item.value          ); continue; }
    if (++nodes > VALIDATION_LIMITS.nodes || item.depth > VALIDATION_LIMITS.depth) return false;
    const v = item.value;
    if (typeof v === 'string') { text += v.length * 2; if (text > VALIDATION_LIMITS.text) return false; continue; }
    if (v === null || v === undefined || typeof v === 'boolean') continue;
    if (typeof v === 'number') { if (!Number.isFinite(v)) return false; continue; }
    if (typeof v !== 'object') return false;
    if (v instanceof Uint8Array) { bytes += v.byteLength; if (bytes > VALIDATION_LIMITS.inputBytes) return false; continue; }
    if (seen.has(v)) return false;
    seen.add(v);
    pending.push({ value: v, depth: item.depth, exit: true });
    const array = Array.isArray(v), proto = Object.getPrototypeOf(v);
    if (array ? proto !== Array.prototype || v.length > VALIDATION_LIMITS.refs : proto !== Object.prototype && proto !== null) return false;
    const keys = Reflect.ownKeys(v);
    if (keys.length > VALIDATION_LIMITS.refs || pending.length + keys.length + nodes > VALIDATION_LIMITS.nodes) return false;
    for (const key of keys) {
      if (array && key === 'length') continue;
      if (typeof key !== 'string' || key.length > 256 || key === '__proto__' || key === 'constructor' || key === 'prototype') return false;
      const descriptor = Object.getOwnPropertyDescriptor(v, key) ;
      if (!Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) return false;
      if (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= v.length)) return false;
      pending.push({ value: descriptor.value, depth: item.depth + 1 });
    }
    if (array && keys.length !== v.length + 1) return false;
  }
  return true;
}
const guarded = (check       , value         )          => { try { return safeTree(value) && check(value); } catch { return false; } };
const rootOptions = obj({ fullText: bool, watch: bool, exclusions: arr(str(256, 1), 128), rescanMinutes: num(0, 525600) });
const settings = obj({ version: one(1), performance, checkAtStartup: bool, ocrDuringScan: one('off', 'triage'), ocrOnBattery: bool });
const target = union(obj({ kind: one('content'), sha256: hash }), obj({ kind: one('file'), rootId: id, relativePath: relative, entryPath: opt(relative) }));
const decision = union(
  obj({ kind: one('merge'), groups: unique(id, 200, 2) }), obj({ kind: one('split'), groupId: id, contents: unique(id, 200, 1) }),
  obj({ kind: one('same', 'different'), a: target, b: target }), obj({ kind: one('label'), groupId: id, label: str(256, 1) }),
  obj({ kind: one('role'), target, role: roles }), obj({ kind: one('tag'), groupId: id, tag: str(64, 1), enabled: bool }), obj({ kind: one('hide'), target, hidden: bool }),
);
const filters = obj({ roots: opt(unique(id, 128)), kinds: opt(unique(kinds, 10)), roles: opt(unique(roles, 10)), states: opt(unique(states, 13)), formats: opt(unique(id, 128)), vendors: opt(unique(str(256, 1), 128)), deviceTypes: opt(unique(str(256, 1), 128)), has: opt(unique(one('board', 'schematic', 'documents'), 3)), groupId: opt(id) });
const query = obj({ text: str(200), mode: one('boards', 'files', 'duplicates', 'problems', 'unsorted'), filters, sort: one('relevance', 'label', 'board-number', 'vendor', 'recent', 'documents', 'completeness'), direction: one('asc', 'desc'), cursor: opt(str(512, 1)), limit: num(1, 200) });
const empty = obj({});
const requestArgs                                  = {
  roots: empty, 'add-root': obj({ label: opt(str(64, 1)) }), 'remove-root': obj({ rootId: id, forgetCorrections: bool }),
  'root-options': obj({ rootId: id, options: rootOptions }), scan: obj({ rootId: opt(id), mode: one('changes', 'full') }), pause: empty, resume: empty, stop: empty, status: empty,
  settings: obj({ settings }), 'get-settings': empty, query, group: obj({ id }), file: obj({ id }), similar: obj({ id, basis: one('layout', 'parts') }),
  decide: obj({ decision }), open: obj({ fileId: id, select: opt(obj({ ref: str(256, 1) })) }), attach: obj({ fileIds: unique(id, 16, 1) }), reveal: obj({ fileId: id }),
  ocr: obj({ contentId: id, pages: one('triage', 'all') }), 'delete-index': obj({ keepCorrections: bool, keepRoots: bool }),
};
const request        = v => {
  const data = v                          ;
  return !!data && typeof data.operation === 'string' && Object.hasOwn(requestArgs, data.operation) && obj({ version: one(1), requestId: id, operation: one(data.operation), args: requestArgs[data.operation                    ] })(v);
};
const page = num(1, 2000), pages = unique(page, 2000), refs = unique(str(256, 1), 250000);
const identifier = obj({ kind: one('board-number', 'revision', 'vendor', 'model', 'device-type', 'title'), raw: str(256, 1), norm: str(256, 1), source, confidence, page: opt(page), pattern: opt(id) });
const identity = obj({ identifiers: arr(identifier, 256), title: opt(str(256)), revision: opt(str(256)), drawing: opt(str(256)), company: opt(str(256)), date: opt(str(256)) });
const term = obj({ norm: str(256, 1), base: opt(str(256, 1)), family: opt(str(256, 1)), category: opt(id), tier: one('known', 'near-ref', 'board-confirmed', 'text'), source, refs: unique(str(256, 1), 8), additionalRefs: count, pages });
const base = { identity, refs, rails: unique(str(256, 1), 2000), terms: arr(term, 20000), truncated: opt(unique(one('refs', 'rails', 'terms', 'components', 'passives', 'full-text'), 6)) };
const boardShape = obj({ ...base, kind: one('board'), adapter: id, variant: opt(str(256)), parts: num(0, 250000), pins: num(0, 1000000), nets: num(0, 1000000), sides: unique(one('top', 'bottom', 'both'), 3), widthMm: opt(num(0, 1000000, false)), heightMm: opt(num(0, 1000000, false)), fingerprint: str(128, 1), fingerprintVersion: num(1, 2147483647), minhash: arr(num(0, 4294967295), 128, 128), components: arr(obj({ ref: str(256, 1), value: str(256), package: opt(str(256)), pinCount: num(0, 1000000), exact: opt(str(256)), base: opt(str(256)), family: opt(str(256)), category: opt(id), source }), 20000), passives: arr(obj({ kind: one('resistor', 'capacitor', 'inductor', 'ferrite'), valueSI: opt(num(0, Number.MAX_VALUE, false)), package: opt(str(256)), count }), 5000) });
const board        = v => {
  if (!boardShape(v)) return false;
  const b = v                                                                                                                                                       ;
  const fp = b.fingerprint.startsWith(`fp${b.fingerprintVersion}:`) ? b.fingerprint.slice(b.fingerprint.indexOf(':') + 1) : b.fingerprint;
  return hash(fp) && b.components.length + b.passives.reduce((total, p) => total + p.count, 0) <= b.parts && b.components.reduce((total, c) => total + c.pinCount, 0) <= b.pins;
};
const document        = v => {
  if (!obj({ ...base, kind: one('document'), format: id, role: roles, pages: page, textLayer: one('yes', 'no', 'mixed'), ocr: one('none', 'triage', 'all'), title: opt(str(256)), producer: opt(str(256)), pageHashes: arr(hash, 2000), fullText: opt(arr(obj({ page, body: str(1_000_000) }), 2000)) })(v)) return false;
  const d = v                                                                                                                                                        ;
  return (d.pageHashes.length === 0 || d.pageHashes.length === d.pages) && (!d.fullText || new Set(d.fullText.map(p => p.page)).size === d.fullText.length && d.fullText.every(p => p.page <= d.pages)) && d.terms.every(t => t.pages.every(p => p <= d.pages)) && d.identity.identifiers.every(i => i.page === undefined || i.page <= d.pages);
};
const summary = union(board, document, obj({ kind: one('image'), width: num(1, 100000), height: num(1, 100000) }));
const progress = obj({ scanId: id, state: one('idle', 'running', 'paused', 'stopping', 'complete', 'failed'), phase: stages, rootId: opt(id), relativeFolder: opt(union(one(''), relative)), discovered: count, completed: count, failed: count, pending: count, bytesRead: count, etaSeconds: opt(obj({ low: count, high: count })), performance });
const event = union(obj({ version: one(1), type: one('progress'), progress }), obj({ version: one(1), type: one('changed'), generation: count, groupIds: unique(id, 200) }), obj({ version: one(1), type: one('error'), error: errors, rootId: opt(id) }));
const root = { id, label: str(64, 1), state: one('online', 'offline', 'no-access'), network: bool, options: rootOptions, fileCount: count };
const registeredRoot        = v => obj({ ...root, realpath: absolute })(v) && (!((v                        ).network) || !((v                                   ).options.watch));
const mainMessage = union(obj({ version: one(1), type: one('configure'), roots: arr(registeredRoot, 128), settings, generation: count }), obj({ version: one(1), type: one('request'), request }), obj({ version: one(1), type: one('shutdown'), requestId: id }));
const job = obj({ version: one(1), type: one('job'), jobId: id, contentId: id, generation: count, extractorVersion: num(1, 2147483647), kind: one('board', 'schematic', 'pdf', 'image'), format: id, name: basename, bytes: v => v instanceof Uint8Array && v.byteLength > 0 && v.byteLength <= VALIDATION_LIMITS.inputBytes, companions: opt(arr(obj({ name: basename, bytes: v => v instanceof Uint8Array && v.byteLength <= 64 * 1024 * 1024 }), 64)), options: obj({ fullText: bool, ocr: one('off', 'triage', 'all') }) });
const indexRequest = union(job, obj({ version: one(1), type: one('cancel'), jobId: id, generation: count }));
const indexResult = union(obj({ version: one(1), type: one('progress'), jobId: id, generation: count, fraction }), obj({ version: one(1), type: one('result'), jobId: id, contentId: id, generation: count, extractorVersion: num(1, 2147483647), summary }), obj({ version: one(1), type: one('error'), jobId: id, generation: count, error: errors }));
const file = obj({ id, rootId: id, relativePath: relative, contentId: opt(id), containerId: opt(id), entryPath: opt(relative), state: states, kind: kinds, format: opt(id), role: roles, problem: opt(errors), missingSince: opt(count), seenScan: id, size: count, mtimeMs: opt(count), fileKey: opt(str(256)), quickKey: opt(str(64)), sha256: opt(hash), workspaceKey: opt(hash) });
const evidence = obj({ kind: one('fingerprint', 'layout-similar', 'layout-related', 'doc-coverage', 'structured-link', 'id-content', 'id-name', 'proximity', 'conflict', 'user-same', 'user-different'), a: id, b: id, strength: one('strong', 'suggest', 'conflict'), score: fraction, foundRefs: opt(count), boardRefs: opt(count), documentOnlyShare: opt(fraction), identifiers: opt(arr(str(256), 256)), pages: opt(pages) });
const group = obj({ id, label: str(256), boardNumber: opt(str(256)), vendor: opt(str(256)), model: opt(str(256)), deviceType: opt(str(256)), updated: count, tags: unique(str(64, 1), 128), members: arr(obj({ contentId: id, role: roles, revision: opt(str(256)), tier: one('automatic', 'suggested', 'user'), evidence: arr(evidence, 256) }), 2000) });
const revision = obj({ contentId: id, label: str(256), scheme: str(64), order: opt(num(-Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)), basis: one('token', 'layout', 'user', 'unknown'), addedParts: opt(count), removedParts: opt(count), changedValues: opt(count) });
const duplicate = obj({ id, kind: one('identical', 'archive-copy', 'other-format', 'resaved-document', 'name-clash'), fileIds: unique(id, 2000), contentIds: unique(id, 2000), evidence: arr(evidence, 256) });
const queryTerm = obj({ field: one('any', 'part', 'board', 'ref', 'rail', 'file'), value: str(200, 1), match: opt(one('exact', 'base', 'prefix', 'family')) });
const match = obj({ term: queryTerm, tier: one('exact', 'base', 'prefix', 'family', 'text'), contentId: id, source: str(64, 1), refs: arr(str(256), 8), pages });
const row = obj({ id, label: str(256), kind: one('group', 'file', 'duplicate'), fileCount: count, matches: arr(match, 128), rootLabel: opt(str(64)), relativePath: opt(relative) });
const facet = arr(obj({ value: str(256), count }), 128);
const queryPage = obj({ rows: arr(row, 200), total: count, cursor: opt(str(512, 1)), facets: obj({ kinds: facet, roles: facet, formats: facet, roots: facet }) });
const detail = obj({ group, files: arr(file, 2000), revisions: arr(revision, 2000), duplicates: arr(duplicate, 2000), boards: arr(board, 200), documents: arr(document, 200) });
// Open/attach reuse the existing payloads; absolute paths are confined to these existing workspace payloads.
const byteData        = v => v instanceof Uint8Array && v.byteLength <= VALIDATION_LIMITS.inputBytes;
const companions        = v => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length <= 64 && Object.entries(v).every(([name, bytes]) => basename(name) && byteData(bytes));
const filePayload = obj({ name: str(4096), path: str(4096), data: byteData, key: hash, companions: opt(companions), startupSource: opt(one('argument', 'recent')) });
const documentPayload = obj({ name: str(4096), path: str(4096), kind: one('pdf', 'image', 'schematic'), format: str(64, 1), data: byteData, key: hash, size: count, companions: opt(companions), skipped: opt(arr(obj({ name: str(4096), reason: str(256) }), 256)) });
const nil = one(null);
const results                                  = {
  roots: arr(obj(root), 128), 'add-root': union(obj(root), nil), 'remove-root': nil, 'root-options': nil, scan: nil, pause: progress, resume: progress, stop: progress, status: progress,
  settings: nil, 'get-settings': settings, query: queryPage, group: union(detail, nil), file: union(file, nil), similar: arr(obj({ groupId: id, score: fraction, basis: one('layout', 'parts') }), 50),
  decide: nil, open: filePayload, attach: arr(documentPayload, 16), reveal: nil, ocr: nil, 'delete-index': nil,
};
const response        = v => {
  const r = v                                        ;
  if (!r || typeof r.operation !== 'string' || !Object.hasOwn(results, r.operation)) return false;
  const envelope = { version: one(1), requestId: id, operation: one(r.operation) };
  return r.ok === true ? obj({ ...envelope, ok: one(true), result: results[r.operation                    ] })(v) : obj({ ...envelope, ok: one(false), error: errors })(v);
};
const serviceMessage = union(obj({ version: one(1), type: one('response'), response }), obj({ version: one(1), type: one('event'), event }), obj({ version: one(1), type: one('checkpointed'), requestId: id }));
function validateLibraryArgs                            (operation   , value         )                                        { return typeof operation === 'string' && Object.hasOwn(requestArgs, operation) && guarded(requestArgs[operation], value); }
function validateLibraryRequest(value         )                          { return guarded(request, value); }
function validateLibraryResponse(value         )                           { return guarded(response, value); }
function validateLibraryDecision(value         )                           { return guarded(decision, value); }
function validateLibrarySettings(value         )                           { return guarded(settings, value); }
function validateIndexSummary(value         )                        { return guarded(summary, value); }
function validateLibraryEvent(value         )                        { return guarded(event, value); }
function validateMainToService(value         )                         { return guarded(mainMessage, value); }
function validateServiceToMain(value         )                         { return guarded(serviceMessage, value); }
function validateServiceToIndexer(value         )                            {
  if (!guarded(indexRequest, value)) return false;
  const j = value                    ;
  if (j.type !== 'job') return true;
  const total = j.bytes.byteLength + (j.companions ?? []).reduce((sum, c) => sum + c.bytes.byteLength, 0);
  return (j.kind === 'pdf' || total <= 64 * 1024 * 1024) && new Set((j.companions ?? []).map(c => c.name.toLowerCase())).size === (j.companions ?? []).length && !(j.companions ?? []).some(c => c.name.toLowerCase() === j.name.toLowerCase());
}
function validateIndexerToService(value         )                            { return guarded(indexResult, value); }
/** Extra job-specific checks: shape validation cannot grant full-text/OCR permission or accept stale outputs. */
function validateResultForJob(value         , input         )                            {
  if (!validateIndexerToService(value) || !validateServiceToIndexer(input) || input.type !== 'job' || value.jobId !== input.jobId || value.generation !== input.generation) return false;
  if (value.type !== 'result') return true;
  if (value.contentId !== input.contentId || value.extractorVersion !== input.extractorVersion) return false;
  const s = value.summary;
  if (input.kind === 'board') return s.kind === 'board' && s.adapter === input.format;
  if (input.kind === 'image') return s.kind === 'image';
  return s.kind === 'document' && s.format === input.format && (!s.fullText || input.options.fullText) && (s.ocr === 'none' || input.options.ocr === 'all' || s.ocr === 'triage' && input.options.ocr === 'triage') &&
    (input.options.ocr !== 'off' || s.identity.identifiers.every(i => i.source !== 'ocr') && s.terms.every(t => t.source !== 'ocr')) &&
    (input.options.ocr !== 'triage' || s.identity.identifiers.every(i => i.source !== 'ocr' || i.page !== undefined && i.page <= 2) && s.terms.every(t => t.source !== 'ocr' || t.pages.length > 0 && t.pages.every(p => p <= 2)));
}

module.exports = { VALIDATION_LIMITS, isRelativeLibraryPath, validateLibraryArgs, validateLibraryRequest, validateLibraryResponse, validateLibraryDecision, validateLibrarySettings, validateIndexSummary, validateLibraryEvent, validateMainToService, validateServiceToMain, validateServiceToIndexer, validateIndexerToService, validateResultForJob };
