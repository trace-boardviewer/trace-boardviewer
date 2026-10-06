import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { savedSettings, defaults } from './settings';

/**
 * Renderer-side settings normalization (the browser-only dev mode keeps the same object in localStorage, and the desktop app runs whatever the main process
 * returns through it). The main process validates the same field in electron/main.cjs; tests/desktop-checks.cjs covers that half.
 */
beforeEach(() => { vi.stubGlobal('navigator', { languages: ['en-US'] }); });
afterEach(() => { vi.unstubAllGlobals(); });

const stored = { language: 'de', theme: 'light', layout: 'focus', motion: false, showLabels: false, showConnections: false };

describe('updateCheck', () => {
  it('is on by default, in the defaults and for a fresh profile', () => {
    expect(defaults.updateCheck).toBe(true);
    expect(savedSettings({}, true).updateCheck).toBe(true);
    expect(savedSettings(undefined).updateCheck).toBe(true);
    expect(savedSettings(null).updateCheck).toBe(true);
  });

  it('a profile saved before this release has no such field and gets true; every other stored setting is kept', () => {
    expect(savedSettings(stored)).toEqual({ ...stored, updateCheck: true });
  });

  it('a stored boolean is kept, true and false alike', () => {
    expect(savedSettings({ ...stored, updateCheck: false })).toEqual({ ...stored, updateCheck: false });
    expect(savedSettings({ ...stored, updateCheck: true })).toEqual({ ...stored, updateCheck: true });
  });

  it('a damaged stored value falls back to true WITHOUT resetting the other settings', () => {
    for (const bad of ['false', 'true', 'yes', 0, 1, null, [], {}, NaN]) {
      expect(savedSettings({ ...stored, updateCheck: bad }), String(JSON.stringify(bad))).toEqual({ ...stored, updateCheck: true });
    }
  });

  it('a damaged value elsewhere does not touch it (each field is checked on its own)', () => {
    expect(savedSettings({ ...stored, theme: 'purple', motion: 'yes', updateCheck: false })).toEqual({ ...stored, theme: 'dark', motion: true, updateCheck: false });
  });

  it('a stored value that is not an object at all gives the defaults, update check included', () => {
    for (const value of ['text', 42, [], [{ updateCheck: false }], true]) {
      expect(savedSettings(value).updateCheck, JSON.stringify(value)).toBe(true);
    }
  });

  it('the settings object has exactly the six old fields plus updateCheck', () => {
    expect(Object.keys(savedSettings({})).sort()).toEqual(['language', 'layout', 'motion', 'showConnections', 'showLabels', 'theme', 'updateCheck']);
  });

  it('main.cjs and the renderer agree on the default (on)', () => {
    const main = readFileSync(new URL('../../../electron/main.cjs', import.meta.url), 'utf8');
    expect(main).toMatch(/DEFAULT_SETTINGS = Object\.freeze\(\{[^}]*updateCheck: true[^}]*\}\)/);
  });
});
