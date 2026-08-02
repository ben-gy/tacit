// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// See ADDITIONAL-TERMS.md for the section 7(b) attribution requirement.
//
// Tacit — one mission, as a single deterministic state machine.
//
// THE ONE ARCHITECTURAL IDEA: a mission is `setup + an ordered log of actions`, and every peer runs
// the SAME machine over that log. The host owns the deal (hands are dealt privately and never go on
// the wire), but it does not own a second, different representation of the game — a guest holds the
// identical Mission object with the other players' hands marked UNKNOWN. That is what lets the host
// broadcast the whole log every couple of seconds and have a peer that missed three messages, or
// connected halfway through, simply replay to the same position. Two representations of one game is
// how a card game desyncs; there is only one here.
//
// Hands are `number[] | null`. null means "this peer is not allowed to know" — it is not an empty
// hand, and every code path that touches a hand has to say which it means.

import { TRUMP, cardOf, colourCards, handSize, isTrump, legalPlays, rankOf, suitOf, trickWinner } from './cards';
import { rungFor, type Mode } from './modes';
import { makeRng, shuffle, type Rng } from '@ben-gy/game-engine/rng';

// ── the action log ──────────────────────────────────────────────────────────────
// Packed into one int so the whole mission fits in a handful of bytes on the wire and a test can
// write a log inline. 24 bits: kkkk ssss pppppppppppppppp.

export const A_DRAFT = 0;
export const A_PLAY = 1;
export const A_SIGNAL = 2;
/**
 * "This seat cannot take anything, move on." HOST-ONLY, and it exists because the alternative
 * desyncs the room.
 *
 * Whether a seat can draft depends on WHAT IS IN ITS HAND, which is exactly the thing a guest is not
 * allowed to know. So a guest silently skipping the same seat the host skipped is impossible: it
 * computed a different draft turn, rejected the host's next action as illegal, asked to be re-dealt,
 * rejected it again, and the two of them traded messages for ever. Putting the skip in the LOG makes
 * the whole draft a pure function of public information again.
 */
export const A_PASS = 3;

export const packAct = (kind: number, seat: number, payload: number): number =>
  (kind << 20) | (seat << 16) | (payload & 0xffff);
export const actKind = (a: number): number => (a >> 20) & 15;
export const actSeat = (a: number): number => (a >> 16) & 15;
export const actPayload = (a: number): number => a & 0xffff;

/** Signal meanings. A signal is a CLAIM about your hand, and it must be true — see `canSignal`. */
export const SIG_HIGH = 0;
export const SIG_LOW = 1;
export const SIG_ONLY = 2;
export const SIG_LABEL = ['highest', 'lowest', 'only'] as const;

export const packSignal = (kind: number, card: number): number => (kind << 8) | card;
export const signalKind = (p: number): number => (p >> 8) & 0xff;
export const signalCard = (p: number): number => p & 0xff;

// ── setup ───────────────────────────────────────────────────────────────────────

/**
 * A candidate on the table. Just a card: the numbered links are NOT printed on the cards, they are
 * decided by the DRAFT — the k-th task taken becomes link k.
 *
 * That is not a shortcut, it is the fix for a real hole. Stamping tokens onto the candidates before
 * the draft means a token can land on a spare that nobody takes, leaving a chain with a missing
 * link (1, then 3) that can never be completed. Tying the token to the pick order makes the chain
 * correct by construction, and turns the draft into the conversation the mode is about: taking
 * first means committing to going first.
 */
export interface TaskSpec {
  card: number;
}

export interface Setup {
  players: number;
  modeId: string;
  /** Which rung of the ladder. 1 is the gentle one. */
  mission: number;
  /** The candidates on the table, public. Longer than `take` — the rest are torn up. */
  pool: TaskSpec[];
  /** How many of `pool` the crew actually takes on. The remainder are discarded at draft end. */
  take: number;
  /** The first this-many tasks TAKEN become numbered links 1..n and must land in that order. */
  ordered: number;
  /** The LAST task taken must land in the very final trick. */
  finale: boolean;
  /** Who leads the first trick: whoever was dealt the top Pulse. Broadcast by the host. */
  commander: number;
  /** The deal, as known to THIS peer. null = a hand this peer is not allowed to see. */
  deal: (number[] | null)[];
  signalBudget: number;
  tricks: number;
}

export interface Signal {
  seat: number;
  card: number;
  kind: number;
}

export interface Task extends TaskSpec {
  /** Seat that drafted it, or -1 while it is still in the pool (or was never taken). */
  owner: number;
  /** 0 = loose. 1..k = a numbered link that may only land after every lower link. Set by the draft. */
  order: number;
  /** This task must be won in the very LAST trick — not a moment sooner. Set by the draft. */
  finale: boolean;
  /** True once the draft closed without this candidate being taken. It is then inert: torn up. */
  discarded: boolean;
  done: boolean;
  /** Trick index it completed on, or -1. */
  trick: number;
}

/** A candidate that is actually in play. A torn-up spare is not a task and cannot be failed. */
export const isLive = (t: Task): boolean => t.owner >= 0 && !t.discarded;

export type Ev =
  | { k: 'deal'; hands: number[][] }
  | { k: 'draft'; seat: number; task: number }
  /**
   * The final task list, emitted the moment the draft closes. It exists for tests/helpers/audit.ts:
   * the ordering and finale rules are the most intricate in the game, and an audit that cannot see
   * which task is which link can only check the easy half and will report a clean sweep while the
   * chain logic is wrong.
   */
  | { k: 'roster'; tasks: Array<{ card: number; owner: number; order: number; finale: boolean }>; tricks: number }
  | { k: 'play'; seat: number; card: number; trick: number }
  | { k: 'trick'; trick: number; lead: number; cards: number[]; winner: number }
  | { k: 'task'; card: number; owner: number; ok: boolean; trick: number }
  | { k: 'signal'; seat: number; card: number; kind: number }
  | { k: 'end'; success: boolean; reason: string };

export type Phase = 'draft' | 'play' | 'over';

export interface Mission {
  readonly setup: Setup;
  readonly mode: Mode;
  hands: (number[] | null)[];
  tasks: Task[];
  signals: Signal[];
  signalsLeft: number[];
  /** Cards played in this trick, in play order starting from `lead`. */
  trick: number[];
  lead: number;
  turn: number;
  trickNo: number;
  tricksWon: number[];
  /** Every card that has hit the table, in order — the deduction surface for players and bots. */
  seen: number[];
  /**
   * seat × suit: this crewmate failed to follow that suit, so they are out of it. Public, derived,
   * and the single most valuable thing anyone at the table knows — in Blackout it is the ONLY thing
   * anyone learns about anyone.
   */
  voids: boolean[][];
  /** Who played each card in `seen`, so the log and the summary can name names. */
  seenBy: number[];
  phase: Phase;
  draftTurn: number;
  /** Set when no seat could take anything: the own-hand rule lifts so the draft cannot hang. */
  draftRelaxed: boolean;
  /** Consecutive passes. A full lap means the table is stuck and the rule lifts. */
  draftPasses: number;
  success: boolean;
  reason: string;
  log: number[];
  events: Ev[];
}

/**
 * The task pool for a rung, from the SHARED round seed. Public by construction: every peer computes
 * the identical pool without a message, which is why only the hands ever need to be unicast.
 */
export function buildPool(mode: Mode, mission: number, players: number, seed: number): TaskSpec[] {
  const rung = rungFor(mode, mission, players);
  const rng = makeRng(seed ^ 0x5eed_1e5f);
  return shuffle(rng, colourCards(players))
    .slice(0, rung.tasks + rung.spare)
    .map((card) => ({ card }));
}

/** Deal from a PRIVATE shuffle. Only ever called where every hand is allowed to be known. */
export function dealHands(players: number, rng: Rng): number[][] {
  const size = handSize(players);
  const deck = shuffle(rng, buildDeckFor(players));
  const hands: number[][] = [];
  for (let s = 0; s < players; s++) hands.push(deck.slice(s * size, (s + 1) * size));
  return hands;
}

function buildDeckFor(players: number): number[] {
  // Local rather than imported so the deal cannot silently drift from cards.ts's deck: this asks
  // cards.ts for the deck and nothing else.
  const out: number[] = [];
  const cards = colourCards(players);
  out.push(...cards);
  for (let r = 1; r <= 4; r++) out.push(cardOf(TRUMP, r));
  return out;
}

/** Whoever holds the top Pulse leads the first trick. Every deck has one, at every player count. */
export function commanderOf(hands: readonly number[][]): number {
  const top = cardOf(TRUMP, 4);
  for (let s = 0; s < hands.length; s++) if (hands[s].includes(top)) return s;
  return 0;
}

/**
 * A setup with every hand known — solo, and every simulation. TWO seeds on purpose: the task pool
 * comes from the shared round seed (so a guest computes the identical pool with no message), and the
 * DEAL comes from a separate one. In a real room the deal seed is minted privately by the host and
 * never leaves it, which is the entire reason a hand stays hidden in a game with no server.
 */
export function makeSetup(
  mode: Mode,
  mission: number,
  players: number,
  poolSeed: number,
  dealSeed: number,
): Setup {
  const hands = dealHands(players, makeRng(dealSeed));
  const rung = rungFor(mode, mission, players);
  return {
    players,
    modeId: mode.id,
    mission,
    pool: buildPool(mode, mission, players, poolSeed),
    take: rung.tasks,
    ordered: rung.ordered,
    finale: rung.finale,
    commander: commanderOf(hands),
    deal: hands,
    signalBudget: mode.signals,
    tricks: handSize(players),
  };
}

/**
 * The same mission as a GUEST sees it: the public pool, its own hand, and four holes where the other
 * hands would be. The mission machine runs identically over both — see the note at the top.
 */
export function guestSetup(
  mode: Mode,
  mission: number,
  players: number,
  poolSeed: number,
  seat: number,
  myHand: readonly number[],
  commander: number,
): Setup {
  const deal: (number[] | null)[] = Array.from({ length: players }, () => null);
  deal[seat] = [...myHand];
  const rung = rungFor(mode, mission, players);
  return {
    players,
    modeId: mode.id,
    mission,
    pool: buildPool(mode, mission, players, poolSeed),
    take: rung.tasks,
    ordered: rung.ordered,
    finale: rung.finale,
    commander,
    deal,
    signalBudget: mode.signals,
    tricks: handSize(players),
  };
}

export function createMission(setup: Setup, mode: Mode): Mission {
  const m: Mission = {
    setup,
    mode,
    hands: [],
    tasks: [],
    signals: [],
    signalsLeft: [],
    trick: [],
    lead: setup.commander,
    turn: setup.commander,
    trickNo: 0,
    tricksWon: [],
    seen: [],
    voids: [],
    seenBy: [],
    phase: 'draft',
    draftTurn: setup.commander,
    draftRelaxed: false,
    draftPasses: 0,
    success: false,
    reason: '',
    log: [],
    events: [],
  };
  reset(m);
  return m;
}

/** Back to the position before any action. Replay is reset + apply, and nothing else. */
export function reset(m: Mission): void {
  const s = m.setup;
  m.hands = s.deal.map((h) => (h === null ? null : [...h]));
  m.tasks = s.pool.map((t) => ({ ...t, owner: -1, order: 0, finale: false, discarded: false, done: false, trick: -1 }));
  m.signals = [];
  m.signalsLeft = Array.from({ length: s.players }, () => s.signalBudget);
  m.trick = [];
  m.lead = s.commander;
  m.turn = s.commander;
  m.trickNo = 0;
  m.tricksWon = Array.from({ length: s.players }, () => 0);
  m.seen = [];
  m.seenBy = [];
  m.voids = Array.from({ length: s.players }, () => [false, false, false, false, false]);
  m.phase = s.pool.length === 0 ? 'play' : 'draft';
  m.draftRelaxed = false;
  m.draftPasses = 0;
  m.draftTurn = m.phase === 'draft' ? s.commander : -1;
  m.success = false;
  m.reason = '';
  m.log = [];
  m.events = [];
  const known = m.hands.every((h) => h !== null);
  if (known) m.events.push({ k: 'deal', hands: (m.hands as number[][]).map((h) => [...h]) });
}

/** Reset and re-apply a whole log. This is how a guest catches up, and how a promoted host resumes. */
export function replay(m: Mission, log: readonly number[]): boolean {
  reset(m);
  for (const a of log) {
    if (!apply(m, a)) return false;
  }
  return true;
}

// ── legality ────────────────────────────────────────────────────────────────────

/** The led suit of the trick in progress, or null when this seat is leading. */
export function ledSuit(m: Mission): number | null {
  return m.trick.length === 0 ? null : suitOf(m.trick[0]);
}

/**
 * What `seat` may legally play right now. Empty when it is not their turn or the hand is unknown.
 *
 * A LOCKED CARD IS ILLEGAL, NOT MERELY UNWISE. A task that cannot land yet — a numbered link whose
 * predecessor is still open, or the finale before the final trick — loses the mission the instant
 * its card enters a trick, whoever wins it. Leaving that as an unwritten social contract means a
 * player can end everyone's run with one innocent tap on a card that looks like any other, and in a
 * game where you are not allowed to warn them, that is indefensible. So the rules simply forbid it.
 *
 * The one exception is the exception that keeps the tension: if following suit leaves you holding
 * NOTHING but locked cards, they become legal and you must play one. Being squeezed into breaking
 * the chain is a real and dramatic way to lose. Doing it by accident is not.
 */
export function legalFor(m: Mission, seat: number): number[] {
  if (m.phase !== 'play' || m.turn !== seat) return [];
  const hand = m.hands[seat];
  if (!hand) return [];
  return legalFrom(m, hand);
}

function legalFrom(m: Mission, hand: readonly number[]): number[] {
  const base = legalPlays(hand, ledSuit(m));
  const locked = new Set(m.tasks.filter((t) => isLive(t) && !t.done && isBlocked(m, t)).map((t) => t.card));
  if (locked.size === 0) return base;
  const open = base.filter((c) => !locked.has(c));
  return open.length > 0 ? open : base;
}

/** True when this seat has no choice but to break the chain. The UI says so before the tap. */
export function isSqueezed(m: Mission, seat: number): boolean {
  const hand = m.hands[seat];
  if (!hand || m.phase !== 'play') return false;
  const legal = legalFrom(m, hand);
  return legal.length > 0 && legal.every((c) => m.tasks.some((t) => isLive(t) && !t.done && t.card === c && isBlocked(m, t)));
}

/**
 * Is this signal TRUE? A signal is a claim, and the game refuses to let anyone make a false one —
 * that is the whole reason a single token carries so much. Holding exactly one card of a colour
 * forces the "only" claim: calling it your highest would be true and deeply misleading, and a
 * co-op where the sanctioned move is to mislead your crew is not this game.
 */
export function canSignal(m: Mission, seat: number, card: number, kind: number): boolean {
  if (m.phase !== 'play' || m.turn !== seat) return false;
  if (m.signalsLeft[seat] <= 0) return false;
  const hand = m.hands[seat];
  if (!hand || !hand.includes(card)) return false;
  const suit = suitOf(card);
  const sameSuit = hand.filter((c) => suitOf(c) === suit);
  if (sameSuit.length === 1) return kind === SIG_ONLY;
  if (kind === SIG_ONLY) return false;
  const ranks = sameSuit.map(rankOf);
  if (kind === SIG_HIGH) return rankOf(card) === Math.max(...ranks);
  if (kind === SIG_LOW) return rankOf(card) === Math.min(...ranks);
  return false;
}

/** Which claims this seat could truthfully make about a card it holds. Drives the signal UI. */
export function signalKindsFor(m: Mission, seat: number, card: number): number[] {
  return [SIG_HIGH, SIG_LOW, SIG_ONLY].filter((k) => canSignal(m, seat, card, k));
}

// ── applying an action ──────────────────────────────────────────────────────────

/**
 * Apply one packed action. Returns false and changes NOTHING if the action is illegal, so a
 * corrupted or hostile log stops the mission instead of half-applying it. Unknown hands are the one
 * place validation is skipped: only the host can see them, and the host already validated.
 */
export function apply(m: Mission, action: number): boolean {
  const kind = actKind(action);
  const seat = actSeat(action);
  const payload = actPayload(action);
  if (seat < 0 || seat >= m.setup.players) return false;

  if (kind === A_DRAFT) return applyDraft(m, seat, payload, action);
  if (kind === A_PASS) return applyPass(m, seat, action);
  if (kind === A_SIGNAL) return applySignal(m, seat, signalCard(payload), signalKind(payload), action);
  if (kind === A_PLAY) return applyPlay(m, seat, payload, action);
  return false;
}

function applyPass(m: Mission, seat: number, action: number): boolean {
  if (m.phase !== 'draft' || m.draftTurn !== seat) return false;
  m.log.push(action);
  m.draftPasses++;
  // A full lap of passes means nobody at the table can take anything under the own-hand rule. Lift
  // it rather than let the draft — and with it the mission — never finish.
  if (m.draftPasses >= m.setup.players) {
    m.draftRelaxed = true;
    m.draftPasses = 0;
  }
  m.draftTurn = (seat + 1) % m.setup.players;
  return true;
}

/**
 * Which candidates this seat may take on.
 *
 * YOU MAY NOT TAKE A TASK WHOSE CARD IS IN YOUR OWN HAND, and this one rule is worth more than any
 * amount of tuning. A task you hold has to win a trick as ITSELF — no trump can help you, because
 * playing the trump means not playing the task — so a middling card in your own hand is close to
 * unwinnable. Measured on the original forced draft: those missions were lost 11 times out of 11.
 * Forbidding it also turns every task into an act of trust, which is the game this wants to be: you
 * are always relying on somebody else to put the card where you can reach it.
 *
 * `relaxed` is the deadlock escape. If a seat can take nothing, the draft passes it on; if the whole
 * table passes, the rule lifts rather than the mission hanging.
 */
export function draftableFor(m: Mission, seat: number, relaxed = false): number[] {
  const idx = m.tasks.map((t, i) => (t.owner === -1 ? i : -1)).filter((i) => i >= 0);
  const hand = m.hands[seat];
  if (relaxed || !hand) return idx;
  const free = idx.filter((i) => !hand.includes(m.tasks[i].card));
  return free.length > 0 ? free : [];
}

function applyDraft(m: Mission, seat: number, task: number, action: number): boolean {
  if (m.phase !== 'draft' || m.draftTurn !== seat) return false;
  if (task < 0 || task >= m.tasks.length || m.tasks[task].owner !== -1) return false;
  const hand = m.hands[seat];
  if (hand && !m.draftRelaxed && hand.includes(m.tasks[task].card) && draftableFor(m, seat).length > 0) return false;

  const taken = m.tasks.filter((t) => t.owner !== -1).length;
  const t = m.tasks[task];
  t.owner = seat;
  // The pick order IS the chain: the k-th task taken is link k, and the last one taken carries the
  // finale. Both are shown on the draft screen before anyone commits.
  if (taken < m.setup.ordered) t.order = taken + 1;
  if (m.setup.finale && taken === m.setup.take - 1) t.finale = true;

  m.log.push(action);
  m.events.push({ k: 'draft', seat, task });

  if (taken + 1 >= m.setup.take) {
    for (const spare of m.tasks) if (spare.owner === -1) spare.discarded = true;
    m.phase = 'play';
    m.draftTurn = -1;
    m.events.push({
      k: 'roster',
      tasks: m.tasks.filter(isLive).map((x) => ({ card: x.card, owner: x.owner, order: x.order, finale: x.finale })),
      tricks: m.setup.tricks,
    });
  } else {
    m.draftPasses = 0;
    m.draftTurn = (seat + 1) % m.setup.players;
  }
  return true;
}

function applySignal(m: Mission, seat: number, card: number, kind: number, action: number): boolean {
  if (m.setup.signalBudget <= 0) return false;
  if (m.phase !== 'play' || m.turn !== seat) return false;
  if (m.signalsLeft[seat] <= 0) return false;
  const hand = m.hands[seat];
  // A guest cannot check a claim about a hand it cannot see, and must take the host's word: the
  // host validated with canSignal() before it ever reached the log.
  if (hand && !canSignal(m, seat, card, kind)) return false;
  if (kind !== SIG_HIGH && kind !== SIG_LOW && kind !== SIG_ONLY) return false;
  m.signalsLeft[seat]--;
  m.signals.push({ seat, card, kind });
  m.log.push(action);
  m.events.push({ k: 'signal', seat, card, kind });
  return true;
}

function applyPlay(m: Mission, seat: number, card: number, action: number): boolean {
  if (m.phase !== 'play' || m.turn !== seat) return false;
  const hand = m.hands[seat];
  if (hand) {
    if (!hand.includes(card)) return false;
    if (!legalFrom(m, hand).includes(card)) return false;
    hand.splice(hand.indexOf(card), 1);
  }
  const led = ledSuit(m);
  // Deduced BEFORE the card joins the trick, or ledSuit() would start reporting this very card.
  if (led !== null && suitOf(card) !== led) m.voids[seat][led] = true;
  m.trick.push(card);
  m.seen.push(card);
  m.seenBy.push(seat);
  m.log.push(action);
  m.events.push({ k: 'play', seat, card, trick: m.trickNo });

  if (m.trick.length < m.setup.players) {
    m.turn = (seat + 1) % m.setup.players;
    return true;
  }
  resolveTrick(m);
  return true;
}

function resolveTrick(m: Mission): void {
  const cards = m.trick;
  const winner = (m.lead + trickWinner(cards)) % m.setup.players;
  m.tricksWon[winner]++;
  m.events.push({ k: 'trick', trick: m.trickNo, lead: m.lead, cards: [...cards], winner });

  const isLast = m.trickNo === m.setup.tricks - 1;
  // A torn-up spare is an ordinary card again. It has no owner, so it cannot be taken by the wrong
  // crewmate, and forgetting that here would fail the mission on a card nobody ever accepted.
  const here = m.tasks.filter((t) => isLive(t) && !t.done && cards.includes(t.card));

  // Failures first. A trick that both completes one task and loses another is a loss — there is no
  // ordering of those two that makes the mission still winnable.
  for (const t of here) {
    if (t.owner !== winner) {
      fail(m, t, `taken by the wrong crewmate`, winner);
      return;
    }
  }
  // Then completions, in link order, so two links landing in one trick resolve 1-then-2 rather than
  // in whatever order the cards happen to sit in the trick.
  for (const t of [...here].sort((a, b) => a.order - b.order)) {
    if (t.finale && !isLast) {
      fail(m, t, 'landed before the final trick', winner);
      return;
    }
    if (t.order > 0) {
      const blocking = m.tasks.find((o) => isLive(o) && o.order > 0 && o.order < t.order && !o.done);
      if (blocking) {
        fail(m, t, 'landed out of order', winner);
        return;
      }
    }
    t.done = true;
    t.trick = m.trickNo;
    m.events.push({ k: 'task', card: t.card, owner: t.owner, ok: true, trick: m.trickNo });
  }

  if (m.tasks.every((t) => !isLive(t) || t.done)) {
    m.phase = 'over';
    m.success = true;
    m.reason = 'every task complete';
    m.events.push({ k: 'end', success: true, reason: m.reason });
    return;
  }
  if (isLast) {
    m.phase = 'over';
    m.success = false;
    m.reason = 'the cards ran out';
    m.events.push({ k: 'end', success: false, reason: m.reason });
    return;
  }
  m.trick = [];
  m.trickNo++;
  m.lead = winner;
  m.turn = winner;
}

function fail(m: Mission, t: Task, why: string, winner: number): void {
  m.events.push({ k: 'task', card: t.card, owner: t.owner, ok: false, trick: m.trickNo });
  m.phase = 'over';
  m.success = false;
  m.reason = why;
  m.events.push({ k: 'end', success: false, reason: why });
  void winner;
}

// ── convenience ─────────────────────────────────────────────────────────────────

export const isOver = (m: Mission): boolean => m.phase === 'over';

/** Tasks actually in play. Spares are not tasks. */
export function liveTasks(m: Mission): Task[] {
  return m.tasks.filter(isLive);
}

/** Live tasks nobody has completed yet. */
export function openTasks(m: Mission): Task[] {
  return m.tasks.filter((t) => isLive(t) && !t.done);
}

/** The next link that is allowed to land, or 0 when nothing is chained. */
export function nextLink(m: Mission): number {
  const open = openTasks(m)
    .filter((t) => t.order > 0)
    .map((t) => t.order);
  return open.length ? Math.min(...open) : 0;
}

/** True when this task is currently BLOCKED by an earlier link and must be dodged, not won. */
export function isBlocked(m: Mission, t: Task): boolean {
  if (t.done || !isLive(t)) return false;
  if (t.finale && m.trickNo !== m.setup.tricks - 1) return true;
  if (t.order === 0) return false;
  return m.tasks.some((o) => isLive(o) && o.order > 0 && o.order < t.order && !o.done);
}

/** How many cards of `suit` are still unaccounted for from a seat's point of view. */
export function unseenOfSuit(m: Mission, suit: number, hand: readonly number[]): number[] {
  const total = suit === TRUMP ? 4 : m.setup.players <= 2 ? 5 : m.setup.players === 3 ? 8 : 9;
  const out: number[] = [];
  for (let r = 1; r <= total; r++) {
    const c = cardOf(suit, r);
    if (!m.seen.includes(c) && !hand.includes(c) && !m.trick.includes(c)) out.push(c);
  }
  return out;
}

/** Is this card certain to win a trick it is led into? The one deduction that is always available. */
export function isBossCard(m: Mission, card: number, hand: readonly number[]): boolean {
  const suit = suitOf(card);
  const higher = unseenOfSuit(m, suit, hand).filter((c) => rankOf(c) > rankOf(card));
  if (higher.length > 0) return false;
  if (isTrump(card)) return true;
  return unseenOfSuit(m, TRUMP, hand).length === 0;
}
