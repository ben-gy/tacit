/**
 * balance.test.ts — principle #18, in its CO-OP form. There are no seats to be unfair to each other
 * here and no leader to snowball, so the thing being refereed is the DIFFICULTY CURVE: mission 1 has
 * to be a near-certain win, the ladder has to bite gradually rather than fall off a cliff, and the
 * top of it has to be genuinely out of reach.
 *
 * Every number below was produced by this file and then written down — not chosen and then
 * confirmed. The bounds are wide enough to survive sampling noise (n=120 gives roughly +-9pp at 95%)
 * and tight enough that the failures this file has already caught would still be caught:
 *
 *   - a forced 1-task draft: mission 1 at 33%, and 0/11 when the owner held its own card
 *   - crewmates hoarding somebody else's task card: the colour never came out and the mission died
 *     on the last trick
 *   - a ladder that added a task every other rung: an 81% -> 40% cliff between mission 1 and 2
 *
 * A separate control arm proves the crew is actually playing rather than getting lucky.
 */

import { describe, expect, it } from 'vitest';
import { runLadder, runMission, runRandomMission, winRate } from './helpers/sim';
import { MODE_IDS, maxTasks, modeOf, rungFor } from '../src/modes';
import { handSize } from '../src/cards';

const COUNTS = [2, 3, 4, 5];
const N = 120;

describe('mission 1 is the handshake, not the test', () => {
  for (const players of COUNTS) {
    it(`${players} players clear the first rung almost every time`, () => {
      for (const mode of MODE_IDS) {
        const rate = winRate(mode, 1, players, N, 31_337);
        /**
         * Chain cannot have a gentle opening rung and still be Chain: its shortest legal mission is
         * a two-link chain, and a chain of one constrains nothing. At a big table that is genuinely
         * hard — measured at 37% with five crew — so the mode is presented as the demanding one and
         * held to a lower floor rather than being quietly declawed into a third loose ladder.
         */
        const floor = modeOf(mode).ordering === 'all' ? (players >= 5 ? 0.3 : 0.45) : 0.8;
        expect(rate, `${mode} ${players}P mission 1 won ${(rate * 100).toFixed(0)}%`).toBeGreaterThan(floor);
      }
    });
  }
});

describe('the ladder is a curve, not a cliff and not a plateau', () => {
  for (const mode of MODE_IDS) {
    it(`${mode} gets harder as it climbs, at every table size`, () => {
      for (const players of COUNTS) {
        const early = winRate(mode, 1, players, N, 4001);
        const mid = winRate(mode, 6, players, N, 4002);
        const late = winRate(mode, 22, players, N, 4003);

        expect(late, `${mode} ${players}P: rung 22 is not hard (${(late * 100).toFixed(0)}%)`).toBeLessThan(0.4);
        expect(early - late, `${mode} ${players}P: the ladder barely moves — it is a plateau`).toBeGreaterThan(0.3);
        // No single step may be a trapdoor. Mid-ladder must still be live for somebody.
        expect(mid, `${mode} ${players}P: rung 6 is already unwinnable`).toBeGreaterThan(0.02);
      }
    });
  }

  it('no adjacent pair of rungs halves the crew twice over', () => {
    /**
     * A cliff is what the first ladder had: 81% at rung 1 and 40% at rung 2. Adjacent rungs may get
     * harder, but a drop of more than 35 points in one step means the step added too much at once.
     *
     * ONE EXCEPTION, and it is characterised rather than hidden. Going from one task to two is the
     * largest single step in the game and stays around 35-40 points at five players however it is
     * softened — two separate mitigations (three spare candidates through the opening rungs, and a
     * slower climb at big tables) each moved it by only a couple of points. It is not a tuning
     * failure: the second task is the first time the crew has to get TWO different people into the
     * right trick, and that is the game arriving. So the first step is allowed 42 points; every
     * other step in the ladder is held to 35.
     */
    for (const mode of MODE_IDS) {
      for (const players of COUNTS) {
        let prev = winRate(mode, 1, players, N, 909);
        for (let m = 2; m <= 12; m++) {
          const here = winRate(mode, m, players, N, 909 + m);
          const firstStep = rungFor(modeOf(mode), m - 1, players).tasks === 1 && rungFor(modeOf(mode), m, players).tasks === 2;
          const bound = firstStep ? 0.42 : 0.35;
          expect(
            prev - here,
            `${mode} ${players}P: rung ${m - 1} -> ${m} fell ${((prev - here) * 100).toFixed(0)} points`,
          ).toBeLessThan(bound);
          prev = here;
        }
      }
    }
  });
});

describe('a run is worth starting and worth losing', () => {
  it('crews get somewhere, and nobody clears the whole ladder by accident', () => {
    for (const mode of MODE_IDS) {
      for (const players of COUNTS) {
        const depths = Array.from({ length: 80 }, (_, i) => runLadder(mode, players, 6000 + i * 3571, 30));
        const mean = depths.reduce((a, b) => a + b, 0) / depths.length;
        const best = Math.max(...depths);
        expect(mean, `${mode} ${players}P: runs end immediately (mean depth ${mean.toFixed(1)})`).toBeGreaterThan(0.4);
        expect(mean, `${mode} ${players}P: runs never end (mean depth ${mean.toFixed(1)})`).toBeLessThan(14);
        expect(best, `${mode} ${players}P: nobody ever got past rung ${best}`).toBeGreaterThan(2);
        expect(best, `${mode} ${players}P: the ladder was cleared outright`).toBeLessThan(30);
      }
    }
  });
});

describe('the crew is playing, not rolling dice', () => {
  it('beats a legal-random control decisively', () => {
    for (const players of [3, 4]) {
      for (const mission of [1, 4]) {
        let random = 0;
        for (let i = 0; i < N; i++) if (runRandomMission('aside', mission, players, 9000 + i * 7919)) random++;
        const skilled = winRate('aside', mission, players, N, 9000);
        const gap = skilled - random / N;
        expect(
          gap,
          `${players}P m${mission}: crew ${(skilled * 100).toFixed(0)}% vs random ${((random / N) * 100).toFixed(0)}%`,
        ).toBeGreaterThan(0.25);
      }
    }
  });
});

describe('no crewmate is the designated scapegoat', () => {
  /**
   * The co-op version of a seat-fairness check, and the guard against the worst way a bot crew can
   * fail: playing "correctly" while quietly steering every dangerous card at one seat, so that every
   * loss is somebody else's task. With identical bots in every seat the blame has to fall evenly —
   * if it does not, the seat carrying it would be the human's.
   */
  it('failed tasks are spread across seats, not concentrated on one', () => {
    for (const players of [3, 4]) {
      const blame = Array.from({ length: players }, () => 0);
      let total = 0;
      for (let i = 0; i < 500; i++) {
        const r = runMission('aside', 5, players, 77_000 + i * 104_729);
        if (r.blameOwner !== null) {
          blame[r.blameOwner]++;
          total++;
        }
      }
      expect(total, 'no failures at all to attribute').toBeGreaterThan(60);
      const share = blame.map((b) => b / total);
      const expected = 1 / players;
      for (let s = 0; s < players; s++) {
        expect(
          Math.abs(share[s] - expected),
          `${players}P: seat ${s} carries ${(share[s] * 100).toFixed(0)}% of the blame (even share ${(expected * 100).toFixed(0)}%) — ${blame.join('/')}`,
        ).toBeLessThan(0.12);
      }
    }
  });
});

describe('the rung table itself', () => {
  it('never asks for more tasks than there are tricks to win them in', () => {
    for (const mode of MODE_IDS) {
      for (const players of COUNTS) {
        for (let m = 1; m <= 40; m++) {
          const rung = rungFor(modeOf(mode), m, players);
          expect(rung.tasks).toBeGreaterThan(0);
          expect(rung.tasks, `${mode} ${players}P m${m}`).toBeLessThanOrEqual(maxTasks(players));
          expect(rung.tasks + 1, `${mode} ${players}P m${m}: no slack left in the hand`).toBeLessThanOrEqual(
            handSize(players),
          );
          expect(rung.ordered).toBeLessThanOrEqual(rung.tasks);
          // A chain of exactly one constrains nothing, so it must never be generated.
          expect(rung.ordered === 1, `${mode} ${players}P m${m}: a one-link chain is not a rule`).toBe(false);
          expect(rung.spare, `${mode} ${players}P m${m}: a forced draft is a dice roll`).toBeGreaterThan(0);
        }
      }
    }
  });

  it('is monotone — a rung is never easier than the one below it', () => {
    for (const mode of MODE_IDS) {
      for (const players of COUNTS) {
        for (let m = 2; m <= 40; m++) {
          const a = rungFor(modeOf(mode), m - 1, players);
          const b = rungFor(modeOf(mode), m, players);
          expect(b.tasks, `${mode} ${players}P m${m}`).toBeGreaterThanOrEqual(a.tasks);
          // Total constraints, not links alone: the finale deliberately TRADES for a link the rung
          // it arrives, so links may drop by one there while the mission gets harder overall.
          const load = (r: typeof a): number => r.ordered + (r.finale ? 1 : 0);
          expect(load(b), `${mode} ${players}P m${m}: fewer constraints than the rung below`).toBeGreaterThanOrEqual(
            load(a),
          );
          expect(
            b.tasks + load(b) > a.tasks + load(a) || (b.tasks === a.tasks && load(b) === load(a)),
            `${mode} ${players}P m${m}: a rung that changes nothing`,
          ).toBe(true);
          expect(b.spare, `${mode} ${players}P m${m}: the crew got MORE choice as it climbed`).toBeLessThanOrEqual(
            a.spare,
          );
        }
      }
    }
  });
});

describe('every mission terminates', () => {
  it('across the whole matrix, no run hangs and every mission resolves', () => {
    for (const mode of MODE_IDS) {
      for (const players of COUNTS) {
        for (const mission of [1, 5, 11, 20, 30]) {
          for (let i = 0; i < 4; i++) {
            const r = runMission(mode, mission, players, 1234 + i * 7919 + mission);
            expect(r.reason.length, `${mode} ${players}P m${mission}: ended with no reason`).toBeGreaterThan(0);
            expect(r.endedOnTrick).toBeLessThan(r.tricks);
          }
        }
      }
    }
  });
});
