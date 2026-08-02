// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// See ADDITIONAL-TERMS.md for the section 7(b) attribution requirement.
//
// Tacit — the deck, and the two rules that decide every trick. Deliberately tiny and dependency-
// free: tests/mechanism.test.ts re-derives the trick winner from FIRST PRINCIPLES rather than
// calling trickWinner(), so an audit that quietly imported this file would be a tautology.
//
// A card is one integer: `suit * 16 + rank`. Four colour suits (0-3) plus the GANTRY (4), which is
// the trump and beats every colour. Ranks start at 1 so 0 is never a legal card — a zero landing in
// a hand is a bug, not a low card.
//
// The suits are named for the parts of a theatre a stage crew works in the dark and in silence,
// which is where the game gets its name: `tacet` is the instruction in a score meaning "this part is
// silent". The names are also the only ones available — `pulse`, `ember` and `tide` each appear in
// 37 to 47 files across the shipped fleet, and a card name that collides with another game's mode
// id or a CSS keyframe is a bug waiting for a stylesheet.

/** The trump suit's index. Four colour suits sit below it. */
export const TRUMP = 4;
/** How many trumps are in every deck, at every player count. Ranks 1..4. */
export const TRUMPS = 4;
/** Colour suits. */
export const COLOURS = 4;

export const cardOf = (suit: number, rank: number): number => suit * 16 + rank;
export const suitOf = (card: number): number => card >> 4;
export const rankOf = (card: number): number => card & 15;
export const isTrump = (card: number): boolean => suitOf(card) === TRUMP;

export const SUIT_NAMES = ['Loft', 'Batten', 'Drape', 'Truss', 'Gantry'] as const;
/** Silhouette, not hue — the channel that survives any colour vision AND a greyscale screenshot. */
export const SUIT_SHAPES = ['chevron', 'bar', 'drape', 'truss', 'star'] as const;

/**
 * How high the colour suits run, so that the deck divides EXACTLY by the player count and nobody
 * plays a hand one card short. 4·R + 4 must be divisible by N:
 *
 *   2P  4×5+4 = 24 → 12 each     3P  4×8+4 = 36 → 12 each
 *   4P  4×9+4 = 40 → 10 each     5P  4×9+4 = 40 →  8 each
 *
 * The Gantry stays at four for every count, because "there are exactly four trumps and the highest
 * one leads" is the single fact a new player has to hold, and a trump count that moved with the
 * table size would make every mission a different game.
 */
export function suitRanks(players: number): number {
  if (players <= 2) return 5;
  if (players === 3) return 8;
  return 9;
}

export function deckSize(players: number): number {
  return COLOURS * suitRanks(players) + TRUMPS;
}

export function handSize(players: number): number {
  return deckSize(players) / players;
}

/** The full deck for a table of this size, in a stable order. Shuffling is the caller's business. */
export function buildDeck(players: number): number[] {
  const ranks = suitRanks(players);
  const out: number[] = [];
  for (let s = 0; s < COLOURS; s++) for (let r = 1; r <= ranks; r++) out.push(cardOf(s, r));
  for (let r = 1; r <= TRUMPS; r++) out.push(cardOf(TRUMP, r));
  return out;
}

/** Every colour card — the pool task cards are drawn from. A pulse is never a task. */
export function colourCards(players: number): number[] {
  return buildDeck(players).filter((c) => !isTrump(c));
}

/**
 * Which cards you are ALLOWED to play. Follow the led suit if you hold it; otherwise anything,
 * including a pulse. There is no obligation to trump and no obligation to beat.
 */
export function legalPlays(hand: readonly number[], led: number | null): number[] {
  if (led === null) return [...hand];
  const following = hand.filter((c) => suitOf(c) === led);
  return following.length > 0 ? following : [...hand];
}

/**
 * Who takes the trick, as an INDEX INTO `cards` (0 = whoever led). Highest pulse if any pulse was
 * played, otherwise the highest card of the led suit. Cards that are neither are discards and can
 * never win, which is why a void player throwing their highest colour card away is safe.
 */
export function trickWinner(cards: readonly number[]): number {
  const led = suitOf(cards[0]);
  let best = 0;
  for (let i = 1; i < cards.length; i++) {
    const c = cards[i];
    const b = cards[best];
    if (isTrump(c)) {
      if (!isTrump(b) || rankOf(c) > rankOf(b)) best = i;
    } else if (!isTrump(b) && suitOf(c) === led && rankOf(c) > rankOf(b)) {
      best = i;
    }
  }
  return best;
}

/** A short label — "Tide 7", "Pulse 3". Used in the log, the summary and every aria-label. */
export function cardName(card: number): string {
  return `${SUIT_NAMES[suitOf(card)]} ${rankOf(card)}`;
}

/** Sort for a hand: colours in suit order low→high, pulses last. Stable and purely cosmetic. */
export function sortHand(hand: readonly number[]): number[] {
  return [...hand].sort((a, b) => (suitOf(a) - suitOf(b)) * 100 + (rankOf(a) - rankOf(b)));
}
