// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// See ADDITIONAL-TERMS.md for the section 7(b) attribution requirement.
//
// Tacit — the crew you play with when nobody else is online.
//
// THERE ARE NO DIFFICULTY TIERS, AND THAT IS A DESIGN DECISION, NOT AN OMISSION. In a versus game a
// weaker bot is an easier game. In a CO-OP it is the exact opposite: a bot that plays badly loses
// YOUR mission, and every loss reads as "my crew is stupid" rather than "that was hard". So the bot
// always plays the best line it can see, and the difficulty lives entirely in the mission ladder,
// where the player can see it and choose it.
//
// THE INFORMATION CONSTRAINT IS STRUCTURAL, NOT A PROMISE. Every function here takes a `BotView`,
// which is built by `viewFor()` and contains exactly one private field: the bot's OWN hand. There is
// no path from a BotView to another player's cards, and tests/bot-view.test.ts scans the object to
// prove it — a co-op bot that peeks is not a hard opponent, it is a broken game.

import { TRUMP, isTrump, legalPlays, rankOf, suitOf, trickWinner } from './cards';
import { SIG_HIGH, SIG_LOW, SIG_ONLY, isLive, type Mission, type Signal, type Task } from './mission';

/** A task as the bot sees it. Identical to the public one — task assignment is never secret. */
export interface TaskView {
  card: number;
  owner: number;
  order: number;
  finale: boolean;
  done: boolean;
  /** Precomputed from public state: this task may NOT land yet, so its card must not be played. */
  blocked: boolean;
}

/**
 * Everything a crewmate is allowed to know. `hand` is the only private field and it is this seat's
 * own. The field list is deliberately closed — bot-view.test.ts asserts the exact key set, so
 * quietly threading a second hand in here fails the build rather than the player.
 */
export interface BotView {
  seat: number;
  players: number;
  tricks: number;
  trickNo: number;
  hand: number[];
  tasks: TaskView[];
  signals: Signal[];
  seen: number[];
  voids: boolean[][];
  trick: number[];
  lead: number;
  signalsLeft: number[];
  /** How many of the candidates on the table will actually be taken. */
  take: number;
  /** How many of the taken tasks become numbered links. */
  ordered: number;
  /** Whether the LAST task taken must land in the final trick. */
  finaleRung: boolean;
}

export const BOT_VIEW_KEYS = [
  'seat',
  'players',
  'tricks',
  'trickNo',
  'hand',
  'tasks',
  'signals',
  'seen',
  'voids',
  'trick',
  'lead',
  'signalsLeft',
  'take',
  'ordered',
  'finaleRung',
] as const;

function blockedFor(tasks: readonly Task[], t: Task, trickNo: number, tricks: number): boolean {
  if (t.done) return false;
  if (t.finale && trickNo !== tricks - 1) return true;
  if (t.order === 0) return false;
  return tasks.some((o) => isLive(o) && o.order > 0 && o.order < t.order && !o.done);
}

/**
 * Build the view for one seat. The ONLY place a hand crosses from the mission into a bot.
 *
 * During the draft the untaken candidates are still `owner === -1` and are shown — that is what the
 * bot is choosing between. Once the draft closes, spares are `discarded` and drop out entirely.
 */
export function viewFor(m: Mission, seat: number): BotView {
  const hand = m.hands[seat];
  return {
    seat,
    players: m.setup.players,
    tricks: m.setup.tricks,
    trickNo: m.trickNo,
    hand: hand ? [...hand] : [],
    tasks: m.tasks.map((t) => ({
      card: t.card,
      owner: t.discarded ? -2 : t.owner,
      order: t.order,
      finale: t.finale,
      done: t.done,
      blocked: blockedFor(m.tasks, t, m.trickNo, m.setup.tricks),
    })),
    signals: m.signals.map((s) => ({ ...s })),
    seen: [...m.seen],
    voids: m.voids.map((v) => [...v]),
    trick: [...m.trick],
    lead: m.lead,
    signalsLeft: [...m.signalsLeft],
    take: m.setup.take,
    ordered: m.setup.ordered,
    finaleRung: m.setup.finale,
  };
}

// ── deduction ───────────────────────────────────────────────────────────────────

const suitTop = (players: number, suit: number): number =>
  suit === TRUMP ? 4 : players <= 2 ? 5 : players === 3 ? 8 : 9;

/** Cards of a suit that are neither in my hand nor already on the table: somebody else holds them. */
function unseen(v: BotView, suit: number): number[] {
  const out: number[] = [];
  for (let r = 1; r <= suitTop(v.players, suit); r++) {
    const c = suit * 16 + r;
    if (v.seen.includes(c) || v.hand.includes(c)) continue;
    out.push(c);
  }
  return out;
}

/**
 * Certain to win a trick it LEADS. Nothing above it in its own suit is still out there, and — for a
 * colour card — no Pulse is either. This one predicate carries most of the bot's competence: it is
 * the difference between hoping a task lands and knowing it does.
 */
export function isBoss(v: BotView, card: number): boolean {
  const suit = suitOf(card);
  if (unseen(v, suit).some((c) => rankOf(c) > rankOf(card))) return false;
  return isTrump(card) || unseen(v, TRUMP).length === 0;
}

/**
 * Nothing still out there in this card's OWN suit outranks it.
 *
 * In a co-operative game this is the predicate that matters, and using the stricter `isBoss` instead
 * was quietly costing missions. Only following suit is compulsory: a crewmate holding Pulses and
 * void in your colour is free to discard, and a crewmate who understands that you need this trick
 * will discard. So "no higher card of my own colour is left" really is as good as unbeatable —
 * whereas `isBoss` additionally demands that every Pulse in the game has already been played, which
 * for the first half of any mission is never true, so the plans that depend on it never fire.
 */
function topOfSuit(v: BotView, card: number): boolean {
  return !unseen(v, suitOf(card)).some((c) => rankOf(c) > rankOf(card));
}

/** Would playing this card take the trick, exactly as it stands right now? */
function wouldWin(v: BotView, card: number): boolean {
  if (v.trick.length === 0) return true;
  return trickWinner([...v.trick, card]) === v.trick.length;
}

const seatAt = (v: BotView, i: number): number => (v.lead + i) % v.players;
const winningSeat = (v: BotView): number => (v.trick.length === 0 ? -1 : seatAt(v, trickWinner(v.trick)));
const hasPlayed = (v: BotView, seat: number): boolean => {
  for (let i = 0; i < v.trick.length; i++) if (seatAt(v, i) === seat) return true;
  return false;
};
const playedBy = (v: BotView, seat: number): number => {
  for (let i = 0; i < v.trick.length; i++) if (seatAt(v, i) === seat) return v.trick[i];
  return -1;
};

/**
 * Is this crewmate's hold on the trick safe from anything that can be FORCED out of a hand?
 *
 * The distinction is the whole rule, and getting it wrong cost a mission in the simulation. Only
 * following suit is compulsory. So a crewmate winning with the top card of the LED suit is safe:
 * everyone else must follow with something lower, and while somebody void could trump them, nobody
 * is ever obliged to, and no crewmate protecting this trick would choose to. A crewmate winning
 * with a LOW card of the led suit is not safe at all — the next hand that holds only a higher one
 * has no choice but to take it off them. (A crewmate who won by trumping a colour is safe for the
 * same reason: no colour card can beat a Pulse, and over-trumping is always a choice.)
 */
function ownerSafe(v: BotView, ownerCard: number): boolean {
  const led = suitOf(v.trick[0]);
  if (suitOf(ownerCard) !== led) return true;
  return !unseen(v, led).some((c) => rankOf(c) > rankOf(ownerCard));
}

/** They have played, they are winning, and nothing compulsory can take it off them. */
function deliverable(v: BotView, owner: number): boolean {
  if (!hasPlayed(v, owner) || winningSeat(v) !== owner) return false;
  return isLast(v) || ownerSafe(v, playedBy(v, owner));
}

/**
 * Read a signal. "Tide 8, my highest" means that crewmate holds nothing in Tide above an 8 — which
 * is what makes it worth leading Tide at them, or worth NOT leading Tide at them. This is the only
 * channel in the game that carries a fact rather than an inference, so the bot leans on it hard.
 */
function signalOf(v: BotView, seat: number, suit: number): Signal | undefined {
  return v.signals.find((s) => s.seat === seat && suitOf(s.card) === suit);
}

// ── choosing a card ─────────────────────────────────────────────────────────────

const byRank = (a: number, b: number): number => rankOf(a) - rankOf(b);
/** Pulses last: a Pulse is the most expensive thing in a hand and the last thing to spend. */
const byValue = (a: number, b: number): number =>
  (isTrump(a) ? 1 : 0) - (isTrump(b) ? 1 : 0) || rankOf(a) - rankOf(b);

/** Live, unfinished tasks. `owner === -2` is a torn-up spare: an ordinary card again. */
const openOf = (v: BotView): TaskView[] => v.tasks.filter((t) => !t.done && t.owner >= 0);

/**
 * The reserve: when this seat owns a task that must land LATE (a finale, or a high link in a chain),
 * its single best card is not available for an ordinary trick. Without this the bot spends its top
 * Pulse on trick two and then cannot win the trick it was hired to win.
 */
function reserved(v: BotView): number[] {
  const mine = openOf(v).filter((t) => t.owner === v.seat && t.blocked);
  if (mine.length === 0 || v.trickNo >= v.tricks - 1) return [];
  const best = [...v.hand].sort(byValue).pop();
  return best === undefined ? [] : [best];
}

export function chooseCard(v: BotView): number {
  const led = v.trick.length === 0 ? null : suitOf(v.trick[0]);
  const legal = legalPlays(v.hand, led);
  if (legal.length === 0) return -1;
  if (legal.length === 1) return legal[0];
  return v.trick.length === 0 ? chooseLead(v, legal) : chooseFollow(v, legal);
}

function chooseFollow(v: BotView, legal: number[]): number {
  const open = openOf(v);
  const onTable = open.filter((t) => v.trick.includes(t.card));

  if (onTable.length > 0) {
    const doomed =
      onTable.some((t) => t.blocked) || new Set(onTable.map((t) => t.owner)).size > 1;
    if (doomed) return dump(v, legal);

    const owner = onTable[0].owner;
    if (owner === v.seat) return takeIt(v, legal);

    // A crewmate's task is on the table. My entire job is to not be the one who wins it.
    const theyLead = winningSeat(v) === owner;
    const stillToPlay = !hasPlayed(v, owner);
    if (theyLead || stillToPlay) {
      const harmless = legal.filter((c) => !wouldWin(v, c));
      if (harmless.length > 0) return safest(v, harmless);
    }
    return dump(v, legal);
  }

  // A crewmate is winning this trick and I am holding their task card: hand it over. THIS IS THE
  // SINGLE MOST VALUABLE RULE IN THE FILE. Without it a bot hoards a card it must never win with,
  // the colour never comes out, and the mission dies on the last trick when the card is finally
  // forced — which is precisely how every remaining loss looked in the simulation before it existed.
  const winner = winningSeat(v);
  if (winner >= 0 && winner !== v.seat && deliverable(v, winner)) {
    const gift = open.find((t) => t.owner === winner && !t.blocked && legal.includes(t.card));
    if (gift) return gift.card;
  }

  // Nothing at stake in this trick yet — but one of my own cards could still put something at stake.
  const safe = legal.filter((c) => !dangerous(v, c));
  const pool = safe.length > 0 ? safe : legal;

  // Completing one of my own tasks by following is only ever right when the win is CERTAIN: I am
  // last to play, or the card is boss. A hopeful high card here is how a mission dies.
  const mineNow = pool.filter((c) => {
    const t = open.find((x) => x.card === c);
    return t && t.owner === v.seat && !t.blocked && wouldWin(v, c) && (isLast(v) || topOfSuit(v, c));
  });
  if (mineNow.length > 0) return mineNow.sort(byValue)[0];

  if (wantsLead(v)) {
    const winners = pool.filter((c) => wouldWin(v, c) && !reserved(v).includes(c));
    if (winners.length > 0 && (isLast(v) || winners.some((c) => topOfSuit(v, c)))) {
      const certain = winners.filter((c) => isLast(v) || topOfSuit(v, c));
      return certain.sort(byValue)[0];
    }
  }
  return safest(v, pool);
}

function chooseLead(v: BotView, legal: number[]): number {
  const open = openOf(v);
  const res = reserved(v);
  const mine = open.filter((t) => t.owner === v.seat && !t.blocked);

  // 1. A task of mine that I hold AND that cannot be beaten. The best move in the game: lead it and
  //    the task is simply done. Lowest such first, so the big guns stay loaded.
  const sure = mine
    .filter((t) => legal.includes(t.card) && topOfSuit(v, t.card))
    .map((t) => t.card)
    .sort(byValue);
  if (sure.length > 0) return sure[0];

  // 1b. A task of mine that I hold but that is not yet safe. Lead a HIGHER card of the same suit:
  //     it takes the trick, keeps the lead, and pulls one card of that colour out of every other
  //     hand — repeat and the task card climbs to the top of what is left. This is the only way a
  //     mid-rank card you hold yourself ever becomes playable.
  const strip = mine
    .filter((t) => legal.includes(t.card) && !topOfSuit(v, t.card))
    .flatMap((t) => legal.filter((c) => suitOf(c) === suitOf(t.card) && rankOf(c) > rankOf(t.card)))
    .filter((c) => !res.includes(c) && topOfSuit(v, c))
    .sort(byRank);
  if (strip.length > 0) return strip[strip.length - 1];

  // 2. A task of mine that somebody ELSE holds. Lead the suit with a card that cannot be beaten and
  //    that outranks the task card, so whoever holds it must follow suit and hand it to me.
  for (const t of mine) {
    if (legal.includes(t.card)) continue;
    const draw = legal
      .filter((c) => suitOf(c) === suitOf(t.card) && rankOf(c) > rankOf(t.card) && topOfSuit(v, c) && !res.includes(c))
      .sort(byRank);
    if (draw.length > 0) return draw[0];
  }

  // 2b. Time. Every task card has to reach the table eventually, and the fewer tricks remain the
  //     fewer chances anyone has to lift it off me. Once the tricks left barely cover the tasks
  //     left, stop waiting for a certainty that is not coming and lead the colour high.
  const pressure = v.tricks - v.trickNo <= mine.length + 1;
  if (pressure) {
    for (const t of mine) {
      const draw = legal
        .filter((c) => suitOf(c) === suitOf(t.card) && (c === t.card || rankOf(c) > rankOf(t.card)))
        .sort(byRank);
      if (draw.length > 0) return draw[draw.length - 1];
    }
  }

  // 3. A crewmate's task card sitting in MY hand. Only hand it over when they have told me, through
  //    a signal or a void, that they can actually take it. Otherwise it stays put.
  for (const t of open) {
    if (t.owner === v.seat || t.blocked || !legal.includes(t.card)) continue;
    const sig = signalOf(v, t.owner, suitOf(t.card));
    const told = sig && (sig.kind === SIG_HIGH || sig.kind === SIG_ONLY) && rankOf(sig.card) > rankOf(t.card);
    if (told && !unseenBeats(v, t)) return t.card;
  }

  // 3b. THIS IS WHAT A SIGNAL IS FOR. A crewmate has told me they hold the high end of a colour, and
  //     they own a task in it. I do not need to be holding their card — leading that colour makes
  //     everyone follow, so whoever IS holding it plays it, and the crewmate who announced the top
  //     of the suit takes the trick. Without this rule the whole comms system measured as worth
  //     exactly nothing: Signals and Blackout had identical win rates at every matched rung.
  for (const t of open) {
    if (t.owner === v.seat || t.blocked) continue;
    const sig = signalOf(v, t.owner, suitOf(t.card));
    if (!sig || sig.kind === SIG_LOW || rankOf(sig.card) <= rankOf(t.card)) continue;
    if (unseenBeats(v, t)) continue;
    const feed = legal
      .filter((c) => suitOf(c) === suitOf(t.card) && c !== t.card && rankOf(c) < rankOf(sig.card) && !res.includes(c))
      .sort(byRank);
    if (feed.length > 0) return feed[0];
  }

  // 4. Nothing to gain: lead something that cannot hurt. A suit with no open task in it, lowest card
  //    first, and never the reserve.
  const quiet = legal.filter((c) => !dangerous(v, c) && !res.includes(c) && !suitHasTask(v, suitOf(c)));
  if (quiet.length > 0) return quiet.sort(byValue)[0];

  const safe = legal.filter((c) => !dangerous(v, c) && !res.includes(c));
  if (safe.length > 0) return safe.sort(byValue)[0];
  return dump(v, legal);
}

/**
 * Could somebody OTHER than the owner be forced to take this trick off them?
 *
 * The owner is assumed to hold one of the higher cards — that is what their signal said. So one
 * higher card outstanding is theirs and fine; two or more means a third hand has one as well, and
 * may have no choice but to play it. Pulses are deliberately NOT counted: over-trumping is never
 * compulsory, and no crewmate would choose to trump a trick their own crew is trying to win.
 */
function unseenBeats(v: BotView, t: TaskView): boolean {
  return unseen(v, suitOf(t.card)).filter((c) => rankOf(c) > rankOf(t.card)).length > 1;
}

const suitHasTask = (v: BotView, suit: number): boolean =>
  openOf(v).some((t) => suitOf(t.card) === suit);

/**
 * Playing this card can lose the mission outright.
 *
 * A CREWMATE'S TASK CARD IS DANGEROUS BY DEFAULT, and that default is the fix for the second-worst
 * bug the simulation found. The old rule said "not dangerous, as long as the owner could still take
 * it" — so a bot would quietly drop somebody else's task card into a trick as its cheapest card,
 * betting that the owner would win. The owner usually did not. Handing a crewmate their task is a
 * DELIBERATE act with a reason behind it (see rule 3 of the lead, and the hand-over below), never
 * something that falls out of picking the lowest card in hand.
 */
function dangerous(v: BotView, card: number): boolean {
  const t = openOf(v).find((x) => x.card === card);
  if (!t) return false;
  if (t.blocked) return true; // ANY trick containing it fails, whoever wins
  if (t.owner === v.seat) return !wouldWin(v, card) || (!isLast(v) && !topOfSuit(v, card));
  // Safe in exactly one situation: they have played, they are winning, and nothing that can be
  // forced out of a hand beats them. Then playing their card into it is not a risk, it is delivery.
  return !deliverable(v, t.owner);
}

const isLast = (v: BotView): boolean => v.trick.length === v.players - 1;

/**
 * Is the lead worth taking? Only when this seat has something to DO with it: a task of its own that
 * it holds and could lead out, or one it could draw out of somebody else's hand. Taking the lead
 * with nothing to lead is how a bot burns the high card it needed three tricks later.
 */
function wantsLead(v: BotView): boolean {
  const mine = openOf(v).filter((t) => t.owner === v.seat && !t.blocked);
  if (mine.length === 0) return false;
  return mine.some(
    (t) =>
      (v.hand.includes(t.card) && topOfSuit(v, t.card)) ||
      v.hand.some((c) => suitOf(c) === suitOf(t.card) && rankOf(c) > rankOf(t.card) && topOfSuit(v, c)),
  );
}

/** Win this trick as cheaply as certainty allows. */
function takeIt(v: BotView, legal: number[]): number {
  const winners = legal.filter((c) => wouldWin(v, c)).sort(byValue);
  if (winners.length === 0) return dump(v, legal);
  if (isLast(v)) return winners[0];
  // Others still to play, so cheapest-that-wins is not good enough — take the strongest thing that
  // is not the reserve, because a task lost here cannot be won back later.
  const res = reserved(v);
  const open = winners.filter((c) => !res.includes(c));
  const pick = open.length > 0 ? open : winners;
  return pick[pick.length - 1];
}

/** The lowest card that does the least damage. Never the reserve while there is any choice. */
function safest(v: BotView, cards: number[]): number {
  const res = reserved(v);
  const pool = cards.filter((c) => !res.includes(c));
  const use = pool.length > 0 ? pool : cards;
  const quiet = use.filter((c) => !suitHasTask(v, suitOf(c)));
  return (quiet.length > 0 ? quiet : use).sort(byValue)[0];
}

/** Last resort: nothing here helps, so throw the least useful thing away. */
function dump(v: BotView, legal: number[]): number {
  const harmless = legal.filter((c) => !dangerous(v, c));
  return (harmless.length > 0 ? harmless : legal).sort(byValue)[0];
}

// ── drafting ────────────────────────────────────────────────────────────────────

/**
 * Score how completable a task looks from this hand. Higher is better.
 *
 * THE NUMBER THAT MATTERS IS HOW MANY CARDS OUTRANK IT, and the two cases are not symmetrical —
 * this is the whole lesson the simulation taught, at a cost of eleven straight losses:
 *
 *   I HOLD the card. Then I have to win a trick with THAT card, as itself; a Pulse in my hand is no
 *   help at all, because playing the Pulse means not playing the task. So every higher card still
 *   out there is a card that can simply take it off me, and a mid-rank card I hold is close to
 *   hopeless. Measured on the forced 1-task draft, this case won 0 of 11.
 *
 *   SOMEBODY ELSE holds it. Then I win the trick it falls in, with anything — a higher card of the
 *   suit, or a Pulse. This is the easy case, and it is why a crew with a choice takes the card that
 *   is NOT in its own hand.
 */
export function draftScore(v: BotView, t: TaskView, order = 0, finale = false): number {
  const suit = suitOf(t.card);
  const pulses = v.hand.filter(isTrump);
  const outstandingPulses = unseen(v, TRUMP).length;
  let score = 0;

  if (v.hand.includes(t.card)) {
    const above = unseen(v, suit).filter((c) => rankOf(c) > rankOf(t.card)).length;
    score += 74 - above * 24;
    // Nothing in my hand protects it: I must play the card itself, so a Pulse out there beats it.
    if (outstandingPulses > 0) score -= 10;
  } else {
    const mine = v.hand.filter((c) => suitOf(c) === suit);
    const above = mine.filter((c) => rankOf(c) > rankOf(t.card));
    score += 30;
    if (above.length > 0) score += 22;
    if (above.some((c) => topOfSuit(v, c))) score += 24;
    score += Math.min(pulses.length, 2) * 11;
    if (mine.length === 0) score += pulses.length > 0 ? 14 : -44;
  }

  // A high link waits for every link below it, and the finale waits for the whole mission. Both
  // need a card held in reserve, so both are worth less to a hand with no top end.
  if (order > 1) score -= (order - 1) * 8;
  if (finale) score += pulses.some((c) => rankOf(c) >= 3) ? 4 : -30;
  return score;
}

/**
 * Pick a candidate. `taken` is how many tasks the crew has already claimed, which is what decides
 * whether THIS pick becomes a numbered link and whether it carries the finale.
 */
export function chooseDraft(v: BotView, available: number[], taken = 0): number {
  const order = taken < v.ordered ? taken + 1 : 0;
  const finale = v.finaleRung && taken === v.take - 1;
  let best = available[0];
  let bestScore = -Infinity;
  for (const i of available) {
    const s = draftScore(v, v.tasks[i], order, finale);
    if (s > bestScore) {
      bestScore = s;
      best = i;
    }
  }
  return best;
}

// ── signalling ──────────────────────────────────────────────────────────────────

export interface SignalChoice {
  card: number;
  kind: number;
  score: number;
}

/**
 * What is worth saying with the one thing you are allowed to say. The ranking is: "I can take that
 * colour" (which is what unlocks somebody else's task), then "I am nearly out of that colour"
 * (which stops the crew feeding me tricks I cannot take), then everything else.
 */
export function bestSignal(v: BotView, truthful: (card: number, kind: number) => boolean): SignalChoice | null {
  let best: SignalChoice | null = null;
  const open = openOf(v);
  // Never say the same thing twice. `bestSignal` is deterministic, so in a two-signal mode a bot
  // that does not remember what it has already shown spends BOTH tokens on the same card — the
  // table then reads "highest Drape / highest Drape" beside one crewmate, which looks like a
  // rendering bug and is really a wasted half of the game's only communication channel.
  const already = new Set(v.signals.filter((s) => s.seat === v.seat).map((s) => s.card));
  for (const card of v.hand) {
    if (already.has(card)) continue;
    const suit = suitOf(card);
    for (const kind of [SIG_HIGH, SIG_LOW, SIG_ONLY]) {
      if (!truthful(card, kind)) continue;
      let score = 0;
      const tasksHere = open.filter((t) => suitOf(t.card) === suit);
      if (kind === SIG_HIGH) {
        score += 8;
        for (const t of tasksHere) {
          if (rankOf(card) > rankOf(t.card)) score += t.owner === v.seat ? 30 : 42;
        }
        if (isTrump(card)) score += 20 + rankOf(card) * 3;
        if (topOfSuit(v, card)) score += 12;
      } else if (kind === SIG_ONLY) {
        score += 16;
        if (tasksHere.length > 0) score += 14;
        if (isTrump(card)) score += 10;
      } else {
        score += 4;
        for (const t of tasksHere) if (rankOf(card) < rankOf(t.card)) score += 8;
      }
      if (!best || score > best.score) best = { card, kind, score };
    }
  }
  return best;
}

/**
 * Should the bot spend a signal NOW? The bar drops as the mission runs on, because an unspent
 * signal at the last trick was worth nothing at all — a crew that hoards its comms has simply
 * chosen to play Blackout by accident.
 */
export function signalThreshold(trickNo: number): number {
  if (trickNo === 0) return 44;
  if (trickNo === 1) return 26;
  if (trickNo === 2) return 14;
  return 1;
}
