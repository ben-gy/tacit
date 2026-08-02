/**
 * mechanism.test.ts — principle #21. A co-op sim measures OUTCOMES, and a broken rule just shifts
 * the outcome, so the difficulty curve cannot tell you the rules work. These assertions audit the
 * event stream from OUTSIDE, at zero tolerance, with every rule restated from first principles in
 * tests/helpers/audit.ts (which imports nothing from src/).
 *
 * Two traps this file deliberately avoids, both of which have shipped bugs elsewhere in the fleet:
 * nothing drains the event array before the audit runs, and every metric is a COUNT OF VIOLATIONS
 * rather than a duration or an average — a count can carry a zero bound, an average cannot.
 *
 * The mutation check at the bottom is the part that proves the audit has teeth.
 */

import { describe, expect, it } from 'vitest';
import { runMission } from './helpers/sim';
import { auditMission, emptyReport, merge, violations, type AuditReport } from './helpers/audit';
import { MODE_IDS } from '../src/modes';
import { trickWinner } from '../src/cards';

function sweep(): AuditReport {
  let total = emptyReport();
  for (const mode of MODE_IDS) {
    for (const players of [2, 3, 4, 5]) {
      for (const mission of [1, 3, 6, 9, 12, 16]) {
        for (let i = 0; i < 6; i++) {
          const seed = 4242 + i * 104_729 + mission * 7919;
          const r = runMission(mode, mission, players, seed);
          total = merge(total, auditMission(r.events, r.hands, players, `${mode}/${players}P/m${mission}/s${i}`));
        }
      }
    }
  }
  return total;
}

describe('the rules of the game hold, every trick, every mission', () => {
  const report = sweep();

  it('audited a real number of tricks — a zero report must not mean the audit never ran', () => {
    expect(report.tricksSeen).toBeGreaterThan(2000);
  });

  it('every zero-tolerance invariant is at zero', () => {
    expect(violations(report), report.notes.join('\n')).toEqual({
      revokes: 0,
      misresolvedTricks: 0,
      phantomCards: 0,
      misjudgedTasks: 0,
      taskWithoutCard: 0,
      falseWins: 0,
      malformedTricks: 0,
    });
  });
});

describe('the audit has teeth — a broken rule must turn it red', () => {
  /**
   * The mutation test the whole file rests on. `trickWinner` is re-implemented here with a single
   * deliberate defect (the Pulse no longer trumps), the audit is run against a stream produced under
   * that defect, and it must FIND it. Without this, "0 violations" only proves the audit is silent.
   */
  it('a trick resolved by the wrong rule is caught', () => {
    let mutated = 0;
    let caughtTotal = 0;
    let missionsUsed = 0;

    for (let s = 0; s < 12; s++) {
      const r = runMission('aside', 6, 4, 20_260_802 + s * 104_729);
      const events = r.events.map((e) => ({ ...e }));
      let here = 0;
      for (const e of events) {
        if (e.k !== 'trick') continue;
        // Re-award the trick as if a Pulse were an ordinary colour: highest of the led suit wins.
        const led = Math.floor(e.cards[0] / 16);
        let best = 0;
        for (let i = 1; i < e.cards.length; i++) {
          if (Math.floor(e.cards[i] / 16) === led && e.cards[i] % 16 > e.cards[best] % 16) best = i;
        }
        const wrong = (e.lead + best) % 4;
        if (wrong !== e.winner) {
          e.winner = wrong;
          here++;
        }
      }
      if (here === 0) continue;
      missionsUsed++;
      mutated += here;
      caughtTotal += auditMission(events, r.hands, 4, 'mutated').misresolvedTricks;
    }

    expect(missionsUsed, 'no sampled mission had a Pulse decide a trick, so nothing was demonstrated').toBeGreaterThan(0);
    expect(caughtTotal, `mutated ${mutated} trick winners and the audit noticed none`).toBe(mutated);
  });

  it('a chain completed OUT OF ORDER is caught — the rule the audit exists for', () => {
    // Hand-built: two links, and the crew lands link 2 first. Link 1 is still open, so the game must
    // fail the mission — and the audit must independently agree, from the roster alone.
    const hands = [
      [0x11, 0x12],
      [0x01, 0x02],
    ];
    const events: Parameters<typeof auditMission>[0] = [
      {
        k: 'roster',
        tasks: [
          { card: 0x01, owner: 1, order: 1, finale: false },
          { card: 0x02, owner: 1, order: 2, finale: false },
        ],
        tricks: 2,
      },
      { k: 'play', seat: 0, card: 0x12, trick: 0 },
      { k: 'play', seat: 1, card: 0x02, trick: 0 },
      { k: 'trick', trick: 0, lead: 0, cards: [0x12, 0x02], winner: 1 },
      // The game correctly refuses this. An audit told it SUCCEEDED must object.
      { k: 'task', card: 0x02, owner: 1, ok: true, trick: 0 },
    ];
    expect(auditMission(events, hands, 2, 'handmade').misjudgedTasks).toBe(1);
  });

  it('a card played from nowhere is caught', () => {
    const r = runMission('aside', 4, 3, 555_001);
    const events = r.events.map((e) => ({ ...e }));
    const play = events.find((e) => e.k === 'play') as Extract<(typeof events)[number], { k: 'play' }>;
    play.card = 0x4f; // a rank that exists in no deck
    expect(auditMission(events, r.hands, 3, 'mutated').phantomCards).toBeGreaterThan(0);
  });

  it('a revoke — following off-suit while holding the led suit — is caught', () => {
    // Build the stream by hand so the revoke is unambiguous: seat 1 holds the led colour and dodges.
    const hands = [
      [0x01, 0x02],
      [0x11, 0x03],
      [0x12, 0x04],
    ];
    const events: Parameters<typeof auditMission>[0] = [
      { k: 'play', seat: 0, card: 0x01, trick: 0 },
      { k: 'play', seat: 1, card: 0x11, trick: 0 },
      { k: 'play', seat: 2, card: 0x12, trick: 0 },
      { k: 'trick', trick: 0, lead: 0, cards: [0x01, 0x11, 0x12], winner: 0 },
    ];
    // BOTH followers held the led colour and dodged it, so there are two revokes here, not one.
    expect(auditMission(events, hands, 3, 'handmade').revokes).toBe(2);
  });

  it('the audit and the shipped resolver agree on a large random sample of tricks', () => {
    // Independent implementations, same answers. If they ever diverge, one of them is wrong and the
    // sweep above would be checking the game against itself.
    let checked = 0;
    let s = 12_345;
    const next = (): number => {
      s = (s * 1_664_525 + 1_013_904_223) >>> 0;
      return s / 4_294_967_296;
    };
    for (let i = 0; i < 4000; i++) {
      const n = 2 + Math.floor(next() * 4);
      const cards = Array.from({ length: n }, () => {
        const suit = Math.floor(next() * 5);
        const top = suit === 4 ? 4 : 9;
        return suit * 16 + (1 + Math.floor(next() * top));
      });
      if (new Set(cards).size !== cards.length) continue;
      const shipped = trickWinner(cards);
      const led = Math.floor(cards[0] / 16);
      let best = 0;
      for (let k = 1; k < cards.length; k++) {
        const cT = Math.floor(cards[k] / 16) === 4;
        const bT = Math.floor(cards[best] / 16) === 4;
        if (cT && !bT) best = k;
        else if (cT && bT && cards[k] % 16 > cards[best] % 16) best = k;
        else if (!cT && !bT && Math.floor(cards[k] / 16) === led && cards[k] % 16 > cards[best] % 16) best = k;
      }
      expect(shipped, `disagreed on [${cards.join(', ')}]`).toBe(best);
      checked++;
    }
    expect(checked).toBeGreaterThan(3000);
  });
});
