/**
 * bot-view.test.ts — THE INFORMATION GATE.
 *
 * In a versus game a peeking bot is a cheap opponent. In a CO-OP it is worse than that: the crew is
 * meant to be deducing each other, and a crewmate that already knows the answer turns every mission
 * into a puppet show whose outcome was decided at the deal. Nothing on screen would look wrong, and
 * no player could ever prove it — which is exactly why it has to be proved here.
 *
 * `viewFor()` is the only door between a Mission (which holds every hand) and the bot, so this file
 * guards that door three ways:
 *
 *   1. the key set is CLOSED — adding a field that carries a hand fails the build, not the player;
 *   2. a DEEP SCAN walks the whole view object and checks that no array of numbers anywhere in it
 *      corresponds to another seat's hand, at many seeds, player counts and points in a mission;
 *   3. the scan is shown to have TEETH against a deliberately leaky view — without that, a scan that
 *      silently walked nothing would report a clean sweep forever.
 */

import { describe, expect, it } from 'vitest';
import {
  BOT_VIEW_KEYS,
  bestSignal,
  chooseCard,
  chooseDraft,
  signalThreshold,
  viewFor,
  type BotView,
} from '../src/bot';
import { legalPlays } from '../src/cards';
import { MODE_IDS, modeOf } from '../src/modes';
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
  type Mission,
} from '../src/mission';

// ── the scan ────────────────────────────────────────────────────────────────────

interface NumArray {
  path: string;
  nums: number[];
}

/**
 * Every array of numbers anywhere in the object, with the path it was found at. Recursive on
 * purpose: a leak two levels down inside `tasks` would be invisible to a check that only looked at
 * the top-level fields, and the top-level fields are the ones a reviewer would think to look at.
 *
 * `voids` (boolean[][]) is skipped by the "all elements are numbers" test rather than by name, so a
 * boolean matrix that quietly turned into a card matrix would start being scanned.
 */
function numericArrays(root: unknown): NumArray[] {
  const out: NumArray[] = [];
  const visited = new Set<object>();
  const walk = (node: unknown, path: string): void => {
    if (node === null || typeof node !== 'object') return;
    if (visited.has(node)) return;
    visited.add(node);
    if (Array.isArray(node)) {
      if (node.length > 0 && node.every((x) => typeof x === 'number')) {
        out.push({ path, nums: node as number[] });
      }
      node.forEach((child, i) => walk(child, `${path}[${i}]`));
      return;
    }
    for (const [k, v] of Object.entries(node)) walk(v, path === '' ? k : `${path}.${k}`);
  };
  walk(root, '');
  return out;
}

/**
 * How many cards of one hand have to show up in the view before it counts as a leak.
 *
 * Not one, and the reason is a genuine numeric collision rather than laziness: `signalsLeft` is a
 * legitimate array of small integers, and the values 1 and 2 are also the card codes for Loft 1 and
 * Loft 2. So up to two of a hand's cards can appear in the view by pure arithmetic coincidence. The
 * signal budget is capped at 2 (see modes.ts), so THREE cards of one hand can never be a
 * coincidence — every other numeric array in the view (`hand`, `seen`, `trick`) is disjoint from
 * another seat's remaining cards by construction, because a card is either mine, on the table, or
 * unknown, and never two of those at once.
 */
const LEAK_FLOOR = 3;

const sortedCopy = (xs: readonly number[]): number[] => [...xs].sort((a, b) => a - b);

/**
 * Everything about `view` that a seat is not entitled to know. Returns a list of human-readable
 * findings; an empty list is a clean view.
 */
function leakFindings(view: unknown, m: Mission, seat: number, where: string): string[] {
  const arrays = numericArrays(view);
  const found: string[] = [];
  for (let other = 0; other < m.setup.players; other++) {
    if (other === seat) continue;
    const secret = m.hands[other];
    if (!secret || secret.length < LEAK_FLOOR) continue;

    // (a) Is the hand simply sitting there, in some order, as one of the arrays?
    const want = JSON.stringify(sortedCopy(secret));
    for (const a of arrays) {
      if (a.nums.length === secret.length && JSON.stringify(sortedCopy(a.nums)) === want) {
        found.push(`${where}: seat ${seat}'s view holds seat ${other}'s whole hand at ${a.path}`);
      }
    }

    // (b) Is it RECOVERABLE — spread across the view rather than sitting in one array?
    const hits = new Map<number, string[]>();
    for (const a of arrays) {
      for (const n of a.nums) {
        if (!secret.includes(n)) continue;
        const at = hits.get(n) ?? [];
        at.push(a.path);
        hits.set(n, at);
      }
    }
    if (hits.size >= LEAK_FLOOR) {
      const detail = [...hits].map(([c, ps]) => `${c}@${[...new Set(ps)].join(',')}`).join(' ');
      found.push(
        `${where}: seat ${seat} can see ${hits.size}/${secret.length} of seat ${other}'s cards — ${detail}`,
      );
    }
  }
  return found;
}

// ── driving a mission ───────────────────────────────────────────────────────────

interface Checkpoints {
  afterDraft: number;
  midTrick: number;
  nearEnd: number;
  scans: number;
  arrays: number;
}

/**
 * One all-bot mission, stopping at EVERY action boundary so `visit` sees the draft, every part-way
 * trick and the endgame. Scanning only "after the deal" would miss a leak that only appears once
 * `trick` or `signals` has something in it, which is precisely where a convenience field gets added.
 */
function driveMission(
  modeId: string,
  mission: number,
  players: number,
  seed: number,
  visit: (m: Mission) => void,
): Mission {
  const mode = modeOf(modeId);
  const m = createMission(makeSetup(mode, mission, players, seed, seed ^ 0x9e37_79b9), mode);
  visit(m);

  let guard = 0;
  while (m.phase === 'draft') {
    if (++guard > 64) throw new Error('bot-view: the draft never finished');
    const seat = m.draftTurn;
    const taken = m.tasks.filter((t) => t.owner !== -1).length;
    const avail = draftableFor(m, seat, m.draftRelaxed);
    if (avail.length === 0) {
      // Nothing this seat may take. The pass is an explicit action — see A_PASS in src/mission.ts.
      if (!apply(m, packAct(A_PASS, seat, 0))) throw new Error(`bot-view: seat ${seat} could neither draft nor pass`);
      continue;
    }
    const pick = chooseDraft(viewFor(m, seat), avail, taken);
    if (!apply(m, packAct(A_DRAFT, seat, pick))) throw new Error(`bot-view: illegal draft ${pick}`);
    visit(m);
  }

  guard = 0;
  while (m.phase === 'play') {
    if (++guard > 400) throw new Error('bot-view: the mission never terminated');
    const seat = m.turn;
    if (m.signalsLeft[seat] > 0 && m.setup.signalBudget > 0) {
      const choice = bestSignal(viewFor(m, seat), (card, kind) => canSignal(m, seat, card, kind));
      if (choice && choice.score >= signalThreshold(m.trickNo)) {
        apply(m, packAct(A_SIGNAL, seat, packSignal(choice.kind, choice.card)));
        visit(m);
      }
    }
    const allowed = legalFor(m, seat);
    const wanted = chooseCard(viewFor(m, seat));
    const card = allowed.includes(wanted) ? wanted : allowed[0];
    if (!apply(m, packAct(A_PLAY, seat, card))) throw new Error(`bot-view: illegal play ${card}`);
    visit(m);
  }
  return m;
}

// ── the tests ───────────────────────────────────────────────────────────────────

describe('the view is the only door, and it is closed', () => {
  it('the hand in the view is exactly this seat’s own hand, and a copy of it', () => {
    for (const id of MODE_IDS) {
      for (const players of [2, 3, 4, 5]) {
        driveMission(id, 6, players, 4242 + players, (m) => {
          for (let s = 0; s < players; s++) {
            const v = viewFor(m, s);
            expect(v.hand, `${id}/${players}P: seat ${s} was handed the wrong cards`).toEqual(m.hands[s]);
            expect(v.hand, 'the view must not alias the mission’s own array').not.toBe(m.hands[s]);
          }
        });
      }
    }
  });

  /**
   * The closed key set. This is the assertion that makes the leak impossible to add by accident: any
   * new field on BotView — however innocently named — turns this red until someone has looked at it
   * and added it to BOT_VIEW_KEYS deliberately.
   */
  it('the key set is exactly BOT_VIEW_KEYS, at every seat and every phase', () => {
    const want = [...BOT_VIEW_KEYS].sort();
    let checked = 0;
    for (const id of MODE_IDS) {
      driveMission(id, 8, 4, 777, (m) => {
        for (let s = 0; s < 4; s++) {
          expect(Object.keys(viewFor(m, s)).sort(), `${id}: the view grew or lost a field`).toEqual(want);
          checked++;
        }
      });
    }
    expect(checked).toBeGreaterThan(100);
  });
});

describe('the deep scan finds no other hand in the view', () => {
  it('across modes, counts, seeds and every point in a mission', () => {
    const cp: Checkpoints = { afterDraft: 0, midTrick: 0, nearEnd: 0, scans: 0, arrays: 0 };
    const findings: string[] = [];

    for (const id of MODE_IDS) {
      for (const players of [2, 3, 4, 5]) {
        for (let i = 0; i < 6; i++) {
          const seed = 20_260_802 + i * 104_729 + players * 7919;
          driveMission(id, 9, players, seed, (m) => {
            if (m.phase === 'play' && m.trickNo === 0 && m.trick.length === 0) cp.afterDraft++;
            if (m.trick.length > 0 && m.trick.length < players) cp.midTrick++;
            if (m.trickNo >= m.setup.tricks - 2) cp.nearEnd++;
            for (let s = 0; s < players; s++) {
              const v = viewFor(m, s);
              cp.arrays += numericArrays(v).length;
              cp.scans++;
              if (findings.length < 20) {
                findings.push(...leakFindings(v, m, s, `${id}/${players}P/s${i}/t${m.trickNo}`));
              }
            }
          });
        }
      }
    }

    expect(findings, findings.join('\n')).toEqual([]);
    // A silent scan is the failure mode this whole file exists to avoid, so the coverage it claims
    // is asserted rather than assumed.
    expect(cp.scans, 'the sweep barely ran').toBeGreaterThan(6000);
    expect(cp.arrays, 'the walk found almost no arrays, so it was not walking the view').toBeGreaterThan(
      cp.scans * 3,
    );
    expect(cp.afterDraft, 'never scanned the position the draft closed on').toBeGreaterThan(80);
    expect(cp.midTrick, 'never scanned a part-way trick').toBeGreaterThan(1000);
    expect(cp.nearEnd, 'never scanned the endgame, where hands are small and easiest to leak').toBeGreaterThan(150);
  });

  /**
   * THE PROOF THAT THE SCAN HAS TEETH. Two shapes of leak, because they fail differently: one adds a
   * new field carrying a whole hand (the shape a helpful refactor produces), the other smuggles the
   * same cards into an array that is SUPPOSED to be there (the shape a subtle bug produces, and the
   * one a key-set assertion alone would never catch).
   */
  it('a deliberately leaky view is flagged — both as a new field and inside an allowed one', () => {
    let newField = 0;
    let smuggled = 0;
    let cases = 0;

    for (const players of [3, 5]) {
      driveMission('aside', 9, players, 5150 + players, (m) => {
        if (m.phase !== 'play' || m.trickNo !== 0 || m.trick.length !== 0) return;
        const secret = m.hands[1]!;
        expect(secret.length).toBeGreaterThanOrEqual(LEAK_FLOOR);
        const honest = viewFor(m, 0);

        expect(leakFindings(honest, m, 0, 'control'), 'the honest view must be clean first').toEqual([]);

        const leaky = { ...honest, leak: [...secret] };
        const a = leakFindings(leaky, m, 0, 'leaky');
        expect(a.length, 'a whole hand bolted onto the view walked straight past the scan').toBeGreaterThan(0);
        expect(a.join('\n')).toContain('leak');
        newField += a.length;

        // Same cards, no new key: they are appended to `seen`, which is a legitimate number array.
        const inside = { ...honest, seen: [...honest.seen, ...secret] };
        const b = leakFindings(inside, m, 0, 'smuggled');
        expect(b.length, 'a hand hidden inside an allowed array walked past the scan').toBeGreaterThan(0);
        smuggled += b.length;
        cases++;
      });
    }
    expect(cases, 'the leaky-view check never ran, so it proved nothing').toBeGreaterThan(1);
    expect(newField).toBeGreaterThan(0);
    expect(smuggled).toBeGreaterThan(0);
  });

  it('the scan reads a hand that is present in any order, not just the dealt one', () => {
    // Guards the scan itself: a permutation check written as an === on the joined string would pass
    // the test above (the leak is inserted in hand order) and miss every real leak, which will not
    // be in hand order.
    const mode = modeOf('hush');
    const m = createMission(makeSetup(mode, 4, 4, 31337, 90210), mode);
    const shuffled = [...m.hands[1]!].reverse();
    expect(leakFindings({ ...viewFor(m, 0), leak: shuffled }, m, 0, 'reversed').length).toBeGreaterThan(0);
  });
});

describe('the bot is a pure function of its view', () => {
  it('chooseCard on the same view twice returns the same card', () => {
    let compared = 0;
    for (const id of MODE_IDS) {
      for (const players of [2, 3, 4, 5]) {
        driveMission(id, 7, players, 9001 + players, (m) => {
          if (m.phase !== 'play') return;
          const seat = m.turn;
          const v: BotView = viewFor(m, seat);
          const first = chooseCard(v);
          expect(chooseCard(v), 'the same view gave two different answers').toBe(first);
          // And a view rebuilt from the same position, which is what a peer would hold.
          expect(chooseCard(viewFor(m, seat)), 'a rebuilt view gave a different answer').toBe(first);
          // Whatever it picked has to be a card it actually holds and could actually play.
          const led = v.trick.length === 0 ? null : Math.floor(v.trick[0] / 16);
          expect(legalPlays(v.hand, led)).toContain(first);
          compared++;
        });
      }
    }
    expect(compared).toBeGreaterThan(300);
  });

  it('chooseDraft on the same view twice picks the same candidate', () => {
    let compared = 0;
    for (const id of MODE_IDS) {
      for (const players of [3, 5]) {
        driveMission(id, 12, players, 24_601 + players, (m) => {
          if (m.phase !== 'draft') return;
          const seat = m.draftTurn;
          const avail = draftableFor(m, seat, m.draftRelaxed);
          if (avail.length === 0) return; // this seat is about to be passed; there is nothing to choose
          const taken = m.tasks.filter((t) => t.owner !== -1).length;
          const v = viewFor(m, seat);
          const first = chooseDraft(v, avail, taken);
          expect(chooseDraft(v, avail, taken)).toBe(first);
          expect(avail).toContain(first);
          compared++;
        });
      }
    }
    expect(compared).toBeGreaterThan(10);
  });
});
