/*
 * Files that belong to no family, and the files that fill the budget: unrelated documents and text, photos, junk files, hostile
 * archives (bounded ZIP bombs, zip-slip names, nested archives, an encrypted entry, a truncated download), signature-only RAR and
 * 7z files, empty files, copies of other families' files dropped in foreign folders, and the large filler files that bring the
 * total to the byte budget.
 */
import { buildFiller, buildFirmware, buildJpeg, buildPng, FIRMWARE_SIZES } from './binary.ts';
import type { Engine } from './engine.ts';
import { signatureOnly } from './zip.ts';
import type { ItemFlag } from './ground-truth.ts';
import type { FamilyRun } from './families.ts';
import { copyFolderOf } from './layout.ts';
import type { Content } from './records.ts';
import type { Rng } from './rng.ts';
import type { UnrelatedTextKind } from './text-docs.ts';
import { buildUnrelatedText } from './text-docs.ts';
import { buildUnrelatedPdf } from './documents.ts';
import { FOLDER_WORDS, OPAQUE_STEMS } from './words.ts';

const DAY = 86_400_000;
const mtimeAt = (rng: Rng): number => Date.UTC(2015, 0, 1) + rng.int(0, 3650) * DAY + rng.int(0, 86_399) * 1000;

function folderFor(run: FamilyRun, rng: Rng): string[] {
  const collection = rng.pick(run.collections);
  return [...collection.root, rng.pick(FOLDER_WORDS), ...(rng.chance(0.3) ? [rng.pick(FOLDER_WORDS)] : [])];
}

const TEXT_KINDS: readonly UnrelatedTextKind[] = ['note', 'log', 'ini', 'json', 'html', 'csv'];
const TEXT_EXTENSIONS: Readonly<Record<UnrelatedTextKind, string>> = { note: '.txt', log: '.log', ini: '.ini', json: '.json', html: '.html', csv: '.csv' };
const PROSE = ['notes', 'todo', 'customers', 'prices', 'readme', 'log', 'session', 'list', 'draft', 'ideas'];

/** The hostile and special cases that every library of 100 files or more holds once, so a small set exercises each of them. */
export function addGuaranteed(e: Engine, run: FamilyRun): void {
  const rng = e.root.fork('guaranteed');
  const where = (label: string): string[] => folderFor(run, rng.fork(label));
  const text = (label: string, lines = 8): Content => e.newContent({ kind: 'text', format: 'text', role: 'other', familyId: null, revision: null, build: () => buildUnrelatedText('note', e.root.fork(`g/${label}`), lines) });
  const reachable = e.items.filter(item => !item.container && item.familyId && (item.role === 'board' || item.role === 'schematic') && !item.flags.includes('copy') && !item.flags.includes('truncated'));
  // the donor of the copies is one of the smaller files, so the special cases stay cheap in a small budget
  const bySize = [...reachable].sort((a, b) => (a.size ?? 0) - (b.size ?? 0));
  const donor = bySize.length ? rng.pick(bySize.slice(0, Math.max(1, Math.floor(bySize.length / 4)))) : null;
  const donorContent = donor ? e.contents.get(donor.contentId)! : null;

  // copies of a real file under a wrong extension, without one, under an opaque name, and cut short
  if (donor && donorContent) {
    const family = run.families.find(entry => entry.id === donor.familyId);
    const named = family ? { vendor: family.vendor, model: family.model, boardNumber: family.boardNumber, deviceType: family.deviceType as never } : null;
    const original = donor.path.split('/').pop()!;
    const dot = original.lastIndexOf('.');
    const stem = dot > 0 ? original.slice(0, dot) : original, extension = dot > 0 ? original.slice(dot) : '';
    const keep = Math.max(1000, Math.floor((donorContent.size ?? 4000) * 0.6));
    const cut = e.newContent({ kind: donorContent.kind, format: donorContent.format, role: donorContent.role, familyId: donor.familyId, revision: donor.revision, flags: ['truncated'], build: () => e.bytesOf(donorContent).slice(0, keep) });
    const cases: Array<[string, Content, ItemFlag[], boolean]> = [
      [`${stem}.txt`, donorContent, ['copy', 'wrong-extension'], true],
      [stem, donorContent, ['copy', 'no-extension'], true],
      [`${OPAQUE_STEMS[0]} ${rng.int(1, 99)}${extension}`, donorContent, ['copy', 'renamed-copy'], false],
      [`${stem} (2)${extension}`, cut, [], true],
    ];
    // twenty folders deep
    cases.push([original, donorContent, ['copy'], true]);
    cases.forEach(([name, content, flags, keepNames], i) => {
      e.addFile({ dir: i === cases.length - 1 ? [...folderFor(run, rng.fork('deep')).slice(0, 1), ...Array.from({ length: 19 }, (_, level) => `d${level + 1}`)] : where(`donor-${i}`), name, content, familyId: donor.familyId, revision: donor.revision, role: donor.role, flags, mtimeMs: donor.mtimeMs + DAY * (i + 1), named: keepNames ? named : null });
    });
  }
  // bounded ZIP bomb
  const bombs = e.options.bytes >= 200 * 1024 * 1024 ? [16, 32, 64] : [8, 16, 24];
  e.addArchive({
    dir: where('bomb'), name: 'old backup.zip', familyId: null, revision: null, mtimeMs: mtimeAt(rng.fork('bomb')), flags: ['zip-bomb'],
    entries: [{ name: 'readme.txt', content: text('bomb-readme') }, ...bombs.map((mib, i) => ({ name: `disk${i + 1}.img`, bombMiB: mib }))],
  });
  // path traversal in entry names
  e.addArchive({
    dir: where('slip'), name: 'drivers.zip', familyId: null, revision: null, mtimeMs: mtimeAt(rng.fork('slip')), flags: ['zip-slip'],
    entries: [
      { name: 'readme.txt', content: text('slip-readme') },
      { name: '../../outside/evil.txt', content: text('slip-a'), flags: ['zip-slip'] },
      { name: '/absolute/evil.bin', content: text('slip-b'), flags: ['zip-slip'] },
      { name: 'C:\\Windows\\Temp\\evil.dll', content: text('slip-c'), flags: ['zip-slip'] },
      { name: 'docs/../../../up.txt', content: text('slip-d'), flags: ['zip-slip'] },
      { name: '..\\..\\back.txt', content: text('slip-e'), flags: ['zip-slip'] },
    ],
  });
  // archive inside archive: the inner members are listed, not opened
  if (donorContent && donor) {
    e.addArchive({
      dir: where('nested'), name: 'collection 2018.zip', familyId: null, revision: null, mtimeMs: mtimeAt(rng.fork('nested')), flags: ['nested-archive'],
      entries: [{ name: 'note.txt', content: text('nested-note') }, { name: 'inner/boards.zip', nested: [{ name: donor.path.split('/').pop()!, content: donorContent, familyId: donor.familyId, revision: donor.revision, role: donor.role }, { name: 'info.txt', content: text('nested-info') }] }],
    });
  }
  // an entry stored with the "encrypted" flag, next to a normal one
  const secret = e.newContent({ kind: 'unknown', format: null, role: 'other', familyId: null, revision: null, flags: ['encrypted'], build: () => e.root.fork('g/secret').bytes(900) });
  e.addArchive({
    dir: where('encrypted'), name: 'customer files.zip', familyId: null, revision: null, mtimeMs: mtimeAt(rng.fork('encrypted')),
    entries: [{ name: 'list.txt', content: text('enc-list') }, { name: 'secret.pdf', content: secret, encrypted: true }, ...(donorContent && donor ? [{ name: donor.path.split('/').pop()!, content: donorContent, familyId: donor.familyId, revision: donor.revision, role: donor.role }] : [])],
  });
  // a download that stopped before the end of the file
  e.addArchive({
    dir: where('cut'), name: 'download.zip', familyId: null, revision: null, mtimeMs: mtimeAt(rng.fork('cut')), truncateTail: true,
    entries: [{ name: 'a.txt', content: text('cut-a', 40) }, { name: 'b.txt', content: text('cut-b', 40) }],
  });
  // signature-only archives of RAR 4, RAR 5 and 7z
  const named = run.recent.length ? run.recent : [];
  (['rar4', 'rar5', '7z'] as const).forEach((kind, i) => {
    const content = e.newContent({ kind: 'archive', format: kind === '7z' ? '7z' : 'rar', variant: kind === 'rar4' ? 'rar4' : kind === 'rar5' ? 'rar5' : undefined, role: 'other', familyId: null, revision: null, flags: ['signature-only'], build: () => signatureOnly(kind, e.root.fork(`g/${kind}`)) });
    const family = named.length ? named[i % named.length] : null;
    const stem = family ? `${family.model} ${rng.pick(['boardview', 'schematics', 'files', 'pack'])}` : `archive ${i + 1}`;
    e.addFile({ dir: where(`sig-${kind}`), name: `${stem}.${kind === '7z' ? '7z' : 'rar'}`, content, familyId: null, revision: null, role: 'other', mtimeMs: mtimeAt(rng.fork(`sig-${kind}`)), named: null });
  });
  // empty files with board-like names
  const empty = e.newContent({ kind: 'unknown', format: null, role: 'other', familyId: null, revision: null, flags: ['empty'], build: () => new Uint8Array(0) });
  for (const name of ['board.brd', 'schematic.pdf', 'New Text Document.txt']) e.addFile({ dir: where(`empty-${name}`), name, content: empty, familyId: null, revision: null, role: 'other', mtimeMs: mtimeAt(rng.fork(`empty-${name}`)), named: null });
}

type Maker = (rng: Rng, index: number) => boolean;

/** One more file of the kinds a collection collects besides the boards. Returns false when the budget of files is used up. */
export function addGenericFile(e: Engine, run: FamilyRun, index: number): boolean {
  if (!e.hasRoom()) return false;
  const rng = e.root.fork(`generic/${index}`);
  const dir = folderFor(run, rng.fork('dir'));
  const mtimeMs = mtimeAt(rng.fork('mtime'));
  const stem = (): string => `${rng.pick(rng.chance(0.5) ? OPAQUE_STEMS : PROSE)}${rng.pick([' ', '_', ''])}${rng.int(1, 99)}`;
  const makers: ReadonlyArray<readonly [Maker, number]> = [
    [() => {
      const kind = rng.pick(TEXT_KINDS), lines = rng.int(3, 120);
      const csv = kind === 'csv';
      const content = e.newContent({ kind: csv ? 'spreadsheet' : 'text', format: csv ? 'csv' : 'text', role: 'other', familyId: null, revision: null, build: () => buildUnrelatedText(kind, e.root.fork(`generic/${index}/text`), lines) });
      return e.addFile({ dir, name: `${stem()}${TEXT_EXTENSIONS[kind]}`, content, familyId: null, revision: null, role: 'other', mtimeMs }) !== null;
    }, 24],
    [() => {
      const pages = Math.max(1, Math.round(rng.int(1, 8) * Math.sqrt(e.scale)));
      const make = () => buildUnrelatedPdf(pages, e.root.fork(`generic/${index}/pdf`));
      const doc = make();
      const content = e.newContent({ kind: 'pdf', format: 'pdf', role: 'other', familyId: null, revision: null, decoys: doc.decoys, pages: doc.pages, build: () => make().bytes, prebuilt: doc.bytes });
      return e.addFile({ dir, name: `${rng.pick(['invoice', 'letter', 'offer', 'receipt', 'contract', 'manual of the shop'])} ${rng.int(1, 999)}.pdf`, content, familyId: null, revision: null, role: 'other', mtimeMs }) !== null;
    }, 12],
    [() => {
      const png = rng.chance(0.5);
      const options = { width: rng.int(32, 96), height: rng.int(24, 72), padBytes: Math.round(rng.int(4_000, 100_000) * Math.sqrt(e.scale)) };
      const content = e.newContent({ kind: 'image', format: png ? 'png' : 'jpeg', role: 'photo', familyId: null, revision: null, build: () => (png ? buildPng : buildJpeg)(e.root.fork(`generic/${index}/image`), options) });
      return e.addFile({ dir, name: `${rng.pick(['IMG', 'DSC', 'photo', 'scan'])}_${rng.int(1, 9999)}${png ? '.png' : '.jpg'}`, content, familyId: null, revision: null, role: 'photo', mtimeMs }) !== null;
    }, 12],
    [() => {
      const junk: Array<[string, () => Uint8Array, ItemFlag[]]> = [
        ['Thumbs.db', () => e.root.fork(`generic/${index}/thumbs`).bytes(rng.int(2000, 6000)), ['junk']],
        ['desktop.ini', () => new TextEncoder().encode('[.ShellClassInfo]\r\nIconResource=%SystemRoot%\\system32\\SHELL32.dll,4\r\n'), ['junk']],
        ['.DS_Store', () => e.root.fork(`generic/${index}/ds`).bytes(rng.int(500, 4000)), ['macos-junk', 'junk']],
        [`~$${stem()}.xlsx`, () => e.root.fork(`generic/${index}/lock`).bytes(165), ['junk']],
      ];
      const [name, build, flags] = rng.pick(junk);
      const content = e.newContent({ kind: 'unknown', format: null, role: 'other', familyId: null, revision: null, flags, build });
      const place = rng.chance(0.25) ? [...dir, rng.pick(['.git', 'node_modules', '$RECYCLE.BIN'])] : dir;
      return e.addFile({ dir: place, name, content, familyId: null, revision: null, role: 'other', mtimeMs }) !== null;
    }, 8],
    [() => {
      const entries = Array.from({ length: rng.int(1, 4) }, (_, k) => ({ name: `${stem()}.txt`, content: e.newContent({ kind: 'text', format: 'text', role: 'other' as const, familyId: null, revision: null, build: () => buildUnrelatedText('note', e.root.fork(`generic/${index}/zip/${k}`), rng.int(3, 30)) }) }));
      const seen = new Set<string>();
      const unique = entries.filter(entry => (seen.has(entry.name.toLowerCase()) ? false : (seen.add(entry.name.toLowerCase()), true)));
      return e.addArchive({ dir, name: `${stem()}.zip`, familyId: null, revision: null, mtimeMs, entries: unique }) !== null;
    }, 6],
    [() => {
      const sizes = FIRMWARE_SIZES.filter(value => value <= (e.options.bytes / e.options.files) * 8);
      if (!sizes.length) return false;
      const size = rng.pick(sizes);
      const content = e.newContent({ kind: 'firmware', format: 'firmware', role: 'firmware', familyId: null, revision: null, build: () => buildFirmware(e.root.fork(`generic/${index}/fw`), size) });
      return e.addFile({ dir, name: `${rng.pick(['dump', 'flash', 'bios backup', 'ec', 'rom'])}${rng.int(1, 99)}${rng.pick(['.bin', '.rom', '.fd'])}`, content, familyId: null, revision: null, role: 'firmware', mtimeMs }) !== null;
    }, 4],
    [() => {
      // a copy of some other file dropped into a foreign folder (proximity that means nothing)
      const sources = e.items.filter(item => !item.container && item.familyId && !item.unreachable);
      if (!sources.length) return false;
      const source = rng.pick(sources);
      const parts = source.path.split('/');
      const collection = rng.pick(run.collections);
      const original = parts[parts.length - 1];
      const dot = original.lastIndexOf('.');
      const extension = dot > 0 ? original.slice(dot) : '';
      const renamed = rng.chance(0.6);
      const name = renamed ? `${rng.pick(OPAQUE_STEMS)}${rng.pick([' ', '_', ''])}${rng.int(1, 99)}${extension}` : original;
      const flags: ItemFlag[] = renamed ? ['copy', 'renamed-copy'] : ['copy'];
      return e.addFile({ dir: copyFolderOf([...collection.root, rng.pick(FOLDER_WORDS)], collection, rng.fork('copy')), name, content: e.contents.get(source.contentId)!, familyId: source.familyId, revision: source.revision, role: source.role, flags, mtimeMs: source.mtimeMs + DAY * rng.int(1, 900), named: null }) !== null;
    }, 18],
    [() => {
      // a bill of materials of something else
      const content = e.newContent({ kind: 'spreadsheet', format: 'csv', role: 'bom', familyId: null, revision: null, build: () => buildUnrelatedText('csv', e.root.fork(`generic/${index}/bom`), rng.int(5, 60)) });
      return e.addFile({ dir, name: `${rng.pick(['bom', 'parts', 'order', 'stock'])} ${rng.int(1, 99)}.csv`, content, familyId: null, revision: null, role: 'bom', mtimeMs }) !== null;
    }, 4],
  ];
  const usable = makers.filter(([, weight]) => weight > 0);
  for (let attempt = 0; attempt < 6; attempt++) {
    const maker = rng.fork(`pick/${attempt}`).weighted(usable);
    if (maker(rng.fork(`do/${attempt}`), index)) return true;
  }
  const content = e.newContent({ kind: 'text', format: 'text', role: 'other', familyId: null, revision: null, build: () => buildUnrelatedText('note', e.root.fork(`generic/${index}/last`), 5) });
  return e.addFile({ dir, name: `${stem()}.txt`, content, familyId: null, revision: null, role: 'other', mtimeMs }) !== null;
}

const FILL_EXTENSIONS = ['.img', '.bak', '.dat', '.vhd', '.iso', '.raw', '.old', '.tmp'];
const FILL_STEMS = ['backup', 'vm disk', 'images', 'old pc', 'archive', 'system', 'recovery', 'export'];
/** The largest single filler file. */
const FILL_MAX = 256 * 1024 * 1024;

/** Adds `slots` large opaque files that use what is left of the byte budget (never more than it). */
export function addFiller(e: Engine, run: FamilyRun, slots: number): void {
  const rng = e.root.fork('filler');
  const left = e.options.bytes - e.diskBytes;
  if (left < slots * 1024) throw new RangeError(`the byte budget is used up (${left} bytes left for ${slots} filler files): raise --bytes or lower --files`);
  const target = Math.floor(left * 0.995);
  const weights = Array.from({ length: slots }, () => 0.5 + rng.next());
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let spent = 0;
  for (let i = 0; i < slots && e.hasRoom(); i++) {
    const size = Math.max(1024, Math.min(FILL_MAX, Math.floor(target * weights[i] / total)));
    if (spent + size > left) break;
    spent += size;
    const content = e.newContent({ kind: 'unknown', format: null, role: 'other', familyId: null, revision: null, build: () => buildFiller(e.root.fork(`filler/${i}`), size) });
    e.addFile({
      dir: folderFor(run, rng.fork(`dir/${i}`)), name: `${rng.pick(FILL_STEMS)} ${rng.int(1, 99)}${rng.pick(FILL_EXTENSIONS)}`, content, familyId: null, revision: null, role: 'other',
      mtimeMs: mtimeAt(rng.fork(`mtime/${i}`)), named: null,
    });
  }
}
