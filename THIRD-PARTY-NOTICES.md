# Third-party notices

Tacit is licensed under the [GNU AGPL-3.0-or-later](./LICENSE) with the additional
attribution term in [ADDITIONAL-TERMS.md](./ADDITIONAL-TERMS.md). The components
below keep their own licences and are **not** covered by that term.

This list is derived from what actually reaches the browser — the `sources` of the
built `dist/**/*.js.map` — rather than from `npm ls`. That distinction matters here:
`npm ls --omit=dev --all` reports over 250 packages, because the engine declares an
optional firebase/libp2p signalling stack that this game never imports. Three
packages are genuinely in the bundle.

## Bundled at runtime

| Component | Version | Licence | Notes |
|---|---|---|---|
| [@ben-gy/game-engine](https://github.com/ben-gy/gh-game-engine) | v1.3.2 | AGPL-3.0-or-later | Netcode, rounds, lobby, join QR, RNG, sound, storage, mobile hardening. |
| [trystero](https://github.com/dmotz/trystero) | pinned by the engine | MIT | WebRTC peer-to-peer over public signalling relays. Arrives through the engine, never as a direct dependency. |
| [@noble/secp256k1](https://github.com/paulmillr/noble-secp256k1) | transitive | MIT | Signing for the nostr signalling strategy Trystero uses. |

## Build-time only, not shipped

Vite, TypeScript, Vitest and jsdom are development dependencies. None of them
appears in `dist/`.

## Assets

Every pixel and every sound in this game is **generated at runtime or at build time
by code in this repository**: the cards are DOM and inline SVG drawn from the path
table in `src/render.ts`, the palette is solved in `src/palette.ts`, the icons come
from `scripts/gen-icons.mjs`, and the audio is synthesised by the engine's Web Audio
module. There are no third-party fonts, images, sprites or sound files, and nothing
is fetched from a CDN.

## Game rules

Tacit is an original implementation of a co-operative hidden-task trick-taking game.
Game mechanics are not subject to copyright and reimplementing one is entirely
legitimate; the name, the deck, the suits, the mission ladder, the artwork and every
line of text here are original to this repository and reference no other product.

## Network

The only requests this game makes are:

- **Cloudflare Web Analytics** (`static.cloudflareinsights.com`) — anonymous,
  cookie-less page-view counts.
- **The hosted feedback widget** (`feedback.benrichardson.dev`).
- **Multiplayer only:** public WebRTC signalling relays, used to introduce two
  browsers to each other, plus short-lived TURN credentials from
  `rt.benrichardson.dev` for peers that cannot form a direct connection. No game
  state passes through any of them.
