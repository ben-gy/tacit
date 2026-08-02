/**
 * rematch.test.ts — live-P2P contract gate #3, THE REMATCH LIFECYCLE. A Tacit room is a LOOP:
 * lobby → mission → results → lobby, and the crew climbs a LADDER inside it. So the round protocol
 * has to decide three things and get all three identical on every peer: who is in the crew, which
 * seed the pool comes from, and WHICH MISSION is being flown. This pins all of that on the fake bus.
 *
 * The Tacit-specific hazard is the third one. Every other game in the fleet freezes one `mode` into
 * the round start; Tacit freezes `{ mode, mission }`, because the rung of the ladder is not derivable
 * from the round number — a crew that fails drops back to mission 1 while the round number keeps
 * climbing, and a crew that resumes a saved run starts at rung 7 on round 1. A guest that rendered
 * or generated from its OWN mission number would build a different task pool, a different task
 * count and a different chain from the host's, off the same seed — two people playing two different
 * missions on one board, with no error anywhere. Hence: the host's opts, byte-identical, and an
 * unknown mode id off the wire goes through modeOf() rather than reaching the generator as
 * `undefined` (which does not throw — it silently produces a mission with `signalBudget: undefined`).
 *
 * The fake bus sits ABOVE Trystero's room cache, so it structurally cannot contain the leave/rejoin
 * defect — net-lifecycle.test.ts and host-election.test.ts guard the transport and the election, and
 * neither substitutes for the other.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRounds, type RoundInfo, type Rounds } from '@ben-gy/game-engine/rematch';
import { Bus } from './helpers/bus';
import { DEFAULT_MODE, MODES, modeOf, type Mode } from '../src/modes';
import { makeSetup } from '../src/mission';

/** Exactly what src/main.ts freezes into a round start. */
interface Opts {
  mode: string;
  mission: number;
}

interface Peer {
  id: string;
  rounds: Rounds<Opts>;
  got: Array<RoundInfo<Opts>>;
}

let bus: Bus;
/** What peer 'a' — the host in every test but the promotion one — currently has selected. */
let hostPick: Opts;

function seat(id: string, own: Opts = { mode: 'hush', mission: 1 }): Peer {
  const net = bus.join(id);
  const peer: Peer = { id, rounds: null as unknown as Rounds<Opts>, got: [] };
  peer.rounds = createRounds<Opts>({
    net,
    playerName: id.toUpperCase(),
    minPlayers: 2,
    // Every peer offers its OWN pick, exactly as the real lobby does. Only the host's may survive.
    roundOpts: () => (id === 'a' ? { ...hostPick } : { ...own }),
    onRound: (info) => peer.got.push(info),
  });
  return peer;
}

function tick(ms: number): void {
  for (let t = 0; t < ms; t += 250) {
    vi.advanceTimersByTime(250);
    bus.flush();
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  // Deterministic but NOT constant: the engine mints each round's seed from Math.random, so a fixed
  // value would hand every round the same seed and quietly fake the "new seed" assertion.
  let r = 0.11;
  vi.spyOn(Math, 'random').mockImplementation(() => (r = (r + 0.37) % 1));
  bus = new Bus();
  hostPick = { mode: 'aside', mission: 1 };
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('a rematch is a new mission inside the SAME room', () => {
  it('both peers vote → exactly one round, one seed, one roster, one host', () => {
    const a = seat('a');
    const b = seat('b');
    bus.flush();
    tick(5000);

    a.rounds.vote();
    b.rounds.vote();
    bus.flush();

    expect(a.got, 'the host did not start a round at all').toHaveLength(1);
    expect(b.got, 'the guest never learned the round began').toHaveLength(1);
    expect(a.got[0].seed, 'two seeds means two different task pools').toBe(b.got[0].seed);
    expect(a.got[0].round).toBe(b.got[0].round);
    expect(
      a.got[0].players.map((p) => p.id),
      'the crew must be frozen by the host, not re-derived per peer',
    ).toEqual(b.got[0].players.map((p) => p.id));
    expect(
      [a.got[0].isHost, b.got[0].isHost].filter(Boolean),
      'exactly one peer may deal the cards',
    ).toHaveLength(1);
    expect(a.got[0].seated && b.got[0].seated, 'both voters must be in the crew').toBe(true);
  });

  it('round two is a NEW seed and the SAME crew', () => {
    const a = seat('a');
    const b = seat('b');
    bus.flush();
    tick(5000);
    a.rounds.vote();
    b.rounds.vote();
    bus.flush();

    a.rounds.finish();
    b.rounds.finish();
    tick(5000);
    a.rounds.vote();
    b.rounds.vote();
    bus.flush();

    expect(a.got, 'the rematch never started').toHaveLength(2);
    expect(a.got[1].round, 'round numbers must be consecutive').toBe(a.got[0].round + 1);
    expect(a.got[1].seed, 'a repeated seed replays the identical task pool').not.toBe(a.got[0].seed);
    expect(a.got[1].players.map((p) => p.id)).toEqual(b.got[1].players.map((p) => p.id));
  });
});

describe('the MISSION number travels with the mode', () => {
  it('the host’s {mode, mission} is what every peer receives, not each peer’s own pick', () => {
    hostPick = { mode: 'runorder', mission: 9 };
    const a = seat('a');
    const b = seat('b', { mode: 'hush', mission: 1 });
    const c = seat('c', { mode: 'aside', mission: 14 });
    bus.flush();
    tick(5000);
    a.rounds.vote();
    b.rounds.vote();
    c.rounds.vote();
    bus.flush();

    for (const p of [a, b, c]) {
      expect(p.got, `${p.id} did not start`).toHaveLength(1);
      expect(p.got[0].opts?.mode, `${p.id} played its own mode instead of the host’s`).toBe('runorder');
      expect(p.got[0].opts?.mission, `${p.id} flew its own rung of the ladder`).toBe(9);
    }
  });

  it('a guest rendering its OWN pick as the host’s would be lying on both fields', () => {
    hostPick = { mode: 'runorder', mission: 6 };
    const a = seat('a');
    const b = seat('b', { mode: 'hush', mission: 1 });
    bus.flush();
    tick(5000);

    const shown = b.rounds.state().hostOpts;
    expect(shown?.mode, 'the lobby must show the HOST’s mode before the round starts').toBe('runorder');
    expect(shown?.mission, 'the lobby must show the HOST’s rung before the round starts').toBe(6);
    // The point of the previous two lines: b's own answer to both questions is different.
    expect(shown?.mode).not.toBe('hush');
    expect(shown?.mission).not.toBe(1);
    void a;
  });

  it('the mission is NOT the round number — a ladder that jumps still arrives intact', () => {
    hostPick = { mode: 'aside', mission: 1 };
    const a = seat('a');
    const b = seat('b');
    bus.flush();
    tick(5000);
    a.rounds.vote();
    b.rounds.vote();
    bus.flush();

    // The crew cleared mission 1, and the host is resuming a saved run rather than counting rounds.
    hostPick = { mode: 'aside', mission: 7 };
    a.rounds.finish();
    b.rounds.finish();
    tick(5000);
    a.rounds.vote();
    b.rounds.vote();
    bus.flush();

    expect(b.got).toHaveLength(2);
    expect(b.got[1].round, 'round two is still round two').toBe(2);
    expect(
      b.got[1].opts?.mission,
      'the rung was derived from the round number instead of read off the wire',
    ).toBe(7);
    expect(b.got[0].opts?.mission).toBe(1);
  });

  it('an unknown mode id off the wire falls back through modeOf(), never reaching the generator raw', () => {
    const a = seat('a');
    const b = seat('b');
    bus.flush();
    tick(5000);
    a.rounds.vote();
    b.rounds.vote();
    bus.flush();
    const first = b.got[0];

    // A host on a build that renamed a mode — or a prototype key, which is the nastier case because
    // `MODES[id]` RESOLVES for it. Sent as a genuine start for the next round from the elected host.
    bus.inject(
      'a',
      'rs',
      {
        round: first.round + 1,
        seed: 4242,
        roster: first.players.map((p) => ({ id: p.id, name: p.name })),
        opts: { mode: 'constructor', mission: 3 },
      },
      'b',
    );
    bus.flush();

    expect(b.got, 'the start itself must still be honoured — an odd mode id is not a reason to hang').toHaveLength(2);
    const raw = b.got[1].opts?.mode;
    expect(raw).toBe('constructor');

    const bare = (MODES as Record<string, Mode | undefined>)[raw];
    const bareSetup = makeSetup(bare as Mode, 3, 3, b.got[1].seed, 99);
    expect(
      bareSetup.signalBudget,
      'a bare MODES[id] lookup builds a mission with undefined fields instead of throwing — which is why the fallback is load-bearing',
    ).toBeUndefined();

    const safe = modeOf(raw);
    expect(safe.id, 'an unknown mode must fall back to the default, not vanish').toBe(DEFAULT_MODE);
    const setup = makeSetup(safe, b.got[1].opts?.mission ?? 1, 3, b.got[1].seed, 99);
    expect(setup.signalBudget, 'the generator got a real Mode').toBe(MODES[DEFAULT_MODE].signals);
    expect(setup.take, 'the generator got a real rung').toBeGreaterThan(0);
    expect(setup.mission).toBe(3);
  });
});

describe('the room survives people coming and going', () => {
  it('a peer that leaves is dropped from the crew rather than deadlocking it', () => {
    const a = seat('a');
    const b = seat('b');
    const c = seat('c');
    bus.flush();
    tick(5000);

    a.rounds.vote();
    b.rounds.vote();
    c.rounds.vote();
    bus.flush();
    expect(a.got[0].players, 'all three should have flown the first mission').toHaveLength(3);

    a.rounds.finish();
    b.rounds.finish();
    bus.leave('c');
    tick(5000);

    a.rounds.vote();
    b.rounds.vote();
    bus.flush();
    expect(a.got, 'a departed crewmate held the whole room hostage').toHaveLength(2);
    expect(a.got[1].players.map((p) => p.id), 'the leaver must not be seated in absentia').toEqual(['a', 'b']);
  });

  it('a promoted host can run the next mission: no tally inherited, but the right round number', () => {
    const a = seat('a');
    const b = seat('b', { mode: 'runorder', mission: 4 });
    const c = seat('c', { mode: 'hush', mission: 1 });
    bus.flush();
    tick(5000);
    a.rounds.vote();
    b.rounds.vote();
    c.rounds.vote();
    bus.flush();
    expect(a.got[0].isHost).toBe(true);

    a.rounds.finish();
    b.rounds.finish();
    c.rounds.finish();
    bus.leave('a');
    bus.setHost('b');
    tick(5000);

    // The promotion is only useful if b's own timeline survived it: b votes for round 2, and a vote
    // for round 1 would be dropped as stale by everyone including itself.
    expect(b.rounds.state().round, 'the promoted host must still know which round the room played').toBe(1);

    b.rounds.vote();
    c.rounds.vote();
    bus.flush();

    expect(b.got, 'the promoted peer could not start the next round').toHaveLength(2);
    expect(b.got[1].isHost, 'the promoted peer must be the one dealing now').toBe(true);
    expect(c.got, 'the survivor never got the new host’s start').toHaveLength(2);
    expect(b.got[1].seed).toBe(c.got[1].seed);
    expect(b.got[1].round, 'the round number must move forward across a promotion').toBe(2);
    expect(
      c.got[1].opts?.mode,
      'the new host’s pick is the room’s pick — c must not keep playing the old host’s',
    ).toBe('runorder');
    expect(c.got[1].opts?.mission).toBe(4);
  });

  it('a peer connecting MID-mission lands unseated, and is seated the following round', () => {
    const a = seat('a');
    const b = seat('b');
    bus.flush();
    tick(5000);
    a.rounds.vote();
    b.rounds.vote();
    bus.flush();

    // c arrives while the mission is in flight.
    const c = seat('c');
    bus.flush();

    expect(c.got, 'a mid-round joiner must still be told a round is playing').toHaveLength(1);
    expect(c.got[0].round, 'it should learn about the CURRENT round').toBe(a.got[0].round);
    expect(
      c.got[0].seated,
      'a peer outside the frozen crew must be unseated, not handed a seat that holds no cards',
    ).toBe(false);
    expect(c.got[0].players.map((p) => p.id)).toEqual(['a', 'b']);
    expect(c.rounds.state().seated).toBe(false);

    a.rounds.finish();
    b.rounds.finish();
    tick(5000);
    a.rounds.vote();
    b.rounds.vote();
    c.rounds.vote();
    bus.flush();

    expect(c.got, 'the spectator must get into the NEXT mission').toHaveLength(2);
    expect(c.got[1].seated, 'an unseated peer that readies up is excluded for the life of the room').toBe(true);
    expect(c.got[1].players.map((p) => p.id)).toEqual(['a', 'b', 'c']);
    expect(a.got[1].players.map((p) => p.id), 'every peer must agree on the enlarged crew').toEqual([
      'a',
      'b',
      'c',
    ]);
  });
});

describe('a stale start cannot rewind a room', () => {
  it('a duplicate start for the round already playing is ignored', () => {
    const a = seat('a');
    const b = seat('b');
    bus.flush();
    tick(5000);
    a.rounds.vote();
    b.rounds.vote();
    bus.flush();
    const first = b.got[0];

    bus.inject(
      'a',
      'rs',
      {
        round: first.round,
        seed: 999999,
        roster: first.players.map((p) => ({ id: p.id, name: p.name })),
        opts: { mode: 'hush', mission: 20 },
      },
      'b',
    );
    bus.flush();

    expect(b.got, 'a duplicate start must not begin a second round').toHaveLength(1);
    expect(b.got[0].seed, 'a re-delivered start must not swap the pool out from under a live mission').toBe(
      first.seed,
    );
    expect(b.got[0].opts?.mission).toBe(first.opts?.mission);
  });

  it('a start for a round already PLAYED never rewinds the number, and no peer plays a round twice', () => {
    const a = seat('a');
    const b = seat('b');
    bus.flush();
    tick(5000);
    a.rounds.vote();
    b.rounds.vote();
    bus.flush();
    a.rounds.finish();
    b.rounds.finish();
    tick(5000);
    a.rounds.vote();
    b.rounds.vote();
    bus.flush();
    expect(b.rounds.state().round).toBe(2);

    // A round-1 start arriving late — a retry from the ack ladder that crawled through a slow relay.
    bus.inject(
      'a',
      'rs',
      {
        round: 1,
        seed: 111111,
        roster: b.got[0].players.map((p) => ({ id: p.id, name: p.name })),
        opts: { mode: 'hush', mission: 1 },
      },
      'b',
    );
    bus.flush();

    expect(b.got, 'a late start for a finished round restarted the room').toHaveLength(2);
    expect(b.rounds.state().round, 'the round number went BACKWARDS').toBe(2);
    const numbers = b.got.map((g) => g.round);
    expect(numbers, 'no peer may run the same round twice').toEqual([...new Set(numbers)]);
    expect(numbers).toEqual([1, 2]);
  });
});

describe('the game’s own channel does not collide with the engine’s', () => {
  // The engine reserves 'rv', 'rs', 'rq' and 'rk' inside this very protocol. A game channel sharing
  // one of those names would feed Tacit's wire messages straight into the rematch state machine.
  const grab = (path: string): string[] =>
    [...readFileSync(join(process.cwd(), path), 'utf8').matchAll(/\.channel<[^>]*>\('([^']+)'/g)].map(
      (m) => m[1],
    );

  it('tacit uses "tm", which the engine does not reserve', () => {
    const reserved = grab('node_modules/@ben-gy/game-engine/src/rematch.ts');
    expect(reserved, 'the engine channel scan found nothing — the regex has rotted').toEqual([
      'rv',
      'rs',
      'rq',
      'rk',
    ]);

    const mine = grab('src/main.ts');
    expect(mine, 'tacit should open exactly one game channel').toEqual(['tm']);
    for (const name of mine) {
      expect(reserved, `channel "${name}" collides with a reserved engine channel`).not.toContain(name);
    }
  });
});
