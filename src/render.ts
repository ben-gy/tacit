// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// See ADDITIONAL-TERMS.md for the section 7(b) attribution requirement.
//
// Tacit — the cards, as DOM. Not canvas: a card game is text and hit targets, and the browser is
// already very good at both. Crisp type at any density, real focus rings, real aria labels, and a
// layout that reflows for a 375px phone without a line of measurement code.
//
// EVERY CARD CARRIES ITS SUIT THREE TIMES: the glyph (a distinct silhouette), the ink (a distinct
// luminance, not just a distinct hue), and the suit's name in the aria-label. Strip the colour and
// the card is still readable, which is the whole point — see src/palette.ts.

import { SUIT_NAMES, cardName, rankOf, suitOf } from './cards';
import { escapeHtml } from './dom';
import { SUIT_INK, SUIT_WASH } from './palette';

/** One 24×24 silhouette per suit. Solid fills only — an outline vanishes at 14px on a phone. */
const GLYPH: readonly string[] = [
  // Loft — the fly loft above the stage: a chevron pointing up.
  'M12 3 L21.5 14 H16.2 L12 9.2 L7.8 14 H2.5 Z',
  // Batten — a lighting bar seen end-on: a slab with two lamps under it.
  'M2.5 6 H21.5 V11 H2.5 Z M6 12.5 a2.2 2.2 0 1 0 0.01 0 Z M18 12.5 a2.2 2.2 0 1 0 0.01 0 Z',
  // Drape — a curtain, scalloped along the bottom.
  'M3 3 H21 V13.5 Q18.6 20.5 15.6 14.2 Q12.9 20.8 10.1 14.2 Q7.2 20.6 3 13.9 Z',
  // Truss — a braced frame: an hourglass of steel.
  'M3.5 3.5 H20.5 V6 L13.6 12 L20.5 18 V20.5 H3.5 V18 L10.4 12 L3.5 6 Z',
  // Gantry — the trump. A star, and the only radially symmetric shape in the set.
  'M12 1.8 L14.7 9 L22.2 9.3 L16.3 13.9 L18.4 21.2 L12 16.9 L5.6 21.2 L7.7 13.9 L1.8 9.3 L9.3 9 Z',
];

export interface CardOpts {
  /** Wire this card up to a tap. Becomes `data-card`. */
  action?: boolean;
  /** Legal to play right now. A card that is not playable is dimmed AND disabled. */
  playable?: boolean;
  /** Locked by an order token or the finale: illegal to play, and visibly so. */
  locked?: boolean;
  /** Somebody's task card. */
  task?: boolean;
  /** Currently picked up. */
  selected?: boolean;
  /** Extra classes. */
  klass?: string;
  /** Overrides the aria-label entirely. */
  label?: string;
  /** Small size, for the trick pile and the task rail. */
  small?: boolean;
}

/**
 * One card. A `<button>` when it is tappable and a `<span>` when it is not — so a card you cannot
 * play is not in the tab order and does not lie to a screen reader about being interactive.
 */
export function cardHtml(card: number, o: CardOpts = {}): string {
  const suit = suitOf(card);
  const rank = rankOf(card);
  const cls = [
    'card',
    `suit-${suit}`,
    o.small ? 'sm' : '',
    o.locked ? 'locked' : '',
    o.task ? 'task' : '',
    o.selected ? 'sel' : '',
    o.action && o.playable ? 'live' : '',
    o.action && !o.playable ? 'dim' : '',
    o.klass ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  const label = o.label ?? `${cardName(card)}${o.locked ? ', locked' : ''}${o.task ? ', a task' : ''}`;
  const style = `--ink:${SUIT_INK[suit]};--wash:${SUIT_WASH[suit]}`;
  const glyph = `<svg class="pip" viewBox="0 0 24 24" aria-hidden="true"><path d="${GLYPH[suit]}"/></svg>`;
  const body = `${glyph}<span class="rank">${rank}</span>${glyph}${
    o.locked ? '<span class="lockmark" aria-hidden="true">&#8709;</span>' : ''
  }`;

  if (o.action) {
    return `<button type="button" class="${cls}" style="${style}" data-card="${card}" aria-label="${escapeHtml(label)}"${
      o.playable ? '' : ' disabled'
    }>${body}</button>`;
  }
  return `<span class="${cls}" style="${style}" role="img" aria-label="${escapeHtml(label)}">${body}</span>`;
}

/** A card nobody is allowed to see. The count is what carries the information, so it is announced. */
export function backHtml(count: number, who: string): string {
  const one = '<span class="card back" aria-hidden="true"></span>';
  return `<span class="fan" role="img" aria-label="${escapeHtml(`${who}: ${count} cards`)}">${one.repeat(
    Math.min(count, 12),
  )}<span class="fan-n">${count}</span></span>`;
}

/** The suit legend shown in How to Play — proves the shapes are the primary channel. */
export function legendHtml(): string {
  return SUIT_NAMES.map(
    (n, s) =>
      `<span class="legend-item"><svg class="pip" viewBox="0 0 24 24" style="--ink:${SUIT_INK[s]}" aria-hidden="true"><path d="${GLYPH[s]}"/></svg>${escapeHtml(
        n,
      )}${s === 4 ? ' <em>(trumps everything)</em>' : ''}</span>`,
  ).join('');
}
