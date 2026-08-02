# Contributing to Tacit

Thanks for your interest in improving Tacit.

## Copyright assignment (required)

By submitting a contribution (a pull request, patch, or any other change) you
**assign the copyright in that contribution to Ben Richardson**, and you confirm
you have the right to do so. This keeps the copyright in the project held by a
single party, so the project can continue to be offered under both the
[GNU AGPL-3.0-or-later](./LICENSE) and a separate commercial licence (see
[ADDITIONAL-TERMS.md](./ADDITIONAL-TERMS.md)).

If you cannot assign copyright, please open an issue to discuss before sending a
pull request.

## Ground rules

- Keep the game **self-contained**: no CDN assets, no third-party fonts, no
  trackers beyond the existing Cloudflare Web Analytics beacon and the hosted
  feedback widget. Art and audio stay procedural.
- The shared engine (`@ben-gy/game-engine`) is a **dependency** — never vendor or
  edit it from here.
- Run `npm test` and `npm run build` before opening a pull request; both must pass.

## The four invariants that are load-bearing

Do not weaken an assertion to get to green. Each of these caught a real defect:

1. **`tests/bot-view.test.ts`** — the bot must never be able to see another hand. The
   field list on `BotView` is closed and asserted; adding a field that carries a
   hand fails the build rather than the player.
2. **`tests/mechanism.test.ts`** — the rules audit deliberately imports **nothing**
   from `src/`. It restates the deck encoding, the follow-suit rule, the trick
   winner and the whole task adjudication from first principles. If you make it
   call `trickWinner()`, it becomes a tautology and stops being worth running.
3. **`tests/balance.test.ts`** — the ladder numbers in `src/modes.ts` were produced by
   this file, not confirmed by it. Changing one means re-running the sweep, not
   editing the expectation. Note the documented exception: the one-task-to-two-tasks
   step is intrinsically ~40 points and two separate mitigations failed to move it.
4. **`tests/contrast.test.ts`** — the suit inks sit on a solved luminance ladder so
   they survive greyscale. Change a hue and **re-solve** the ladder; the first set
   was picked by eye and every ink landed within 1.02:1 of every other.

## SPDX headers

Every source file under `src/` carries a three-line SPDX header. Keep it.
