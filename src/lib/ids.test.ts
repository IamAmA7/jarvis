import { describe, expect, it } from 'vitest';
import { makeId } from './ids';

describe('makeId', () => {
  it('respects the prefix', () => {
    expect(makeId('s_')).toMatch(/^s_/);
    expect(makeId('chunk-')).toMatch(/^chunk-/);
  });

  it('returns unique values across calls', () => {
    const set = new Set<string>();
    for (let i = 0; i < 500; i++) set.add(makeId('x_'));
    expect(set.size).toBe(500);
  });

  it('uses a time-ish prefix after the explicit prefix', () => {
    const id = makeId('s_');
    // chars 2..N should be base36 — matches [0-9a-z]
    expect(id.slice(2)).toMatch(/^[0-9a-z]+$/);
  });
});
