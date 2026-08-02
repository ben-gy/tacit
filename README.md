# Tacit

**Win the right card for the right crewmate — and you are almost never allowed to say which.**

🎮 Play: https://tacit.benrichardson.dev

## What it is

A co-operative trick-taking card game for one to five. Everyone is dealt an equal hand, a few **task
cards** are laid face up, and you take turns claiming one each — but never a card that is already in
your own hand. Then you play tricks. A task is complete when the crewmate who claimed it wins the
trick containing that exact card; if anyone else takes it, the mission is over for everybody.

The whole game lives in the gap between what you can see and what you are allowed to say. You watch a
crewmate lead the colour you are holding their card in, and you have to decide, in silence, whether
they are asking for it or about to lose it. In **Aside** you get one signal for the entire mission —
show one card as your highest, lowest or only one of its colour, and the game will not let you lie
about it. In **Hush** you get nothing at all.

Clear a mission and the crew climbs a rung: more tasks, then tasks numbered into a chain that has to
land in order, then one that must land in the very final trick. Fail and the run ends. Play it solo
against a crew of bots, or send a link and play it with friends.

## How to play

- **Follow the colour that was led** if you hold one. Otherwise play anything.
- **Highest card of the led colour wins the trick** — unless somebody plays a **Gantry**, which trumps
  everything. Whoever wins leads the next trick.
- **A task lands when its owner wins the trick containing that card.** Anyone else takes it and the
  mission fails.
- A **numbered** task must land after every lower number. A task marked for the **final trick** must
  land there and nowhere else. Cards that cannot legally land yet are locked and cannot be played —
  unless following suit leaves you nothing else, and then the game warns you first.
- **Desktop:** click, or tab and press. **Mobile:** tap. That is the whole control scheme.

## Multiplayer

Live peer-to-peer for 2–5, with no server. Create a room and get a **QR code, a link and a four-letter
code** — a friend can scan it, open it, or type it. The mission number belongs to the room, so the
whole crew climbs the ladder together.

Hands are genuinely hidden: the host shuffles from a private seed it never transmits and sends each
player only their own cards. Everything public — the tasks, every card played — travels as one shared
log, so a peer that misses a message simply catches up.

If the host leaves mid-mission, the crew re-attests their opening hands to whoever takes over and the
run continues. If exactly one player is missing, their hand is reconstructed as the deck minus every
other hand, so a two-player room needs no answer at all. There is no referee, which means a
determined player could lie about what they were dealt — in a game with no winner, only to
themselves. A room that collapses to one player is a walkover, never an endless wait.

The only network traffic multiplayer adds is a public WebRTC signalling relay introducing two
browsers to each other, plus short-lived TURN credentials for connections that cannot form directly.
No game state ever touches a server.

## Tech

- Vite 6 + vanilla TypeScript
- DOM rendering — a card game is text and hit targets
- Shared engine ([`@ben-gy/game-engine`](https://github.com/ben-gy/gh-game-engine)): P2P netcode,
  multi-round sessions, lobby + join QR, deterministic RNG, procedural audio, storage, mobile hardening
- Vitest: rules, P2P-sync determinism, an information-leak gate on the bot, a difficulty-curve
  simulation, an independent mechanism audit, and a contrast gate

No cookies, no fingerprinting, no third-party fonts. Anonymous, cookie-less page-view counts via
Cloudflare Web Analytics.

## A note on the bots

They do not cheat, and that is enforced rather than promised. Every crewmate — human or not — decides
from a `BotView` that contains exactly one private field: its own hand. `tests/bot-view.test.ts`
walks the whole object looking for any other player's cards, and proves the search works by trying it
against a deliberately leaky one.

They also have **no difficulty tiers**, on purpose. In a competitive game a weaker opponent is an
easier game; in a co-op it is the reverse — a bot that plays badly loses *your* mission. The crew
always plays its best line, and the difficulty lives in the mission ladder where you can see it.

## Local dev

```bash
npm install
npm run dev
npm test
npm run build
npm run preview
```

## License

[GNU Affero General Public License v3.0 or later](./LICENSE), with an attribution
requirement added under section 7(b) — see [ADDITIONAL-TERMS.md](./ADDITIONAL-TERMS.md).

A separate commercial licence without the AGPL's source-disclosure obligations is
available on request: <hi@ben.gy>.

Third-party components keep their own licences — see [THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md).
