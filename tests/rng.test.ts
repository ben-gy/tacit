/**
 * rng.test.ts — the P2P-sync determinism invariant. Two peers never send a deal, a pool or a shuffle
 * to each other: they send a SEED and rebuild everything from it, and then send only the ACTION LOG.
 * If any of that is not bit-identical, every multiplayer mission is quietly broken — and in a co-op
 * with hidden hands the desync does not show up as a wrong pixel, it shows up as one peer being told
 * the mission failed while the other is still playing it.
 *
 * The half that matters most for Tacit is the task pool: it is computed independently on every peer
 * from the shared round seed and is never transmitted, so a pool that differs by one card means two
 * crews playing two different missions with no message that could ever reveal it.
 */

import { describe, expect, it } from 'vitest';
import { makeRng, newSeed, shuffle } from '@ben-gy/game-engine/rng';
import { MODE_IDS, modeOf, rungFor } from '../src/modes';
import { isTrump } from '../src/cards';
import {
  A_DRAFT,
  A_PLAY,
  A_SIGNAL,
  apply,
  buildPool,
  createMission,
  draftableFor,
  legalFor,
  makeSetup,
  packAct,
  packSignal,
  replay,
  signalKindsFor,
  type Mission,
} from '../src/mission';

const PLAYERS = [2, 3, 4, 5];
const MISSIONS = [1, 4, 8, 13];
/** The deal seed the solo/sim path derives from the round seed. Mirrored here, not imported. */
const dealSeedFor = (seed: number): number => seed ^ 0x9e37_79b9;

/**
 * Everything that distinguishes one position from another, including the private hands. Two peers
 * that agree on this string are playing the same game; anything left out of it is a field a desync
 * could hide in, which is why this is deliberately a whole-object snapshot rather than a hash of the
 * three or four fields that felt important.
 */
function position(m: Mission): string {
  return JSON.stringify({
    phase: m.phase,
    success: m.success,
    reason: m.reason,
    trickNo: m.trickNo,
    trick: m.trick,
    lead: m.lead,
    turn: m.turn,
    tricksWon: m.tricksWon,
    seen: m.seen,
    seenBy: m.seenBy,
    voids: m.voids,
    hands: m.hands,
    tasks: m.tasks,
    signals: m.signals,
    signalsLeft: m.signalsLeft,
    draftTurn: m.draftTurn,
    draftRelaxed: m.draftRelaxed,
    log: m.log,
  });
}

/**
 * A whole mission driven through `apply()` by a fixed rotation rather than by the bot, so this file
 * tests the MACHINE and not the crew: a bot that happened to be deterministic would otherwise mask a
 * mission machine that was not. Signals are spent whenever they are legal so `applySignal` is on the
 * path too — a signal is a log entry like any other and has to replay like one.
 */
function playThrough(modeId: string, mission: number, players: number, seed: number): Mission {
  const mode = modeOf(modeId);
  const m = createMission(makeSetup(mode, mission, players, seed, dealSeedFor(seed)), mode);

  let n = 0;
  while (m.phase === 'draft') {
    if (++n > 64) throw new Error('rng: the draft never finished');
    const seat = m.draftTurn;
    const avail = draftableFor(m, seat, m.draftRelaxed);
    if (!apply(m, packAct(A_DRAFT, seat, avail[n % avail.length]))) {
      throw new Error(`rng: illegal draft at seat ${seat}`);
    }
  }

  n = 0;
  while (m.phase === 'play') {
    if (++n > 400) throw new Error('rng: the mission never terminated');
    const seat = m.turn;
    if (m.signalsLeft[seat] > 0) {
      for (const card of m.hands[seat] ?? []) {
        const kinds = signalKindsFor(m, seat, card);
        if (kinds.length > 0) {
          apply(m, packAct(A_SIGNAL, seat, packSignal(kinds[0], card)));
          break;
        }
      }
    }
    const legal = legalFor(m, seat);
    if (!apply(m, packAct(A_PLAY, seat, legal[n % legal.length]))) {
      throw new Error(`rng: illegal play at seat ${seat}`);
    }
  }
  return m;
}

describe('the generator itself', () => {
  it('the same seed produces the same stream', () => {
    const a = makeRng(12345);
    const b = makeRng(12345);
    const xs = Array.from({ length: 200 }, () => a());
    const ys = Array.from({ length: 200 }, () => b());
    expect(xs).toEqual(ys);
  });

  it('a different seed produces a different stream', () => {
    const a = makeRng(1);
    const b = makeRng(2);
    const xs = Array.from({ length: 50 }, () => a());
    const ys = Array.from({ length: 50 }, () => b());
    expect(xs).not.toEqual(ys);
  });

  it('stays inside [0, 1)', () => {
    const r = makeRng(99);
    for (let i = 0; i < 5000; i++) {
      const v = r();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('shuffles identically from the same seed and keeps every element', () => {
    const src = Array.from({ length: 40 }, (_, i) => i);
    const a = shuffle(makeRng(777), src);
    const b = shuffle(makeRng(777), src);
    expect(a).toEqual(b);
    expect(a.slice().sort((x, y) => x - y)).toEqual(src);
    expect(a, 'a shuffle that never moves anything is not a shuffle').not.toEqual(src);
  });

  it('newSeed produces a fresh 32-bit value', () => {
    const seeds = new Set(Array.from({ length: 200 }, () => newSeed()));
    expect(seeds.size).toBeGreaterThan(150);
    for (const s of seeds) {
      expect(Number.isInteger(s)).toBe(true);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThan(2 ** 32);
    }
  });
});

describe('two peers holding the same seed hold the same mission', () => {
  /**
   * The pool is the one piece of shared state that is NEVER sent: each peer computes it from the
   * round seed the moment the round starts. It therefore has to match at every player count and in
   * every mode, because the mode and the rung change how many candidates are laid out.
   */
  it('buildPool is identical on both peers, at every count and in every mode', () => {
    let pools = 0;
    for (const id of MODE_IDS) {
      const mode = modeOf(id);
      for (const players of PLAYERS) {
        for (const mission of MISSIONS) {
          for (const seed of [0, 1, 424242, 2 ** 31, 4294967295]) {
            const a = buildPool(mode, mission, players, seed);
            const b = buildPool(mode, mission, players, seed);
            const where = `${id}/${players}P/m${mission}/s${seed}`;
            expect(b, `${where}: the two peers laid out different candidates`).toEqual(a);

            const rung = rungFor(mode, mission, players);
            expect(a.length, `${where}: wrong number of candidates`).toBe(rung.tasks + rung.spare);
            expect(a.every((t) => !isTrump(t.card)), `${where}: a Gantry card became a task`).toBe(true);
            expect(new Set(a.map((t) => t.card)).size, `${where}: the same card twice`).toBe(a.length);
            pools++;
          }
        }
      }
    }
    expect(pools).toBeGreaterThan(200);
  });

  it('a different seed lays out a different pool — otherwise the agreement above is vacuous', () => {
    const mode = modeOf('aside');
    const pools = new Set(
      Array.from({ length: 40 }, (_, i) => JSON.stringify(buildPool(mode, 6, 4, 900 + i * 7919))),
    );
    expect(pools.size).toBeGreaterThan(30);
  });

  it('makeSetup deals the same hands and elects the same commander from the same two seeds', () => {
    for (const id of MODE_IDS) {
      const mode = modeOf(id);
      for (const players of PLAYERS) {
        for (let i = 0; i < 8; i++) {
          const pool = 5150 + i * 104_729;
          const deal = dealSeedFor(pool);
          const a = makeSetup(mode, 7, players, pool, deal);
          const b = makeSetup(mode, 7, players, pool, deal);
          const where = `${id}/${players}P/s${pool}`;
          expect(b.deal, `${where}: the deal diverged`).toEqual(a.deal);
          expect(b.commander, `${where}: the two peers elected different commanders`).toBe(a.commander);
          expect(b, `${where}: some other field of the setup diverged`).toEqual(a);

          // A hand must be a hand: every card dealt exactly once, and nobody short.
          const all = (a.deal as number[][]).flat();
          expect(new Set(all).size, `${where}: a card was dealt twice`).toBe(all.length);
          expect(new Set(a.deal.map((h) => h!.length)).size, `${where}: unequal hands`).toBe(1);
        }
      }
    }
  });

  it('a different DEAL seed deals different hands — the pool seed alone must not fix the deal', () => {
    const mode = modeOf('aside');
    const base = makeSetup(mode, 3, 4, 1234, 1);
    const other = makeSetup(mode, 3, 4, 1234, 2);
    expect(other.pool).toEqual(base.pool);
    expect(other.deal).not.toEqual(base.deal);
  });

  it('the same log replays to the same position on both sides', () => {
    let replayed = 0;
    for (const id of MODE_IDS) {
      const mode = modeOf(id);
      for (const players of PLAYERS) {
        for (let i = 0; i < 4; i++) {
          const seed = i * 4099 + 3 + players * 7919;
          const host = playThrough(id, 5, players, seed);

          // The peer rebuilds the setup from the seeds alone and replays the log it was sent.
          const peer = createMission(makeSetup(mode, 5, players, seed, dealSeedFor(seed)), mode);
          const where = `${id}/${players}P/s${seed}`;
          expect(replay(peer, host.log), `${where}: the log was rejected by the other peer`).toBe(true);
          expect(position(peer), `${where}: the two peers ended on different positions`).toBe(position(host));
          expect(peer.success).toBe(host.success);
          expect(peer.reason).toBe(host.reason);
          replayed++;
        }
      }
    }
    expect(replayed).toBe(MODE_IDS.length * PLAYERS.length * 4);
  });

  it('replaying a PREFIX of the log lands where the host was at that point — a peer catching up mid-mission', () => {
    const mode = modeOf('runorder');
    const host = playThrough('runorder', 9, 4, 20_260_802);
    expect(host.log.length).toBeGreaterThan(8);

    // Walk the host forward one action at a time and make a fresh peer replay the prefix each time.
    const walk = createMission(makeSetup(mode, 9, 4, 20_260_802, dealSeedFor(20_260_802)), mode);
    for (let k = 0; k < host.log.length; k++) {
      expect(apply(walk, host.log[k]), `action ${k} was rejected on the second run`).toBe(true);
      const late = createMission(makeSetup(mode, 9, 4, 20_260_802, dealSeedFor(20_260_802)), mode);
      expect(replay(late, host.log.slice(0, k + 1)), `prefix of ${k + 1} rejected`).toBe(true);
      expect(position(late), `a peer that joined at action ${k} saw a different position`).toBe(position(walk));
    }
    expect(position(walk)).toBe(position(host));
  });

  it('nothing in the mission machine reaches for Math.random', () => {
    const real = Math.random;
    Math.random = () => {
      throw new Error('the mission rolled its own dice instead of using the shared seed');
    };
    // Collected rather than asserted inside the stub: an assertion failure in here would be reported
    // against a globally broken Math.random, which is a confusing way to read a real failure.
    const ends: string[] = [];
    try {
      for (const id of MODE_IDS) {
        for (const players of PLAYERS) {
          const m = playThrough(id, 6, players, 8675_309);
          ends.push(`${id}/${players}P:${m.phase}`);
          // The pool and the deal are the two places a shortcut would be tempting.
          buildPool(modeOf(id), 6, players, 4242);
          makeSetup(modeOf(id), 6, players, 4242, 99);
        }
      }
    } finally {
      Math.random = real;
    }
    expect(ends.length).toBe(MODE_IDS.length * PLAYERS.length);
    expect(ends.every((e) => e.endsWith(':over'))).toBe(true);
  });
});
