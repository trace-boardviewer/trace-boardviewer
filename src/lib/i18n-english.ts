/**
 * English is the type source of the message keys (`MessageKey` in ./i18n.ts is `keyof typeof en`) and the runtime English
 * catalog. The catalogs are namespace files, `electron/locales/<language>/<namespace>.json`: one import per file of
 * `electron/locales/en/`, merged below. Adding a namespace means adding its eight files and one line to each of the two
 * lists here; `src/lib/i18n-layout.test.ts` fails with a message when a file of `en/` is not listed. The other seven languages
 * need no registration: ./i18n.ts loads them with a glob and the tests require them to have exactly the English keys.
 */
import app from '../../electron/locales/en/app.json';
import board from '../../electron/locales/en/board.json';
import common from '../../electron/locales/en/common.json';
import dialogs from '../../electron/locales/en/dialogs.json';
import diagnostic from '../../electron/locales/en/diagnostic.json';
import documents from '../../electron/locales/en/documents.json';
import formats from '../../electron/locales/en/formats.json';
import kinds from '../../electron/locales/en/kinds.json';
import native from '../../electron/locales/en/native.json';
import network from '../../electron/locales/en/network.json';
import notes from '../../electron/locales/en/notes.json';
import pdf from '../../electron/locales/en/pdf.json';
import schematic from '../../electron/locales/en/schematic.json';
import settings from '../../electron/locales/en/settings.json';
import support from '../../electron/locales/en/support.json';
import workspace from '../../electron/locales/en/workspace.json';

export const en = {
  ...app, ...board, ...common, ...dialogs, ...diagnostic, ...documents, ...formats, ...kinds, ...native,
  ...network, ...notes, ...pdf, ...schematic, ...settings, ...support, ...workspace,
};
