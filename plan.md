# Game Plan: Tacit

## Overview
- **Name:** Tacit
- **Repo name:** tacit
- **Tagline:** Win the right card for the right crewmate — and you are almost never allowed to say which.
- **Genre (directory category):** card

Taken from the head of IDEAS.md's board-game initiative (the "Cosmoscrew / The Crew-shaped" line).
Renamed: `Cosmoscrew` parses badly ("cosmo-screw") and the theme moved from a spaceship to a stage
crew, which is where the name comes from — **tacet** is the instruction in a score meaning *this part
is silent*. Mechanic only; no reference to the source game ships anywhere in the product.

**The fleet's first trick-taker.** 48 games shipped, none of them a trick-taking game, and the CARD
genre held only three (a bluff, a silent-line co-op, a sealed-bid auction).

## Core Loop
Everyone is dealt an equal hand. A few **task cards** are laid face up; players take turns claiming
one each — **never a card already in their own hand**, so every task depends on somebody else. Then
you play tricks: follow the led colour if you can, highest of that colour wins, the **Gantry** trumps
everything. A task is complete when the crewmate who claimed it wins the trick containing that exact
card. Anyone else takes it → the mission is over. Clear them all and the crew climbs a rung.

The tension is that you can see exactly what needs to happen and you are not allowed to say it. You
watch a crewmate lead the colour you are holding their card in, and you have to decide whether they
are asking for it or about to lose it.

## Controls
- **Primary input:** touch. **Why not a sensor:** the last several builds *were* sensor-first
  (`warble` voice-pitch, `brim` accelerometer, `waft` camera), the queue's current priority is the
  board-game initiative, and a hidden-information card game's entire input is "choose one of the
  twelve things in your hand" — a tap is not the lazy answer here, it is the correct one. Gyro/mic
  were considered and rejected: neither adds anything to a game whose whole content is deduction.
- **Desktop:** click. Every control is a real button and reachable by keyboard/tab with visible focus.
- **Mobile:** tap-first. Cards are ≥42×58px with ≥44px controls; the hand wraps rather than scrolls,
  so nothing is ever off-screen. No D-pad and no joystick — neither fits a card game (principle #19).

## Multiplayer
- **Mode:** live P2P, 2–5 — **plus a complete solo game against a bot crew.**
- **Shape: CO-OP.** Not versus, and not close: a trick-taker where you are trying to hand cards to
  each other is a fundamentally different game from one where you are trying to take them. Versus
  would also have needed a scoring system, and a co-op needs none — the mission either lands or it
  does not.
- **The opponent** is the difficulty ladder: each cleared mission deals more tasks, then numbers them
  into a chain that must land in order, then demands one lands in the very final trick.
- **What stops one player soloing it:** the own-hand draft rule. You cannot claim a task you are
  holding, so every single task in the game requires another player to put a card where you can win it.
- **Topology:** host-authoritative with genuinely hidden hands. The host shuffles from a **private**
  seed it never sends and unicasts each peer only its own hand; everything public travels as one
  broadcast log containing the whole action history every time.
- **Channels:** one, `tm` (≤12 bytes), with a `t` discriminator: `deal` (unicast), `log` (broadcast),
  `act` (peer→host), `need`, `claim`, `att`.
- **Room entry — all three ways in:** scan the QR, open the link, or type the code. The stock lobby
  gives all three; the QR is verified square, light-backed and inside the card in the browser pass.
- **Late joiner:** `seated: false` → a spectator view that shows the public table and no hands at all.
- **If the host leaves:** the promoted peer broadcasts `claim`, every peer answers with its **opening**
  hand, and the new host refills the deal and replays the log. If exactly one seat never answers, its
  hand is *derived* as the deck minus every other hand — so the common case (a two-player room whose
  host leaves) needs no answer from anybody. A room that collapses to **one** is a walkover.
- **End of round → rematch:** `createRounds`, never touching the room. The **mission number** rides in
  `roundOpts` beside the mode, so clearing a mission advances the whole crew and failing resets to 1.
  Waiting shows a visible countdown and a ready count; the host can force start; "Back to lobby" does
  not leave the room.

## Juice Plan
Procedural SFX only: a pitched `blip` per card played (pitch varies with the card, so a trick has a
little melody), a `thud` when a trick resolves, `win`/`lose` on a task landing or dying, a high blip
on a signal, `select` on a draft pick. The trick zone pulses on resolution. Haptics on a task
resolving. 3-2-1-Go count-in with audio before every mission. All of it respects
`prefers-reduced-motion`.

## Style Direction
**Vibe:** a theatre working light — deep blue-black house, warm cards, one gold accent.
**Palette:** solved, not picked. The five suit inks sit on a deliberate **luminance ladder** (0.090 →
0.203, an even 1.159 step) so they are distinguishable in greyscale, and each suit also has its own
silhouette. Hue is the third channel, not the first.
**Theme:** dark.

## Technical Architecture
- **Stack:** Vanilla TypeScript + Vite.
- **Render:** DOM/CSS — a card game is text and hit targets, and the browser is better at both than a
  canvas is.
- **Engine modules:** `net`, `rematch`, `turn`, `lobby`, `qr` (via lobby), `rng`, `sound`, `storage`,
  `mobile`, `identity`. Imported, never copied.
- **Persistence:** localStorage for mode, crew size, mute and the best rung reached per mode.

## Non-Goals
No chat. No spectator hand-peeking. No ranked/global leaderboard. No public room board (this is a
game you play with people you know). No bot difficulty tiers — see below.

## The two things the simulation changed, and one it refused to
Written after the fact, because both were decided by measurement rather than argument:

1. **A forced draft is a dice roll.** The first build dealt exactly as many task cards as the mission
   needed. Mission 1 at four players was won 33% of the time, and — the number that mattered —
   **0 times out of 11** when the task card happened to land in its own owner's hand, because a card
   you hold has to win a trick *as itself* and no trump can help you. The fix was two rules: **spare
   candidates** to draft from, and **you may not claim a task whose card is in your own hand.** The
   second turns the degenerate case into the game's best idea.
2. **The bot had no plan for a crewmate's card.** It would hoard somebody else's task card rather than
   risk it, so the colour never came out and the mission died on the last trick when it was finally
   forced. Teaching it to *hand the card over when the owner is winning and nothing compulsory can
   beat them* took mission 1 from 50% to 85%.
3. **What it refused:** an A/B on 400 identical seeds per cell showed the signal system changes a BOT
   crew's win rate by **less than one point** — well inside noise. That is not a bug and it was not
   "fixed": identical bots already coordinate implicitly because they reason identically. A comms
   channel only carries information when the other minds are opaque, i.e. when a human is playing.
   Reported honestly rather than tuned until the number moved.

**No bot difficulty tiers, on purpose.** In a versus game a weaker bot is an easier game; in a co-op it
is the exact opposite — a bot that plays badly loses *your* mission, and every loss reads as "my crew
is stupid". The bot always plays its best line and the difficulty lives entirely in the ladder, where
the player can see it and choose it.

## How To Play (player-facing copy)
> You are a stage crew working in the dark. Each mission lays out a few task cards and you take turns
> claiming one each — but never a card already in your own hand.
> Follow the colour that was led if you can; highest of that colour wins the trick, unless someone
> plays a Gantry, which trumps everything.
> A task is done when the crewmate who claimed it wins the trick containing that exact card. If
> anyone else takes it, the mission is over.
> And you may not talk about your hand.
