/**
 * contrast.test.ts — principle #22. "Screenshot it and look" cannot see an invisible game piece: a
 * shape drawn in the right cell, at the right size, in a colour a shade off its background reads as
 * an empty cell, and on a deliberately moody dark palette that reads as ATMOSPHERE rather than as a
 * bug. Scrapwall shipped its walls at 1.14:1 and a player reported them as see-through.
 *
 * So the constants are measured here, pure and instant, and the rendered pixels are probed
 * separately in the browser pass. Both are needed: this proves the palette, only the canvas proves
 * what was actually painted.
 *
 * WCAG 2.1 SC 1.4.11 sets 3:1 as the floor for a non-text graphic. Text is held to 4.5:1.
 */

import { describe, expect, it } from 'vitest';
import { CARD_SURFACES, ON_CARD, ON_PANEL, PALETTE, PANEL_SURFACES, SUIT_INK, SUIT_WASH } from '../src/palette';
import { SUIT_NAMES, SUIT_SHAPES } from '../src/cards';

function channel(v: number): number {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

function luminance(hex: string): number {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) throw new Error(`not a 6-digit hex colour: ${hex}`);
  const n = parseInt(m[1], 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

function ratio(a: string, b: string): number {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

const show = (n: number): string => n.toFixed(2);

describe('every suit is legible on every card face it can be printed on', () => {
  for (let s = 0; s < SUIT_INK.length; s++) {
    for (const surface of CARD_SURFACES) {
      it(`${SUIT_NAMES[s]} ink on ${surface}`, () => {
        const r = ratio(SUIT_INK[s], PALETTE[surface]);
        expect(r, `${SUIT_NAMES[s]} ${SUIT_INK[s]} on ${surface} ${PALETTE[surface]} is ${show(r)}:1`).toBeGreaterThanOrEqual(
          3,
        );
      });
    }
  }
});

describe('the card itself is visible on the table', () => {
  for (const f of CARD_SURFACES) {
    for (const bg of ['table', 'ground', 'panel'] as const) {
      it(`${f} on ${bg}`, () => {
        const r = ratio(PALETTE[f], PALETTE[bg]);
        expect(r, `${f} on ${bg} is ${show(r)}:1`).toBeGreaterThanOrEqual(3);
      });
    }
  }

  it('a face-down card is distinguishable from the table AND from a face-up card', () => {
    expect(ratio(PALETTE.back, PALETTE.table), `back vs table ${show(ratio(PALETTE.back, PALETTE.table))}`).toBeGreaterThanOrEqual(
      1.5,
    );
    expect(ratio(PALETTE.back, PALETTE.face)).toBeGreaterThanOrEqual(3);
    // Its pattern has to be visible ON the back, or a face-down card is a flat hole in the layout.
    expect(ratio(PALETTE.backLine, PALETTE.back)).toBeGreaterThanOrEqual(1.5);
  });
});

describe('status colours read on every panel they sit on', () => {
  for (const key of ON_PANEL) {
    for (const surface of PANEL_SURFACES) {
      it(`${key} on ${surface}`, () => {
        const r = ratio(PALETTE[key], PALETTE[surface]);
        // Body text is held to the stricter text threshold; graphics to 3:1.
        const floor = key === 'text' || key === 'textMuted' ? 4.5 : 3;
        expect(r, `${key} ${PALETTE[key]} on ${surface} ${PALETTE[surface]} is ${show(r)}:1`).toBeGreaterThanOrEqual(
          floor,
        );
      });
    }
  }
});

describe('text printed on a card', () => {
  for (const key of ON_CARD) {
    for (const surface of CARD_SURFACES) {
      it(`${key} on ${surface}`, () => {
        const r = ratio(PALETTE[key], PALETTE[surface]);
        const floor = key === 'cardInk' ? 4.5 : 3;
        expect(r, `${key} on ${surface} is ${show(r)}:1`).toBeGreaterThanOrEqual(floor);
      });
    }
  }
});

describe('the suits do not rely on hue', () => {
  it('every suit has its own silhouette, and there are exactly five of each', () => {
    expect(SUIT_SHAPES.length).toBe(SUIT_INK.length);
    expect(new Set(SUIT_SHAPES).size, 'two suits share a shape — colour blindness would merge them').toBe(
      SUIT_SHAPES.length,
    );
    expect(new Set(SUIT_NAMES).size).toBe(SUIT_NAMES.length);
  });

  it('the inks are separated in LUMINANCE, so they survive a greyscale screenshot', () => {
    const lums = SUIT_INK.map(luminance).sort((a, b) => a - b);
    for (let i = 1; i < lums.length; i++) {
      // Not a WCAG number — a design invariant. Two inks at the same lightness are one ink to
      // anyone reading shape-first, and the whole point is that hue is the LAST channel.
      const gap = (lums[i] + 0.05) / (lums[i - 1] + 0.05);
      expect(gap, `two suit inks sit at the same lightness (${lums.map((l) => l.toFixed(3)).join(', ')})`).toBeGreaterThan(
        1.12,
      );
    }
  });

  it('every wash is light enough to print its own ink on top of', () => {
    for (let s = 0; s < SUIT_WASH.length; s++) {
      const r = ratio(SUIT_INK[s], SUIT_WASH[s]);
      expect(r, `${SUIT_NAMES[s]} ink on its own wash is ${show(r)}:1`).toBeGreaterThanOrEqual(3);
    }
  });
});

describe('the palette is well-formed', () => {
  it('every colour is a 6-digit hex, so nothing silently falls back to black', () => {
    const all = [...Object.values(PALETTE), ...SUIT_INK, ...SUIT_WASH];
    for (const c of all) expect(c, `${c} is not a 6-digit hex`).toMatch(/^#[0-9a-f]{6}$/i);
    expect(all.length).toBeGreaterThan(20);
  });
});
