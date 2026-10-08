import { describe, expect, it } from 'vitest';
import { supportIsActive } from './support-status';

describe('verified support visibility', () => {
  it('the popup and heart are suppressed only before the confirmed receipt expires', () => {
    const paid = { status: 'verified' as const, expiresAt: 1000, available: true };
    expect(supportIsActive(paid, 999)).toBe(true);
    expect(supportIsActive(paid, 1000)).toBe(false);
    for (const status of ['inactive', 'pending', 'unavailable'] as const) expect(supportIsActive({ ...paid, status }, 999)).toBe(false);
    expect(supportIsActive(null, 999)).toBe(false);
    expect(supportIsActive({ ...paid, expiresAt: NaN }, 999)).toBe(false);
  });
});
