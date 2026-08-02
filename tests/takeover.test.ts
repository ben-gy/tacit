/**
 * takeover.test.ts — live-P2P contract gate #2, HOST TRANSFER.
 *
 * WHY THIS FILE EXISTS. Tacit is host-authoritative AND the hands are genuinely hidden, so the host
 * is the only machine in the room that can adjudicate anything. When it walks out it takes the only
 * copy of the deal with it. A previous game in this fleet shipped this gate broken, and the symptom
 * was not a crash: the survivor sat on a board that never moved again. So "it did not throw" proves
 * nothing here. Every takeover case below has to REACH isOver() — an actual ending — with real,
 * legal actions flowing through the promoted host.
 *
 * It is proven without a network: Session takes its transport as `deps.send`, so a handful of
 * Sessions wired to each other by hand IS the mesh. What is under test is the PROTOCOL — claim /
 * att / deriveMissing / replay — which has to be right before transport is interesting;
 * net-lifecycle.test.ts and host-election.test.ts guard the transport and the election themselves.
 *
 * The specific defects guarded:
 *   - a draft step that each peer works out for itself, so a guest can never replay the host again;
 *   - a guest that applies its own moves locally (two divergent copies of a hidden-hand game);
 *   - a host that takes a peer's word for a seat it does not occupy, or a card it does not hold;
 *   - a `deal` that carries somebody else's cards;
 *   - a rebuild that replays to a DIFFERENT position than the host it inherited from;
 *   - a rebuild that never finishes because one peer's `att` was dropped;
 *   - a seat whose peer walked out, or never answered, and that nobody drives afterwards.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildDeck, sortHand } from '../src/cards';
import { chooseCard, chooseDraft, viewFor } from '../src/bot';
import { modeOf } from '../src/modes';
import {
  A_DRAFT,
  A_PASS,
  A_PLAY,
  actKind,
  actSeat,
  draftableFor,
  isOver,
  legalFor,
  packAct,
  type Mission,
} from '../src/mission';
import { Session, type SessionInit, type WireMsg } from '../src/session';

// ── the mesh, such as it is ─────────────────────────────────────────────────────

interface Envelope {
  from: string;
  to?: string | string[];
  m: WireMsg;
}

/**
 * Sessions wired to each other. Delivery is QUEUED and drained FIFO by pump(), so a message sent
 * while another is being handled lands behind it rather than re-entering the receiver — which is
 * what a channel does and what a direct call does not.
 *
 * The storm guard counts DELIVERIES, not rounds: a peer that cannot replay the host's log answers
 * every broadcast with another `need`, and one `need` fans back out to the whole room, so a failure
 * to converge grows rather than repeats.
 */
class Room {
  readonly sent: Envelope[] = [];
  readonly delivered: Array<{ to: string; from: string; m: WireMsg }> = [];
  private readonly sessions = new Map<string, Session>();
  private readonly queue: Envelope[] = [];
  private readonly live = new Set<string>();
  private readonly deaf = new Set<string>();

  spawn(id: string, init: Omit<SessionInit, 'deps'>): Session {
    // Live before construction: a guest's constructor sends `need` the moment it exists.
    this.live.add(id);
    const s = new Session({
      ...init,
      deps: {
        send: (m, to) => {
          if (!this.live.has(id)) return;
          const e: Envelope = { from: id, to, m: structuredClone(m) };
          this.queue.push(e);
          this.sent.push(e);
        },
        onChange: () => {},
        onEvents: () => {},
        onEnd: () => {},
      },
    });
    this.sessions.set(id, s);
    return s;
  }

  get(id: string): Session {
    const s = this.sessions.get(id);
    if (!s) throw new Error(`room: no session ${id}`);
    return s;
  }

  isLive(id: string): boolean {
    return this.live.has(id);
  }

  /** The phone went away. Anything already queued is in flight; nothing after it is. */
  kill(id: string): void {
    this.live.delete(id);
    this.sessions.get(id)?.destroy();
  }

  /** Still in the room, but nothing reaches it — one dropped `claim` looks exactly like this. */
  mute(id: string): void {
    this.deaf.add(id);
  }

  unmute(id: string): void {
    this.deaf.delete(id);
  }

  pump(): void {
    let n = 0;
    while (this.queue.length > 0) {
      if (++n > 600) throw new Error('room: message storm — the protocol did not converge');
      const e = this.queue.shift()!;
      const targets =
        e.to === undefined ? [...this.live].filter((p) => p !== e.from) : Array.isArray(e.to) ? e.to : [e.to];
      for (const t of targets) {
        if (t === e.from || !this.live.has(t) || this.deaf.has(t)) continue;
        const copy = structuredClone(e.m);
        this.delivered.push({ to: t, from: e.from, m: copy });
        this.get(t).receive(copy, e.from);
      }
    }
  }

  msgs(t: WireMsg['t']): Envelope[] {
    return this.sent.filter((e) => e.m.t === t);
  }
}

interface Crew {
  room: Room;
  ids: string[];
  /** The session sitting in `seat`, whether it is still in the room or not. */
  at: (seat: number) => Session;
  /** The opening hands as the original host dealt them, sorted. The answer key. */
  opening: number[][];
}

/**
 * A room mid-deal: seat 0 hosts, everybody else is a guest that has been dealt in and has caught up.
 *
 * Only the host gets a real `dealSeed`. The guests are handed 0 on purpose — if a guest ever ends
 * up holding a hand it did not receive on the wire, that hand came from a shared number, and a hand
 * derived from a shared number is not hidden information.
 *
 * The seeds below are not decorative: see the note on `play()`.
 */
function openRoom(
  o: { modeId?: string; mission?: number; ids?: string[]; poolSeed?: number; dealSeed?: number } = {},
): Crew {
  const ids = o.ids ?? ['a', 'b', 'c'];
  const mode = modeOf(o.modeId ?? 'aside');
  const room = new Room();
  const names = ids.map((id) => id.toUpperCase());

  ids.forEach((id, seat) => {
    room.spawn(id, {
      mode,
      mission: o.mission ?? 3,
      players: ids.length,
      mySeat: seat,
      // A networked crew drives no bots at all until somebody walks out.
      bots: new Set<number>(),
      isHost: seat === 0,
      names: [...names],
      peerOfSeat: [...ids],
      poolSeed: o.poolSeed ?? 3007,
      dealSeed: seat === 0 ? (o.dealSeed ?? 3_668_339_987) : 0,
    });
  });
  room.pump();

  const host = room.get(ids[0]);
  expect(host.m, 'the host never built a mission').not.toBeNull();
  const opening = host.m!.setup.deal.map((h) => sortHand(h!));
  return { room, ids, at: (seat) => room.get(ids[seat]), opening };
}

// ── driving a mission through whoever is holding it ─────────────────────────────

const seatToMove = (m: Mission): number => (m.phase === 'draft' ? m.draftTurn : m.turn);

/**
 * The next action for whoever is to move, chosen from the AUTHORITATIVE mission — the only copy in
 * which every hand is visible. Picked with the shipped bot so the mission plays out like a real one
 * instead of collapsing on trick one.
 */
function nextAction(m: Mission): number | null {
  const seat = seatToMove(m);
  if (seat < 0) return null;
  if (m.phase === 'draft') {
    const avail = draftableFor(m, seat, m.draftRelaxed);
    if (avail.length === 0) return null;
    const taken = m.tasks.filter((t) => t.owner !== -1).length;
    return packAct(A_DRAFT, seat, chooseDraft(viewFor(m, seat), avail, taken));
  }
  const allowed = legalFor(m, seat);
  if (allowed.length === 0) return null;
  const wanted = chooseCard(viewFor(m, seat));
  return packAct(A_PLAY, seat, allowed.includes(wanted) ? wanted : allowed[0]);
}

/**
 * One action, from whoever is to move, proposed by the peer that actually occupies that seat.
 *
 * Who that is comes from the HOST's own `peerOfSeat`, not from the test's idea of who is connected,
 * because that is the list the host adjudicates against: a seat it has written off is one whose
 * proposals it will now refuse. A seat with nobody behind it is then the host's own problem — there
 * we advance the clock instead and let the crew's bot cover it, which is requirement 7.
 *
 * Returns false when the position did not move — a frozen board, which is the failure this whole
 * file exists to catch.
 */
function step(room: Room, host: Session): boolean {
  const m = host.m;
  if (!m || isOver(m) || host.rebuilding) return false;
  const before = m.log.length;
  const seat = seatToMove(m);
  const id = seat >= 0 ? host.peerOfSeat[seat] : '';
  const owner = id && room.isLive(id) ? room.get(id) : null;
  const act = nextAction(m);

  if (owner && act !== null) {
    owner.submit(act);
    room.pump();
  } else {
    vi.advanceTimersByTime(1500);
    room.pump();
  }
  return m.log.length > before;
}

/**
 * Play exactly `actions` actions so the takeover lands mid-mission.
 *
 * The seeds every test passes to openRoom() were picked so the crew survives well past this point —
 * a mission that has already ended has no takeover to test.
 */
function play(room: Room, host: Session, actions: number): void {
  for (let i = 0; i < actions; i++) {
    expect(step(room, host), `the mission stalled after ${i} of ${actions} actions`).toBe(true);
  }
}

function driveToEnd(room: Room, host: Session, why: string): number {
  let taken = 0;
  for (let i = 0; i < 800 && !isOver(host.m!); i++) {
    if (!step(room, host)) break;
    taken++;
  }
  expect(isOver(host.m!), why).toBe(true);
  return taken;
}

/** Everything about a position that two peers have to agree on, exactly. */
function position(m: Mission): unknown {
  return {
    log: [...m.log],
    phase: m.phase,
    turn: m.turn,
    lead: m.lead,
    trickNo: m.trickNo,
    trick: [...m.trick],
    tricksWon: [...m.tricksWon],
    seen: [...m.seen],
    seenBy: [...m.seenBy],
    signalsLeft: [...m.signalsLeft],
    signals: m.signals.map((s) => ({ ...s })),
    tasks: m.tasks.map((t) => ({
      card: t.card,
      owner: t.owner,
      order: t.order,
      finale: t.finale,
      discarded: t.discarded,
      done: t.done,
      trick: t.trick,
    })),
  };
}

/** The realistic promotion, in the order net.ts fires it: onPeerLeave BEFORE onHostChange. */
function promote(crew: Crew, deadSeat: number, newHostSeat: number): Session {
  const { room, ids } = crew;
  room.kill(ids[deadSeat]);
  for (const id of ids) {
    if (id === ids[deadSeat] || !room.isLive(id)) continue;
    room.get(id).peerLeft(ids[deadSeat]);
  }
  const promoted = crew.at(newHostSeat);
  promoted.becomeHost();
  room.pump();
  return promoted;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// ── (0) the guest has to be able to replay the host's log at all ───────────────

describe('every peer replays the same history', () => {
  it('a seat that can take nothing PASSES in the log, rather than being silently skipped', () => {
    // This fixture deals seat 2 every single candidate in the pool, so it cannot take anything under
    // the own-hand rule and the draft has to walk past it. THE SKIP MUST BE AN ACTION IN THE LOG.
    // Working it out per peer cannot work: only the host can see seat 2's hand, so a guest computes
    // a different next drafter, its replay of the host's log fails, and it answers every broadcast
    // with `need` — a room that never converges, from one unlucky deal. Found by this file before
    // A_PASS existed; kept because the seed still reproduces it exactly.
    const crew = openRoom({ poolSeed: 90_210, dealSeed: 0x51ce_d00d });
    const { room } = crew;
    const host = crew.at(0);
    play(room, host, 6);

    expect(
      host.m!.log.some((a) => actKind(a) === A_PASS),
      'this fixture is meant to force a seat to pass — if it no longer does, it is guarding nothing',
    ).toBe(true);
    for (const seat of [1, 2]) {
      expect(crew.at(seat).m!.log, `seat ${seat} could not replay the host's draft`).toEqual(host.m!.log);
      expect(position(crew.at(seat).m!), `seat ${seat} replayed to a different position`).toEqual(
        position(host.m!),
      );
    }
  });
});

// ── (1) a guest is not allowed to move the game on its own ─────────────────────

describe('before any promotion, only the host moves the game', () => {
  it('a guest PROPOSES: submit() sends `act` and does not touch its own log', () => {
    const crew = openRoom();
    const { room } = crew;
    const host = crew.at(0);
    const guest = crew.at(1);

    // Walk the draft round to seat 1 so the guest genuinely has something legal to propose.
    while (seatToMove(host.m!) !== 1) expect(step(room, host), 'the draft never reached seat 1').toBe(true);

    const act = nextAction(host.m!)!;
    const guestLog = guest.m!.log.length;
    const hostLog = host.m!.log.length;
    const actsBefore = room.msgs('act').length;

    expect(guest.submit(act), 'a guest must accept the tap and forward it').toBe(true);
    expect(room.msgs('act').length, 'the guest kept the action to itself instead of proposing it').toBe(actsBefore + 1);
    expect(
      guest.m!.log.length,
      'the guest applied its own action locally — that is two copies of a hidden-hand game, and they will disagree',
    ).toBe(guestLog);
    expect(host.m!.log.length, 'the host must not have seen it yet').toBe(hostLog);

    room.pump();
    expect(host.m!.log.length, 'the host never adjudicated the proposal').toBe(hostLog + 1);
    expect(guest.m!.log, 'the guest must adopt the action only when the host broadcasts it back').toEqual(host.m!.log);
  });

  it('the host throws out a proposal for a seat the sender does not occupy', () => {
    // The seat is packed into the action's own bits, so a peer can name any seat it likes. If the
    // host does not check that the seat belongs to the sender, one crewmate can play EVERYBODY's
    // cards — which in a game whose entire subject is that you cannot coordinate is not so much a
    // cheat as a different and much worse game. Mutation-checked: deleting the one-line check in
    // Session.receive turns this test red and nothing else in the suite notices.
    const crew = openRoom();
    const { room, ids } = crew;
    const host = crew.at(0);

    // Wind the draft to a seat that is NOT seat 1, then have seat 1's peer propose it anyway.
    while (seatToMove(host.m!) === 1) expect(step(room, host), 'the draft stalled').toBe(true);
    const victim = seatToMove(host.m!);
    expect(victim, 'this test needs a seat other than the impersonator to be on move').not.toBe(1);

    const act = nextAction(host.m!)!;
    const before = host.m!.log.length;

    // Seat 1's peer ('b') sends an action stamped with somebody else's seat, straight at the host.
    host.receive({ t: 'act', mn: host.mission, act }, ids[1]);
    room.pump();

    expect(
      host.m!.log.length,
      `the host executed an action for seat ${victim} that arrived from seat 1's peer`,
    ).toBe(before);

    // And the same action from the peer that really does hold that seat is accepted, so the check is
    // rejecting the impersonation rather than rejecting everything.
    host.receive({ t: 'act', mn: host.mission, act }, ids[victim]);
    room.pump();
    expect(host.m!.log.length, 'the rightful seat was refused too — the check is too strict').toBe(before + 1);
  });

  it('the host throws out a proposal that is out of turn', () => {
    const crew = openRoom();
    const { room, ids } = crew;
    const host = crew.at(0);
    const guest = crew.at(1);
    play(room, host, 6);
    expect(host.m!.phase).toBe('play');

    const notTheirTurn = (host.m!.turn + 1) % ids.length;
    const card = host.m!.hands[notTheirTurn]![0];
    const before = host.m!.log.length;

    guest.submit(packAct(A_PLAY, notTheirTurn, card));
    room.pump();
    expect(host.m!.log.length, 'a card played out of turn was written into the shared history').toBe(before);
  });

  it('the host throws out a card the proposer does not hold', () => {
    const crew = openRoom();
    const { room, ids } = crew;
    const host = crew.at(0);
    play(room, host, 6);
    expect(host.m!.phase).toBe('play');

    // Whoever is to move, propose a card that is in somebody ELSE's hand. Only the host can tell.
    const seat = host.m!.turn;
    const other = (seat + 1) % ids.length;
    const notMine = host.m!.hands[other]!.find((c) => !host.m!.hands[seat]!.includes(c))!;
    const before = host.m!.log.length;

    crew.at(seat).submit(packAct(A_PLAY, seat, notMine));
    room.pump();
    expect(
      host.m!.log.length,
      'the host took a peer’s word for a card it does not hold — the host is the only thing that can check',
    ).toBe(before);
  });
});

// ── (2) the deal is private ────────────────────────────────────────────────────

describe('the deal reaches exactly one pair of eyes', () => {
  it('a guest learns its own hand and NOTHING about anyone else', () => {
    const crew = openRoom();
    const { room, ids } = crew;
    const guest = crew.at(1);
    const m = guest.m!;

    expect(m.setup.deal[1], 'the guest was never dealt in').not.toBeNull();
    expect(sortHand(m.hands[1]!), 'the guest holds a different hand than the host dealt it').toEqual(crew.opening[1]);

    for (let seat = 0; seat < ids.length; seat++) {
      if (seat === 1) continue;
      expect(
        m.hands[seat],
        `seat ${seat}'s cards are visible to a crewmate — the whole game is hidden information`,
      ).toBeNull();
      expect(m.setup.deal[seat], `seat ${seat}'s opening hand leaked into the guest's setup`).toBeNull();
    }

    // And nothing that reached this guest on the wire ever carried anybody else's cards.
    const dealt = room.delivered.filter((d) => d.to === 'b' && d.m.t === 'deal');
    expect(dealt.length, 'the guest was never sent a deal').toBeGreaterThan(0);
    for (const d of dealt) {
      const msg = d.m as Extract<WireMsg, { t: 'deal' }>;
      expect(msg.seat, 'the host unicast a guest somebody else’s seat').toBe(1);
      expect(sortHand(msg.hand), 'a deal message carried cards that are not this seat’s').toEqual(crew.opening[1]);
    }
  });
});

// ── (3) the rebuild ────────────────────────────────────────────────────────────

describe('a promoted peer rebuilds the whole deal and the exact position', () => {
  it('it claims, the room attests, and the mission is where the dead host left it', () => {
    const crew = openRoom();
    const { room, ids } = crew;
    const oldHost = crew.at(0);
    play(room, oldHost, 14);
    expect(oldHost.m!.phase, 'the takeover must land mid-mission, not during the draft').toBe('play');
    const was = position(oldHost.m!);

    const claimsBefore = room.msgs('claim').length;
    const attsBefore = room.msgs('att').length;
    const newHost = promote(crew, 0, 1);

    expect(room.msgs('claim').length - claimsBefore, 'a promoted peer must announce itself').toBe(1);
    expect(
      room.msgs('att').length - attsBefore,
      'the surviving crewmate never re-attested — the new host is guessing at the deal',
    ).toBe(1);
    expect(newHost.rebuilding, 'the rebuild never finished, so nobody can move').toBe(false);

    for (let seat = 0; seat < ids.length; seat++) {
      const hand = newHost.m!.setup.deal[seat];
      expect(hand, `the new host has no idea what seat ${seat} was dealt`).not.toBeNull();
      expect(sortHand(hand!), `seat ${seat}'s rebuilt opening hand is not the one that was dealt`).toEqual(
        crew.opening[seat],
      );
    }
    expect(position(newHost.m!), 'the replay landed on a different position than the host it inherited from').toEqual(
      was,
    );
  });

  it('the callbacks arriving the other way round rebuilds just the same', () => {
    // net.ts fires onPeerLeave before onHostChange, but a promotion that only works in one order is
    // a bug waiting for a different transport.
    const crew = openRoom();
    const { room, ids } = crew;
    play(room, crew.at(0), 14);
    const was = position(crew.at(0).m!);

    room.kill(ids[0]);
    const newHost = crew.at(1);
    newHost.becomeHost();
    room.pump();
    for (const id of ids) if (room.isLive(id)) room.get(id).peerLeft(ids[0]);
    room.pump();

    expect(newHost.rebuilding, 'the rebuild hung when the promotion arrived before the departure').toBe(false);
    expect(newHost.m!.setup.deal.every((h) => h !== null), 'a hand went missing').toBe(true);
    expect(position(newHost.m!)).toEqual(was);
    expect(newHost.abandoned.has(0), 'the dead host’s seat must be marked abandoned so the crew covers it').toBe(true);
  });

  it('the surviving guest is still in step with the new host afterwards', () => {
    const crew = openRoom();
    const { room } = crew;
    play(room, crew.at(0), 14);
    const newHost = promote(crew, 0, 1);
    const guest = crew.at(2);

    expect(guest.m!.log, 'the guest fell behind the new host at the moment of the handover').toEqual(newHost.m!.log);
    expect(position(guest.m!)).toEqual(position(newHost.m!));
    expect(guest.m!.hands[1], 'the takeover leaked the new host’s hand to the room').toBeNull();
  });
});

// ── (4) THE ONE THAT MATTERS ───────────────────────────────────────────────────

describe('the mission KEEPS RUNNING under the new host', () => {
  it('reaches an actual ending, with real actions, after the host walked out', () => {
    const crew = openRoom();
    const { room } = crew;
    play(room, crew.at(0), 14);
    const newHost = promote(crew, 0, 1);
    const before = newHost.m!.log.length;

    const taken = driveToEnd(room, newHost, 'the survivor is stuck on a frozen board — the mission never ended');
    expect(taken, 'the mission "ended" without anybody actually playing after the takeover').toBeGreaterThan(4);
    // At LEAST one log entry per driven action, and legitimately more: the seat whose player walked
    // out is now covered by the crew's own bot, and its plays land in the same log. An exact equality
    // here would be asserting that the abandoned seat stopped playing, which is the bug this whole
    // file exists to catch.
    expect(newHost.m!.log.length, 'driven actions did not reach the log').toBeGreaterThanOrEqual(before + taken);
    expect(newHost.m!.reason, 'a finished mission must say why it finished').not.toBe('');

    // And the survivor that did NOT get promoted saw the same ending, rather than being left behind.
    const guest = crew.at(2);
    expect(isOver(guest.m!), 'the other survivor is still sitting on a live board').toBe(true);
    expect(guest.m!.log, 'the two survivors ended on different histories').toEqual(newHost.m!.log);
    expect(guest.m!.success).toBe(newHost.m!.success);
  });

  it('holds for every mode, including the one with no signals at all', () => {
    for (const modeId of ['aside', 'hush', 'runorder']) {
      const crew = openRoom({ modeId, mission: 6, poolSeed: 7007, dealSeed: 1_401_181_143 });
      const { room } = crew;
      play(room, crew.at(0), 12);
      const newHost = promote(crew, 0, 1);
      expect(newHost.rebuilding, `${modeId}: the rebuild never finished`).toBe(false);
      driveToEnd(room, newHost, `${modeId}: the mission froze after the host left`);
    }
  });

  it('holds at four crew, where two seats are still live peers', () => {
    const crew = openRoom({ ids: ['a', 'b', 'c', 'd'], mission: 5, poolSeed: 1007, dealSeed: 2_654_435_761 });
    const { room } = crew;
    play(room, crew.at(0), 16);
    const newHost = promote(crew, 0, 1);

    expect(room.msgs('att'), 'both surviving crewmates must re-attest at four players').toHaveLength(2);
    for (let seat = 0; seat < 4; seat++) {
      expect(sortHand(newHost.m!.setup.deal[seat]!), `seat ${seat} was rebuilt wrong`).toEqual(crew.opening[seat]);
    }
    driveToEnd(room, newHost, 'four crew, host gone, board frozen');
  });
});

// ── (5) deriveMissing ──────────────────────────────────────────────────────────

describe('a two-player room needs no answer from anybody', () => {
  it('the survivor derives the dead host’s hand as the deck minus its own', () => {
    const crew = openRoom({ ids: ['a', 'b'], mission: 4 });
    const { room } = crew;
    play(room, crew.at(0), 10);

    const attsBefore = room.msgs('att').length;
    const survivor = promote(crew, 0, 1);

    expect(room.msgs('att').length, 'nobody was left to answer, and none was needed').toBe(attsBefore);
    expect(survivor.rebuilding, 'the survivor sat waiting four seconds for a room that is empty').toBe(false);

    const derived = survivor.m!.setup.deal[0];
    expect(derived, 'the dead host’s hand was not reconstructed at all').not.toBeNull();
    expect(sortHand(derived!), 'the derived hand is not the one that was dealt').toEqual(crew.opening[0]);

    // Stated independently of the game: it is the deck, minus the hand the survivor is holding.
    const mine = new Set(crew.opening[1]);
    expect(sortHand(derived!)).toEqual(sortHand(buildDeck(2).filter((c) => !mine.has(c))));

    expect(survivor.alone(), 'a room down to one is a walkover, and main.ts has to be told').toBe(true);
    driveToEnd(room, survivor, 'the last player alive cannot finish the mission');
  });
});

// ── (6) a peer that never answers ──────────────────────────────────────────────

describe('a rebuild that one peer never answers still finishes', () => {
  it('the four-second window closes, the silent seat stays null, and the host adjudicates again', () => {
    const crew = openRoom({ ids: ['a', 'b', 'c', 'd'], mission: 5, poolSeed: 1007, dealSeed: 2_654_435_761 });
    const { room } = crew;
    play(room, crew.at(0), 16);

    // Seat 3's channel drops the claim. Everything else about that peer is fine — it is still there,
    // it still knows its own hand, and it will keep playing.
    room.mute('d');
    const newHost = promote(crew, 0, 1);

    expect(newHost.rebuilding, 'a rebuild must WAIT for the room before carrying on with holes').toBe(true);
    expect(newHost.submit(0), 'a host in the middle of a rebuild must refuse to adjudicate').toBe(false);
    expect(newHost.m!.setup.deal[3], 'seat 3 cannot be known yet — it never answered').toBeNull();

    // Three seconds of tick()s is not enough: a peer on a slow phone deserves the whole window.
    for (let t = 0; t < 3000; t += 250) {
      vi.advanceTimersByTime(250);
      newHost.tick();
      room.pump();
    }
    expect(newHost.rebuilding, 'the window closed early on a peer that was about to answer').toBe(true);

    for (let t = 0; t < 3000; t += 250) {
      vi.advanceTimersByTime(250);
      newHost.tick();
      room.pump();
    }
    expect(
      newHost.rebuilding,
      'the rebuild never finished — every survivor is frozen, waiting on one silent peer',
    ).toBe(false);
    expect(newHost.m!.setup.deal[3], 'a seat nobody attested must be left null, not invented').toBeNull();
    expect(sortHand(newHost.m!.setup.deal[2]!), 'the seat that DID answer was rebuilt wrong').toEqual(crew.opening[2]);
    expect(sortHand(newHost.m!.setup.deal[1]!), 'the new host lost track of its own hand').toEqual(crew.opening[1]);
  });

  it('the silent seat is treated as EMPTY: the crew covers it and the mission reaches an ending', () => {
    const crew = openRoom({ ids: ['a', 'b', 'c', 'd'], mission: 5, poolSeed: 1007, dealSeed: 2_654_435_761 });
    const { room } = crew;
    play(room, crew.at(0), 16);
    // The channel that dropped the claim stays down: a peer that cannot answer a claim is, as far as
    // this room can tell, a peer that has gone.
    room.mute('d');
    const newHost = promote(crew, 0, 1);
    for (let t = 0; t < 5000; t += 250) {
      vi.advanceTimersByTime(250);
      newHost.tick();
      room.pump();
    }
    expect(newHost.rebuilding).toBe(false);

    // Attestation is the liveness signal: no answer means nobody is behind that seat.
    expect(newHost.abandoned.has(3), 'a seat that never answered has nobody behind it — the crew must cover it').toBe(
      true,
    );
    // But NOT locked out: the peer id is kept, so a crewmate who was merely slow — a backgrounded
    // tab, one dropped message — can take its own seat back the moment it acts.
    expect(newHost.peerOfSeat[3], 'the seat was written off for good over one dropped message').toBe('d');

    // The OPENING hand stays unknown, but the seat has to be holding something or the bot is handed
    // an empty hand, finds no legal card, and the board silently stops being anybody's turn. That is
    // the frozen board this file exists for, and it is the quietest possible version of it.
    const m = newHost.m!;
    const hand = m.hands[3];
    expect(m.setup.deal[3], 'an opening hand nobody attested must not be invented — history cannot be rewritten').toBeNull();
    expect(hand, 'the seat the host cannot see was left holding nothing at all').not.toBeNull();
    expect(hand!.length, 'the reconstructed hand is the wrong size for the tricks already played').toBe(
      m.setup.tricks - m.seenBy.filter((s) => s === 3).length,
    );
    const accounted = new Set([...m.seen, ...(m.hands[1] ?? []), ...(m.hands[2] ?? [])]);
    expect(
      hand!.filter((c) => accounted.has(c)),
      'the reconstruction handed out cards that are already on the table or in a hand the host can see',
    ).toEqual([]);

    const before = m.log.length;
    driveToEnd(room, newHost, 'the mission froze around the seat that never answered the claim');
    expect(
      m.log.slice(before).filter((a) => actSeat(a) === 3).length,
      'the silent seat never played again — that seat is where the board froze',
    ).toBeGreaterThan(0);
  });

  it('a peer that turns up late takes its own seat back off the crew', () => {
    const crew = openRoom({ ids: ['a', 'b', 'c', 'd'], mission: 5, poolSeed: 1007, dealSeed: 2_654_435_761 });
    const { room } = crew;
    play(room, crew.at(0), 16);
    room.mute('d');
    const newHost = promote(crew, 0, 1);
    for (let t = 0; t < 5000; t += 250) {
      vi.advanceTimersByTime(250);
      newHost.tick();
      room.pump();
    }
    expect(newHost.abandoned.has(3), 'seat 3 should have been picked up by the crew').toBe(true);

    // Speaking at all is proof of life. It does not matter whether this particular action is legal —
    // what matters is that a crewmate who is demonstrably still there stops being played by a bot.
    room.unmute('d');
    newHost.receive({ t: 'act', mn: newHost.mission, act: packAct(A_PLAY, 3, crew.opening[3][0]) }, 'd');
    expect(
      newHost.abandoned.has(3),
      'the crewmate is right there and talking, and the bot is still playing their cards',
    ).toBe(false);
  });
});

// ── (7) a seat with nobody behind it ───────────────────────────────────────────

describe('a crewmate walking out is a harder mission, never a stopped one', () => {
  it('the crew’s own bot covers the empty seat, and the mission still ends', () => {
    const crew = openRoom();
    const { room, ids } = crew;
    const host = crew.at(0);
    play(room, host, 12);

    room.kill(ids[2]);
    host.peerLeft(ids[2]);
    crew.at(1).peerLeft(ids[2]);
    room.pump();

    expect(host.abandoned.has(2), 'the vacated seat was never marked').toBe(true);
    expect(host.alone(), 'one crewmate short of three is not a walkover').toBe(false);

    const before = host.m!.log.length;
    driveToEnd(room, host, 'the mission stopped dead on the seat nobody is sitting in');
    // Seat 2 has no peer any more, so every action it took came from the crew's own bot.
    expect(host.m!.log.length, 'nothing at all was played after the crewmate left').toBeGreaterThan(before + 4);
    expect(
      host.m!.log.slice(before).filter((a) => actSeat(a) === 2).length,
      'the bot never covered the empty seat — that seat is where the board froze',
    ).toBeGreaterThan(0);
  });

  it('a room down to ONE survivor reports alone(), which is the walkover signal', () => {
    const crew = openRoom();
    const { room, ids } = crew;
    const host = crew.at(0);
    play(room, host, 12);

    room.kill(ids[2]);
    host.peerLeft(ids[2]);
    expect(host.alone()).toBe(false);

    room.kill(ids[1]);
    host.peerLeft(ids[1]);
    expect(host.alone(), 'the last player in the room has to be told the mission is a walkover').toBe(true);
    expect(isOver(host.m!), 'alone() is a signal for the screen, not an ending in itself').toBe(false);

    // And even then it does not freeze: the crew's bot covers both empty seats.
    driveToEnd(room, host, 'the last survivor cannot finish alone');
  });

  it('a survivor promoted into a room that has ALREADY emptied gives up waiting, and alone() ends it', () => {
    // One crewmate walked out earlier, then the host did. Nobody is left who can attest seat 2, so
    // the promoted host cannot derive anything — two holes, and deriveMissing only covers one. What
    // saves this room is not the rebuild, it is alone(): the screen collects a walkover.
    const crew = openRoom();
    const { room, ids } = crew;
    play(room, crew.at(0), 12);

    room.kill(ids[2]);
    for (const id of ['a', 'b']) room.get(id).peerLeft(ids[2]);
    const survivor = promote(crew, 0, 1);

    // It does NOT sit out the four-second window: every other seat's peer has already gone, so there
    // is nobody who could answer and waiting would be four seconds of a spinner for a message that
    // cannot arrive. What matters is where it ends up, which the assertions below pin.
    expect(survivor.rebuilding, 'nobody is left to ask, so the rebuild must not wait on the room').toBe(false);

    for (let t = 0; t < 5000; t += 250) {
      vi.advanceTimersByTime(250);
      survivor.tick();
      room.pump();
    }
    expect(survivor.rebuilding, 'the survivor waits forever for an answer that is never coming').toBe(false);
    expect(survivor.m!.setup.deal[1], 'the survivor forgot its own hand').not.toBeNull();
    expect(survivor.alone(), 'the last player in the room must be told this is a walkover, not a game').toBe(true);
  });
});
