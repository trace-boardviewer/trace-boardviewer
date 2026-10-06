# Contributing to TRACE

Small, focused contributions are welcome. Describe the observable problem and the resulting behavior. For import bugs, include a minimal synthetic example and the expected units, side, coordinates, pad shape or net relationship.

## Local workflow

1. Install Node.js 24+ and the pnpm version declared in `package.json`.
2. Run `pnpm install --frozen-lockfile` and `pnpm setup:electron`.
3. Start the desktop UI with `pnpm dev:desktop`. Use `--user-data-dir=<absolute-path>` for an isolated development profile.
4. Run `pnpm test`, `pnpm test:desktop` and `pnpm build` before submitting a change.
5. For renderer work, check top/bottom selection, labels, net highlighting, pan/zoom, both layouts and both themes. Use `pnpm qa:races` for async UI regressions; real-board QA is described in the README.

Keep formatting and naming consistent with adjacent code. Add tests for geometry, parsing, persistence and meaningful regressions. Keep UI work responsive on boards with thousands of components and on nets with thousands of pins.

## Board formats and sample data

Every new importer needs a documented format variant and synthetic fixtures covering units, rotation, mirroring, sides, pad geometry and net membership. Report approximations explicitly. Logical connection lines must not be described as copper traces.

Keep customer boards, schematics, measurements, notes and identifying screenshots out of the repository. Use a public sample only when you have redistribution rights; document its source and license. The `.gitignore` excludes common board files by default. A synthetic fixture intended for publication may be added deliberately after review.

## Adding or improving a translation

TRACE speaks Hungarian (`hu`), English (`en`), German (`de`), French (`fr`), Italian (`it`), Slovak (`sk`), Polish (`pl`) and Ukrainian (`uk`). The interface (`src/lib/i18n.ts`) and the native shell (`electron/i18n.cjs`: file dialogs and error messages) read the same catalogs, `electron/locales/<lang>.json`, with identical lookup, plural and interpolation rules.

- **Keys.** `en.json` and `hu.json` are the complete reference catalogs. Keys are semantic (`unit.pins`, `parse.error.empty`, `native.dialog.openTitle`), never the English wording, so improving a text never renames a key. Every catalog has exactly the keys of `en.json`.
- **Values.** A value is a string, or a plural object for counts, for example `{ "one": "{count} pin", "other": "{count} pins" }`. The form is chosen with the CLDR rules of the language from `params.count`, so list every category the language uses for whole numbers and always `other`: English, German, French, Italian `one`, `other`; Slovak `one`, `few`, `other`; Polish and Ukrainian `one`, `few`, `many`, `other`. Every plural form must contain `{count}`. Hungarian may use a plain string.
- **Placeholders.** Copy `{name}` placeholders exactly; do not translate, rename, add or drop them. Numbers passed as parameters are formatted for the language automatically. The literal `$` in `$END{section}` and `${section}` is part of the GENCAD syntax and stays.
- **Fixed tokens.** Keep `mm`, `MB`, `GENCAD`, `TRACE`, `.cad`, `.gcd`, version numbers and GENCAD record keywords (`PIN`, `PADSTACK`, `SHAPE`, ...) as they are, in Latin letters in every language. Do not translate or invent board data.
- **Writing.** Use the language's own alphabet and typographic conventions, and end a text with the same punctuation as the English one. Keep texts short enough for the 960 x 640 minimum window; German, French, Polish and Slovak are the longest.
- **Check.** Run `pnpm test`. `src/lib/i18n.test.ts` checks key and placeholder parity, plural completeness, leftover English or Hungarian, alphabets, fixed tokens and native/web parity. When a text is identical to English on purpose (a cognate such as "Format", or EDA jargon such as "Pin"), add it with a short reason to the allow-list in that test.
- **Review.** Describe the context of the texts you changed, ask a native speaker to review, and do not submit unreviewed machine translation. Switch the language in Settings and look at the screen before submitting.

To add a language, create `electron/locales/<lang>.json` with all keys, then register the code in `LANGUAGES`, `LANGUAGE_NAMES`, `LOCALE_TAGS` and the catalog import in `src/lib/i18n.ts`, in `LANGUAGES`, `LOCALE_TAGS` and `catalogs` in `electron/i18n.cjs`, and in the README language table.

## Pull requests and issues

Include the affected platform, TRACE version, reproduction steps, expected result and checks performed. Avoid private board paths or data in logs. If a sample cannot be shared, provide the smallest synthetic case that demonstrates the problem.

Contributions to the original project code are made under the project's MIT license. Keep third-party notices intact when changing bundled assets or dependencies.
