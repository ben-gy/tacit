/**
 * no-deadlock.test.ts — live-P2P contract gate #5, plus every way a Tacit MISSION can stop moving.
 *
 * THE ENGINE HALF. A peer that never votes must not hold the room: quorum arms a countdown, the
 * countdown is VISIBLE (`startsInMs`), and when it expires the round starts without the straggler.
 * A silent wait and a hang look identical from the sofa, which is why the countdown being non-null
 * is part of the contract rather than a nicety.
 *
 * THE TACIT HALF. Tacit has no timer and no score clock: a mission that stops moving stops for
 * good, and in a co-op there is nobody who benefits from the stall to notice it. Every stall this
 * game can have comes from one of four places, and each gets a guard here.
 *
 *   THE DRAFT can hand the turn to a seat with nothing it may take (you may never take a task whose
 *   card is in your own hand). `nextDrafter` has to walk on, and if the whole table is stuck the
 *   own-hand rule has to LIFT — `draftRelaxed` — because a harder mission is a better failure than
 *   a draft screen that never closes. Both positions are built by hand: they are rare enough that
 *   fishing for a seed gives no control over them, and a test that only fires on some seeds is a
 *   test that will one day quietly stop firing.
 *
 *   THE PLAY can hand the turn to a seat with no legal card, and that is fatal in a very quiet way:
 *   `Session.maybeBot` commits nothing when `legalFor` is empty AND schedules no follow-up, so the
 *   mission simply stops with the turn indicator on somebody. `legalFor` must therefore never be
 *   empty while the mission is live — which is exactly what the squeeze rule is for: when every card
 *   you may play is a locked task card, the locked ones become legal again.
 *
 *   A MISSION must run out of tricks. `setup.tricks` is the only bound on the length of a mission,
 *   so if the trick counter can pass it, nothing ever ends the round.
 *
 *   THE WIRE can leave a peer waiting on a message that will never come. A guest whose private deal
 *   was dropped must ASK (`need`) rather than sit on an empty screen; a host must answer one; a
 *   guest whose replay of the public log fails must ask to be re-dealt rather than render a board
 *   that is quietly wrong; and a promoted host's re-attestation must always finish, whether the room
 *   answers it or not.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRounds, type RoundInfo, type Rounds } from '@ben-gy/game-engine/rematch';
import { Bus } from './helpers/bus';
import { runMission } from './helpers/sim';
import { buildDeck, handSize } from '../src/cards';
import { MODES, MODE_IDS, modeOf } from '../src/modes';
import {
  A_DRAFT,
  A_PASS,
  A_PLAY,
  apply,
  createMission,
  draftableFor,
  isBlocked,
  isLive,
  isOver,
  isSqueezed,
  legalFor,
  makeSetup,
  packAct,
  type Mission,
  type Setup,
} from '../src/mission';
import { Session, type WireMsg } from '../src/session';

// ════════════════════════════════════════════════════════════════════════════════
// THE ENGINE HALF — a straggler must not hold the room.
// ════════════════════════════════════════════════════════════════════════════════

const GRACE_MS = 8000;

interface Peer {
  id: string;
  rounds: Rounds;
  got: RoundInfo[];
}

let bus: Bus;

function seat(id: string): Peer {
  const net = bus.join(id);
  const peer: Peer = { id, rounds: null as unknown as Rounds, got: [] };
  peer.rounds = createRounds({
    net,
    playerName: id.toUpperCase(),
    minPlayers: 2,
    graceMs: GRACE_MS,
    roundOpts: () => ({ mode: 'aside', mission: 1 }),
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

function room(): [Peer, Peer, Peer] {
  const a = seat('a');
  const b = seat('b');
  const c = seat('c');
  bus.flush();
  tick(5000);
  return [a, b, c];
}

describe('a straggler cannot hold the room', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    bus = new Bus();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('quorum arms a countdown that is VISIBLE while it runs', () => {
    const [a, b] = room();
    expect(a.rounds.state().startsInMs, 'a countdown before quorum would be a lie').toBeNull();

    a.rounds.vote();
    b.rounds.vote();
    bus.flush();

    const first = a.rounds.state().startsInMs;
    expect(first, 'a silent wait is indistinguishable from a hang').not.toBeNull();
    expect(first!, 'the countdown must have time left on it').toBeGreaterThan(0);
    expect(first!, 'the countdown must not exceed the grace window').toBeLessThanOrEqual(GRACE_MS);

    tick(2000);
    const later = a.rounds.state().startsInMs;
    expect(later, 'the countdown is not counting down').toBeLessThan(first!);
    expect(later!, 'the countdown expired two seconds into an eight-second grace').toBeGreaterThan(0);
  });

  it('the mission starts WITHOUT the straggler when the countdown expires', () => {
    const [a, b, c] = room();
    a.rounds.vote();
    b.rounds.vote();
    bus.flush();
    expect(a.got, 'quorum alone must not start the mission — the third peer gets its grace').toHaveLength(0);

    tick(GRACE_MS + 2000);

    expect(a.got, 'the room deadlocked on a peer that never tapped').toHaveLength(1);
    expect(b.got, 'the second voter was left behind by the start it asked for').toHaveLength(1);
    expect(a.got[0].players.map((p) => p.id), 'the crew must be exactly the peers that voted').toEqual(['a', 'b']);
    expect(c.got, 'the straggler must still be told, so it can spectate rather than stare at a lobby').toHaveLength(1);
    expect(c.got[0].seated, 'a peer that never voted must not be dealt in').toBe(false);
    expect(a.rounds.state().startsInMs, 'the countdown must clear once it has fired').toBeNull();
  });

  it('the spectator can queue for the NEXT mission rather than being stuck forever', () => {
    const [a, b, c] = room();
    a.rounds.vote();
    b.rounds.vote();
    bus.flush();
    tick(GRACE_MS + 2000);
    expect(c.got[0].seated).toBe(false);

    c.rounds.vote();
    bus.flush();
    expect(c.rounds.state().voted, 'a spectator that cannot register a vote is stuck for good').toBe(true);

    a.rounds.finish();
    b.rounds.finish();
    tick(5000);
    a.rounds.vote();
    b.rounds.vote();
    bus.flush();
    tick(GRACE_MS + 2000);

    expect(a.got, 'the second mission never started').toHaveLength(2);
    expect(a.got[1].players.map((p) => p.id), 'the spectator was not seated for the mission it voted for').toEqual([
      'a',
      'b',
      'c',
    ]);
    expect(c.got[1].seated).toBe(true);
  });
});

describe('unanimity is not made to wait', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    bus = new Bus();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('everyone voting starts the mission immediately, with no countdown', () => {
    const [a, b, c] = room();
    a.rounds.vote();
    b.rounds.vote();
    c.rounds.vote();
    bus.flush();

    expect(a.got, 'a full room was made to sit through a grace period it did not need').toHaveLength(1);
    expect(a.rounds.state().startsInMs, 'no countdown should ever have been armed').toBeNull();
    expect(a.got[0].players, 'a unanimous start must seat everybody').toHaveLength(3);
  });
});

describe('losing quorum cancels the countdown', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    bus = new Bus();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('a peer backing out stops the clock, and no mission starts', () => {
    const [a, b] = room();
    a.rounds.vote();
    b.rounds.vote();
    bus.flush();
    expect(a.rounds.state().startsInMs).not.toBeNull();

    tick(2000);
    b.rounds.unvote();
    bus.flush();
    tick(500);

    expect(a.rounds.state().startsInMs, 'the countdown kept running after quorum was lost').toBeNull();
    tick(GRACE_MS + 2000);
    expect(a.got, 'a mission started for a crew of one').toHaveLength(0);
    expect(a.rounds.state().votes.map((v) => v.id), 'the withdrawn vote is still counted').toEqual(['a']);
  });

  it('re-reaching quorum arms a FRESH countdown, not a resumed one', () => {
    const [a, b] = room();
    a.rounds.vote();
    b.rounds.vote();
    bus.flush();
    tick(4000);
    b.rounds.unvote();
    bus.flush();
    tick(500);
    expect(a.rounds.state().startsInMs).toBeNull();

    b.rounds.vote();
    bus.flush();

    const restarted = a.rounds.state().startsInMs;
    expect(restarted, 'quorum was reached again and nothing was armed').not.toBeNull();
    expect(restarted!, 'the countdown resumed mid-flight instead of restarting').toBeGreaterThan(GRACE_MS - 1000);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// THE TACIT HALF — every way one mission can stop moving.
// ════════════════════════════════════════════════════════════════════════════════

const COUNTS = [2, 3, 4, 5];

/** A mission still in the DRAFT, with the pool and the hands written by hand. */
function drafting(o: {
  hands: number[][];
  pool: number[];
  take: number;
  tricks?: number;
  commander?: number;
}): Mission {
  const mode = MODES.aside;
  const setup: Setup = {
    players: o.hands.length,
    modeId: mode.id,
    mission: 1,
    pool: o.pool.map((card) => ({ card })),
    take: o.take,
    ordered: 0,
    finale: false,
    commander: o.commander ?? 0,
    deal: o.hands.map((h) => [...h]),
    signalBudget: mode.signals,
    tricks: o.tricks ?? 4,
  };
  return createMission(setup, mode);
}

/**
 * Play the draft out with a hard bound, so a hang FAILS instead of hanging.
 *
 * A seat that may take nothing is PASSED, and the pass is an explicit action in the log. That is not
 * an implementation detail: whether a seat can draft depends on its hidden hand, so a guest silently
 * skipping the seat the host skipped is impossible — it would compute a different draft turn, reject
 * the host's next action, and the two would trade messages for ever. Only the host can make this
 * call, and it writes the answer down. See A_PASS in src/mission.ts.
 */
function finishDraft(m: Mission, note: string): { picks: number; passes: number } {
  let picks = 0;
  let passes = 0;
  while (m.phase === 'draft') {
    expect(picks + passes, `${note}: the draft never closed — this is the hang`).toBeLessThan(64);
    const seat = m.draftTurn;
    const avail = draftableFor(m, seat, m.draftRelaxed);
    if (avail.length === 0) {
      expect(apply(m, packAct(A_PASS, seat, 0)), `${note}: seat ${seat} could neither draft nor pass`).toBe(true);
      passes++;
      continue;
    }
    expect(apply(m, packAct(A_DRAFT, seat, avail[0])), `${note}: the draft offered seat ${seat} an illegal pick`).toBe(
      true,
    );
    picks++;
  }
  return { picks, passes };
}

describe('the draft always closes', () => {
  it('passes a seat that may take nothing, without lifting the rule', () => {
    // Seat 0 holds BOTH candidates, so every task on the table is one it may not claim. Seat 1 holds
    // neither. Seat 0 is the commander, so the draft OPENS on it and immediately passes.
    const m = drafting({
      hands: [
        [0x01, 0x02, 0x03],
        [0x11, 0x12, 0x13],
      ],
      pool: [0x01, 0x02],
      take: 2,
      commander: 0,
    });

    expect(m.draftTurn, 'the draft must open on the commander, pass or not').toBe(0);
    expect(draftableFor(m, 0, m.draftRelaxed).length, 'seat 0 holds both candidates and may take neither').toBe(0);
    expect(m.draftRelaxed, 'the own-hand rule was thrown away before anybody had passed').toBe(false);

    const { picks, passes } = finishDraft(m, 'one stuck seat');

    expect(passes, 'the stuck seat was never passed').toBeGreaterThan(0);
    expect(picks, 'a two-task draft took the wrong number of picks').toBe(2);
    expect(m.phase, 'the draft never handed over to the play phase').toBe('play');
    expect(m.tasks.filter((t) => t.owner === 1), 'both tasks must land on the only seat that may take them').toHaveLength(
      2,
    );
    expect(m.draftRelaxed, 'passing one stuck seat must not lift the rule for everybody').toBe(false);
  });

  it('lifts the own-hand rule when the WHOLE table is stuck', () => {
    // Every candidate is in every hand. A real deal cannot produce that — but a REBUILT one can: after
    // a host transfer the hands arrive as claims from peers (`att`), and nothing on the wire promises
    // they are disjoint. The draft must survive a deal it does not believe in.
    const m = drafting({
      hands: [
        [0x01, 0x02, 0x03],
        [0x01, 0x02, 0x13],
      ],
      pool: [0x01, 0x02],
      take: 2,
      commander: 0,
    });

    expect(m.draftRelaxed, 'the rule must not lift before a full lap of passes').toBe(false);

    const { picks, passes } = finishDraft(m, 'whole table stuck');

    expect(passes, 'a stuck table must pass all the way round before the rule lifts').toBeGreaterThanOrEqual(2);
    expect(m.draftRelaxed, 'nobody at the table could take anything and the rule never lifted').toBe(true);
    expect(picks, 'a two-task draft took the wrong number of picks').toBe(2);
    expect(m.phase, 'the relaxed draft still never closed').toBe('play');
    expect(m.tasks.every((t) => t.owner >= 0), 'the relaxed draft left a task unclaimed').toBe(true);
  });

  it('every rung lays out MORE candidates than the crew must take', () => {
    // A pool that cannot fill `take` is a draft that can never reach its own end condition, and the
    // seat to draft would be handed the turn forever.
    for (const modeId of MODE_IDS) {
      for (const players of COUNTS) {
        for (let mission = 1; mission <= 30; mission++) {
          const setup = makeSetup(modeOf(modeId), mission, players, 12345, 6789);
          const at = `${modeId} ${players}P rung ${mission}`;
          expect(setup.take, `${at}: a rung that asks for no task at all`).toBeGreaterThan(0);
          expect(setup.pool.length, `${at}: the pool cannot fill the draft, so it can never close`).toBeGreaterThan(
            setup.take,
          );
          expect(setup.take, `${at}: more tasks than tricks — the mission cannot be completed`).toBeLessThan(
            setup.tricks,
          );
        }
      }
    }
  });

  it('always closes, on every rung of every mode at every table, over a seeded sweep', () => {
    // The bound inside finishDraft is the real assertion: a draft that cannot close is the hang.
    let drafts = 0;
    let passes = 0;
    for (const modeId of MODE_IDS) {
      for (const players of COUNTS) {
        for (let mission = 1; mission <= 14; mission++) {
          for (let seed = 1; seed <= 12; seed++) {
            const mode = modeOf(modeId);
            const at = `${modeId} ${players}P rung ${mission} seed ${seed}`;
            const m = createMission(makeSetup(mode, mission, players, seed * 7919, seed * 104_729), mode);
            const r = finishDraft(m, at);
            drafts += r.picks;
            passes += r.passes;
            expect(m.phase, `${at}: the draft did not reach the play phase`).toBe('play');
            expect(m.tasks.filter((t) => t.owner >= 0).length, `${at}: wrong number of tasks taken`).toBe(m.setup.take);
          }
        }
      }
    }
    expect(drafts, 'the sweep never actually drafted anything').toBeGreaterThan(1000);
    // Non-vacuity: real deals DO put a candidate in the drafter's own hand, so the pass path is
    // exercised by the sweep rather than only by the two hand-built positions above.
    expect(passes, 'the pass path was never reached, so the sweep proves nothing about it').toBeGreaterThan(0);
  });
});

describe('the seat to move always has a card', () => {
  it('legalFor is never empty until the mission is over, across every mode and table', () => {
    let plies = 0;
    let squeezes = 0;

    for (const modeId of MODE_IDS) {
      for (const players of COUNTS) {
        for (let mission = 1; mission <= 14; mission++) {
          for (let seed = 1; seed <= 8; seed++) {
            const mode = modeOf(modeId);
            const at = `${modeId} ${players}P rung ${mission} seed ${seed}`;
            const setup = makeSetup(mode, mission, players, seed * 31_337, seed * 2_654_435_761);
            const m = createMission(setup, mode);
            finishDraft(m, at);

            // A seeded walk rather than the bot: the bot avoids the awkward positions on purpose, and
            // the awkward positions are the whole point.
            let rnd = (seed * 2_246_822_519) >>> 0;
            const next = (n: number): number => {
              rnd = (rnd * 1_664_525 + 1_013_904_223) >>> 0;
              return rnd % n;
            };

            let guard = 0;
            while (!isOver(m)) {
              expect(guard++, `${at}: the play phase never terminated`).toBeLessThan(400);
              const s = m.turn;
              const legal = legalFor(m, s);
              expect(
                legal.length,
                `${at}: seat ${s} must play and has no legal card — the mission stops here forever`,
              ).toBeGreaterThan(0);

              const allLocked = legal.every((c) =>
                m.tasks.some((t) => isLive(t) && !t.done && t.card === c && isBlocked(m, t)),
              );
              if (allLocked) {
                squeezes++;
                expect(
                  isSqueezed(m, s),
                  `${at}: seat ${s} has nothing but locked cards and the UI would not warn it`,
                ).toBe(true);
              }

              expect(apply(m, packAct(A_PLAY, s, legal[next(legal.length)])), `${at}: a legal card was rejected`).toBe(
                true,
              );
              plies++;
            }
          }
        }
      }
    }

    expect(plies, 'the sweep barely played anything').toBeGreaterThan(10_000);
    // A positive control: if the sweep never squeezed anybody, the squeeze branch above is unverified
    // and the "locked cards become legal" escape could be broken without this test noticing.
    expect(squeezes, 'the sweep never produced a squeeze, so the escape hatch is untested').toBeGreaterThan(0);
  });

  it('the shipped bot crew never runs out of cards either', () => {
    // sim.ts throws the moment a seat has no legal card, so this is the same guard run through the
    // real chooseCard/chooseDraft path rather than a random walk.
    for (const modeId of MODE_IDS) {
      for (const players of COUNTS) {
        for (let mission = 1; mission <= 10; mission++) {
          for (let seed = 1; seed <= 6; seed++) {
            const at = `${modeId} ${players}P rung ${mission} seed ${seed}`;
            expect(
              () => runMission(modeId, mission, players, seed * 15_485_863),
              `${at}: the shipped crew stalled`,
            ).not.toThrow();
          }
        }
      }
    }
  });
});

describe('every mission runs out of tricks', () => {
  it('reaches an end within setup.tricks, and the trick counter never passes it', () => {
    let missions = 0;
    for (const modeId of MODE_IDS) {
      for (const players of COUNTS) {
        for (let mission = 1; mission <= 16; mission++) {
          for (let seed = 1; seed <= 10; seed++) {
            const at = `${modeId} ${players}P rung ${mission} seed ${seed}`;
            const r = runMission(modeId, mission, players, seed * 1_000_003);
            missions++;

            expect(r.tricks, `${at}: a mission with no tricks in it`).toBe(handSize(players));
            expect(r.endedOnTrick, `${at}: the mission played past the last trick — nothing would ever end it`)
              .toBeLessThan(r.tricks);
            expect(r.reason, `${at}: the mission ended without saying why`).not.toBe('');
            expect(
              r.events.some((e) => e.k === 'end'),
              `${at}: the mission stopped without ever emitting an end`,
            ).toBe(true);

            const plays = r.events.filter((e) => e.k === 'play').length;
            expect(plays, `${at}: more cards were played than the crew was dealt`).toBeLessThanOrEqual(
              r.tricks * players,
            );
          }
        }
      }
    }
    expect(missions, 'the termination sweep is too small to mean anything').toBeGreaterThan(1500);
  });
});

// ── the wire ────────────────────────────────────────────────────────────────────

interface Sent {
  msg: WireMsg;
  to?: string | string[];
}

const PEERS = ['h', 'p1', 'p2', 'p3'];
let live: Session[] = [];

function mkSession(o: {
  players: number;
  mySeat: number | null;
  isHost: boolean;
  bots?: number[];
  peerOfSeat?: string[];
  out: Sent[];
  dealSeed?: number;
  onEnd?: () => void;
}): Session {
  const s = new Session({
    mode: MODES.aside,
    mission: 1,
    players: o.players,
    mySeat: o.mySeat,
    bots: new Set(o.bots ?? []),
    isHost: o.isHost,
    names: PEERS.slice(0, o.players),
    peerOfSeat: o.peerOfSeat ?? PEERS.slice(0, o.players),
    deps: {
      send: (msg, to) => o.out.push({ msg, to }),
      onChange: () => {},
      onEvents: () => {},
      onEnd: o.onEnd ?? (() => {}),
    },
    poolSeed: 4242,
    dealSeed: o.dealSeed ?? 8675_309,
  });
  live.push(s);
  return s;
}

const kinds = (out: Sent[], t: WireMsg['t']): Sent[] => out.filter((s) => s.msg.t === t);

describe('a peer waiting on a message that never came', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    live = [];
  });
  afterEach(() => {
    for (const s of live) s.destroy();
    vi.useRealTimers();
  });

  it('a guest with no deal ASKS for one instead of sitting on an empty screen', () => {
    const out: Sent[] = [];
    const guest = mkSession({ players: 2, mySeat: null, isHost: false, out });

    expect(guest.m, 'a guest cannot invent a mission — it has no hand yet').toBeNull();
    expect(kinds(out, 'need'), 'a guest that says nothing waits forever, and looks identical to a hang').toHaveLength(1);
    expect(kinds(out, 'need')[0].to, 'the ask must reach whoever is hosting, so it goes to everyone').toBeUndefined();
  });

  it('a host answers a `need` with that peer’s own hand AND the public log', () => {
    const out: Sent[] = [];
    const host = mkSession({ players: 2, mySeat: 0, isHost: true, out });
    expect(host.m, 'the host deals the moment it exists').not.toBeNull();
    out.length = 0;

    host.receive({ t: 'need', mn: 1 }, 'p1');

    const deals = kinds(out, 'deal');
    expect(deals, 'the host ignored a peer asking to be dealt in').toHaveLength(1);
    expect(deals[0].to, 'a hand is the one private message in the game and must be unicast').toBe('p1');
    const deal = deals[0].msg as Extract<WireMsg, { t: 'deal' }>;
    expect(deal.seat, 'the host re-dealt the wrong seat').toBe(1);
    expect(deal.hand, 'the re-deal must carry the same hand that seat already had').toEqual(
      host.m!.setup.deal[1],
    );
    expect(kinds(out, 'log'), 'a hand without the log leaves the guest unable to catch up').toHaveLength(1);
  });

  it('a host answers a `need` from a seatless peer with the log alone, rather than throwing', () => {
    const out: Sent[] = [];
    const host = mkSession({ players: 2, mySeat: 0, isHost: true, out });
    out.length = 0;

    expect(() => host.receive({ t: 'need', mn: 1 }, 'stranger'), 'an unknown peer must not break the host').not.toThrow();
    expect(kinds(out, 'deal'), 'a peer with no seat has no hand to be given').toHaveLength(0);
    expect(kinds(out, 'log'), 'a spectator that asks must still be caught up').toHaveLength(1);
  });

  it('the host re-sends everything on its heartbeat, so a LOST `need` still recovers', () => {
    const out: Sent[] = [];
    const host = mkSession({ players: 3, mySeat: 0, isHost: true, out });
    out.length = 0;

    host.beat();

    expect(kinds(out, 'deal'), 'the heartbeat must re-deal every seat but the host’s own').toHaveLength(2);
    expect(kinds(out, 'log'), 'the heartbeat must carry the public log too').toHaveLength(1);
  });
});

describe('a guest that disagrees with the host asks to be re-dealt', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    live = [];
  });
  afterEach(() => {
    for (const s of live) s.destroy();
    vi.useRealTimers();
  });

  function dealtGuest(hostOut: Sent[], guestOut: Sent[]): { host: Session; guest: Session } {
    const host = mkSession({ players: 2, mySeat: 0, isHost: true, out: hostOut });
    const guest = mkSession({ players: 2, mySeat: null, isHost: false, out: guestOut });
    const deal = kinds(hostOut, 'deal').find((s) => s.to === 'p1')!.msg;
    guest.receive(deal, 'h');
    return { host, guest };
  }

  it('a log it believes illegal produces a `need`, not a wrong board', () => {
    const hostOut: Sent[] = [];
    const guestOut: Sent[] = [];
    const { guest } = dealtGuest(hostOut, guestOut);
    expect(guest.m, 'the guest never took the deal').not.toBeNull();
    expect(guest.mySeat, 'the deal is what tells a guest which seat it is in').toBe(1);
    guestOut.length = 0;

    // A log the guest cannot replay: a card played while the mission is still drafting. Whatever the
    // cause — a stale build, a promoted host that rebuilt from different hands — the guest must not
    // paint half of it.
    guest.receive({ t: 'log', mn: 1, log: [packAct(A_PLAY, 1, 0x11)] }, 'h');

    expect(kinds(guestOut, 'need'), 'the guest swallowed a log it could not replay and rendered it anyway')
      .toHaveLength(1);
    expect(guest.m!.log, 'a failed replay must leave nothing half-applied').toHaveLength(0);
    expect(guest.m!.phase, 'the guest advanced past the draft on a log it rejected').toBe('draft');
  });

  it('but a log it CAN replay is applied silently — the ask is not the default', () => {
    const hostOut: Sent[] = [];
    const guestOut: Sent[] = [];
    const { host, guest } = dealtGuest(hostOut, guestOut);
    guestOut.length = 0;
    hostOut.length = 0;

    // Drive one real draft pick on the host, whichever seat is to draft, and hand the guest the log
    // the host actually broadcast.
    const s = host.m!.draftTurn;
    const pick = draftableFor(host.m!, s, host.m!.draftRelaxed)[0];
    if (s === 0) host.submit(packAct(A_DRAFT, 0, pick));
    else host.receive({ t: 'act', mn: 1, act: packAct(A_DRAFT, s, pick) }, 'p1');
    const log = kinds(hostOut, 'log').at(-1)!.msg as Extract<WireMsg, { t: 'log' }>;
    expect(log.log, 'the host did not apply the draft pick at all').toHaveLength(1);

    guest.receive(log, 'h');

    expect(kinds(guestOut, 'need'), 'the guest asked to be re-dealt over a log that was perfectly good')
      .toHaveLength(0);
    expect(guest.m!.log, 'the guest did not adopt the host’s history').toEqual(log.log);
  });

  it('a stale log from before a promotion is ignored rather than rewinding the board', () => {
    const hostOut: Sent[] = [];
    const guestOut: Sent[] = [];
    const { host, guest } = dealtGuest(hostOut, guestOut);
    hostOut.length = 0;
    const s = host.m!.draftTurn;
    const pick = draftableFor(host.m!, s, host.m!.draftRelaxed)[0];
    if (s === 0) host.submit(packAct(A_DRAFT, 0, pick));
    else host.receive({ t: 'act', mn: 1, act: packAct(A_DRAFT, s, pick) }, 'p1');
    guest.receive(kinds(hostOut, 'log').at(-1)!.msg, 'h');
    expect(guest.m!.log).toHaveLength(1);
    guestOut.length = 0;

    guest.receive({ t: 'log', mn: 1, log: [] }, 'h');

    expect(guest.m!.log, 'a shorter log must never roll the mission backwards').toHaveLength(1);
    expect(kinds(guestOut, 'need'), 'a stale broadcast is not a disagreement worth a re-deal').toHaveLength(0);
  });
});

describe('a promoted host always finishes rebuilding', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    live = [];
  });
  afterEach(() => {
    for (const s of live) s.destroy();
    vi.useRealTimers();
  });

  function promote(players: number): { host: Session; guest: Session; guestOut: Sent[] } {
    const hostOut: Sent[] = [];
    const guestOut: Sent[] = [];
    const host = mkSession({ players, mySeat: 0, isHost: true, out: hostOut });
    const guest = mkSession({ players, mySeat: null, isHost: false, out: guestOut });
    guest.receive(kinds(hostOut, 'deal').find((s) => s.to === 'p1')!.msg, 'h');
    guest.peerLeft('h');
    guestOut.length = 0;
    guest.becomeHost();
    return { host, guest, guestOut };
  }

  it('a two-player room needs no answer at all: the missing hand is the rest of the deck', () => {
    const { host, guest } = promote(2);

    expect(guest.rebuilding, 'a two-player rebuild has nothing to wait for and must not wait').toBe(false);
    const derived = [...(guest.m!.setup.deal[0] as number[])].sort((a, b) => a - b);
    const truth = [...(host.m!.setup.deal[0] as number[])].sort((a, b) => a - b);
    expect(derived, 'the derived hand is not the hand the old host actually dealt').toEqual(truth);
    expect(derived.length, 'the derived hand is the wrong size').toBe(handSize(2));
    expect(
      derived.every((c) => buildDeck(2).includes(c)),
      'the derived hand contains a card that is not in the deck',
    ).toBe(true);
  });

  it('it asks the room, and carries on with holes when the room never answers', () => {
    const { guest, guestOut } = promote(4);

    expect(kinds(guestOut, 'claim'), 'a promoted host that never claims can never rebuild').toHaveLength(1);
    expect(guest.rebuilding, 'with three unknown hands it must wait for at least a moment').toBe(true);
    expect(guest.submit(packAct(A_PLAY, 1, 0x11)), 'nothing may be committed mid-rebuild').toBe(false);

    // The screen ticks on an interval precisely so that a rebuild nobody answers still ends.
    vi.advanceTimersByTime(5000);
    guest.tick();

    expect(guest.rebuilding, 'the room stayed frozen because two peers never answered the claim').toBe(false);
    expect(guest.m, 'the mission was thrown away instead of carried on with holes').not.toBeNull();
    expect(guest.m!.setup.deal[1], 'the promoted host forgot its OWN hand').not.toBeNull();
  });

  it('a peer answering the claim ends the wait immediately, without the timeout', () => {
    const hostOut: Sent[] = [];
    const guestOut: Sent[] = [];
    const host = mkSession({ players: 3, mySeat: 0, isHost: true, out: hostOut });
    const guest = mkSession({ players: 3, mySeat: null, isHost: false, out: guestOut });
    guest.receive(kinds(hostOut, 'deal').find((s) => s.to === 'p1')!.msg, 'h');
    guest.peerLeft('h');
    guest.becomeHost();
    expect(guest.rebuilding).toBe(true);

    // Seat 2 attests; seat 0 (the host that left) is then the only hole, so it is derivable.
    guest.receive({ t: 'att', mn: 1, seat: 2, hand: [...(host.m!.setup.deal[2] as number[])] }, 'p2');

    expect(guest.rebuilding, 'every hand is now known and the rebuild still did not finish').toBe(false);
    expect(
      [...(guest.m!.setup.deal[0] as number[])].sort((a, b) => a - b),
      'the derived hand for the departed host is wrong',
    ).toEqual([...(host.m!.setup.deal[0] as number[])].sort((a, b) => a - b));
    expect(kinds(guestOut, 'log'), 'the new host must publish the log it is now the authority on').not.toHaveLength(0);
  });

  it('a mission already over does not start a rebuild that could never end', () => {
    const hostOut: Sent[] = [];
    const guestOut: Sent[] = [];
    const host = mkSession({ players: 3, mySeat: 0, isHost: true, out: hostOut });
    const guest = mkSession({ players: 3, mySeat: null, isHost: false, out: guestOut });
    guest.receive(kinds(hostOut, 'deal').find((s) => s.to === 'p1')!.msg, 'h');
    guest.m!.phase = 'over';
    guestOut.length = 0;

    guest.becomeHost();

    expect(guest.rebuilding, 'a finished mission has nothing to re-attest and must not block the summary').toBe(false);
    expect(kinds(guestOut, 'claim'), 'nobody should be asked to re-attest a mission that already ended').toHaveLength(0);
  });
});

describe('a crewmate walking out does not stop the board', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    live = [];
  });
  afterEach(() => {
    for (const s of live) s.destroy();
    vi.useRealTimers();
  });

  const run = (ms: number): void => {
    for (let t = 0; t < ms; t += 700) vi.advanceTimersByTime(700);
  };

  it('the vacated seat is PLAYED by the crew, and the mission finishes', () => {
    const out: Sent[] = [];
    let ended = false;
    // This client hosts and drives seats 0 and 1 itself; seat 2 is a live peer. So the mission is
    // expected to stall on seat 2 — that is correct — and must stop stalling the moment it leaves.
    const s = mkSession({
      players: 3,
      mySeat: null,
      isHost: true,
      bots: [0, 1],
      peerOfSeat: ['', '', 'p2'],
      out,
      onEnd: () => {
        ended = true;
      },
    });

    run(60_000);
    const m = s.m!;
    expect(isOver(m), 'the mission finished without seat 2, which is a live peer, ever playing').toBe(false);
    const waitingOn = m.phase === 'draft' ? m.draftTurn : m.turn;
    expect(waitingOn, 'the crew stalled on a seat it is supposed to be driving itself').toBe(2);
    expect(s.abandoned.size, 'nobody has left yet').toBe(0);

    s.peerLeft('p2');
    run(120_000);

    expect(s.abandoned.has(2), 'a seat whose peer vanished must be marked as abandoned').toBe(true);
    expect(isOver(s.m!), 'the mission never restarted after the seat was picked up by the crew').toBe(true);
    expect(ended, 'the mission ended and nobody was told').toBe(true);
  });

  it('a room that has collapsed to one is a walkover, not an eternal wait', () => {
    const out: Sent[] = [];
    const s = mkSession({ players: 2, mySeat: 0, isHost: true, out });

    expect(s.alone(), 'a full room is not a walkover').toBe(false);
    s.peerLeft('p1');
    expect(s.alone(), 'the last crewmate left and the mission would wait forever for them').toBe(true);
  });
});
