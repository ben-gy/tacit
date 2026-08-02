/**
 * rules.test.ts — the rules themselves, at the level a player would argue about them. cards.ts and
 * mission.ts are the only two files a desync, a lost mission or a "that was legal!" can come from,
 * and everything above them (the bots, the sim, the audit, the net layer) assumes they are right.
 *
 * Three things here are load-bearing rather than merely nice:
 *   - the deck must divide EXACTLY at every player count, or somebody plays a hand one card short
 *     and the whole trick structure quietly breaks;
 *   - `apply` must be all-or-nothing, because a half-applied illegal action off the wire leaves two
 *     peers holding different games and there is no server to arbitrate;
 *   - a torn-up spare must be an ORDINARY card again, or the mission dies on a card nobody accepted.
 *
 * Where an exact position is needed the Mission is hand-built rather than searched for by seed: a
 * chain landing out of order, a finale landing early and a squeeze are all rare enough that a seeded
 * game gives no control over them, and a test that only fires on some seeds is a test that will one
 * day stop firing.
 */

import { describe, expect, it } from 'vitest';
import {
  COLOURS,
  TRUMP,
  TRUMPS,
  buildDeck,
  cardOf,
  colourCards,
  deckSize,
  handSize,
  isTrump,
  legalPlays,
  rankOf,
  suitOf,
  suitRanks,
  trickWinner,
} from '../src/cards';
import { MODES, modeOf, type Mode } from '../src/modes';
import {
  A_DRAFT,
  A_PLAY,
  A_SIGNAL,
  SIG_HIGH,
  SIG_LOW,
  SIG_ONLY,
  apply,
  canSignal,
  commanderOf,
  createMission,
  dealHands,
  draftableFor,
  isBlocked,
  isLive,
  isSqueezed,
  legalFor,
  makeSetup,
  packAct,
  packSignal,
  replay,
  signalKindsFor,
  type Mission,
  type Setup,
} from '../src/mission';
import { makeRng } from '@ben-gy/game-engine/rng';

const COUNTS = [2, 3, 4, 5];

// Cards, written the way the packing reads them: suit * 16 + rank.
const LOFT = 0;
const BATTEN = 1;
const DRAPE = 2;
const TRUSS = 3;

// ── hand-built positions ────────────────────────────────────────────────────────

interface Handmade {
  hands: number[][];
  tricks: number;
  commander?: number;
  tasks?: Array<{ card: number; owner: number; order?: number; finale?: boolean }>;
  signals?: number;
  modeId?: string;
}

/**
 * A mission already in the play phase, with an exact deal and an exact task roster. The pool is
 * empty (so `reset` opens straight into play) and the tasks are written on afterwards — which is
 * legitimate precisely because the machine reads `m.tasks` live and never consults the pool again.
 */
function position(o: Handmade): Mission {
  const mode = modeOf(o.modeId ?? 'aside');
  const setup: Setup = {
    players: o.hands.length,
    modeId: mode.id,
    mission: 1,
    pool: [],
    take: 0,
    ordered: 0,
    finale: false,
    commander: o.commander ?? 0,
    deal: o.hands.map((h) => [...h]),
    signalBudget: o.signals ?? mode.signals,
    tricks: o.tricks,
  };
  const m = createMission(setup, mode);
  m.tasks = (o.tasks ?? []).map((t) => ({
    card: t.card,
    owner: t.owner,
    order: t.order ?? 0,
    finale: t.finale ?? false,
    discarded: false,
    done: false,
    trick: -1,
  }));
  return m;
}

/** A mission still in the DRAFT, with a pool written by hand so the pick order is predictable. */
function drafting(o: {
  hands: number[][];
  pool: number[];
  take: number;
  tricks: number;
  ordered?: number;
  finale?: boolean;
  commander?: number;
}): Mission {
  const mode = MODES.aside;
  const setup: Setup = {
    players: o.hands.length,
    modeId: mode.id,
    mission: 1,
    pool: o.pool.map((card) => ({ card })),
    take: o.take,
    ordered: o.ordered ?? 0,
    finale: o.finale ?? false,
    commander: o.commander ?? 0,
    deal: o.hands.map((h) => [...h]),
    signalBudget: mode.signals,
    tricks: o.tricks,
  };
  return createMission(setup, mode);
}

const play = (m: Mission, seat: number, card: number): boolean => apply(m, packAct(A_PLAY, seat, card));
const draft = (m: Mission, seat: number, task: number): boolean => apply(m, packAct(A_DRAFT, seat, task));
const signal = (m: Mission, seat: number, card: number, kind: number): boolean =>
  apply(m, packAct(A_SIGNAL, seat, packSignal(kind, card)));

/** An action that must be refused AND must leave the mission byte-identical. */
function refused(m: Mission, what: string, act: () => boolean): void {
  const before = JSON.stringify(m);
  expect(act(), `${what} was accepted`).toBe(false);
  expect(JSON.stringify(m), `${what} was refused but still changed the mission`).toBe(before);
}

/**
 * A whole mission driven by nothing but the rules — no bot, so this file does not inherit bot.ts's
 * opinions. Picks are taken by a rotating index so the run is deterministic and reaches deep,
 * unusual positions rather than the same opening every time.
 */
function drive(mode: Mode, mission: number, players: number, seed: number): { m: Mission; setup: Setup } {
  const setup = makeSetup(mode, mission, players, seed, seed ^ 0x9e37_79b9);
  const m = createMission(setup, mode);
  let n = 0;
  let guard = 0;

  while (m.phase === 'draft') {
    expect(++guard, 'the draft never closed').toBeLessThan(64);
    const seat = m.draftTurn;
    const avail = draftableFor(m, seat, m.draftRelaxed);
    expect(avail.length, 'a drafting seat with nothing to take').toBeGreaterThan(0);
    expect(draft(m, seat, avail[n++ % avail.length]), 'a legal draft was refused').toBe(true);
  }

  guard = 0;
  while (m.phase === 'play') {
    expect(++guard, 'the mission never terminated').toBeLessThan(400);
    const seat = m.turn;
    // Spend the signal on the opening trick, so signals appear in the log a replay has to reproduce.
    if (m.trickNo === 0 && m.signalsLeft[seat] > 0) {
      const hand = m.hands[seat]!;
      for (const card of hand) {
        const kind = [SIG_HIGH, SIG_LOW, SIG_ONLY].find((k) => canSignal(m, seat, card, k));
        if (kind !== undefined) {
          expect(signal(m, seat, card, kind), 'a true signal was refused').toBe(true);
          break;
        }
      }
    }
    const legal = legalFor(m, seat);
    expect(legal.length, 'a live mission with no legal card').toBeGreaterThan(0);
    expect(play(m, seat, legal[n++ % legal.length]), 'a legal card was refused').toBe(true);
  }
  return { m, setup };
}

// ── the deck ────────────────────────────────────────────────────────────────────

/**
 * WHY: the colour suits change length with the table so that 4·R + 4 divides by N. Get that wrong at
 * any one count and somebody plays a hand one card short — every trick after that has a hole in it,
 * and nothing else in the game would notice.
 */
describe('the deck divides exactly, at every table size', () => {
  it('deals equal hands with nothing left over', () => {
    for (const players of COUNTS) {
      const deck = buildDeck(players);
      expect(deck).toHaveLength(deckSize(players));
      expect(deckSize(players) % players, `${players}P: the deck does not divide`).toBe(0);
      expect(handSize(players) * players).toBe(deck.length);

      const hands = dealHands(players, makeRng(0xc0ffee + players));
      expect(hands).toHaveLength(players);
      for (const h of hands) expect(h, `${players}P: an uneven hand`).toHaveLength(handSize(players));
      expect(new Set(hands.map((h) => h.length)).size, `${players}P: hands are not all equal`).toBe(1);
    }
  });

  it('holds every card exactly once, and never a rank 0', () => {
    for (const players of COUNTS) {
      const deck = buildDeck(players);
      expect(new Set(deck).size, `${players}P: a duplicate card`).toBe(deck.length);
      for (const c of deck) expect(rankOf(c), `${players}P: rank 0 is not a card`).toBeGreaterThan(0);

      // The deal is a permutation of the deck: every card once, none invented.
      const dealt = dealHands(players, makeRng(1234 + players)).flat();
      expect(new Set(dealt).size, `${players}P: a card was dealt twice`).toBe(dealt.length);
      expect(dealt.slice().sort((a, b) => a - b)).toEqual(deck.slice().sort((a, b) => a - b));
    }
  });

  it('carries exactly four trumps, whatever the table size', () => {
    for (const players of COUNTS) {
      const trumps = buildDeck(players).filter(isTrump);
      expect(trumps, `${players}P: the Gantry changed size with the table`).toHaveLength(TRUMPS);
      expect(trumps.map(rankOf).sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
      expect(colourCards(players).some(isTrump), 'a trump leaked into the task pool').toBe(false);
      expect(colourCards(players)).toHaveLength(deckSize(players) - TRUMPS);
    }
  });

  it('runs each colour from 1 to its rank ceiling, with no gaps', () => {
    for (const players of COUNTS) {
      const ranks = suitRanks(players);
      const want = Array.from({ length: ranks }, (_, i) => i + 1);
      for (let s = 0; s < COLOURS; s++) {
        const got = buildDeck(players)
          .filter((c) => suitOf(c) === s)
          .map(rankOf)
          .sort((a, b) => a - b);
        expect(got, `${players}P: colour ${s} is not 1..${ranks}`).toEqual(want);
      }
      expect(suitRanks(players) * COLOURS + TRUMPS).toBe(deckSize(players));
    }
  });

  it('always finds the top trump, so somebody always leads', () => {
    for (const players of COUNTS) {
      for (let seed = 0; seed < 20; seed++) {
        const hands = dealHands(players, makeRng(seed * 7919 + players));
        const cmd = commanderOf(hands);
        expect(hands[cmd], `${players}P/${seed}: the commander does not hold the top Gantry`).toContain(cardOf(TRUMP, 4));
      }
    }
  });
});

// ── following suit ──────────────────────────────────────────────────────────────

/**
 * WHY: "follow if you can, anything if you can't" is the only restriction on a trick, and both
 * halves matter — the second half is what makes a void public information, which in Hush is the ONLY
 * thing anyone ever learns about anyone.
 */
describe('legalPlays: follow suit if you can, anything if you cannot', () => {
  const hand = [cardOf(LOFT, 1), cardOf(LOFT, 5), cardOf(BATTEN, 3), cardOf(TRUMP, 2)];

  it('leaves the leader completely free', () => {
    const out = legalPlays(hand, null);
    expect(out.slice().sort((a, b) => a - b)).toEqual(hand.slice().sort((a, b) => a - b));
    expect(out, 'the caller was handed the hand array itself').not.toBe(hand);
  });

  it('forces the led colour when the hand holds it', () => {
    expect(legalPlays(hand, LOFT).sort((a, b) => a - b)).toEqual([cardOf(LOFT, 1), cardOf(LOFT, 5)]);
    expect(legalPlays(hand, BATTEN)).toEqual([cardOf(BATTEN, 3)]);
    expect(legalPlays(hand, LOFT), 'a trump is not a way out of following suit').not.toContain(cardOf(TRUMP, 2));
  });

  it('opens everything when void — and never OBLIGES the trump', () => {
    const out = legalPlays(hand, DRAPE);
    expect(out.slice().sort((a, b) => a - b)).toEqual(hand.slice().sort((a, b) => a - b));
    expect(out, 'a void player must be allowed to discard rather than trump').toContain(cardOf(LOFT, 1));
  });

  it('treats a led trump like any other led suit', () => {
    expect(legalPlays(hand, TRUMP)).toEqual([cardOf(TRUMP, 2)]);
    expect(legalPlays([cardOf(LOFT, 9), cardOf(TRUSS, 1)], TRUMP).length, 'a trumpless hand is free').toBe(2);
  });
});

// ── who takes the trick ─────────────────────────────────────────────────────────

/**
 * WHY: every task in the game is decided by this one function, so a wrong answer does not look like
 * a bug — it looks like the crew losing. The last assertion is the one that matters most: a card
 * that is neither a trump nor the led suit is a DISCARD, which is what makes throwing your highest
 * off-suit card away safe.
 */
describe('trickWinner: trumps, then the led suit, and nothing else', () => {
  it('gives it to the highest trump wherever it sits', () => {
    expect(trickWinner([cardOf(LOFT, 9), cardOf(TRUMP, 1), cardOf(LOFT, 8)])).toBe(1);
    expect(trickWinner([cardOf(LOFT, 9), cardOf(TRUMP, 1), cardOf(TRUMP, 4), cardOf(TRUMP, 2)])).toBe(2);
    expect(trickWinner([cardOf(TRUMP, 3), cardOf(TRUMP, 4)]), 'a led trump is still beatable').toBe(1);
  });

  it('gives it to the highest of the led suit when no trump was played', () => {
    expect(trickWinner([cardOf(DRAPE, 2), cardOf(DRAPE, 7), cardOf(DRAPE, 5)])).toBe(1);
    expect(trickWinner([cardOf(DRAPE, 9), cardOf(DRAPE, 7)])).toBe(0);
  });

  it('lets a trump beat any colour, however high', () => {
    for (let r = 1; r <= 9; r++) {
      expect(trickWinner([cardOf(TRUSS, r), cardOf(TRUMP, 1)]), `Gantry 1 lost to Truss ${r}`).toBe(1);
    }
  });

  it('never lets an off-suit discard win — the whole reason a discard is safe', () => {
    // The leader's rank 1 beats two off-suit 9s, because neither of them is even in the running.
    expect(trickWinner([cardOf(BATTEN, 1), cardOf(DRAPE, 9), cardOf(TRUSS, 9)])).toBe(0);

    let s = 987_654_321;
    const next = (): number => {
      s = (s * 1_664_525 + 1_013_904_223) >>> 0;
      return s / 4_294_967_296;
    };
    let checked = 0;
    for (let i = 0; i < 4000; i++) {
      const n = 2 + Math.floor(next() * 4);
      const cards = Array.from({ length: n }, () => {
        const suit = Math.floor(next() * 5);
        return cardOf(suit, 1 + Math.floor(next() * (suit === TRUMP ? TRUMPS : 9)));
      });
      if (new Set(cards).size !== cards.length) continue;
      const win = cards[trickWinner(cards)];
      const led = suitOf(cards[0]);
      if (cards.some(isTrump)) {
        expect(isTrump(win), `a colour beat a trump in [${cards.join(',')}]`).toBe(true);
        expect(rankOf(win)).toBe(Math.max(...cards.filter(isTrump).map(rankOf)));
      } else {
        expect(suitOf(win), `an off-suit discard won [${cards.join(',')}]`).toBe(led);
        expect(rankOf(win)).toBe(Math.max(...cards.filter((c) => suitOf(c) === led).map(rankOf)));
      }
      checked++;
    }
    expect(checked, 'the random sweep barely ran').toBeGreaterThan(3000);
  });
});

// ── the machine ─────────────────────────────────────────────────────────────────

/**
 * WHY: a mission is `setup + a log`, and a peer that missed three messages catches up by replaying
 * it. If a replay could land anywhere but the identical position, or if a rejected action could
 * leave a fingerprint, two peers would be holding different games with no server to arbitrate.
 */
describe('the mission machine: a log replays to the identical position', () => {
  it('reproduces the whole mission, exactly, for every mode and table size', () => {
    // A mission can end on the very first trick, so depth is tracked across the sweep rather than
    // demanded of every run: a green result must not be reachable by replaying nothing.
    let deepest = 0;
    for (const id of ['aside', 'hush', 'runorder']) {
      for (const players of COUNTS) {
        for (const mission of [1, 7, 14]) {
          const label = `${id}/${players}P/m${mission}`;
          const { m, setup } = drive(modeOf(id), mission, players, 5150 + players * 31 + mission);
          expect(m.phase, `${label}: the mission never finished`).toBe('over');
          expect(m.log.length, `${label}: nothing happened, so nothing was proved`).toBeGreaterThan(players);
          deepest = Math.max(deepest, m.log.length);

          const again = createMission(setup, modeOf(id));
          expect(replay(again, m.log), `${label}: a legal log was rejected on replay`).toBe(true);

          expect(again.phase, label).toBe(m.phase);
          expect(again.turn, label).toBe(m.turn);
          expect(again.trickNo, label).toBe(m.trickNo);
          expect(again.trick, label).toEqual(m.trick);
          expect(again.tricksWon, label).toEqual(m.tricksWon);
          expect(again.tasks, label).toEqual(m.tasks);
          expect(again.hands, label).toEqual(m.hands);
          expect(again.voids, label).toEqual(m.voids);
          expect(again.signals, label).toEqual(m.signals);
          expect(again.success, label).toBe(m.success);
          expect(again.reason, label).toBe(m.reason);
          expect(JSON.stringify(again), `${label}: the replay diverged somewhere`).toBe(JSON.stringify(m));
        }
      }
    }
    expect(deepest, 'every sampled mission ended almost immediately — replay was never stressed').toBeGreaterThan(30);
  });

  it('rejects a corrupted log instead of half-applying it', () => {
    const { m, setup } = drive(MODES.aside, 3, 4, 24_680);
    const bad = [...m.log];
    bad.splice(bad.length - 1, 0, packAct(A_PLAY, 0, 0x0f)); // a card in nobody's hand
    const again = createMission(setup, MODES.aside);
    expect(replay(again, bad), 'a hostile log was replayed anyway').toBe(false);
  });

  it('changes NOTHING when it refuses an action', () => {
    const m = position({
      hands: [
        [cardOf(LOFT, 2), cardOf(DRAPE, 5)],
        [cardOf(LOFT, 3), cardOf(DRAPE, 2)],
      ],
      tricks: 2,
      tasks: [{ card: cardOf(DRAPE, 2), owner: 0 }],
    });

    refused(m, 'a play out of turn', () => play(m, 1, cardOf(LOFT, 3)));
    refused(m, 'a card that is not in hand', () => play(m, 0, cardOf(TRUSS, 4)));
    refused(m, 'a draft during the play phase', () => draft(m, 0, 0));
    refused(m, 'a seat that is not at this table', () => play(m, 7, cardOf(LOFT, 2)));
    refused(m, 'an unknown action kind', () => apply(m, packAct(9, 0, 0)));

    expect(play(m, 0, cardOf(LOFT, 2))).toBe(true);
    refused(m, 'a revoke — dodging the led colour while holding it', () => play(m, 1, cardOf(DRAPE, 2)));
    refused(m, 'the same seat playing twice', () => play(m, 0, cardOf(DRAPE, 5)));
    expect(play(m, 1, cardOf(LOFT, 3))).toBe(true);
  });

  it('accepts nothing at all once the mission is over', () => {
    const m = position({
      hands: [[cardOf(DRAPE, 5)], [cardOf(DRAPE, 2)]],
      tricks: 1,
      tasks: [{ card: cardOf(DRAPE, 5), owner: 0 }],
    });
    expect(play(m, 0, cardOf(DRAPE, 5))).toBe(true);
    expect(play(m, 1, cardOf(DRAPE, 2))).toBe(true);
    expect(m.phase).toBe('over');
    refused(m, 'a card played after the end', () => play(m, 0, cardOf(DRAPE, 5)));
    expect(legalFor(m, 0), 'a finished mission still offered cards').toEqual([]);
  });
});

// ── the draft ───────────────────────────────────────────────────────────────────

/**
 * WHY: the draft is where the two subtlest rules live. You may not take a task whose card is in your
 * own hand (measured: those missions were lost 11 times out of 11, because a card you hold has to
 * win a trick as itself), and the spares are TORN UP at the close — a spare still treated as a task
 * would fail the mission on a card nobody ever accepted.
 */
describe('the draft: what you may take, and what happens to the rest', () => {
  it('will not let a seat take a task it is holding', () => {
    const m = drafting({
      hands: [
        [cardOf(LOFT, 2), cardOf(DRAPE, 5)],
        [cardOf(LOFT, 3), cardOf(DRAPE, 2)],
      ],
      pool: [cardOf(LOFT, 2), cardOf(DRAPE, 2)],
      take: 1,
      tricks: 2,
    });
    expect(m.phase).toBe('draft');
    expect(m.draftTurn).toBe(0);
    expect(draftableFor(m, 0), 'seat 0 was offered the card in its own hand').toEqual([1]);
    expect(draftableFor(m, 1), 'seat 1 holds the other candidate').toEqual([0]);
    refused(m, 'drafting a card out of your own hand', () => draft(m, 0, 0));
    // The escape hatch still exists — it is only lifted when the whole table can take nothing.
    expect(draftableFor(m, 0, true), 'the relaxed draft must still see everything').toEqual([0, 1]);
  });

  it('tears up the spares, and a torn-up spare is an ordinary card again', () => {
    const m = drafting({
      hands: [
        [cardOf(LOFT, 2), cardOf(DRAPE, 5)],
        [cardOf(LOFT, 3), cardOf(DRAPE, 2)],
      ],
      pool: [cardOf(LOFT, 2), cardOf(DRAPE, 2)],
      take: 1,
      tricks: 2,
    });
    expect(draft(m, 0, 1)).toBe(true);
    expect(m.phase, 'taking the last task must close the draft').toBe('play');
    expect(m.tasks[0].discarded, 'the untaken candidate was not torn up').toBe(true);
    expect(isLive(m.tasks[0]), 'a torn-up spare is not a task').toBe(false);
    expect(m.tasks[1].owner).toBe(0);
    const roster = m.events.find((e) => e.k === 'roster');
    expect(roster && roster.k === 'roster' && roster.tasks).toEqual([
      { card: cardOf(DRAPE, 2), owner: 0, order: 0, finale: false },
    ]);

    // Trick 0: the spare (Loft 2) is taken by seat 1, who owns nothing. That must be a non-event.
    expect(play(m, 0, cardOf(LOFT, 2))).toBe(true);
    expect(play(m, 1, cardOf(LOFT, 3))).toBe(true);
    expect(m.phase, 'a torn-up spare failed the mission').toBe('play');
    expect(m.reason).toBe('');
    expect(m.tricksWon).toEqual([0, 1]);

    // Trick 1: the real task lands with its owner, and that is the mission.
    expect(play(m, 1, cardOf(DRAPE, 2))).toBe(true);
    expect(play(m, 0, cardOf(DRAPE, 5))).toBe(true);
    expect(m.success, 'the mission should have been won').toBe(true);
    expect(m.reason).toBe('every task complete');
  });

  it('numbers the links by PICK ORDER — the k-th task taken is link k', () => {
    const m = drafting({
      hands: [
        [cardOf(LOFT, 1), cardOf(BATTEN, 1)],
        [cardOf(DRAPE, 1), cardOf(TRUSS, 1)],
      ],
      pool: [cardOf(LOFT, 2), cardOf(BATTEN, 2), cardOf(DRAPE, 2)],
      take: 2,
      ordered: 2,
      tricks: 2,
    });
    expect(draft(m, 0, 0)).toBe(true);
    expect(m.tasks[0].order, 'the first task taken is link 1').toBe(1);
    expect(m.draftTurn, 'the draft passes to the next seat').toBe(1);
    expect(draft(m, 1, 2)).toBe(true);
    expect(m.tasks[2].order, 'the second task taken is link 2').toBe(2);
    expect(m.tasks[0].owner).toBe(0);
    expect(m.tasks[2].owner).toBe(1);
    expect(m.tasks[1].discarded, 'the candidate nobody took must not keep a link number').toBe(true);
    expect(m.tasks[1].order).toBe(0);
  });

  it('hangs the finale on the LAST task taken, and only when the rung asks for one', () => {
    const build = (finale: boolean): Mission =>
      drafting({
        hands: [
          [cardOf(LOFT, 1), cardOf(BATTEN, 1)],
          [cardOf(DRAPE, 1), cardOf(TRUSS, 1)],
        ],
        pool: [cardOf(LOFT, 2), cardOf(BATTEN, 2), cardOf(DRAPE, 2)],
        take: 2,
        finale,
        tricks: 2,
      });

    const withFinale = build(true);
    expect(draft(withFinale, 0, 0)).toBe(true);
    expect(withFinale.tasks[0].finale, 'the first task taken must not carry the finale').toBe(false);
    expect(draft(withFinale, 1, 1)).toBe(true);
    expect(withFinale.tasks[1].finale, 'the last task taken carries the finale').toBe(true);

    const without = build(false);
    expect(draft(without, 0, 0)).toBe(true);
    expect(draft(without, 1, 1)).toBe(true);
    expect(without.tasks.some((t) => t.finale), 'a rung with no finale grew one').toBe(false);
  });
});

// ── locked cards ────────────────────────────────────────────────────────────────

/**
 * WHY: a task that cannot land yet loses the mission the instant its card enters a trick, whoever
 * wins it. Leaving that as an unwritten social contract lets one innocent tap end everyone's run in
 * a game where you are not allowed to warn anybody — so it is illegal, with exactly one exception:
 * when following suit leaves you holding nothing else, it becomes legal and the UI must be able to
 * say so BEFORE the tap.
 */
describe('a locked card is illegal, until it is the only thing left', () => {
  const chained = (hands: number[][], tricks: number, commander = 0): Mission =>
    position({
      hands,
      tricks,
      commander,
      tasks: [
        { card: cardOf(LOFT, 1), owner: 1, order: 1 },
        { card: cardOf(LOFT, 2), owner: 0, order: 2 },
      ],
    });

  it('hides a blocked link from the legal list while a lower link is open', () => {
    const m = chained(
      [
        [cardOf(LOFT, 2), cardOf(DRAPE, 1)],
        [cardOf(LOFT, 1), cardOf(DRAPE, 2)],
      ],
      3,
    );
    expect(isBlocked(m, m.tasks[1]), 'link 2 is blocked while link 1 is open').toBe(true);
    expect(isBlocked(m, m.tasks[0]), 'the lowest open link is never blocked').toBe(false);
    expect(legalFor(m, 0), 'a blocked link was offered alongside a safe card').toEqual([cardOf(DRAPE, 1)]);
    expect(isSqueezed(m, 0)).toBe(false);
    refused(m, 'playing a blocked link with a safe card in hand', () => play(m, 0, cardOf(LOFT, 2)));
  });

  it('makes it legal — and reports the squeeze — when there is nothing else', () => {
    const m = chained([[cardOf(LOFT, 2)], [cardOf(BATTEN, 1)]], 1);
    expect(legalFor(m, 0), 'a squeezed seat must still have a move').toEqual([cardOf(LOFT, 2)]);
    expect(isSqueezed(m, 0), 'the UI has to be able to warn before the tap').toBe(true);
    expect(isSqueezed(m, 1), 'a seat that is not to play is not squeezed').toBe(false);
    expect(play(m, 0, cardOf(LOFT, 2)), 'the squeeze must be playable').toBe(true);
  });

  it('locks a finale until the very last trick, then unlocks it', () => {
    const m = position({
      hands: [
        [cardOf(LOFT, 2), cardOf(DRAPE, 1)],
        [cardOf(LOFT, 1), cardOf(DRAPE, 2)],
      ],
      tricks: 2,
      tasks: [{ card: cardOf(LOFT, 2), owner: 0, finale: true }],
    });
    expect(isBlocked(m, m.tasks[0])).toBe(true);
    expect(legalFor(m, 0)).toEqual([cardOf(DRAPE, 1)]);
    refused(m, 'a finale played early with an alternative in hand', () => play(m, 0, cardOf(LOFT, 2)));

    m.trickNo = m.setup.tricks - 1; // stand in the final trick and ask again
    expect(isBlocked(m, m.tasks[0]), 'the finale is exactly what the last trick is for').toBe(false);
    expect(legalFor(m, 0).sort((a, b) => a - b)).toEqual([cardOf(LOFT, 2), cardOf(DRAPE, 1)].sort((a, b) => a - b));
    expect(isSqueezed(m, 0)).toBe(false);
  });
});

// ── adjudication ────────────────────────────────────────────────────────────────

/**
 * WHY: five different endings share one code path, and their ORDER is the rule — a trick that both
 * completes one task and loses another is a loss, because no ordering of those two leaves the
 * mission winnable. Each ending is built here as an exact position rather than searched for, since
 * a chain landing out of order needs a squeeze to happen at all.
 */
describe('adjudicating a trick: complete, or lose the mission', () => {
  it('completes a task when its OWNER takes the trick, and ends the mission at once', () => {
    const m = position({
      hands: [
        [cardOf(DRAPE, 5), cardOf(DRAPE, 1), cardOf(BATTEN, 1)],
        [cardOf(DRAPE, 2), cardOf(DRAPE, 3), cardOf(BATTEN, 2)],
      ],
      tricks: 3,
      tasks: [{ card: cardOf(DRAPE, 5), owner: 0 }],
    });
    expect(play(m, 0, cardOf(DRAPE, 5))).toBe(true);
    expect(play(m, 1, cardOf(DRAPE, 2))).toBe(true);
    expect(m.success).toBe(true);
    expect(m.phase).toBe('over');
    expect(m.reason).toBe('every task complete');
    expect(m.trickNo, 'a completed roster must not play out the remaining tricks').toBe(0);
    expect(m.tasks[0].done).toBe(true);
    expect(m.tasks[0].trick).toBe(0);
    expect(m.events.filter((e) => e.k === 'task' && e.ok)).toHaveLength(1);
  });

  it('loses the mission when anyone ELSE takes the trick holding the card', () => {
    const m = position({
      hands: [
        [cardOf(DRAPE, 5), cardOf(BATTEN, 1)],
        [cardOf(DRAPE, 2), cardOf(BATTEN, 2)],
      ],
      tricks: 2,
      tasks: [{ card: cardOf(DRAPE, 2), owner: 1 }],
    });
    // Seat 1's own task card, taken by seat 0. Trust is the whole game: somebody has to put it where
    // its owner can reach it, and this is what happens when they do not.
    expect(play(m, 0, cardOf(DRAPE, 5))).toBe(true);
    expect(play(m, 1, cardOf(DRAPE, 2))).toBe(true);
    expect(m.phase).toBe('over');
    expect(m.success).toBe(false);
    expect(m.reason).toBe('taken by the wrong crewmate');
    expect(m.events.some((e) => e.k === 'task' && !e.ok && e.card === cardOf(DRAPE, 2))).toBe(true);
  });

  it('loses the mission when a chain link lands out of order', () => {
    const m = position({
      hands: [[cardOf(LOFT, 2)], [cardOf(BATTEN, 1)]],
      tricks: 1,
      tasks: [
        { card: cardOf(LOFT, 1), owner: 1, order: 1 },
        { card: cardOf(LOFT, 2), owner: 0, order: 2 },
      ],
    });
    // Seat 0 is squeezed into link 2 and WINS it — so this is not a wrong-crewmate loss, it is the
    // chain breaking, which is the rule that needed its own path.
    expect(isSqueezed(m, 0)).toBe(true);
    expect(play(m, 0, cardOf(LOFT, 2))).toBe(true);
    expect(play(m, 1, cardOf(BATTEN, 1))).toBe(true);
    expect(m.success).toBe(false);
    expect(m.reason).toBe('landed out of order');
    expect(m.tasks[1].done, 'a task that broke the chain must not be marked complete').toBe(false);
  });

  it('loses the mission when the finale lands before the final trick', () => {
    const early = position({
      hands: [
        [cardOf(LOFT, 2), cardOf(DRAPE, 1)],
        [cardOf(LOFT, 1), cardOf(BATTEN, 3)],
      ],
      tricks: 2,
      commander: 1,
      tasks: [{ card: cardOf(LOFT, 2), owner: 0, finale: true }],
    });
    expect(play(early, 1, cardOf(LOFT, 1))).toBe(true);
    expect(isSqueezed(early, 0), 'seat 0 must follow Loft, and its only Loft is the finale').toBe(true);
    expect(play(early, 0, cardOf(LOFT, 2))).toBe(true);
    expect(early.success).toBe(false);
    expect(early.reason).toBe('landed before the final trick');

    // The identical play, one trick shorter: now it IS the final trick, and it wins.
    const onTime = position({
      hands: [
        [cardOf(LOFT, 2), cardOf(DRAPE, 1)],
        [cardOf(LOFT, 1), cardOf(BATTEN, 3)],
      ],
      tricks: 1,
      commander: 1,
      tasks: [{ card: cardOf(LOFT, 2), owner: 0, finale: true }],
    });
    expect(play(onTime, 1, cardOf(LOFT, 1))).toBe(true);
    expect(play(onTime, 0, cardOf(LOFT, 2))).toBe(true);
    expect(onTime.success, 'the same finale on the last trick must be a win').toBe(true);
  });

  it('loses the mission when the cards simply run out', () => {
    const m = position({
      hands: [[cardOf(BATTEN, 1)], [cardOf(BATTEN, 2)]],
      tricks: 1,
      tasks: [{ card: cardOf(DRAPE, 9), owner: 0 }],
    });
    expect(play(m, 0, cardOf(BATTEN, 1))).toBe(true);
    expect(play(m, 1, cardOf(BATTEN, 2))).toBe(true);
    expect(m.phase).toBe('over');
    expect(m.success).toBe(false);
    expect(m.reason).toBe('the cards ran out');
  });

  it('counts a trick that both completes and loses a task as a LOSS', () => {
    const m = position({
      hands: [
        [cardOf(DRAPE, 5), cardOf(BATTEN, 1)],
        [cardOf(DRAPE, 2), cardOf(BATTEN, 2)],
      ],
      tricks: 2,
      tasks: [
        { card: cardOf(DRAPE, 5), owner: 0 },
        { card: cardOf(DRAPE, 2), owner: 1 },
      ],
    });
    expect(play(m, 0, cardOf(DRAPE, 5))).toBe(true);
    expect(play(m, 1, cardOf(DRAPE, 2))).toBe(true);
    expect(m.success, 'a completion must not paper over a loss in the same trick').toBe(false);
    expect(m.reason).toBe('taken by the wrong crewmate');
  });
});

// ── signals ─────────────────────────────────────────────────────────────────────

/**
 * WHY: a signal is a CLAIM, and the single token it costs is only worth anything because the game
 * refuses to let anyone make a false one. Holding exactly one card of a colour forces the "only"
 * claim: calling it your highest would be true and deeply misleading, and a co-op whose sanctioned
 * move is to mislead your crew is not this game.
 */
describe('canSignal: a signal has to be true', () => {
  const table = (): Mission =>
    position({
      hands: [
        [cardOf(LOFT, 1), cardOf(LOFT, 3), cardOf(LOFT, 5), cardOf(BATTEN, 1)],
        [cardOf(BATTEN, 2), cardOf(BATTEN, 3), cardOf(DRAPE, 1), cardOf(DRAPE, 2)],
        [cardOf(TRUSS, 1), cardOf(TRUSS, 2), cardOf(TRUSS, 3), cardOf(TRUMP, 1)],
      ],
      tricks: 4,
      signals: 1,
    });

  it('only accepts "highest" and "lowest" when they are actually true', () => {
    const m = table();
    expect(canSignal(m, 0, cardOf(LOFT, 5), SIG_HIGH)).toBe(true);
    expect(canSignal(m, 0, cardOf(LOFT, 5), SIG_LOW), 'the top card is not the lowest').toBe(false);
    expect(canSignal(m, 0, cardOf(LOFT, 1), SIG_LOW)).toBe(true);
    expect(canSignal(m, 0, cardOf(LOFT, 1), SIG_HIGH)).toBe(false);
    for (const kind of [SIG_HIGH, SIG_LOW, SIG_ONLY]) {
      expect(canSignal(m, 0, cardOf(LOFT, 3), kind), 'a middle card can claim nothing at all').toBe(false);
    }
    expect(signalKindsFor(m, 0, cardOf(LOFT, 5))).toEqual([SIG_HIGH]);
    expect(signalKindsFor(m, 0, cardOf(LOFT, 3))).toEqual([]);
  });

  it('FORCES the "only" claim when a colour is a singleton', () => {
    const m = table();
    expect(canSignal(m, 0, cardOf(BATTEN, 1), SIG_ONLY)).toBe(true);
    expect(canSignal(m, 0, cardOf(BATTEN, 1), SIG_HIGH), 'true but misleading is still refused').toBe(false);
    expect(canSignal(m, 0, cardOf(BATTEN, 1), SIG_LOW)).toBe(false);
    expect(signalKindsFor(m, 0, cardOf(BATTEN, 1))).toEqual([SIG_ONLY]);
    expect(canSignal(m, 0, cardOf(LOFT, 5), SIG_ONLY), '"only" is a lie with three Lofts in hand').toBe(false);
  });

  it('refuses a claim about a card you do not hold, or a turn that is not yours', () => {
    const m = table();
    expect(canSignal(m, 0, cardOf(DRAPE, 1), SIG_ONLY), 'that card is in seat 1s hand').toBe(false);
    expect(canSignal(m, 1, cardOf(DRAPE, 1), SIG_ONLY), 'it is not seat 1s turn').toBe(false);
    expect(canSignal(m, 0, cardOf(LOFT, 5), 99), 'an unknown claim kind').toBe(false);
    refused(m, 'a false "highest" claim', () => signal(m, 0, cardOf(LOFT, 1), SIG_HIGH));
  });

  it('spends the budget, and there is no second signal', () => {
    const m = table();
    expect(m.signalsLeft).toEqual([1, 1, 1]);
    expect(signal(m, 0, cardOf(LOFT, 5), SIG_HIGH)).toBe(true);
    expect(m.signalsLeft[0]).toBe(0);
    expect(m.signals).toEqual([{ seat: 0, card: cardOf(LOFT, 5), kind: SIG_HIGH }]);
    expect(canSignal(m, 0, cardOf(BATTEN, 1), SIG_ONLY), 'the budget is spent').toBe(false);
    refused(m, 'a second signal on a budget of one', () => signal(m, 0, cardOf(BATTEN, 1), SIG_ONLY));
  });

  it('never lets a word be said in Hush', () => {
    const m = position({
      hands: [
        [cardOf(LOFT, 1), cardOf(LOFT, 5)],
        [cardOf(BATTEN, 1), cardOf(BATTEN, 5)],
      ],
      tricks: 2,
      modeId: 'hush',
    });
    expect(m.setup.signalBudget).toBe(0);
    expect(m.signalsLeft).toEqual([0, 0]);
    expect(canSignal(m, 0, cardOf(LOFT, 5), SIG_HIGH), 'Hush has no comms panel at all').toBe(false);
    refused(m, 'a signal in Hush', () => signal(m, 0, cardOf(LOFT, 5), SIG_HIGH));
  });
});
