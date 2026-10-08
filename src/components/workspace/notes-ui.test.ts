import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { WorkspaceApi } from '../../app/api';
import { createStatusStore } from '../../app/statusStore';
import { LANGUAGES, catalogs, createFormatters, createTranslator, renderMessage } from '../../lib/i18n';
import type { Language, MessageKey } from '../../lib/i18n';
import type { Board, BoardComponent, BoardNote, BoardPin } from '../../lib/types';
import { noteKeyIndex } from '../../lib/note-keys';
import { FALLBACK_TEXT, PROBLEM_TEXT, REFUSAL_TEXT, describeKey, describeNoteTarget } from './note-text';
import { NotesSection } from './InspectorSections';
import { StatusBar } from './StatusBar';
import { UnresolvedNotesList } from './UnresolvedNotes';
import { UiContext } from './ui-context';
import type { UiContextValue } from './ui-context';

const T0 = '2026-10-05T10:00:00.000Z';
const decode = (html: string): string => html.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const catalog = (lang: Language, key: string): string => (catalogs[lang] as Record<string, string>)[key];
const uiFor = (lang: Language): UiContextValue => ({ t: createTranslator(lang), fmt: createFormatters(lang), language: lang, text: message => renderMessage(lang, message), copy: () => {} });
const withUi = (lang: Language, element: ReturnType<typeof createElement>) => renderToStaticMarkup(createElement(UiContext.Provider, { value: uiFor(lang) }, element));

interface PartSpec { ref: string; at: [number, number]; generated?: boolean; pads?: Array<{ number: string; at?: [number, number]; generated?: boolean }> }
function board(specs: PartSpec[]): Board {
  const components: BoardComponent[] = [], pins: BoardPin[] = [];
  specs.forEach((spec, index) => {
    const id = `part:${index}`, pinIds: string[] = [];
    (spec.pads ?? []).forEach((pad, padIndex) => {
      const pinId = `pin:${pins.length}`;
      pinIds.push(pinId);
      pins.push({ id: pinId, componentId: id, number: pad.number, ...(pad.generated ? { numberGenerated: true as const } : {}), name: '', net: '', side: 'top', radius: 0.2, shape: 'round', x: pad.at?.[0] ?? spec.at[0] + padIndex, y: pad.at?.[1] ?? spec.at[1] });
    });
    components.push({ id, ref: spec.ref, ...(spec.generated ? { refGenerated: true as const } : {}), value: '', package: '', side: 'top', bounds: { minX: 0, minY: 0, maxX: 1, maxY: 1 }, position: { x: spec.at[0], y: spec.at[1] }, rotation: 0, pinIds, outline: [] });
  });
  return { name: 'synthetic', format: 'test', units: 'mm', components, pins, nets: [], outline: [], bounds: { minX: 0, minY: 0, maxX: 1, maxY: 1 }, warnings: [] };
}
const apiOf = (state: Partial<WorkspaceApi['state']>) => ({ state: { notesBlocked: null, ...state }, actions: { removeNote: async () => {}, retryNotes: async () => {} } }) as unknown as WorkspaceApi;

describe('the catalogs carry every string of the notes UI in all eight languages', () => {
  const keys = new Set<MessageKey>([...Object.values(FALLBACK_TEXT), ...Object.values(REFUSAL_TEXT), ...Object.values(PROBLEM_TEXT),
    'notes.unresolvedTitle', 'notes.unresolvedIntro', 'notes.unresolvedEmpty', 'notes.wasAttachedTo', 'notes.targetPart', 'notes.copyText',
    'notes.measureVoltage', 'notes.measureResistance', 'notes.measureOther', 'toast.notesUnresolved', 'toast.notesUpdateFailed'] as MessageKey[]);
  it.each(LANGUAGES)('%s: every key has its own, non-empty text (nothing falls back to another language or to the key)', lang => {
    for (const key of keys) {
      const text = catalog(lang, key);
      expect(typeof text, key).toBe('string');
      expect(text.length, key).toBeGreaterThanOrEqual(3);
      expect(createTranslator(lang)(key), key).toBe(text);
    }
  });
  it('every problem, fallback and refusal the library can report has a text', () => {
    expect(Object.keys(PROBLEM_TEXT).sort()).toEqual(['component-ambiguous', 'component-missing', 'duplicate-target', 'legacy-id-missing', 'legacy-indistinguishable', 'pin-ambiguous', 'pin-missing']);
    expect(Object.keys(FALLBACK_TEXT).sort()).toEqual(['duplicate-reference', 'unnamed-part', 'unnamed-pin']);
    expect(Object.keys(REFUSAL_TEXT).sort()).toEqual(['part-indistinguishable', 'pin-indistinguishable']);
    expect(new Set([...Object.values(PROBLEM_TEXT), ...Object.values(FALLBACK_TEXT), ...Object.values(REFUSAL_TEXT)]).size).toBe(12);
  });
});

describe('describing a note target', () => {
  const t = createTranslator('en'), fmt = createFormatters('en');
  it('says part, pin and position in words, and shows a positional id as it was saved', () => {
    expect(describeKey({ ref: 'U7' }, t, fmt)).toBe('Component U7');
    expect(describeKey({ ref: 'U7', pin: '3' }, t, fmt)).toBe('Component U7 · Pin 3');
    expect(describeKey({ ref: 'R1', at: { side: 'top', x: 12.5, y: -8.25 } }, t, fmt)).toBe(`Component R1 (Position ${fmt.mm(12.5)} · ${fmt.mm(-8.25)} mm, Top)`);
    expect(describeKey({ at: { side: 'bottom', x: 1, y: 2 }, pinAt: { side: 'both', x: 3, y: 4 } }, t, fmt)).toBe(`Component (Position ${fmt.mm(1)} · ${fmt.mm(2)} mm, Bottom) · Pin (Position ${fmt.mm(3)} · ${fmt.mm(4)} mm, Both)`);
    const legacy: BoardNote = { id: 'n', componentId: 'part:12', pinId: 'pin:341', text: 'x', updatedAt: T0 };
    expect(describeNoteTarget(legacy, t, fmt)).toBe('Component part:12 · Pin pin:341');
    expect(describeNoteTarget({ id: 'n', componentId: 'part:12', text: 'x', updatedAt: T0 }, t, fmt)).toBe('Component part:12');
  });
});

describe('the unresolved notes list', () => {
  const b = board([{ ref: 'R1', at: [1, 1], pads: [{ number: '1' }] }, { ref: 'U1', at: [4, 1], pads: [{ number: '1' }, { number: '2' }] }]);
  const notes: BoardNote[] = [
    { id: 'keep', target: { ref: 'U1' }, text: 'attached, so not listed', updatedAt: T0 },
    { id: 'a', componentId: 'part:42', pinId: 'pin:7', text: 'Replaced <b>C12</b> & rechecked', measurements: { voltage: '3.3 V', resistance: '4.7 k', other: 'warm' }, updatedAt: T0, unresolved: { reason: 'legacy-id-missing', at: T0 } },
    { id: 'b', target: { ref: 'C77', pin: '2' }, text: 'on a part the board does not have', updatedAt: T0 },
    { id: 'c', target: { ref: 'U1', pin: '9' }, text: '', measurements: { other: 'only a measurement' }, updatedAt: T0 },
    { id: 'd', componentId: 'part:3', text: 'two notes wanted the same pin', updatedAt: T0, unresolved: { reason: 'duplicate-target', at: T0 } },
  ];
  const api = apiOf({ board: b, notes });

  it.each(LANGUAGES)('%s: every unresolved note shows its old target, the reason and its text, and can be copied and deleted, all in the catalog language', lang => {
    const html = withUi(lang, createElement(UnresolvedNotesList, { api }));
    const items = html.split('data-testid="unresolved-note"').slice(1);
    expect(items).toHaveLength(4);
    const target = (item: string) => decode(/data-testid="unresolved-target">([^<]*)</.exec(item)![1]);
    const reason = (item: string) => decode(/data-testid="unresolved-reason">([^<]*)</.exec(item)![1]);
    expect(items.map(target)).toEqual([
      `${catalog(lang, 'notes.targetPart')} part:42 · ${catalog(lang, 'inspector.colPin')} pin:7`, `${catalog(lang, 'notes.targetPart')} C77 · ${catalog(lang, 'inspector.colPin')} 2`,
      `${catalog(lang, 'notes.targetPart')} U1 · ${catalog(lang, 'inspector.colPin')} 9`, `${catalog(lang, 'notes.targetPart')} part:3`,
    ]);
    expect(items.map(reason)).toEqual([catalog(lang, 'notes.reasonLegacyIdMissing'), catalog(lang, 'notes.reasonComponentMissing'), catalog(lang, 'notes.reasonPinMissing'), catalog(lang, 'notes.reasonDuplicateTarget')]);
    for (const item of items) {
      expect(decode(item)).toContain(`aria-label="${catalog(lang, 'notes.copyText')}"`);
      expect(decode(item)).toContain(`aria-label="${catalog(lang, 'common.delete')}"`);
      expect(item).toContain('data-testid="unresolved-copy"');
      expect(item).toContain('data-testid="unresolved-delete"');
    }
    expect(decode(items[0])).toContain(`<dt>${catalog(lang, 'notes.measureVoltage')}</dt>`);
    expect(decode(items[0])).toContain(`<dt>${catalog(lang, 'notes.measureResistance')}</dt>`);
    expect(decode(items[2])).toContain(`<dt>${catalog(lang, 'notes.measureOther')}</dt><dd class="mono">only a measurement</dd>`);
    expect(html).not.toContain('attached, so not listed');
    expect(decode(html)).toContain(catalog(lang, 'notes.wasAttachedTo'));
  });

  it('the note text is shown as text, never as markup', () => {
    const html = withUi('en', createElement(UnresolvedNotesList, { api }));
    expect(html).toContain('Replaced &lt;b&gt;C12&lt;/b&gt; &amp; rechecked');
    expect(html).not.toContain('<b>C12</b>');
    expect(decode(/data-testid="unresolved-text">([^<]*)</.exec(html)![1])).toBe('Replaced <b>C12</b> & rechecked');
  });

  it.each(LANGUAGES)('%s: with nothing unresolved the list says so', lang => {
    const html = withUi(lang, createElement(UnresolvedNotesList, { api: apiOf({ board: b, notes: [notes[0]] }) }));
    expect(html).toContain('data-testid="unresolved-empty"');
    expect(decode(html)).toContain(catalog(lang, 'notes.unresolvedEmpty'));
    expect(html).not.toContain('data-testid="unresolved-note"');
  });
});

describe('the notes section of the inspector discloses how a note is bound', () => {
  const b = board([
    { ref: 'R1', at: [1, 1], pads: [{ number: '1' }, { number: '2' }] }, { ref: 'C5', at: [3, 1], pads: [{ number: '1' }] }, { ref: 'C5', at: [6, 1], pads: [{ number: '1' }] },
    { ref: '#1', at: [9, 1], generated: true, pads: [{ number: '1' }] }, { ref: 'J1', at: [12, 1], pads: [{ number: '~1', generated: true, at: [12, 2] }, { number: '', at: [14, 2] }, { number: '', at: [14, 2] }] },
    { ref: 'TP', at: [20, 1] }, { ref: 'TP', at: [20, 1] },
  ]);
  const section = (lang: Language, componentId: string, pinId: string | null, notes: BoardNote[] = []) => {
    const component = b.components.find(c => c.id === componentId)!, pin = pinId ? b.pins.find(p => p.id === pinId)! : null;
    return withUi(lang, createElement(NotesSection, { api: apiOf({ board: b, notes }), componentRef: component.ref, componentId, pinId, pinNumber: pin?.number ?? null, onEdit: () => {} }));
  };
  const captions = (html: string) => [...html.matchAll(/data-testid="note-fallback">([^<]*)</g)].map(match => decode(match[1]));

  it('a part and a pin the file names uniquely carry no caption and offer to add a note', () => {
    const html = section('en', 'part:0', 'pin:1');
    expect(captions(html)).toEqual([]);
    expect([...html.matchAll(/data-testid="add-note"/g)]).toHaveLength(2);
    expect(html).not.toContain('data-testid="note-refused"');
  });

  it.each(LANGUAGES)('%s: duplicate reference, unnamed part and unnumbered pad each say how the note is bound', lang => {
    expect(captions(section(lang, 'part:1', null))).toEqual([catalog(lang, 'notes.fallbackDuplicateRef')]);
    expect(captions(section(lang, 'part:3', null))).toEqual([catalog(lang, 'notes.fallbackUnnamedPart')]);
    expect(captions(section(lang, 'part:3', 'pin:4'))).toEqual([catalog(lang, 'notes.fallbackUnnamedPart'), catalog(lang, 'notes.fallbackUnnamedPart')]);
    expect(captions(section(lang, 'part:4', 'pin:5'))).toEqual([catalog(lang, 'notes.fallbackUnnamedPin')]);
  });

  it.each(LANGUAGES)('%s: a part or pin that cannot be told apart offers no note and says why', lang => {
    const part = section(lang, 'part:5', null);
    expect(decode(part)).toContain(catalog(lang, 'notes.refusePart'));
    expect(part).toContain('data-testid="note-refused"');
    expect(part).not.toContain('data-testid="add-note"');
    const pin = section(lang, 'part:4', 'pin:6');
    expect(decode(pin)).toContain(catalog(lang, 'notes.refusePin'));
    expect([...pin.matchAll(/data-testid="add-note"/g)]).toHaveLength(1);
  });

  it('an existing note on an anchored part shows the caption inside its card', () => {
    const target = noteKeyIndex(b).target('part:1');
    if (!target.ok) throw new Error('no target');
    const html = section('en', 'part:1', null, [{ id: 'n', target: target.key, text: 'bulged', updatedAt: T0 }]);
    expect(html).toContain('data-testid="note-card"');
    expect(html).toContain('bulged');
    expect(captions(html)).toEqual([catalog('en', 'notes.fallbackDuplicateRef')]);
    expect(html).not.toContain('data-testid="add-note"');
  });
});

describe('the status bar entry for unresolved notes', () => {
  const render = (lang: Language, unresolvedNotes: number) => withUi(lang, createElement(StatusBar, {
    store: createStatusStore(), fmt: createFormatters(lang), t: createTranslator(lang), counts: { components: 2, pins: 3, nets: 1 }, warnings: 0,
    save: { dirty: false, saving: false, failure: null }, persistence: 'native', breadcrumb: '', unresolvedNotes, onInfo: () => {}, onHelp: () => {}, onUnresolvedNotes: () => {},
  }));
  it('shows nothing without unresolved notes', () => {
    expect(render('en', 0)).not.toContain('unresolved-notes-button');
  });
  it.each(LANGUAGES)('%s: a labelled button with the count appears when notes are unresolved', lang => {
    const html = render(lang, 3);
    const label = `${catalog(lang, 'notes.unresolvedTitle')}: 3`;
    expect(decode(html)).toContain(`aria-label="${label}"`);
    expect(decode(html)).toContain(`title="${label}"`);
    expect(html).toMatch(/data-testid="unresolved-notes-button"[^>]*>(?:<svg[\s\S]*?<\/svg>)<span class="mono">3<\/span>/);
  });
});
