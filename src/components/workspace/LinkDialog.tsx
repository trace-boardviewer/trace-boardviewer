import { AlertTriangle, ArrowRight, Check, Link2, Trash2, TriangleAlert } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { WorkspaceApi } from '../../app/api';
import type { AliasIssue, LinkReport, NetLinkRow, PinLinkRow, RefLinkRow } from '../../lib/crossprobe';
import type { WorkspaceAliases } from '../../lib/documents';
import { Modal, naturalOrder } from './ui';
import { useUi } from './ui-context';

// i18n: pending
const T = {
  title: 'Board and schematic link', intro: 'Names that differ between the board and the schematic are never linked on a guess. Create an alias only when YOU know that two names are the same thing; each one can be removed again and applies to this board only.',
  persisted: 'Aliases are saved with this board\'s workspace. The board and schematic files are never modified.',
  sessionOnly: 'Browser mode: nothing is saved. Aliases work until this page is closed.',
  noLink: 'No schematic is attached and ready, so there is nothing to compare. Attach a schematic in the Documents tab.',
  summary: 'Comparison', refsLinked: (n: number) => `${n} linked`, refsAlias: (n: number) => `${n} by alias`, refsAmbiguous: (n: number) => `${n} ambiguous`, schOnly: (n: number) => `${n} schematic-only`, boardOnly: (n: number) => `${n} board-only`,
  netsDiffer: (n: number) => `${n} nets differ`, pinsDiffer: (n: number) => `${n} pins differ`,
  refs: 'Reference aliases', refsHint: 'A schematic reference such as "U1A" that has no board component of that name can be linked to one board reference.',
  schRef: 'Schematic reference', boardRef: 'Board reference', chooseSchRef: 'Choose a schematic reference', chooseBoardRef: 'Choose a board reference', chooseBoardNet: 'Choose a board net', chooseSchNet: 'Choose a schematic net',
  caseFlag: 'differs only in letter case: confirm it is the same part', flagged: 'letter case differs', components: (n: number) => `${n} components`, alreadyAliased: 'already has an alias: creating a new one replaces it',
  refConsequence: (from: string, to: string) => `Consequence: schematic reference "${from}" will be treated as board reference "${to}" in cross-probing, search and the pin comparison (pins are matched by number). Nothing is renamed in either file.`,
  createRef: 'Create reference alias', noSchOnlyRefs: 'Every schematic reference has a board counterpart.', noBoardOnlyRefs: 'No board-only references.',
  nets: 'Net aliases', netsHint: 'Net names are never merged by similarity. Confirm a schematic net name and a board net name as the same net.',
  schNet: 'Schematic net', boardNet: 'Board net', filterNets: 'Filter board nets', evidence: (pins: number, board: string) => `${pins} compared pin${pins === 1 ? '' : 's'} of board net ${board}`,
  netConsequence: (from: string, to: string) => `Consequence: schematic net "${from}" will be treated as the same net as board net "${to}": the net comparison marks it as confirmed and selecting one side selects the other. Pins are not changed.`,
  createNet: 'Create net alias', noNetCandidates: 'No schematic net names without a board counterpart.', fromComparison: 'Seen in the comparison (choose to review, nothing is applied):', use: 'Review', useBoardNet: (name: string) => `Use board net ${name}`,
  differences: 'Differences found', diffCaption: 'Schematic net → board net, as seen on the compared pins. Review pre-fills the form; nothing is applied until you create the alias.', noDiff: 'No pin or net differences are listed.', pinDiffer: (ref: string, pin: string, board: string, sch: string) => `${ref} pin ${pin}: board net ${board || 'none'}, schematic net ${sch || 'none'}`,
  missingPin: (ref: string, pin: string, where: string) => `${ref} pin ${pin}: ${where}`, pinMissingBoard: 'missing on the board', pinMissingSch: 'missing in the schematic',
  confirmed: 'Confirmed aliases', noAliases: 'No aliases yet.', refAlias: 'Reference', netAlias: 'Net', remove: (kind: string, from: string, to: string) => `Remove ${kind} alias ${from} → ${to}`,
  removeHint: 'Removing an alias only unlinks the two names again; documents, notes and files are untouched.',
  issue: (i: AliasIssue) => i.problem === 'source-missing' ? `The schematic has no ${i.kind === 'ref' ? 'reference' : 'net'} "${i.from}" any more` : `The board has no ${i.kind === 'ref' ? 'reference' : 'net'} "${i.to}" any more`,
  truncated: 'The list was truncated by its limit; the comparison is still complete for the counts above.', more: (n: number) => `+${n} more`,
  created: (kind: string, from: string, to: string) => `Created ${kind} alias: schematic ${from} → board ${to}.`, removed: (from: string) => `Removed the alias for ${from}.`, close: 'Close',
};
const LIST_LIMIT = 100;
const fold = (text: string) => text.normalize('NFKC').toLowerCase();

interface Props { api: WorkspaceApi; aliases: WorkspaceAliases; onCreate(kind: 'refs' | 'nets', from: string, to: string): void; onRemove(kind: 'refs' | 'nets', from: string): void; onClose(): void }

/** Link and alias panel: lists what differs, lets the technician confirm an alias explicitly (never auto-applied) and remove existing ones. */
export function LinkDialog({ api, aliases, onCreate, onRemove, onClose }: Props) {
  const { t } = useUi();
  const { state } = api;
  const link: LinkReport | null = state.link;
  const [refFrom, setRefFrom] = useState('');
  const [refTo, setRefTo] = useState('');
  const [netFrom, setNetFrom] = useState('');
  const [netTo, setNetTo] = useState('');
  const [netFilter, setNetFilter] = useState('');
  const [message, setMessage] = useState('');

  const model = useMemo(() => {
    if (!link) return null;
    const schOnly = link.refs.rows.filter((row: RefLinkRow) => row.status === 'schematic-only');
    const boardOnly = link.refs.rows.filter((row: RefLinkRow) => row.status === 'board-only');
    const schRefs = schOnly.map(row => ({ ref: row.schematicRefs[0] ?? row.ref, flagged: row.caseInsensitive.boardRefs })).sort((a, b) => naturalOrder(a.ref, b.ref));
    const boardRefs = boardOnly.map(row => ({ ref: row.ref, count: row.boardComponentsTotal, flagged: row.caseInsensitive.schematicRefs })).sort((a, b) => naturalOrder(a.ref, b.ref));
    const boardNets = (state.board?.nets ?? []).map(net => net.name).filter(Boolean).sort(naturalOrder);
    const netsByFold = new Map<string, string[]>();
    for (const name of boardNets) { const key = fold(name); netsByFold.set(key, [...(netsByFold.get(key) ?? []), name]); }
    const schNets = new Set<string>();
    for (const row of link.schematicOnlyNets.rows) schNets.add(row.name);
    const pairs: Array<{ sch: string; board: string; pins: number }> = [];
    for (const row of link.nets.rows as NetLinkRow[]) if (row.relation === 'differs') for (const net of row.schematicNets) if (net.name !== row.boardNet) { schNets.add(net.name); pairs.push({ sch: net.name, board: row.boardNet, pins: net.pins }); }
    const diffPins = link.pins.rows.filter((row: PinLinkRow) => row.status !== 'match' && row.status !== 'net-unknown');
    return { schRefs, boardRefs, boardNets, netsByFold, schNets: [...schNets].sort(naturalOrder), pairs, diffPins };
  }, [link, state.board]);

  const refEntries = Object.entries(aliases.refs).sort((a, b) => naturalOrder(a[0], b[0]));
  const netEntries = Object.entries(aliases.nets).sort((a, b) => naturalOrder(a[0], b[0]));
  const issues = (kind: 'ref' | 'net', from: string, to: string) => (link?.aliasIssues.rows ?? []).filter(issue => issue.kind === kind && issue.from === from && issue.to === to);
  const persisted = state.persistence === 'native';

  const refChoice = model?.schRefs.find(item => item.ref === refFrom);
  const boardRefOptions = useMemo(() => {
    if (!model) return [];
    const flagged = new Set(refChoice?.flagged ?? []);
    return [...model.boardRefs].sort((a, b) => Number(flagged.has(b.ref)) - Number(flagged.has(a.ref)) || naturalOrder(a.ref, b.ref)).slice(0, 400);
  }, [model, refChoice]);
  const netFlagged = useMemo(() => new Set(model && netFrom ? model.netsByFold.get(fold(netFrom))?.filter(name => name !== netFrom) ?? [] : []), [model, netFrom]);
  const netOptions = useMemo(() => {
    if (!model) return [];
    const needle = fold(netFilter.trim());
    const base = needle ? model.boardNets.filter(name => fold(name).includes(needle)) : model.boardNets;
    return [...base].sort((a, b) => Number(netFlagged.has(b)) - Number(netFlagged.has(a))).slice(0, LIST_LIMIT);
  }, [model, netFilter, netFlagged]);
  const netHints = useMemo(() => (model && netFrom ? model.pairs.filter(pair => pair.sch === netFrom) : []), [model, netFrom]);

  const createRef = () => { if (!refFrom || !refTo) return; onCreate('refs', refFrom, refTo); setMessage(T.created('reference', refFrom, refTo)); setRefFrom(''); setRefTo(''); };
  const createNet = () => { if (!netFrom || !netTo) return; onCreate('nets', netFrom, netTo); setMessage(T.created('net', netFrom, netTo)); setNetFrom(''); setNetTo(''); setNetFilter(''); };
  const remove = (kind: 'refs' | 'nets', from: string) => { onRemove(kind, from); setMessage(T.removed(from)); };
  const list = <Row,>(rows: readonly Row[], render: (row: Row, index: number) => React.ReactNode, total = rows.length) => <>{rows.slice(0, LIST_LIMIT).map(render)}{total > LIST_LIMIT && <li className="muted">{T.more(total - LIST_LIMIT)}</li>}</>;

  return <Modal title={T.title} closeLabel={t('common.close')} wide testId="link-dialog" close={onClose} initialFocus="[data-testid=alias-ref-from]">
    <div className="wsp-link">
      <p className="settings-hint">{T.intro}</p>
      <p className={'wsp-persist wsp-link-persist' + (persisted ? ' ok' : '')} role="note" data-testid="alias-persistence">{persisted ? <Check size={13} /> : <TriangleAlert size={13} />}{persisted ? T.persisted : T.sessionOnly}</p>
      {message && <p className="wsp-export-result" role="status" data-testid="alias-message">{message}</p>}
      {!link || !model ? <p className="empty-caption" data-testid="link-empty">{T.noLink}</p> : <>
        <section className="wsp-link-summary" aria-label={T.summary} data-testid="link-summary">
          <span>{T.refsLinked(link.summary.refs.unique)}</span><span>{T.refsAlias(link.summary.refs.alias)}</span><span className={link.summary.refs.ambiguous ? 'warn' : ''}>{T.refsAmbiguous(link.summary.refs.ambiguous)}</span>
          <span className={link.summary.refs.schematicOnly ? 'warn' : ''}>{T.schOnly(link.summary.refs.schematicOnly)}</span><span>{T.boardOnly(link.summary.refs.boardOnly)}</span>
          <span className={link.summary.nets.differs ? 'warn' : ''}>{T.netsDiffer(link.summary.nets.differs)}</span><span className={link.summary.pins.netDiffers ? 'warn' : ''}>{T.pinsDiffer(link.summary.pins.netDiffers + link.summary.pins.pinMissingOnBoard + link.summary.pins.pinMissingOnSchematic)}</span>
        </section>

        <section className="wsp-link-block" aria-labelledby="wsp-link-refs"><h3 id="wsp-link-refs">{T.refs}</h3><p className="settings-hint">{T.refsHint}</p>
          {model.schRefs.length === 0 ? <p className="empty-caption">{T.noSchOnlyRefs}</p> : <div className="wsp-link-form" role="group" aria-label={T.createRef}>
            <label><span>{T.schRef}</span><select value={refFrom} data-testid="alias-ref-from" onChange={e => { setRefFrom(e.target.value); setRefTo(''); setMessage(''); }}>
              <option value="">{T.chooseSchRef}</option>
              {model.schRefs.slice(0, 400).map(item => <option key={item.ref} value={item.ref}>{item.ref}{aliases.refs[item.ref] !== undefined ? ` — ${T.alreadyAliased}` : ''}{item.flagged.length ? ` — ${T.flagged}: ${item.flagged.join(', ')}` : ''}</option>)}</select></label>
            <ArrowRight size={15} className="wsp-link-arrow" aria-hidden="true" />
            <label><span>{T.boardRef}</span><select value={refTo} data-testid="alias-ref-to" disabled={!refFrom} onChange={e => { setRefTo(e.target.value); setMessage(''); }}>
              <option value="">{T.chooseBoardRef}</option>
              {boardRefOptions.map(item => <option key={item.ref} value={item.ref}>{item.ref}{item.count > 1 ? ` (${T.components(item.count)})` : ''}{refChoice?.flagged.includes(item.ref) ? ` — ${T.caseFlag}` : ''}</option>)}</select></label>
            <button type="button" className="primary-button" data-testid="alias-ref-create" disabled={!refFrom || !refTo} onClick={createRef}><Link2 size={14} />{T.createRef}</button>
            {refFrom && refTo && <p className="wsp-link-consequence" data-testid="alias-ref-consequence">{T.refConsequence(refFrom, refTo)}{refChoice?.flagged.includes(refTo) ? ` ${T.caseFlag}.` : ''}</p>}
          </div>}
          <details className="wsp-link-lists"><summary>{T.schOnly(model.schRefs.length)} · {T.boardOnly(model.boardRefs.length)}</summary>
            <div className="wsp-link-columns"><ul aria-label={T.schOnly(model.schRefs.length)}>{list(model.schRefs, item => <li key={item.ref}><button type="button" className="wsp-link-pick mono" onClick={() => { setRefFrom(item.ref); setRefTo(''); }}>{item.ref}</button>{item.flagged.length > 0 && <em className="wsp-chip warn">{T.flagged}: {item.flagged.join(', ')}</em>}</li>)}</ul>
              <ul aria-label={T.boardOnly(model.boardRefs.length)}>{model.boardRefs.length === 0 ? <li className="muted">{T.noBoardOnlyRefs}</li> : list(model.boardRefs, item => <li key={item.ref}><span className="mono">{item.ref}</span>{item.flagged.length > 0 && <em className="wsp-chip warn">{T.flagged}: {item.flagged.join(', ')}</em>}</li>)}</ul></div>
            {link.refs.truncated && <p className="wsp-reason">{T.truncated}</p>}
          </details>
        </section>

        <section className="wsp-link-block" aria-labelledby="wsp-link-nets"><h3 id="wsp-link-nets">{T.nets}</h3><p className="settings-hint">{T.netsHint}</p>
          {model.schNets.length === 0 && !netFrom ? <p className="empty-caption">{T.noNetCandidates}</p> : <div className="wsp-link-form" role="group" aria-label={T.createNet}>
            <label><span>{T.schNet}</span><select value={netFrom} data-testid="alias-net-from" onChange={e => { setNetFrom(e.target.value); setNetTo(''); setMessage(''); }}>
              <option value="">{T.chooseSchNet}</option>{[...new Set([...(netFrom ? [netFrom] : []), ...model.schNets])].slice(0, 400).map(name => <option key={name} value={name}>{name}{aliases.nets[name] !== undefined ? ` — ${T.alreadyAliased}` : ''}</option>)}</select></label>
            <ArrowRight size={15} className="wsp-link-arrow" aria-hidden="true" />
            <div className="wsp-link-netpick"><label><span>{T.boardNet}</span><input type="search" value={netFilter} placeholder={T.filterNets} aria-label={T.filterNets} data-testid="alias-net-filter" disabled={!netFrom} onChange={e => setNetFilter(e.target.value)} /></label>
              <select value={netTo} size={5} aria-label={T.boardNet} data-testid="alias-net-to" disabled={!netFrom} onChange={e => { setNetTo(e.target.value); setMessage(''); }}>
                {netOptions.length === 0 ? <option value="" disabled>—</option> : netOptions.map(name => <option key={name} value={name}>{name}{netFlagged.has(name) ? ` — ${T.caseFlag}` : ''}</option>)}</select></div>
            <button type="button" className="primary-button" data-testid="alias-net-create" disabled={!netFrom || !netTo} onClick={createNet}><Link2 size={14} />{T.createNet}</button>
            {netHints.length > 0 && <div className="wsp-link-hints" data-testid="alias-net-hints"><span className="muted">{T.fromComparison}</span>{netHints.map(pair => <button key={pair.board} type="button" className="outline-button" aria-label={T.useBoardNet(pair.board)} onClick={() => { setNetTo(pair.board); setNetFilter(''); }}><span className="mono">{pair.board}</span><span className="muted">{T.evidence(pair.pins, pair.board)}</span></button>)}</div>}
            {netFrom && netTo && <p className="wsp-link-consequence" data-testid="alias-net-consequence">{T.netConsequence(netFrom, netTo)}{netFlagged.has(netTo) ? ` ${T.caseFlag}.` : ''}</p>}
          </div>}
        </section>

        <section className="wsp-link-block" aria-labelledby="wsp-link-diff"><h3 id="wsp-link-diff">{T.differences}</h3>{model.pairs.length > 0 && <p className="settings-hint">{T.diffCaption}</p>}
          {model.diffPins.length === 0 && model.pairs.length === 0 ? <p className="empty-caption">{T.noDiff}</p> : <ul className="wsp-link-diff" data-testid="link-differences">
            {list(model.pairs, (pair, i) => <li key={`n${i}`}><span className="mono">{pair.sch}</span><ArrowRight size={12} aria-hidden="true" /><span className="mono">{pair.board}</span><span className="muted">{T.evidence(pair.pins, pair.board)}</span>
              <button type="button" className="text-button" onClick={() => { setNetFrom(pair.sch); setNetTo(pair.board); setNetFilter(''); setMessage(''); }}>{T.use}</button></li>)}
            {list(model.diffPins, (row, i) => <li key={`p${i}`}>{row.status === 'net-differs' ? T.pinDiffer(row.ref, row.pinNumber, row.boardNet, row.schematic?.netName ?? '') : T.missingPin(row.ref, row.pinNumber, row.status === 'pin-missing-on-board' ? T.pinMissingBoard : row.status === 'pin-missing-on-schematic' ? T.pinMissingSch : row.status)}</li>)}
          </ul>}
          {(link.pins.truncated || link.nets.truncated) && <p className="wsp-reason">{T.truncated}</p>}
        </section>
      </>}

      <section className="wsp-link-block" aria-labelledby="wsp-link-aliases"><h3 id="wsp-link-aliases">{T.confirmed}</h3>
        {refEntries.length + netEntries.length === 0 ? <p className="empty-caption" data-testid="alias-empty">{T.noAliases}</p> : <ul className="wsp-alias-list" data-testid="alias-list">
          {refEntries.map(([from, to]) => <li key={`r:${from}`} data-kind="refs"><span className="wsp-chip">{T.refAlias}</span><span className="mono">{from}</span><ArrowRight size={12} aria-hidden="true" /><span className="mono">{to}</span>
            {issues('ref', from, to).map(issue => <em key={issue.problem} className="wsp-chip warn" data-testid="alias-issue"><AlertTriangle size={10} />{T.issue(issue)}</em>)}
            <button type="button" className="tool-button" aria-label={T.remove('reference', from, to)} data-testid="alias-remove" onClick={() => remove('refs', from)}><Trash2 size={13} /></button></li>)}
          {netEntries.map(([from, to]) => <li key={`n:${from}`} data-kind="nets"><span className="wsp-chip">{T.netAlias}</span><span className="mono">{from}</span><ArrowRight size={12} aria-hidden="true" /><span className="mono">{to}</span>
            {issues('net', from, to).map(issue => <em key={issue.problem} className="wsp-chip warn" data-testid="alias-issue"><AlertTriangle size={10} />{T.issue(issue)}</em>)}
            <button type="button" className="tool-button" aria-label={T.remove('net', from, to)} data-testid="alias-remove" onClick={() => remove('nets', from)}><Trash2 size={13} /></button></li>)}
        </ul>}
        <p className="settings-hint">{T.removeHint}</p>
      </section>
    </div>
    <div className="modal-footer"><button type="button" className="outline-button" data-testid="link-close" onClick={onClose}>{T.close}</button></div>
  </Modal>;
}
