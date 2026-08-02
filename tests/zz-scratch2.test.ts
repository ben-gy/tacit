// TEMPORARY debug scaffold — deleted before this branch is done.
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { modeOf } from '../src/modes';
import { A_DRAFT, A_PLAY, draftableFor, legalFor, packAct, type Mission } from '../src/mission';
import { chooseCard, chooseDraft, viewFor } from '../src/bot';
import { Session, type WireMsg } from '../src/session';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function build(ids: string[], modeId: string, mission: number, poolSeed: number, dealSeed: number) {
  const mode = modeOf(modeId);
  const queue: Array<{ from: string; to?: string | string[]; m: WireMsg }> = [];
  const sessions = new Map<string, Session>();
  const live = new Set<string>(ids);
  const deaf = new Set<string>();
  ids.forEach((id, seat) => {
    sessions.set(
      id,
      new Session({
        mode,
        mission,
        players: ids.length,
        mySeat: seat,
        bots: new Set<number>(),
        isHost: seat === 0,
        names: ids.map((x) => x.toUpperCase()),
        peerOfSeat: [...ids],
        poolSeed,
        dealSeed: seat === 0 ? dealSeed : 0,
        deps: {
          send: (m, to) => {
            if (live.has(id)) queue.push({ from: id, to, m: structuredClone(m) });
          },
          onChange: () => {},
          onEvents: () => {},
          onEnd: () => {},
        },
      }),
    );
  });
  const pump = (): void => {
    let n = 0;
    while (queue.length) {
      if (++n > 600) throw new Error('storm');
      const e = queue.shift()!;
      const targets = e.to === undefined ? [...live].filter((p) => p !== e.from) : Array.isArray(e.to) ? e.to : [e.to];
      for (const t of targets) {
        if (t === e.from || !live.has(t) || deaf.has(t)) continue;
        sessions.get(t)!.receive(structuredClone(e.m), e.from);
      }
    }
  };
  pump();
  return { sessions, pump, live, deaf, ids };
}

const seatOf = (m: Mission): number => (m.phase === 'draft' ? m.draftTurn : m.turn);

function act(m: Mission): number | null {
  const seat = seatOf(m);
  if (seat < 0) return null;
  if (m.phase === 'draft') {
    const avail = draftableFor(m, seat, m.draftRelaxed);
    if (!avail.length) return null;
    return packAct(A_DRAFT, seat, chooseDraft(viewFor(m, seat), avail, m.tasks.filter((t) => t.owner !== -1).length));
  }
  const allowed = legalFor(m, seat);
  if (!allowed.length) return null;
  const wanted = chooseCard(viewFor(m, seat));
  return packAct(A_PLAY, seat, allowed.includes(wanted) ? wanted : allowed[0]);
}

describe('scratch2', () => {
  it('3p already emptied', () => {
    const r = build(['a', 'b', 'c'], 'aside', 3, 3007, 3668339987);
    const host = r.sessions.get('a')!;
    for (let i = 0; i < 12; i++) {
      r.sessions.get(r.ids[seatOf(host.m!)])!.submit(act(host.m!)!);
      r.pump();
    }
    r.live.delete('c');
    r.sessions.get('a')!.peerLeft('c');
    r.sessions.get('b')!.peerLeft('c');
    r.live.delete('a');
    r.sessions.get('b')!.peerLeft('a');
    const b = r.sessions.get('b')!;
    // eslint-disable-next-line no-console
    console.log('before becomeHost: isHost', b.isHost, 'phase', b.m!.phase, 'abandoned', [...b.abandoned]);
    b.becomeHost();
    const priv = b as unknown as { attested: Map<number, number[]>; claimAt: number; players: number; mySeat: number };
    // eslint-disable-next-line no-console
    console.log(
      'straight after becomeHost: rebuilding', b.rebuilding,
      'attested', [...priv.attested.keys()],
      'players', priv.players, 'mySeat', priv.mySeat,
      'claimAt', priv.claimAt, 'now', Date.now(),
    );
    r.pump();
    // eslint-disable-next-line no-console
    console.log('after: rebuilding', b.rebuilding, 'deal', b.m!.setup.deal.map((h) => (h ? h.length : null)));
    expect(true).toBe(true);
  });

  it('4p muted seat 3', () => {
    const r = build(['a', 'b', 'c', 'd'], 'aside', 5, 1007, 2654435761);
    const host = r.sessions.get('a')!;
    for (let i = 0; i < 16; i++) {
      r.sessions.get(r.ids[seatOf(host.m!)])!.submit(act(host.m!)!);
      r.pump();
    }
    r.deaf.add('d');
    r.live.delete('a');
    for (const id of ['b', 'c', 'd']) r.sessions.get(id)!.peerLeft('a');
    const b = r.sessions.get('b')!;
    b.becomeHost();
    r.pump();
    for (let t = 0; t < 5000; t += 250) {
      vi.advanceTimersByTime(250);
      b.tick();
      r.pump();
    }
    r.deaf.delete('d');
    const d = r.sessions.get('d')!;
    // eslint-disable-next-line no-console
    console.log(
      'rebuilding', b.rebuilding,
      'hostLog', b.m!.log.length, 'dLog', d.m!.log.length,
      'hostTurn', seatOf(b.m!), 'dTurn', seatOf(d.m!),
      'hostPhase', b.m!.phase, 'dPhase', d.m!.phase,
      'deal', b.m!.setup.deal.map((h) => (h ? h.length : null)),
      'abandoned', [...b.abandoned],
      'peerOfSeat', b.peerOfSeat,
    );
    for (let i = 0; i < 6; i++) {
      const seat = seatOf(b.m!);
      const owner = r.sessions.get(r.ids[seat])!;
      if (!r.live.has(r.ids[seat])) break;
      const allowed = legalFor(owner.m!, seat);
      const a = allowed.length ? packAct(A_PLAY, seat, allowed[0]) : null;
      const before = b.m!.log.length;
      if (a === null) {
        // eslint-disable-next-line no-console
        console.log(i, 'seat', seat, 'no legal card in own mission; ownerTurn', seatOf(owner.m!), 'ownerPhase', owner.m!.phase);
        break;
      }
      owner.submit(a);
      r.pump();
      // eslint-disable-next-line no-console
      console.log(i, 'seat', seat, 'grew', b.m!.log.length - before, 'hostPhase', b.m!.phase, 'hostTurn', seatOf(b.m!), 'ownerIsHost', owner.isHost, 'peerOfSeat[seat]', b.peerOfSeat[seat]);
      if (b.m!.log.length === before) break;
    }
    expect(true).toBe(true);
  });
});
