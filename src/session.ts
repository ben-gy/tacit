// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// See ADDITIONAL-TERMS.md for the section 7(b) attribution requirement.
//
// Tacit — one mission, played by whoever is here: bots, peers, or a mix. Solo and multiplayer are
// the SAME object with a different `mode`, because the alternative is two code paths that disagree.
//
// THE HIDDEN-HAND PROBLEM, AND WHY IT IS SOLVED THE WAY IT IS.
// The whole game is hidden information, so the deal cannot be derived from the shared round seed —
// that seed is broadcast to everyone by the rematch protocol, and anything derived from it is public
// by construction. So the host shuffles from a PRIVATE seed it never sends, and unicasts each peer
// only its own hand. Everything else — the task pool, every card played, every signal — is public
// and travels as one broadcast log.
//
// That buys real hidden information and costs exactly one hard problem: when the host leaves, the
// only copy of the deal leaves with it. The fix is RE-ATTESTATION. Every peer kept its own opening
// hand, the whole action log is already replicated everywhere, and a mission is `setup + log`. So
// the promoted host asks the room to re-attest, replays, and carries on. A crewmate could lie about
// their hand — and would be lying to their own crew in a game with no winner, which is a problem
// worth having compared to a mission that simply dies when a phone runs out of battery.
//
// And if exactly one seat never answers, its hand is not a mystery: it is the deck minus every
// other hand. `deriveMissing` does that, so the common case of the host leaving a two-player room
// needs no answer from anybody.

import { buildDeck } from './cards';
import { chooseCard, chooseDraft, bestSignal, signalThreshold, viewFor } from './bot';
import { modeOf, type Mode } from './modes';
import {
  A_DRAFT,
  A_PASS,
  A_PLAY,
  A_SIGNAL,
  actSeat,
  apply,
  canSignal,
  createMission,
  draftableFor,
  guestSetup,
  isOver,
  legalFor,
  makeSetup,
  packAct,
  packSignal,
  replay,
  type Ev,
  type Mission,
  type Setup,
} from './mission';

export type WireMsg =
  /** Host -> ONE peer. The only private message in the game. */
  | { t: 'deal'; mn: number; seat: number; hand: number[]; pool: number[]; take: number; ord: number; fin: boolean; cmd: number; mode: string; players: number }
  /** Host -> everyone. The whole action log, every time. A dropped message becomes a non-event. */
  | { t: 'log'; mn: number; log: number[] }
  /** Peer -> host. A proposed action; the host is the only one that decides. */
  | { t: 'act'; mn: number; act: number }
  /** Peer -> host. "I have nothing — deal me in." */
  | { t: 'need'; mn: number }
  /** New host -> everyone. "I have taken over; tell me what you were dealt." */
  | { t: 'claim'; mn: number }
  /** Peer -> new host. Its OPENING hand, so the promoted host can rebuild and replay. */
  | { t: 'att'; mn: number; seat: number; hand: number[] };

export interface SessionDeps {
  send: (m: WireMsg, to?: string | string[]) => void;
  onChange: () => void;
  onEvents: (evs: Ev[]) => void;
  onEnd: () => void;
}

export interface SessionInit {
  mode: Mode;
  mission: number;
  players: number;
  /** Which seat the local player occupies, or null for a spectator. */
  mySeat: number | null;
  /** Seats driven by the local bot. Solo fills this with every seat but yours. */
  bots: Set<number>;
  isHost: boolean;
  names: string[];
  /** Peer id per seat, for unicasting a deal. Empty in solo. */
  peerOfSeat: string[];
  deps: SessionDeps;
  /** Public seed for the task pool. Shared by the rematch protocol. */
  poolSeed: number;
  /** Private seed for the deal. NEVER sent. Host and solo only. */
  dealSeed: number;
}

export class Session {
  readonly mode: Mode;
  readonly mission: number;
  readonly players: number;
  mySeat: number | null;
  bots: Set<number>;
  isHost: boolean;
  names: string[];
  peerOfSeat: string[];
  deps: SessionDeps;
  m: Mission | null = null;
  /** True while a promoted host is waiting for the room to re-attest. */
  rebuilding = false;
  /** Set when a peer vanished mid-mission and the bot picked up its seat. */
  readonly abandoned = new Set<number>();
  private lastEventCount = 0;
  private botTimer: ReturnType<typeof setTimeout> | null = null;
  private claimAt = 0;
  /** How many times we have asked to be re-dealt after a failed replay. Bounded on purpose. */
  private needTries = 0;
  private attested = new Map<number, number[]>();
  private ended = false;
  private readonly poolSeed: number;
  private readonly dealSeed: number;

  constructor(init: SessionInit) {
    this.mode = init.mode;
    this.mission = init.mission;
    this.players = init.players;
    this.mySeat = init.mySeat;
    this.bots = init.bots;
    this.isHost = init.isHost;
    this.names = init.names;
    this.peerOfSeat = init.peerOfSeat;
    this.deps = init.deps;
    this.poolSeed = init.poolSeed;
    this.dealSeed = init.dealSeed;

    if (this.isHost) this.dealAsHost();
    else this.deps.send({ t: 'need', mn: this.mission });
  }

  // ── setup ──────────────────────────────────────────────────────────────────

  private dealAsHost(): void {
    const setup = makeSetup(this.mode, this.mission, this.players, this.poolSeed, this.dealSeed);
    this.m = createMission(setup, this.mode);
    // The very first drafter may already be unable to take anything.
    this.pumpDraft();
    this.pushDeals();
    this.broadcastLog();
    this.changed();
    this.maybeBot();
  }

  /** Unicast every seat its own hand. Repeated on `need`, so a peer that missed it can ask again. */
  private pushDeals(to?: number): void {
    const m = this.m;
    if (!m) return;
    for (let seat = 0; seat < this.players; seat++) {
      if (to !== undefined && seat !== to) continue;
      const peer = this.peerOfSeat[seat];
      const hand = m.setup.deal[seat];
      if (!peer || !hand || seat === this.mySeat) continue;
      this.deps.send(
        {
          t: 'deal',
          mn: this.mission,
          seat,
          hand: [...hand],
          pool: m.setup.pool.map((p) => p.card),
          take: m.setup.take,
          ord: m.setup.ordered,
          fin: m.setup.finale,
          cmd: m.setup.commander,
          mode: this.mode.id,
          players: this.players,
        },
        peer,
      );
    }
  }

  private broadcastLog(): void {
    if (!this.m || !this.isHost) return;
    this.deps.send({ t: 'log', mn: this.mission, log: [...this.m.log] });
  }

  // ── the wire ───────────────────────────────────────────────────────────────

  receive(msg: WireMsg, from: string): void {
    if (msg.mn !== this.mission) return;

    if (msg.t === 'deal') {
      // A guest learns its own hand and the public shape of the mission, and nothing else.
      if (this.m && this.m.log.length > 0) return;
      const setup = guestSetup(modeOf(msg.mode), this.mission, msg.players, this.poolSeed, msg.seat, msg.hand, msg.cmd);
      this.overrideSetup(setup, msg);
      this.m = createMission(setup, this.mode);
      this.mySeat = msg.seat;
      this.changed();
      return;
    }

    if (msg.t === 'log') {
      if (this.isHost || !this.m) return;
      // Replay from scratch. The host's log is the truth; ours is a cache of it.
      const before = this.m.log.length;
      if (msg.log.length < before) return; // a stale broadcast from before a promotion
      if (!replay(this.m, msg.log)) {
        /**
         * Our own hand disagrees with the host's history, so ask to be dealt again rather than
         * render a board that is quietly wrong — but ASK ONLY A FEW TIMES.
         *
         * There is one position the host cannot answer from: a peer whose attestation was lost
         * during a takeover has been played from a reconstruction, and the host has no opening hand
         * to re-deal it. Unbounded asking then becomes a `need`/`log` storm that runs for the rest
         * of the mission. After a handful of attempts this peer accepts it has fallen out of the
         * mission and watches instead — a spectator is a legible state; a board frozen several
         * plies behind, silently, is not.
         */
        if (++this.needTries <= 4) this.deps.send({ t: 'need', mn: this.mission });
        else this.mySeat = null;
        this.changed();
        return;
      }
      this.needTries = 0;
      this.changed();
      return;
    }

    if (msg.t === 'act') {
      if (!this.isHost || !this.m) return;
      // A peer may only act for ITS OWN seat. Without this check the host executes whatever seat the
      // sender packed into the action, so one crewmate could quietly play everybody's cards — and in
      // a game whose whole point is that you cannot coordinate, that is not a cheat so much as a
      // different, much worse game. The seat is in the action's own bits, so it costs one compare.
      const seat = actSeat(msg.act);
      if (this.peerOfSeat[seat] !== from) return;
      // They are demonstrably still here, so hand the seat back if the crew had picked it up.
      this.abandoned.delete(seat);
      this.commit(msg.act);
      return;
    }

    if (msg.t === 'need') {
      if (!this.isHost || !this.m) return;
      const seat = this.peerOfSeat.indexOf(from);
      if (seat >= 0) this.pushDeals(seat);
      this.broadcastLog();
      return;
    }

    if (msg.t === 'claim') {
      // Somebody else was promoted. Tell them what we were dealt so they can rebuild.
      if (this.isHost || !this.m || this.mySeat === null) return;
      const hand = this.m.setup.deal[this.mySeat];
      if (hand) this.deps.send({ t: 'att', mn: this.mission, seat: this.mySeat, hand: [...hand] }, from);
      return;
    }

    if (msg.t === 'att') {
      if (!this.isHost || !this.rebuilding) return;
      this.attested.set(msg.seat, [...msg.hand]);
      this.tryRebuild();
    }
  }

  private overrideSetup(setup: Setup, msg: Extract<WireMsg, { t: 'deal' }>): void {
    // The pool travels with the deal rather than being re-derived, so a guest can never disagree
    // with the host about which cards are on the table — not even if it somehow has a stale build.
    setup.pool = msg.pool.map((card) => ({ card }));
    setup.take = msg.take;
    setup.ordered = msg.ord;
    setup.finale = msg.fin;
  }

  // ── actions ────────────────────────────────────────────────────────────────

  /** A local action from the human. Applied by the host, proposed by anyone else. */
  submit(action: number): boolean {
    if (!this.m || this.rebuilding) return false;
    if (this.isHost) return this.commit(action);
    // Optimism is wrong here: the host owns the hands and might reject. Propose and wait for the
    // log to come back, which is at most one round trip and cannot desync.
    this.deps.send({ t: 'act', mn: this.mission, act: action });
    return true;
  }

  private commit(action: number): boolean {
    const m = this.m;
    if (!m || !this.isHost) return false;
    if (!apply(m, action)) return false;
    this.pumpDraft();
    this.broadcastLog();
    this.changed();
    this.maybeBot();
    return true;
  }

  /**
   * Host only: pass on behalf of any seat that cannot take a candidate under the own-hand rule.
   *
   * Only the host can decide this, because it is the only peer that can see the hand it depends on —
   * which is exactly why the decision is written into the log as an A_PASS rather than recomputed by
   * each peer. See the comment on A_PASS in mission.ts.
   */
  private pumpDraft(): void {
    const m = this.m;
    if (!m || !this.isHost) return;
    for (let guard = 0; m.phase === 'draft' && guard < m.setup.players * 3; guard++) {
      const seat = m.draftTurn;
      if (seat < 0) return;
      if (m.hands[seat] === null || draftableFor(m, seat, m.draftRelaxed).length > 0) return;
      if (!apply(m, packAct(A_PASS, seat, 0))) return;
    }
  }

  // ── the local crew ─────────────────────────────────────────────────────────

  /** Seats this client is responsible for driving: its own bots, plus any seat that walked out. */
  private drives(seat: number): boolean {
    if (this.bots.has(seat)) return true;
    return this.isHost && this.abandoned.has(seat);
  }

  private maybeBot(): void {
    const m = this.m;
    if (!m || this.botTimer !== null || this.rebuilding) return;
    if (isOver(m)) return;
    const seat = m.phase === 'draft' ? m.draftTurn : m.turn;
    if (seat < 0 || !this.drives(seat)) return;

    // setTimeout, never rAF: a backgrounded tab never fires rAF, and a crew that stops playing when
    // the player checks a message is a hang, not a pause.
    this.botTimer = setTimeout(() => {
      this.botTimer = null;
      const cur = this.m;
      if (!cur || isOver(cur) || this.rebuilding) return;
      const s = cur.phase === 'draft' ? cur.draftTurn : cur.turn;
      if (s < 0 || !this.drives(s)) return;

      if (cur.phase === 'draft') {
        const avail = draftableFor(cur, s, cur.draftRelaxed);
        const taken = cur.tasks.filter((t) => t.owner !== -1).length;
        if (avail.length > 0) this.commit(packAct(A_DRAFT, s, chooseDraft(viewFor(cur, s), avail, taken)));
        else this.commit(packAct(A_PASS, s, 0));
        return;
      }

      if (cur.signalsLeft[s] > 0 && cur.setup.signalBudget > 0) {
        const choice = bestSignal(viewFor(cur, s), (card, kind) => canSignal(cur, s, card, kind));
        if (choice && choice.score >= signalThreshold(cur.trickNo)) {
          this.commit(packAct(A_SIGNAL, s, packSignal(choice.kind, choice.card)));
        }
      }
      const allowed = legalFor(cur, s);
      const wanted = chooseCard(viewFor(cur, s));
      const card = allowed.includes(wanted) ? wanted : allowed[0];
      if (card !== undefined) this.commit(packAct(A_PLAY, s, card));
      // A beat of thinking time. Long enough that a card visibly lands rather than teleporting,
      // short enough that four bots in a row is not a wait.
    }, m.phase === 'draft' ? 520 : 620);
  }

  // ── the room changing shape ────────────────────────────────────────────────

  /**
   * A crewmate left. In a co-op there is nobody to hand the win to, so the run continues with their
   * seat played by the crew's own bot — a mission that gets harder, never a board that stops. When
   * the room is down to ONE, that is a walkover: the mission ends rather than waiting forever.
   */
  peerLeft(peerId: string): void {
    const seat = this.peerOfSeat.indexOf(peerId);
    if (seat < 0) return;
    this.abandoned.add(seat);
    this.peerOfSeat[seat] = '';
    this.changed();
    this.maybeBot();
  }

  /** Everyone else has gone. Nothing left to co-operate with. */
  alone(): boolean {
    return this.mySeat !== null && this.abandoned.size >= this.players - 1;
  }

  /**
   * This peer has just been promoted. It knows only its own hand and the public log, so it asks the
   * room to re-attest and rebuilds. `deriveMissing` covers the very common case — a two-player room
   * whose host left — with no answer needed from anyone.
   */
  becomeHost(): void {
    if (this.isHost || !this.m || isOver(this.m)) {
      this.isHost = true;
      return;
    }
    this.isHost = true;
    this.rebuilding = true;
    this.claimAt = Date.now();
    this.attested.clear();
    if (this.mySeat !== null) {
      const mine = this.m.setup.deal[this.mySeat];
      if (mine) this.attested.set(this.mySeat, [...mine]);
    }
    this.deps.send({ t: 'claim', mn: this.mission });
    this.changed();
    this.tryRebuild();
  }

  private tryRebuild(): void {
    const m = this.m;
    if (!m || !this.rebuilding) return;
    const known = [...this.attested.keys()];
    const missing = [];
    for (let s = 0; s < this.players; s++) if (!this.attested.has(s)) missing.push(s);

    if (missing.length === 1) {
      const derived = this.deriveMissing(known);
      if (derived) this.attested.set(missing[0], derived);
      missing.length = 0;
    }
    // Nobody left who COULD answer — every other seat's peer has already gone. Waiting out the full
    // window here would show "rebuilding…" for four seconds and then rebuild exactly the same thing,
    // which is four seconds of a spinner for no reason at all.
    const anyoneToAsk = this.peerOfSeat.some((p, s) => p !== '' && s !== this.mySeat && !this.attested.has(s));
    // Otherwise give the room a moment to answer; after that, carry on with holes. A seat we cannot
    // see is a seat we cannot validate, which in a co-op costs nothing but a rule check.
    if (missing.length > 0 && anyoneToAsk && Date.now() - this.claimAt < 4000) return;

    const log = [...m.log];
    for (let s = 0; s < this.players; s++) {
      const hand = this.attested.get(s);
      m.setup.deal[s] = hand ? [...hand] : null;
    }
    replay(m, log);
    this.fillUnattested(m);

    // ATTESTATION IS THE LIVENESS SIGNAL. A seat that did not answer the claim is a seat with nobody
    // behind it — starting with the host that just walked out — so the crew's own bot picks it up.
    // Without this the mission stalls in the quietest way there is: the board is correct, nothing
    // errors, and it is simply nobody's turn for ever. It relies on onPeerLeave having fired, which
    // the engine does do first, but a takeover must not DEPEND on two callbacks arriving in order.
    // Marked abandoned, but the peer id is KEPT. Clearing it as well locks the seat out for good,
    // so a crewmate who was merely slow to answer — a backgrounded tab, one dropped message — can
    // never play again, and the bot quietly takes over a seat whose player is sitting right there.
    // `receive` un-abandons a seat the moment its real peer acts.
    for (let s = 0; s < this.players; s++) {
      if (s === this.mySeat || this.attested.has(s)) continue;
      this.abandoned.add(s);
    }
    this.rebuilding = false;
    this.changed();
    this.maybeBot();
    this.broadcastLog();
  }

  /**
   * Hand out the cards nobody accounted for.
   *
   * WITHOUT THIS THE MISSION FREEZES, and it froze in exactly the way that is hardest to notice: a
   * seat whose hand the new host cannot see is a seat the crew's bot cannot play for either — the
   * bot is handed an empty hand, finds no legal card, and simply never moves. The board looks fine.
   * Nothing errors. It is just nobody's turn, forever. The takeover test caught it.
   *
   * So any seat still unknown gets a reconstruction of what it is holding NOW: the cards nobody can
   * account for, dealt out in the right count. It is a fiction, and it is a fiction about somebody
   * who has already left the room — a far better outcome than a run that dies because a phone went
   * flat.
   *
   * Deliberately applied AFTER the replay, never before. A fabricated opening hand can contradict a
   * play that is already in the log — hand a seat a Batten it never had and its perfectly legal
   * Drape discard becomes a revoke, `replay` refuses the whole log, and the rebuild fails outright.
   * Filling the CURRENT hand cannot rewrite history, because there is no history left to rewrite.
   */
  private fillUnattested(m: Mission): void {
    const unknown: number[] = [];
    for (let s = 0; s < this.players; s++) if (m.hands[s] === null) unknown.push(s);
    if (unknown.length === 0) return;

    const pool = new Set(buildDeck(this.players));
    for (const c of m.seen) pool.delete(c);
    for (let s = 0; s < this.players; s++) for (const c of m.hands[s] ?? []) pool.delete(c);

    // What each seat still holds: one card fewer for every card it has already put on the table.
    const rest = [...pool];
    for (const seat of unknown) {
      const played = m.seen.filter((_, i) => m.seenBy[i] === seat);
      const owed = Math.max(0, m.setup.tricks - played.length);
      m.hands[seat] = rest.splice(0, owed);
      void played;
      /**
       * The OPENING deal is deliberately left null. Writing the reconstruction back would let the
       * seat be re-dealt, but a fabricated opening hand cannot be replayed safely: give the seat a
       * colour it never held and a discard it legally made becomes a revoke, so `replay` throws out
       * the whole log. History is not ours to invent. The bounded `need` retry below is what stops
       * a returning peer looping instead.
       */
    }
  }

  /** The one hand nobody attested is the deck minus every hand that was attested. */
  private deriveMissing(known: number[]): number[] | null {
    if (known.length !== this.players - 1) return null;
    const rest = new Set(buildDeck(this.players));
    for (const s of known) for (const c of this.attested.get(s) ?? []) rest.delete(c);
    return rest.size > 0 ? [...rest] : null;
  }

  /** Called on a timer by the screen, so a rebuild that nobody answers still finishes. */
  tick(): void {
    if (this.rebuilding) this.tryRebuild();
    if (this.isHost && this.m && !isOver(this.m)) this.maybeBot();
  }

  // ── plumbing ───────────────────────────────────────────────────────────────

  private changed(): void {
    const m = this.m;
    if (m && m.events.length > this.lastEventCount) {
      this.deps.onEvents(m.events.slice(this.lastEventCount));
      this.lastEventCount = m.events.length;
    }
    this.deps.onChange();
    if (m && isOver(m) && !this.ended) {
      this.ended = true;
      this.deps.onEnd();
    }
  }

  /** Re-broadcast, so a peer that missed everything still catches up. Host only, on a heartbeat. */
  beat(): void {
    if (!this.isHost || !this.m) return;
    this.pushDeals();
    this.broadcastLog();
  }

  destroy(): void {
    if (this.botTimer !== null) clearTimeout(this.botTimer);
    this.botTimer = null;
  }
}
