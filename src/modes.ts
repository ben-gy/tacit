// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// See ADDITIONAL-TERMS.md for the section 7(b) attribution requirement.
//
// Tacit — the three modes and the mission ladder. A mode has to change how the game PLAYS, not just
// a number, so the axis here is the two things that actually govern a trick-taking co-op: HOW MUCH
// YOU MAY SAY, and WHAT SHAPE the tasks are in.
//
//   Signals   1 signal each, tasks mostly loose      — the base game: read your crew, then commit.
//   Blackout  0 signals, tasks always loose          — nobody may say anything, ever. You deduce the
//                                                      whole table from the cards that hit it.
//   Chain     2 signals, EVERY task numbered         — the verb inverts: most of the round is spent
//                                                      DODGING cards you desperately want.
//
// The HOST's pick travels frozen inside rematch.ts's round start, together with the rung of the
// ladder the crew has reached, so two peers can never be playing different missions. modeOf() guards
// an id off the wire with Object.hasOwn — a bare `MODES[id] ||` lets 'constructor' through as a Mode
// of undefined fields.

import { handSize } from './cards';

export interface Mode {
  id: string;
  name: string;
  blurb: string;
  /** Signals each crewmate may spend per mission. Zero means the comms panel never appears. */
  signals: number;
  /**
   * How task order tokens are handed out.
   *   'none'   never — every task is loose (Blackout).
   *   'ladder' loose early, a growing numbered chain later (Signals).
   *   'all'    every task is a link in one chain, from mission 1 (Chain).
   */
  ordering: 'none' | 'ladder' | 'all';
}

/**
 * The ids are theatre, and they are also the only ones that were free: `signals`, `blackout` and
 * `chain` are ALL already mode ids in the shipped fleet, and a duplicate id is how two games end up
 * sharing a saved setting. Checked before the names went anywhere near the UI.
 */
export const MODES: Record<string, Mode> = {
  aside: {
    id: 'aside',
    name: 'Aside',
    blurb: 'One signal each, and tasks that start loose and end up chained. Show a card as your highest, lowest or only of its colour — then never mention it again.',
    signals: 1,
    ordering: 'ladder',
  },
  hush: {
    id: 'hush',
    name: 'Hush',
    blurb: 'No signals, ever. Tasks stay loose, and everything you know about your crew you read off the table.',
    signals: 0,
    ordering: 'none',
  },
  runorder: {
    id: 'runorder',
    name: 'Running Order',
    blurb: 'Every task is numbered and must land in order — so most of the round is spent dodging cards you badly want. Two signals each. The demanding one.',
    signals: 2,
    ordering: 'all',
  },
};

export const MODE_IDS: string[] = ['aside', 'hush', 'runorder'];
export const DEFAULT_MODE = 'aside';

export function modeOf(id: string | null | undefined): Mode {
  if (typeof id === 'string' && Object.hasOwn(MODES, id)) return MODES[id];
  return MODES[DEFAULT_MODE];
}

/** What a single rung of the ladder asks of the crew. Pure — the sim and the game share it. */
export interface Rung {
  /** How many task cards the crew actually takes on. */
  tasks: number;
  /**
   * How many EXTRA candidates are laid out beside them. The crew drafts `tasks` of `tasks + spare`
   * and the rest are torn up.
   *
   * This is the single most important number in the game and it was put here by the simulation. A
   * dealt task with no spare is not difficulty, it is a dice roll: measured, a crew forced to accept
   * whatever card came up won mission 1 only 33% of the time at four players, and **zero** times out
   * of eleven when the card happened to land in its own owner's hand — a low card you hold yourself
   * has to win a trick as itself, and nothing in the rules lets you do that on demand. A spare turns
   * that from a coin flip into a decision: you take the task you can actually see a route to.
   */
  spare: number;
  /** How many of them carry a numbered order token (0, or >= 2 — a chain of one constrains nothing). */
  ordered: number;
  /** Whether the highest-numbered task must also land in the very last trick. */
  finale: boolean;
}

/**
 * The ceiling on tasks, so a mission can never ask for more wins than there are tricks. Leaving two
 * tricks of slack is what keeps the last rungs hard rather than arithmetic: with every trick spoken
 * for there is no room to lose one deliberately, which is most of the skill.
 */
export function maxTasks(players: number): number {
  return Math.min(10, handSize(players) - 1);
}

/**
 * The ladder. Mission 1 is one loose task and is meant to be a near-certain win — the crew has to
 * see the shape of the thing before it starts biting. The numbers here were chosen by
 * tests/balance.test.ts, not by argument; changing one means re-running the sweep.
 */
export function rungFor(mode: Mode, mission: number, players: number): Rung {
  const m = Math.max(1, Math.floor(mission));
  const cap = maxTasks(players);

  // The choice on offer narrows as the crew climbs. Three candidates for one task at the bottom of
  // the ladder is a comfortable pick; one spare near the top is barely a reprieve.
  // A chain is the hardest shape in the game, so Chain always lays out one more candidate than the
  // loose modes. Measured: without it, Chain's opening rung won only 34% at five players, which is
  // not a first mission, it is a wall.
  const extra = mode.ordering === 'all' ? 1 : 0;
  // Three candidates spare through the opening rungs. The 1-task to 2-task step is the single
  // biggest jump in the whole ladder — measured at 39 points with five crew, because a second task
  // does not just add work, it adds a second person who has to be in the right place — and the extra
  // choice at the draft is what absorbs it.
  const spare = (m <= 5 ? 3 : m <= 10 ? 2 : 1) + extra;

  /**
   * How many rungs it takes to add a task. Measured: an extra task costs roughly a third of the
   * crew's win rate, so a ladder that adds one every other rung is a cliff, not a curve — and it
   * gets steeper with the table, because more hands means fewer cards each and more people who can
   * accidentally take the wrong trick. Four and five players therefore climb a rung slower.
   */
  const step = players <= 3 ? 2 : 3;

  if (mode.ordering === 'all') {
    // Every link completed early is a loss, so the crew spends most of the round dodging. It starts
    // at two (a chain of one constrains nothing) and climbs at half the pace of the loose ladder.
    const tasks = Math.min(Math.min(players >= 4 ? 5 : 6, cap), 2 + Math.floor((m - 1) / (step * 2)));
    return { tasks, spare, ordered: tasks, finale: m >= 13 && tasks >= 4 };
  }

  const tasks = Math.min(cap, 1 + Math.floor((m - 1) / step));

  // Blackout never chains and never has a finale. Its escalation is the raw task count, and the cap
  // above is set high enough that it keeps climbing rather than saturating into a plateau — which is
  // exactly what it did when the cap was eight: rung 16 and rung 30 were the same mission.
  if (mode.ordering === 'none') return { tasks, spare, ordered: 0, finale: false };

  // 'ladder': loose to begin with. Order tokens arrive at rung 6 in a PAIR — a chain of one is not
  // a constraint, so introducing them one at a time would be a rung that changed nothing at all.
  const finale = m >= 14 && tasks >= 3;
  /**
   * The links arrive on a schedule that is deliberately OUT OF PHASE with the task count.
   *
   * Tasks step whenever `(m - 1) % step === 0`, i.e. on odd rungs at two and three players and every
   * third rung at four and five. Links step at 6, 12, 18 — even, and never a multiple of three plus
   * one — so no single rung ever adds a task AND a link at once. Measured: when rung 11 did both, the
   * crew dropped 36 points in one step, which reads as the game breaking rather than getting harder.
   */
  const chained = m < 6 ? 0 : Math.min(tasks, 2 + Math.floor((m - 6) / 6));
  // The finale TRADES for a link rather than stacking on top of one. Measured: bolting it onto a
  // full chain dropped the crew 58 points in a single rung, which is a trapdoor, not a curve.
  const ordered = finale && chained > 2 ? chained - 1 : chained;
  return { tasks, spare, ordered, finale };
}
