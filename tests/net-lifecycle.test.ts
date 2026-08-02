/**
 * net-lifecycle.test.ts — live-P2P contract gate: ONE ROOM PER SESSION, and the most valuable
 * trivial test in the suite. A rematch versions missions INSIDE the living room; leaving and
 * rejoining to reset hands back a dying room object and every peer then elects itself host. The
 * engine makes the trap throw; this pins that, plus the one-join invariant. No transport required.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const joinRoom = vi.fn();

vi.mock('trystero', () => {
  interface FakeRoom {
    makeAction: (name: string) => [ReturnType<typeof vi.fn>, (cb: unknown) => void];
    onPeerJoin: (cb: unknown) => void;
    onPeerLeave: (cb: unknown) => void;
    getPeers: () => Record<string, unknown>;
    leave: () => Promise<void>;
  }
  const make = (): FakeRoom => ({
    makeAction: () => [vi.fn(), () => {}],
    onPeerJoin: () => {},
    onPeerLeave: () => {},
    getPeers: () => ({}),
    leave: () => new Promise<void>((res) => setTimeout(res, 0)),
  });
  return {
    joinRoom: (...args: unknown[]) => {
      joinRoom(...args);
      return make();
    },
    selfId: 'self-peer',
  };
});

vi.mock('trystero/nostr', () => ({ getRelaySockets: () => ({}) }));

import { createNet, netStats, resetNetStats } from '@ben-gy/game-engine/net';

const CFG = { appId: 'tacit@2', roomId: 'K7QM' };

describe('one join per session', () => {
  beforeEach(() => {
    resetNetStats();
    joinRoom.mockClear();
  });

  it('a whole multi-mission session joins exactly once', async () => {
    const net = createNet(CFG);
    net.channel('play', () => {});
    net.onPeersChange(() => {});
    net.channel('tbl', () => {});
    net.onPeersChange(() => {});

    expect(netStats().joins, 'a rematch must version missions INSIDE the room').toBe(1);
    expect(joinRoom).toHaveBeenCalledTimes(1);

    await net.leave();
    expect(netStats().active).toEqual([]);
  });

  it('leaving and coming back later is one join each, not a leak', async () => {
    const a = createNet(CFG);
    await a.leave();
    const b = createNet(CFG);
    expect(netStats().joins).toBe(2);
    await b.leave();
  });
});

describe('the leave/rejoin trap fails loudly', () => {
  beforeEach(() => {
    resetNetStats();
    joinRoom.mockClear();
  });

  it('throws when the same room is rejoined while still tearing down', async () => {
    const net = createNet(CFG);
    const pending = net.leave();
    expect(() => createNet(CFG)).toThrow(/tearing down/i);
    await pending;
    const again = createNet(CFG);
    expect(netStats().joins).toBe(2);
    await again.leave();
  });

  it('throws when the same room is joined twice concurrently', async () => {
    const net = createNet(CFG);
    expect(() => createNet(CFG)).toThrow(/already joined/i);
    expect(netStats().joins).toBe(1);
    await net.leave();
  });

  it('a DIFFERENT room on the same page is not blocked', async () => {
    const a = createNet(CFG);
    const b = createNet({ ...CFG, roomId: 'ZZ99' });
    expect(netStats().joins).toBe(2);
    await Promise.all([a.leave(), b.leave()]);
    expect(netStats().active).toEqual([]);
  });
});

describe('a net that was never left still holds its slot', () => {
  afterEach(() => resetNetStats());
  it('reports itself as active so a stray second createNet is caught', () => {
    resetNetStats();
    createNet(CFG);
    expect(netStats().active).toEqual(['tacit@2/K7QM']);
  });
});
