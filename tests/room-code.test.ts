/**
 * room-code.test.ts — live-P2P contract gate #1. Every plausible way of typing a code must
 * canonicalise to the exact bytes the invite link carries, or two crewmates silently land in
 * different rooms and each sit alone forever.
 */

import { describe, expect, it } from 'vitest';
import { normalizeRoomCode } from '@ben-gy/game-engine/lobby';

const CANON = 'K7QM';

describe('a hand-typed code reaches the same room as the link', () => {
  const typings: Array<[string, string]> = [
    ['exactly as printed', 'K7QM'],
    ['lower case (the phone keyboard default)', 'k7qm'],
    ['mixed case', 'k7Qm'],
    ['leading and trailing whitespace', '  K7QM  '],
    ['read aloud with a dash', 'K7-QM'],
    ['spaced out for legibility', 'K 7 Q M'],
    ['lower case with dashes and spaces at once', ' k7-q m '],
    ['pasted with a stray newline', 'K7QM\n'],
    ['pasted with a tab', '\tk7qm'],
  ];

  for (const [why, raw] of typings) {
    it(`${why}: ${JSON.stringify(raw)} -> ${CANON}`, () => {
      expect(normalizeRoomCode(raw)).toBe(CANON);
    });
  }

  it('all of them agree with each other, not just with the constant', () => {
    const results = new Set(typings.map(([, raw]) => normalizeRoomCode(raw)));
    expect(results.size, `${[...results].join(', ')} — these are different rooms`).toBe(1);
  });
});

describe('the canonical form is a fixed point', () => {
  it('normalising twice is the same as normalising once', () => {
    for (const raw of ['k7qm', ' K7-QM ', 'abcd', 'ZZ99', '', 'a b c d e f g h i j']) {
      const once = normalizeRoomCode(raw);
      expect(normalizeRoomCode(once), `not idempotent for ${JSON.stringify(raw)}`).toBe(once);
    }
  });
});

describe('what it strips, and what it must not', () => {
  it('drops punctuation and separators entirely', () => {
    expect(normalizeRoomCode('K7.Q,M!')).toBe(CANON);
  });
  it('drops non-ASCII rather than passing bytes a room id cannot carry', () => {
    expect(normalizeRoomCode('K7QMé')).toBe(CANON);
    expect(normalizeRoomCode('K7QM✨')).toBe(CANON);
  });
  it('keeps digits — the alphabet is alphanumeric, not letters', () => {
    expect(normalizeRoomCode('2345')).toBe('2345');
  });
  it('returns empty for input with nothing usable in it, rather than throwing', () => {
    expect(normalizeRoomCode('---')).toBe('');
    expect(normalizeRoomCode('   ')).toBe('');
    expect(normalizeRoomCode('')).toBe('');
  });
});
