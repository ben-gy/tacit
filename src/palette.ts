// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// See ADDITIONAL-TERMS.md for the section 7(b) attribution requirement.
//
// Tacit — every colour that carries meaning, in one place so tests/contrast.test.ts can hold it to
// WCAG 2.1 §1.4.11 (>= 3:1 for a non-text graphic) against every surface it can actually sit on.
//
// HOW THE SUITS SURVIVE COLOUR BLINDNESS, and why hue is the LEAST important of the three channels:
//
//   1. SILHOUETTE. Each suit has its own shape — chevron, bar, drape, truss, star — drawn as a solid
//      glyph at both ends of the card and blown up behind the rank. Two cards of different suits do
//      not look alike in a greyscale screenshot, let alone to a deuteranope.
//   2. LUMINANCE. The five inks are deliberately stepped apart in lightness, not just hue, so the
//      shapes read as different even if colour is stripped entirely.
//   3. HUE, last, as a convenience for the majority who can use it.
//
// Suit inks are drawn on the CARD FACE, which is light — so they are dark, saturated colours rather
// than the neon a dark-background game would use. That is checked, not assumed: SUIT_INK is held to
// 3:1 against `face`, `faceDim` and `faceLit` by the contrast test.

export const PALETTE = {
  /** The house: the darkest thing on screen. */
  ground: '#0B1418',
  /** The stage floor — the table the cards sit on. */
  table: '#132229',
  /** A panel: the HUD, the task rail, a sheet. */
  panel: '#1B2F38',
  panelHi: '#26424E',
  edge: '#37596A',

  /** A card face. Everything with a suit ink on it is drawn on one of these three. */
  face: '#F2EDE3',
  /**
   * A card that cannot be played right now. Deliberately only a little darker than `face`, because
   * "dimmed" is the surface with the LEAST headroom: every suit ink has to clear 3:1 against it, and
   * the first draft of this palette dimmed hard enough that the Gantry ink landed at 2.98:1 — an
   * unplayable card whose suit you could no longer read.
   */
  faceDim: '#E2DDD3',
  /** The card under your thumb, and the card that just won a trick. */
  faceLit: '#FFFBF2',

  /** The back of a card nobody may see. Light enough to be a card rather than a hole in the table. */
  back: '#325B6E',
  backLine: '#5E9AB4',

  /** The house accent — buttons, the room code, the mission number. Drawn on the dark panels. */
  accent: '#E8B04B',
  /** A task that has landed. Drawn on panels. */
  good: '#5FD3A0',
  /** A task that has been lost, and the mission-failed banner. Drawn on panels. */
  bad: '#FF7B72',
  /** A locked task: legible, obviously inert, and never mistaken for a live one. */
  locked: '#9AB0BC',

  text: '#F3F8FA',
  textMuted: '#A7C0CC',
  /** Ink for text printed ON a card face. */
  cardInk: '#16232A',
  cardInkMuted: '#5C6E78',
} as const;

/**
 * The five suit inks, in suit order: Loft, Batten, Drape, Truss, Gantry.
 *
 * SOLVED, NOT PICKED. The first set was chosen by eye and every one of them landed between 0.104 and
 * 0.157 relative luminance — a spread of 1.02:1 across the whole suit, which is to say they were
 * five different hues of exactly one grey. In a greyscale screenshot, and to anyone reading shape
 * and lightness before hue, they were indistinguishable. The contrast test caught it; nothing else
 * would have, because on screen they look like five obviously different colours.
 *
 * These are the same five hues scaled to hit a deliberate luminance ladder — 0.090, 0.112, 0.138,
 * 0.168, 0.203 — an even 1.159 step between neighbours, spanning the whole usable band. The band is
 * narrow because the top of it is fixed by `faceDim`: an ink lighter than about 0.209 stops clearing
 * 3:1 against a dimmed card. Change a hue and RE-SOLVE the ladder; do not nudge a hex until it looks
 * nice, because looking nice is exactly what the broken set did.
 */
export const SUIT_INK = ['#105695', '#AE4917', '#156C42', '#885BC7', '#9D7713'] as const;

/** A slightly deeper tone of each ink, for the big watermark glyph behind the rank. */
export const SUIT_WASH = ['#D6E7F3', '#F4DFD2', '#D5EBE0', '#E4DCEE', '#F0E6CC'] as const;

/** Every surface a suit ink can actually be drawn on. */
export const CARD_SURFACES = ['face', 'faceDim', 'faceLit'] as const;
/** Every surface a status colour can be drawn on. */
export const PANEL_SURFACES = ['panel', 'panelHi', 'table', 'ground'] as const;
/** Everything drawn on a panel that carries meaning. */
export const ON_PANEL = ['accent', 'good', 'bad', 'locked', 'text', 'textMuted'] as const;
/** Everything drawn on a card face that carries meaning. */
export const ON_CARD = ['cardInk', 'cardInkMuted'] as const;
