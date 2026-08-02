// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson
//
// sim.ts — an all-bot crew playing real missions through the SHIPPED code paths. It drives
// `apply()` with actions chosen by the shipped `chooseCard`/`chooseDraft`/`bestSignal`, so what it
// measures is the game, not a model of the game.
//
// It keeps the whole event stream. tests/mechanism.test.ts audits that stream from OUTSIDE, and the
// two traps that made this necessary elsewhere in the fleet are both avoided here on purpose:
// nothing drains `events` before the audit runs, and the audit counts RULE VIOLATIONS rather than
// timing an average, because a violation count can carry a zero-tolerance bound and an average
// cannot.

import { chooseCard, chooseDraft, bestSignal, signalThreshold, viewFor } from '../../src/bot';
import { modeOf } from '../../src/modes';
import {
  A_DRAFT,
  A_PASS,
  A_PLAY,
  A_SIGNAL,
  apply,
  canSignal,
  createMission,
  draftableFor,
  legalFor,
  makeSetup,
  packAct,
  packSignal,
  type Ev,
  type Mission,
} from '../../src/mission';

export interface MissionResult {
  success: boolean;
  reason: string;
  events: Ev[];
  hands: number[][];
  mission: number;
  players: number;
  modeId: string;
  /** Whose task died, when one did. null on a win or a "cards ran out". */
  blameOwner: number | null;
  /** Which trick the mission ended on. */
  endedOnTrick: number;
  tricks: number;
  /** Every action the crew took, so a failure can be replayed exactly. */
  log: number[];
}

/** One mission, played to the end by bots in every seat. Deterministic in `seed`. */
export function runMission(modeId: string, mission: number, players: number, seed: number): MissionResult {
  const mode = modeOf(modeId);
  const setup = makeSetup(mode, mission, players, seed, seed ^ 0x9e37_79b9);
  const m = createMission(setup, mode);
  const hands = (setup.deal as number[][]).map((h) => [...h]);

  let guard = 0;
  while (m.phase === 'draft') {
    if (++guard > 64) throw new Error('sim: the draft never finished');
    const seat = m.draftTurn;
    const available = draftableFor(m, seat, m.draftRelaxed);
    if (available.length === 0) {
      // Nothing this seat may take: the pass is an ACTION, so it lands in the log like everything
      // else and every peer advances the draft identically.
      if (!apply(m, packAct(A_PASS, seat, 0))) throw new Error(`sim: seat ${seat} could neither draft nor pass`);
      continue;
    }
    const taken = m.tasks.filter((t) => t.owner !== -1).length;
    const pick = chooseDraft(viewFor(m, seat), available, taken);
    if (!apply(m, packAct(A_DRAFT, seat, pick))) throw new Error(`sim: illegal draft pick ${pick}`);
  }

  guard = 0;
  while (m.phase === 'play') {
    if (++guard > 400) throw new Error('sim: the mission never terminated');
    const seat = m.turn;
    const v = viewFor(m, seat);

    if (m.signalsLeft[seat] > 0 && setup.signalBudget > 0) {
      const choice = bestSignal(v, (card, kind) => canSignal(m, seat, card, kind));
      if (choice && choice.score >= signalThreshold(m.trickNo)) {
        apply(m, packAct(A_SIGNAL, seat, packSignal(choice.kind, choice.card)));
      }
    }

    // The bot picks from its own reasoning; the mission is the authority on what is legal. A locked
    // card the bot wanted is simply not available, and if it is squeezed the only cards left ARE
    // locked — so fall back to what the rules allow rather than throwing.
    const allowed = legalFor(m, seat);
    const wanted = chooseCard(viewFor(m, seat));
    const card = allowed.includes(wanted) ? wanted : allowed[0];
    if (card === undefined) throw new Error(`sim: seat ${seat} had no legal card`);
    if (!apply(m, packAct(A_PLAY, seat, card))) {
      throw new Error(`sim: seat ${seat} proposed an illegal card ${card}`);
    }
  }

  const lostTask = m.events.find((e) => e.k === 'task' && !e.ok) as Extract<Ev, { k: 'task' }> | undefined;
  return {
    success: m.success,
    reason: m.reason,
    events: m.events,
    hands,
    mission,
    players,
    modeId,
    blameOwner: lostTask ? lostTask.owner : null,
    endedOnTrick: m.trickNo,
    tricks: setup.tricks,
    log: [...m.log],
  };
}

/** A whole run: climb the ladder until the crew fails. Returns how many rungs they cleared. */
export function runLadder(modeId: string, players: number, seed: number, cap = 30): number {
  for (let mission = 1; mission <= cap; mission++) {
    if (!runMission(modeId, mission, players, seed + mission * 7919).success) return mission - 1;
  }
  return cap;
}

/** Win rate at one rung, over `n` independent seeds. */
export function winRate(modeId: string, mission: number, players: number, n: number, seed0 = 1000): number {
  let wins = 0;
  for (let i = 0; i < n; i++) {
    if (runMission(modeId, mission, players, seed0 + i * 104_729).success) wins++;
  }
  return wins / n;
}

/** A control crew that ignores every deduction the bot makes: legal, random, and nothing more. */
export function runRandomMission(modeId: string, mission: number, players: number, seed: number): boolean {
  const mode = modeOf(modeId);
  const setup = makeSetup(mode, mission, players, seed, seed ^ 0x9e37_79b9);
  const m = createMission(setup, mode);
  let s = (seed ^ 0x1234_5678) >>> 0;
  const next = (): number => {
    s = (s * 1_664_525 + 1_013_904_223) >>> 0;
    return s / 4_294_967_296;
  };

  let guard = 0;
  while (m.phase === 'draft' && guard++ < 64) {
    const avail = m.tasks.map((t, i) => (t.owner === -1 ? i : -1)).filter((i) => i >= 0);
    apply(m, packAct(A_DRAFT, m.draftTurn, avail[Math.floor(next() * avail.length)]));
  }
  guard = 0;
  while (m.phase === 'play' && guard++ < 400) {
    const seat = m.turn;
    const hand = m.hands[seat]!;
    const led = m.trick.length === 0 ? null : Math.floor(m.trick[0] / 16);
    const follow = hand.filter((c) => Math.floor(c / 16) === led);
    const pool = led !== null && follow.length > 0 ? follow : hand;
    apply(m, packAct(A_PLAY, seat, pool[Math.floor(next() * pool.length)]));
  }
  return m.success;
}
