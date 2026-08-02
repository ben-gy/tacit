// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson
//
// audit.ts — THE MECHANISM AUDIT (principle #21). It re-derives what should have happened from the
// event stream, using constants written out longhand HERE, and counts every disagreement with what
// the game actually did.
//
// It deliberately imports NOTHING from src/. Not cards.ts, not mission.ts, not even the trump
// constant. An audit that calls `trickWinner()` to check `trickWinner()` is a tautology: it stays
// green when the rule it is checking is wrong, which is the exact failure mode this file exists to
// prevent. Every rule below is restated from the printed rules of the game:
//
//   * a card is `suit * 16 + rank`; suits 0-3 are colours and suit 4 is the Pulse, which is trump
//   * you must follow the led suit if you hold it; otherwise anything goes
//   * the highest Pulse wins; if there is no Pulse, the highest card of the LED suit wins
//   * a task is completed when the trick containing its card is won by the crewmate who took it on
//   * a task is failed the moment that trick is won by anybody else
//
// Every counter below is a COUNT OF RULE VIOLATIONS, held at zero tolerance. Not a duration and not
// an average: a duration has no honest threshold (see scrapwall, where the broken and the fixed
// build differed by 0.2s and the metric would have shipped the bug).

import type { Ev } from '../../src/mission';

const AUDIT_TRUMP_SUIT = 4;
const auditSuit = (card: number): number => Math.floor(card / 16);
const auditRank = (card: number): number => card % 16;

/** Restated from the rules, not imported: highest trump, else highest of the led suit. */
function auditWinnerIndex(cards: number[]): number {
  const led = auditSuit(cards[0]);
  let best = 0;
  for (let i = 1; i < cards.length; i++) {
    const cSuit = auditSuit(cards[i]);
    const bSuit = auditSuit(cards[best]);
    const cTrump = cSuit === AUDIT_TRUMP_SUIT;
    const bTrump = bSuit === AUDIT_TRUMP_SUIT;
    if (cTrump && !bTrump) best = i;
    else if (cTrump && bTrump && auditRank(cards[i]) > auditRank(cards[best])) best = i;
    else if (!cTrump && !bTrump && cSuit === led && auditRank(cards[i]) > auditRank(cards[best])) best = i;
  }
  return best;
}

export interface AuditReport {
  /** A crewmate played off-suit while still holding the led suit. Illegal, at zero tolerance. */
  revokes: number;
  /** The game awarded a trick to somebody other than the card that actually won it. */
  misresolvedTricks: number;
  /** The game played a card that was not in that crewmate's hand (or played one twice). */
  phantomCards: number;
  /** The game called a task complete when the winner was not its owner, or vice versa. */
  misjudgedTasks: number;
  /** A task was reported complete on a trick whose cards did not contain its card. */
  taskWithoutCard: number;
  /** The mission ended successfully with a live task still unfinished. */
  falseWins: number;
  /** A trick did not contain exactly one card per crewmate. */
  malformedTricks: number;
  /** Tricks audited, so a zero report cannot be mistaken for "the audit never ran". */
  tricksSeen: number;
  /** Human-readable first offences, for a failing assertion that has to be actionable. */
  notes: string[];
}

export function emptyReport(): AuditReport {
  return {
    revokes: 0,
    misresolvedTricks: 0,
    phantomCards: 0,
    misjudgedTasks: 0,
    taskWithoutCard: 0,
    falseWins: 0,
    malformedTricks: 0,
    tricksSeen: 0,
    notes: [],
  };
}

export function merge(a: AuditReport, b: AuditReport): AuditReport {
  return {
    revokes: a.revokes + b.revokes,
    misresolvedTricks: a.misresolvedTricks + b.misresolvedTricks,
    phantomCards: a.phantomCards + b.phantomCards,
    misjudgedTasks: a.misjudgedTasks + b.misjudgedTasks,
    taskWithoutCard: a.taskWithoutCard + b.taskWithoutCard,
    falseWins: a.falseWins + b.falseWins,
    malformedTricks: a.malformedTricks + b.malformedTricks,
    tricksSeen: a.tricksSeen + b.tricksSeen,
    notes: [...a.notes, ...b.notes].slice(0, 12),
  };
}

/**
 * Audit one mission from its event stream alone. `hands` is the deal as dealt; everything else is
 * rebuilt here, including who held what at every moment.
 */
export function auditMission(events: Ev[], hands: number[][], players: number, label = ''): AuditReport {
  const r = emptyReport();
  const held = hands.map((h) => [...h]);
  const completed = new Set<number>();

  // The task list as drafted. Restating the chain rules here — rather than trusting the game's own
  // `blocked` flag — is the entire point: an audit that cannot see which task is link 2 can only
  // check the easy half of the rules, and will report a clean sweep while the chain logic is wrong.
  const roster = events.find((e) => e.k === 'roster') as Extract<Ev, { k: 'roster' }> | undefined;
  const spec = new Map(roster ? roster.tasks.map((t) => [t.card, t]) : []);
  const tricksTotal = roster ? roster.tricks : 0;
  const owners = new Map<number, number>([...spec].map(([card, t]) => [card, t.owner]));

  let trickCards: number[] = [];
  let trickSeats: number[] = [];

  const note = (s: string): void => {
    if (r.notes.length < 12) r.notes.push(label ? `${label}: ${s}` : s);
  };

  for (const e of events) {
    if (e.k === 'play') {
      const hand = held[e.seat];
      const at = hand.indexOf(e.card);
      if (at < 0) {
        r.phantomCards++;
        note(`seat ${e.seat} played ${e.card}, which was not in its hand`);
      } else {
        if (trickCards.length > 0) {
          const led = auditSuit(trickCards[0]);
          if (auditSuit(e.card) !== led && hand.some((c) => auditSuit(c) === led)) {
            r.revokes++;
            note(`seat ${e.seat} played off-suit while still holding suit ${led}`);
          }
        }
        hand.splice(at, 1);
      }
      trickCards.push(e.card);
      trickSeats.push(e.seat);
      continue;
    }

    if (e.k === 'trick') {
      r.tricksSeen++;
      if (trickCards.length !== players) {
        r.malformedTricks++;
        note(`trick ${e.trick} had ${trickCards.length} cards for ${players} crew`);
      }
      if (trickCards.join(',') !== e.cards.join(',')) {
        r.malformedTricks++;
        note(`trick ${e.trick} reported cards that differ from the ones played`);
      }
      const expected = trickSeats[auditWinnerIndex(trickCards)];
      if (expected !== e.winner) {
        r.misresolvedTricks++;
        note(`trick ${e.trick} went to seat ${e.winner}; the cards say seat ${expected}`);
      }
      // Every live task card sitting in this trick must resolve, and only in one direction. The
      // three ways a task can go wrong, restated: the wrong crewmate took it; a numbered link landed
      // while an earlier link was still open; the finale landed anywhere but the last trick.
      const here = [...owners.keys()].filter((c) => trickCards.includes(c) && !completed.has(c));
      here.sort((a, b) => (spec.get(a)?.order ?? 0) - (spec.get(b)?.order ?? 0));
      let alreadyFailed = here.some((c) => owners.get(c) !== expected);
      for (const card of here) {
        const t = spec.get(card)!;
        const earlierOpen = [...owners.keys()].some((o) => {
          const s = spec.get(o)!;
          return s.order > 0 && s.order < t.order && !completed.has(o);
        });
        const outOfOrder = t.order > 0 && earlierOpen;
        const earlyFinale = t.finale && e.trick !== tricksTotal - 1;
        const shouldSucceed = owners.get(card) === expected && !outOfOrder && !earlyFinale && !alreadyFailed;

        const reported = events.find(
          (x) => x.k === 'task' && x.card === card && x.trick === e.trick,
        ) as Extract<Ev, { k: 'task' }> | undefined;
        if (!reported) {
          // Silence is only allowed once the mission has already ended on an earlier failure in the
          // very same trick — nothing after that is adjudicated.
          if (!alreadyFailed && shouldSucceed) {
            r.misjudgedTasks++;
            note(`task ${card} on trick ${e.trick} was never adjudicated, but the owner won it`);
          }
          continue;
        }
        if (reported.ok !== shouldSucceed) {
          r.misjudgedTasks++;
          note(
            `task ${card} on trick ${e.trick}: game said ${reported.ok ? 'complete' : 'failed'}, rules say ${
              shouldSucceed ? 'complete' : 'failed'
            } (winner seat ${expected}, owner ${owners.get(card)}, link ${t.order}${t.finale ? ', finale' : ''})`,
          );
        }
        if (reported.ok) completed.add(card);
        else alreadyFailed = true;
      }
      trickCards = [];
      trickSeats = [];
      continue;
    }

    if (e.k === 'task' && e.ok) {
      const trick = events.filter((x) => x.k === 'trick') as Array<Extract<Ev, { k: 'trick' }>>;
      const t = trick.find((x) => x.trick === e.trick);
      if (t && !t.cards.includes(e.card)) {
        r.taskWithoutCard++;
        note(`task ${e.card} was called complete on trick ${e.trick}, which never contained it`);
      }
      continue;
    }

    if (e.k === 'end' && e.success) {
      const unfinished = [...owners.keys()].filter((c) => !completed.has(c));
      if (unfinished.length > 0) {
        r.falseWins++;
        note(`mission declared a success with ${unfinished.length} task(s) unfinished`);
      }
    }
  }

  return r;
}

/** Every zero-tolerance counter, so a test can assert the whole set in one line. */
export function violations(r: AuditReport): Record<string, number> {
  return {
    revokes: r.revokes,
    misresolvedTricks: r.misresolvedTricks,
    phantomCards: r.phantomCards,
    misjudgedTasks: r.misjudgedTasks,
    taskWithoutCard: r.taskWithoutCard,
    falseWins: r.falseWins,
    malformedTricks: r.malformedTricks,
  };
}
