// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// See ADDITIONAL-TERMS.md for the section 7(b) attribution requirement.
//
// Tacit — bootstrap and the screen machine. Owns which screen is up and the room's Net, which is
// created ONCE per session and never left for a rematch. Rules live in mission.ts, the crew in
// bot.ts, one mission in session.ts, the table in table.ts.

import '@ben-gy/game-engine/mobile.css';
import './styles/main.css';

import { hardenViewport } from '@ben-gy/game-engine/mobile';
import { createSfx } from '@ben-gy/game-engine/sound';
import { createStore } from '@ben-gy/game-engine/storage';
import { createNet, roomAppId, setTurnConfig, type Net } from '@ben-gy/game-engine/net';
import { getTurnConfig } from '@ben-gy/game-engine/turn';
import { createRounds, type RoundInfo, type RoundPlayer, type Rounds } from '@ben-gy/game-engine/rematch';
import { clearRoomInUrl, createLobby, createRoomEntry, normalizeRoomCode, setRoomInUrl } from '@ben-gy/game-engine/lobby';
import { resolveName } from '@ben-gy/game-engine/identity';
import { newSeed } from '@ben-gy/game-engine/rng';

import { cardName } from './cards';
import { escapeHtml } from './dom';
import { MODE_IDS, modeOf } from './modes';
import { isLive, isOver, SIG_LABEL, type Ev, type Mission } from './mission';
import { Session, type WireMsg } from './session';
import { TableView } from './table';
import { runCountdown } from './countdown';
import { ATTRIB, aboutHtml, helpHtml, menuHtml, resultsHtml, type ResultRow } from './ui';

const SLUG = 'tacit';

const app = document.querySelector<HTMLElement>('#app')!;
let content: HTMLElement;

const store = createStore(SLUG);
const sfx = createSfx(store.get<boolean>('muted', false) ?? false);
const reducedMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

let unlocked = false;
function unlock(): void {
  if (unlocked) return;
  unlocked = true;
  try {
    sfx.unlock();
  } catch {
    /* audio unlock is best-effort */
  }
}
window.addEventListener('pointerdown', unlock, { once: true });
window.addEventListener('keydown', unlock, { once: true });

const playerName = resolveName(store, () => `Crew ${Math.floor(Math.random() * 900 + 100)}`);
let myModeChoice = modeOf(store.get<string>('mode', '')).id;
let hostOptsMode = myModeChoice;
let myCrew = Math.min(5, Math.max(2, store.get<number>('crew', 4) ?? 4));

const bestKey = (mode: string): string => `best_${mode}`;
const bestFor = (mode: string): number => store.get<number>(bestKey(mode), 0) ?? 0;
function noteBest(mode: string, reached: number): void {
  if (reached > bestFor(mode)) store.set(bestKey(mode), reached);
}

let net: Net | null = null;
let rounds: Rounds | null = null;
let session: Session | null = null;
let roster: RoundPlayer[] = [];
let roomCode = '';
let soloMission = 1;
let netMission = 1;

const cleanups: Array<() => void> = [];
const onCleanup = (fn: () => void): void => void cleanups.push(fn);
function teardown(): void {
  for (const fn of cleanups.splice(0)) {
    try {
      fn();
    } catch {
      /* a failing teardown must never block the next screen */
    }
  }
}
const setPlaying = (on: boolean): void => void document.body.classList.toggle('playing', on);

function mountShell(): void {
  app.innerHTML = `<main class="main-content" id="content"></main><footer class="site-footer">${ATTRIB}</footer>`;
  content = document.getElementById('content')!;
}

function sheet(html: string): void {
  const wrap = document.createElement('div');
  wrap.className = 'overlay';
  wrap.innerHTML = `<div class="sheet">${html}</div>`;
  document.body.appendChild(wrap);
  const close = (): void => wrap.remove();
  const armedAt = Date.now();
  wrap.addEventListener('pointerdown', (e) => {
    // A sheet opened from a pointerup would otherwise be closed by that gesture's trailing click.
    if (e.target === wrap && Date.now() - armedAt > 350) close();
  });
  wrap.querySelectorAll('.sheet-close').forEach((b) => b.addEventListener('click', close));
}

function toast(msg: string): void {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.classList.add('show'), 10);
  setTimeout(() => t.remove(), 2100);
}

function ping(cue: string, pitch?: number): void {
  try {
    sfx.play(cue, pitch === undefined ? undefined : { pitch });
  } catch {
    /* audio is best-effort and must never break a turn */
  }
}

// ── menu ────────────────────────────────────────────────────────────────────────
function showMenu(): void {
  teardown();
  setPlaying(false);
  content.innerHTML = menuHtml({ modeId: myModeChoice, crew: myCrew, best: bestFor(myModeChoice), muted: sfx.muted() });

  content.querySelectorAll<HTMLElement>('.chip[data-mode]').forEach((c) =>
    c.addEventListener('click', () => {
      myModeChoice = modeOf(c.dataset.mode).id;
      store.set('mode', myModeChoice);
      ping('select');
      showMenu();
    }),
  );
  content.querySelectorAll<HTMLElement>('.chip[data-crew]').forEach((c) =>
    c.addEventListener('click', () => {
      myCrew = Math.min(5, Math.max(2, Number(c.dataset.crew) || 4));
      store.set('crew', myCrew);
      ping('select');
      showMenu();
    }),
  );
  content.querySelector('#playSolo')!.addEventListener('click', () => startSolo(1));
  content.querySelector('#playFriends')!.addEventListener('click', () => showRoomEntry());
  content.querySelector('#help')!.addEventListener('click', () => sheet(helpHtml()));
  content.querySelector('#about')!.addEventListener('click', () => sheet(aboutHtml()));
  content.querySelector('#mute')!.addEventListener('click', () => {
    sfx.setMuted(!sfx.muted());
    store.set('muted', sfx.muted());
    showMenu();
  });

  if (!store.get<boolean>('seenHelp', false)) {
    store.set('seenHelp', true);
    sheet(helpHtml());
  }
}

// ── juice ───────────────────────────────────────────────────────────────────────
function juice(evs: Ev[]): void {
  for (const e of evs) {
    if (e.k === 'play') ping('blip', 0.9 + (e.card % 5) * 0.06);
    else if (e.k === 'trick') {
      ping('thud', 0.8);
      if (!reducedMotion) flash('trickzone');
    } else if (e.k === 'task') {
      ping(e.ok ? 'win' : 'lose', e.ok ? 1 : 0.7);
      if (!reducedMotion && 'vibrate' in navigator) {
        try {
          navigator.vibrate(e.ok ? [10, 40, 10] : 90);
        } catch {
          /* haptics are best-effort */
        }
      }
    } else if (e.k === 'signal') ping('blip', 1.5);
    else if (e.k === 'draft') ping('select');
  }
}

function flash(cls: string): void {
  const el = content.querySelector<HTMLElement>(`.${cls}`);
  if (!el) return;
  el.classList.remove('pulse');
  void el.offsetWidth;
  el.classList.add('pulse');
}

// ── running one mission ─────────────────────────────────────────────────────────
let activeSession: Session | null = null;
let table: TableView | null = null;

function runMissionScreen(s: Session, multi: boolean, onDone: (success: boolean) => void): void {
  setPlaying(true);
  content.innerHTML = `<section class="screen game"><div id="tableHost"></div></section>`;
  const host = content.querySelector<HTMLElement>('#tableHost')!;

  const view = new TableView(host, {
    submit: (a) => s.submit(a),
    quit: () => onQuit(),
    names: () => s.names,
    mySeat: () => s.mySeat,
    rebuilding: () => s.rebuilding,
    abandoned: () => s.abandoned,
    ping,
  });
  table = view;

  let live = false;
  const cd = runCountdown(host, sfx, () => {
    live = true;
    view.paint(s.m);
  });

  s.deps.onChange = () => {
    if (live) view.paint(s.m);
  };
  s.deps.onEvents = (evs) => juice(evs);
  /**
   * The results screen is deliberately held back for a beat so the final trick is visible. That beat
   * has to be CANCELLABLE: without it, starting a new mission inside the delay lets the old one's
   * summary fire anyway — against the new mission, because `session` has already moved on. The
   * symptom is a results screen headed "Mission 1 failed · 0 of 0 tasks landed" (the new mission,
   * still mid-draft) with a button offering "Mission 2" (the old one, which succeeded). Two
   * different games on one screen, and it is on screen for real.
   */
  let endTimer: ReturnType<typeof setTimeout> | null = null;
  s.deps.onEnd = () => {
    const ok = !!s.m?.success;
    endTimer = setTimeout(() => {
      endTimer = null;
      // Belt and braces: if the room has moved on to another mission, this summary is stale.
      if (session !== s) return;
      onDone(ok);
    }, 1100);
  };

  // Every clock in the game runs on setInterval, never rAF: a backgrounded tab never fires rAF, and
  // a crew that freezes when the player checks a message is a hang.
  const clock = setInterval(() => {
    s.tick();
    if (multi) s.beat();
    if (multi && s.alone() && s.m && !isOver(s.m)) {
      // A room that has collapsed to ONE is a walkover, not an eternal wait — there is nobody left
      // to co-operate with. Stamp a reason onto the mission on the way out: without it the summary
      // says "failed" and then explains nothing, which reads as the game breaking rather than as
      // everyone having gone home.
      s.m.reason = 'the rest of the crew left the room';
      onDone(false);
    }
  }, 1200);

  function onQuit(): void {
    if (multi) rounds?.finish();
    teardown();
    if (multi && net && rounds) showLobby();
    else showMenu();
  }

  onCleanup(() => {
    clearInterval(clock);
    if (endTimer !== null) clearTimeout(endTimer);
    endTimer = null;
    cd.cancel();
    view.destroy();
    if (table === view) table = null;
  });
  view.paint(s.m);
}

// ── solo ────────────────────────────────────────────────────────────────────────
const CREWMATES = ['Rigger', 'Spot', 'Flyman', 'Deck'];

function startSolo(mission: number): void {
  teardown();
  soloMission = mission;
  const mode = modeOf(myModeChoice);
  const players = myCrew;
  const mySeat = 0;
  const bots = new Set<number>();
  for (let s = 1; s < players; s++) bots.add(s);
  const names = [playerName, ...CREWMATES.slice(0, players - 1)];

  const s = new Session({
    mode,
    mission,
    players,
    mySeat,
    bots,
    isHost: true,
    names,
    peerOfSeat: [],
    poolSeed: newSeed(),
    dealSeed: newSeed(),
    deps: { send: () => {}, onChange: () => {}, onEvents: () => {}, onEnd: () => {} },
  });
  session = s;
  activeSession = s;
  onCleanup(() => s.destroy());

  runMissionScreen(s, false, (ok) => {
    if (ok) noteBest(mode.id, mission);
    showResults(false, ok);
  });
}

// ── multiplayer ─────────────────────────────────────────────────────────────────
let netSend: (m: WireMsg, to?: string | string[]) => void = () => {};
let msgOff: () => void = () => {};
let lobby: { repaint(): void; destroy(): void } | null = null;
let lobbyMounted = false;

const repaintLobby = (): void => void (lobbyMounted && lobby?.repaint());

function showRoomEntry(): void {
  teardown();
  setPlaying(false);
  content.innerHTML = '<section class="screen"><div id="entry"></div></section>';
  const host = content.querySelector<HTMLElement>('#entry')!;

  const deep = new URL(location.href).searchParams.get('room');
  if (deep) {
    const code = normalizeRoomCode(deep);
    clearRoomInUrl();
    if (code.length >= 3) {
      void enterRoom(code, false);
      return;
    }
  }

  const entry = createRoomEntry({
    container: host,
    onSubmit: (code: string, created: boolean) => void enterRoom(normalizeRoomCode(code), created),
    onCancel: showMenu,
    title: 'Play with friends',
    subtitle: 'Start a room and send the link, or type a code you were given.',
  });
  onCleanup(() => entry.destroy());
}

async function enterRoom(code: string, created: boolean): Promise<void> {
  teardown();
  setPlaying(false);
  roomCode = code;
  setRoomInUrl(code);
  netMission = 1;
  session = null;
  activeSession = null;

  content.innerHTML = `<section class="screen"><div class="lobby-searching"><span class="spinner"></span> Connecting…</div></section>`;

  try {
    setTurnConfig(await getTurnConfig());
  } catch {
    /* fail open — TURN is an upgrade, never a dependency */
  }

  const n = createNet(
    { appId: roomAppId(SLUG), roomId: code, claimHost: created },
    {
      onHostChange: (_id, isSelf) => {
        repaintLobby();
        // The host holds every hidden hand, so a promotion is not a formality here: the new host has
        // to ask the room what it was dealt before it can adjudicate anything.
        if (isSelf) session?.becomeHost();
      },
      onPeers: () => repaintLobby(),
      onPeerLeave: (id) => {
        session?.peerLeft(id);
        repaintLobby();
      },
    },
  );
  net = n;

  const r = createRounds<{ mode: string; mission: number }>({
    net: n,
    playerName,
    minPlayers: 2,
    roundOpts: () => ({ mode: myModeChoice, mission: netMission }),
    onRound: (info) => startNetMission(info),
    onChange: (s) => {
      const ho = s.hostOpts as { mode?: string; mission?: number } | null;
      if (ho && typeof ho.mode === 'string') hostOptsMode = modeOf(ho.mode).id;
      if (ho && typeof ho.mission === 'number') netMission = Math.max(1, ho.mission | 0);
      repaintLobby();
      refreshResults();
    },
  });
  rounds = r;

  const send = n.channel<WireMsg>('tm', (data, from) => session?.receive(data, from));
  netSend = (m, to) => send(m, to);
  msgOff = () => send.off();

  showLobby();
}

function showLobby(): void {
  const n = net;
  const r = rounds;
  if (!n || !r) return;
  lobbyMounted = true;
  setPlaying(false);
  teardown();

  content.innerHTML = `<section class="screen"><div id="lobby-host"></div></section>`;
  const isHost = (): boolean => n.isHost() && n.hostSettled();

  lobby = createLobby({
    container: content.querySelector<HTMLElement>('#lobby-host')!,
    net: n,
    rounds: r,
    roomCode,
    minPlayers: 2,
    maxPlayers: 5,
    onCancel: () => void leaveRoom(),
    modeSlot: () => {
      if (isHost()) {
        return `<div class="lobby-modes" id="lm">${MODE_IDS.map(
          (id) =>
            `<button class="chip mode-btn${id === myModeChoice ? ' on' : ''}" data-mode="${id}" aria-pressed="${
              id === myModeChoice
            }">${escapeHtml(modeOf(id).name)}</button>`,
        ).join('')}<p class="mode-blurb">${escapeHtml(modeOf(myModeChoice).blurb)}</p>
        <p class="mode-blurb">Next up: <strong>mission ${netMission}</strong></p></div>`;
      }
      return `<p class="host-pick">${
        n.hostSettled()
          ? `The host chose <strong>${escapeHtml(modeOf(hostOptsMode).name)}</strong> · mission ${netMission}`
          : 'Waiting for the host…'
      }</p>`;
    },
    onModeMount: () => {
      if (!isHost()) return;
      content.querySelectorAll<HTMLElement>('#lm .mode-btn').forEach((b) =>
        b.addEventListener('click', () => {
          myModeChoice = modeOf(b.dataset.mode).id;
          store.set('mode', myModeChoice);
          lobby?.repaint();
        }),
      );
    },
  });
  onCleanup(() => {
    lobby?.destroy();
    lobby = null;
  });
}

function startNetMission(info: RoundInfo<{ mode: string; mission: number }>): void {
  teardown();
  lobbyMounted = false;
  roster = info.players;
  const mode = modeOf(info.opts?.mode);
  netMission = Math.max(1, (info.opts?.mission as number) || 1);

  const myIndex = roster.findIndex((p) => p.id === (net?.selfId ?? ''));
  const seated = info.seated && myIndex >= 0;
  const players = Math.max(2, roster.length);
  const names = roster.map((p, i) => p.name || `Crew ${i + 1}`);
  // Two crewmates can arrive with the same handle — the default one is random, and two tabs on one
  // device share the store outright. Identical names on a results screen make it unreadable.
  names.forEach((nm, i) => {
    if (names.indexOf(nm) !== i) names[i] = `${nm} (${i + 1})`;
  });

  const s = new Session({
    mode,
    mission: netMission,
    players,
    mySeat: seated ? myIndex : null,
    bots: new Set(),
    isHost: info.isHost,
    names,
    peerOfSeat: roster.map((p) => p.id),
    poolSeed: info.seed,
    // Never sent. The host shuffles from this and unicasts only each peer's own hand.
    dealSeed: newSeed(),
    deps: { send: (m, to) => netSend(m, to), onChange: () => {}, onEvents: () => {}, onEnd: () => {} },
  });
  session = s;
  activeSession = s;
  onCleanup(() => s.destroy());

  runMissionScreen(s, true, (ok) => {
    if (ok) {
      netMission += 1;
      noteBest(mode.id, netMission - 1);
    } else {
      netMission = 1;
    }
    showResults(true, ok);
  });
}

// ── results ─────────────────────────────────────────────────────────────────────
let resultsMounted = false;
let multi = false;
let lastSuccess = false;

function showResults(isMulti: boolean, ok: boolean): void {
  teardown();
  setPlaying(false);
  multi = isMulti;
  lastSuccess = ok;
  resultsMounted = true;
  if (isMulti) rounds?.finish();

  content.innerHTML = `<section class="screen results-screen" id="res"></section><div class="menu-actions" id="ract"></div>`;
  renderResults();
  onCleanup(() => {
    resultsMounted = false;
  });
}

function rowsFor(m: Mission, names: string[], mySeat: number | null): ResultRow[] {
  return Array.from({ length: m.setup.players }, (_, s) => {
    const sig = m.signals.find((x) => x.seat === s);
    return {
      name: names[s] ?? `Seat ${s + 1}`,
      isYou: s === mySeat,
      tasks: m.tasks
        .filter((t) => isLive(t) && t.owner === s)
        .map((t) => ({ card: t.card, done: t.done, order: t.order, finale: t.finale })),
      tricks: m.tricksWon[s],
      signalled: sig ? `${cardName(sig.card)} as ${SIG_LABEL[sig.kind]}` : null,
    };
  });
}

function renderResults(): void {
  const s = session;
  const m = s?.m;
  if (!s || !m || !resultsMounted) return;
  const box = content.querySelector<HTMLElement>('#res');
  const act = content.querySelector<HTMLElement>('#ract');
  if (!box || !act) return;

  const lost = m.events.find((e) => e.k === 'task' && !e.ok) as Extract<Ev, { k: 'task' }> | undefined;
  const lostTrick = lost ? (m.events.filter((e) => e.k === 'trick') as Array<Extract<Ev, { k: 'trick' }>>).find((t) => t.trick === lost.trick) : undefined;

  box.innerHTML = resultsHtml({
    success: m.success,
    reason: m.reason,
    mission: m.setup.mission,
    modeName: s.mode.name,
    best: bestFor(s.mode.id),
    rows: rowsFor(m, s.names, s.mySeat),
    lostCard: lost ? lost.card : null,
    lostTo: lostTrick && lost && lostTrick.winner !== lost.owner ? (s.names[lostTrick.winner] ?? null) : null,
    multi,
  });

  act.innerHTML = multi
    ? `<button class="btn primary" id="again">${lastSuccess ? `Mission ${netMission}` : 'Start again'}</button>
       <p class="waiting-note" id="waiting" aria-live="polite"></p>
       <button class="btn" id="lobby">Back to lobby</button>
       <button class="btn ghost" id="menu">Main menu</button>
       <button class="btn ghost results-feedback" id="feedback">Report a problem</button>`
    : `<button class="btn primary" id="again">${lastSuccess ? `Mission ${soloMission + 1}` : 'Try again'}</button>
       <button class="btn" id="share">Share</button>
       <button class="btn ghost" id="menu">Main menu</button>
       <button class="btn ghost results-feedback" id="feedback">Report a problem</button>`;

  act.querySelector('#feedback')!.addEventListener('click', (e) =>
    window.feedback?.open({ returnFocusTo: e.currentTarget as HTMLElement }),
  );
  act.querySelector('#menu')!.addEventListener('click', () => (multi ? void leaveRoom() : showMenu()));

  if (multi) {
    const again = act.querySelector<HTMLButtonElement>('#again')!;
    again.addEventListener('click', () => {
      rounds?.vote();
      again.disabled = true;
      again.textContent = 'Waiting for the crew…';
      refreshResults();
    });
    act.querySelector('#lobby')!.addEventListener('click', () => showLobby());
    refreshResults();
  } else {
    act.querySelector('#again')!.addEventListener('click', () => startSolo(lastSuccess ? soloMission + 1 : 1));
    act.querySelector('#share')!.addEventListener('click', () => void share());
  }
}

function refreshResults(): void {
  if (!resultsMounted || !multi) return;
  const waiting = content.querySelector<HTMLElement>('#waiting');
  if (!waiting) return;
  const r = rounds?.state();
  if (r && r.startsInMs !== null) {
    waiting.textContent = `Starting in ${Math.ceil(r.startsInMs / 1000)}s — ${r.votes.length}/${Math.max(
      r.present.length,
      1,
    )} ready`;
  } else if (r && r.votes.length) {
    waiting.textContent = `${r.votes.length}/${Math.max(r.present.length, 1)} ready for the next mission`;
  } else {
    waiting.textContent = '';
  }
}

setInterval(() => refreshResults(), 400);

async function share(): Promise<void> {
  const s = session;
  if (!s) return;
  const text = `Tacit · ${s.mode.name} — ${lastSuccess ? 'cleared' : 'lost'} mission ${s.mission}\nhttps://tacit.benrichardson.dev`;
  try {
    if (navigator.share) {
      await navigator.share({ text });
      return;
    }
  } catch {
    /* cancelled — fall through to copy */
  }
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied to clipboard');
  } catch {
    toast('Could not copy');
  }
}

async function leaveRoom(): Promise<void> {
  teardown();
  // Take the room out of the URL on the way out, or a reload — or reopening from a home-screen icon
  // — silently drops the player back into a room they deliberately left.
  clearRoomInUrl();
  lobbyMounted = false;
  session = null;
  activeSession = null;
  const n = net;
  const r = rounds;
  net = null;
  rounds = null;
  netSend = () => {};
  try {
    msgOff();
  } catch {
    /* the channel may already be gone */
  }
  msgOff = () => {};
  r?.destroy();
  if (n) {
    try {
      await n.leave();
    } catch {
      /* leaving is best-effort */
    }
  }
  showMenu();
}

// ── boot ────────────────────────────────────────────────────────────────────────
function boot(): void {
  hardenViewport();
  mountShell();
  const room = new URL(location.href).searchParams.get('room');
  if (room && normalizeRoomCode(room).length >= 3) showRoomEntry();
  else showMenu();
  window.addEventListener('beforeunload', () => {
    void net?.leave();
  });
}

// Exposed so the browser-verification pass can drive the REAL submit path synchronously — rAF is
// throttled in a hidden tab, and every phone check runs through this. Never read by gameplay.
(window as unknown as { __tacit?: unknown }).__tacit = {
  state(): unknown {
    const s = activeSession;
    const m = s?.m;
    if (!s || !m) return null;
    return {
      mode: m.setup.modeId,
      mission: m.setup.mission,
      players: m.setup.players,
      phase: m.phase,
      turn: m.turn,
      draftTurn: m.draftTurn,
      trickNo: m.trickNo,
      tricks: m.setup.tricks,
      trick: m.trick.slice(),
      hand: s.mySeat === null ? [] : (m.hands[s.mySeat] ?? []).slice(),
      mySeat: s.mySeat,
      over: isOver(m),
      success: m.success,
      reason: m.reason,
      tasks: m.tasks.filter(isLive).map((t) => ({ card: t.card, owner: t.owner, order: t.order, done: t.done })),
      pool: m.tasks.map((t) => ({ card: t.card, owner: t.owner })),
      log: m.log.slice(),
    };
  },
  submit(action: number): boolean {
    return activeSession ? activeSession.submit(action) : false;
  },
  /** Play one legal card for the local seat — enough to walk a whole mission in an automation pane. */
  step(): boolean {
    const s = activeSession;
    const m = s?.m;
    if (!s || !m || s.mySeat === null || isOver(m)) return false;
    if (m.phase === 'draft') {
      if (m.draftTurn !== s.mySeat) return false;
      const avail = m.tasks.map((t, i) => (t.owner === -1 ? i : -1)).filter((i) => i >= 0);
      const hand = m.hands[s.mySeat] ?? [];
      const ok = avail.filter((i) => !hand.includes(m.tasks[i].card));
      const pick = (ok.length ? ok : avail)[0];
      return pick === undefined ? false : s.submit((0 << 20) | (s.mySeat << 16) | pick);
    }
    if (m.turn !== s.mySeat) return false;
    const legal = m.hands[s.mySeat] ? legalOf(m, s.mySeat) : [];
    if (legal.length === 0) return false;
    return s.submit((1 << 20) | (s.mySeat << 16) | legal[0]);
  },
};

function legalOf(m: Mission, seat: number): number[] {
  // Imported lazily through the module graph to keep the hook honest: it uses the SHIPPED rule.
  return legalForRef(m, seat);
}
import { legalFor as legalForRef } from './mission';

boot();
