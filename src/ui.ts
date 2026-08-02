// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// See ADDITIONAL-TERMS.md for the section 7(b) attribution requirement.
//
// Tacit — the screens that are not the table: menu, how-to-play, about, results.

import { cardName } from './cards';
import { escapeHtml, plural } from './dom';
import { MODE_IDS, modeOf, rungFor } from './modes';
import { legendHtml } from './render';

export const ATTRIB =
  'Built by <a href="https://benrichardson.dev/" target="_blank" rel="noopener">benrichardson.dev</a> · <a href="https://lab.benrichardson.dev" target="_blank" rel="noopener">more games, tools &amp; sites</a>';

export interface MenuState {
  modeId: string;
  crew: number;
  best: number;
  muted: boolean;
}

export function menuHtml(s: MenuState): string {
  const mode = modeOf(s.modeId);
  return `
  <section class="screen menu">
    <h1 class="wordmark">Tacit</h1>
    <p class="tagline">A co-operative trick-taker. Win the right card for the right crewmate — and you are almost never allowed to say which.</p>

    <div class="picker" role="group" aria-label="Mode">
      ${MODE_IDS.map(
        (id) =>
          `<button type="button" class="chip${id === s.modeId ? ' on' : ''}" data-mode="${id}" aria-pressed="${
            id === s.modeId
          }">${escapeHtml(modeOf(id).name)}</button>`,
      ).join('')}
    </div>
    <p class="blurb">${escapeHtml(mode.blurb)}</p>

    <div class="picker" role="group" aria-label="Crew size">
      <span class="picker-label">Crew</span>
      ${[2, 3, 4, 5]
        .map(
          (n) =>
            `<button type="button" class="chip sm${n === s.crew ? ' on' : ''}" data-crew="${n}" aria-pressed="${
              n === s.crew
            }">${n}</button>`,
        )
        .join('')}
    </div>

    ${s.best > 0 ? `<p class="best">Best run: <strong>mission ${s.best}</strong></p>` : ''}

    <div class="menu-actions">
      <button class="btn primary" id="playSolo">Play solo</button>
      <button class="btn" id="playFriends">Play with friends</button>
      <button class="btn ghost" id="help">How to play</button>
      <button class="btn ghost" id="about">About</button>
      <button class="btn ghost" id="mute" aria-pressed="${s.muted}">${s.muted ? 'Sound off' : 'Sound on'}</button>
    </div>
  </section>`;
}

export function helpHtml(): string {
  return `
  <h2>How to play</h2>
  <p><strong>You are a stage crew working in the dark.</strong> Everyone is dealt a hand. Each mission
  lays out a few <em>task</em> cards, and you take turns claiming one each — but never a card that is
  already in your own hand, so every task depends on somebody else.</p>
  <p>Play goes round in tricks: follow the colour that was led if you can, otherwise play anything.
  Highest card of the led colour wins the trick — unless somebody plays a <strong>Gantry</strong>,
  which trumps everything.</p>
  <p><strong>A task is done when the crewmate who claimed it wins the trick containing that exact
  card.</strong> If anyone else takes it, the mission is over. Clear every task and you climb to the
  next mission; fail one and the run ends.</p>
  <p>The catch: you may not talk about your hand. In <em>Aside</em> you get one signal for the whole
  mission — show one card as your highest, lowest or only one of its colour. In <em>Hush</em> you get
  nothing at all.</p>
  <div class="legend">${legendHtml()}</div>
  <button class="btn sheet-close">Got it</button>`;
}

export function aboutHtml(): string {
  return `
  <h2>About Tacit</h2>
  <p>A co-operative trick-taking game for one to five. Play solo against a crew of bots, or send a
  link and play with friends. The mechanic is the classic hidden-task co-op trick-taker; the deck,
  the missions, the artwork and every word of it are original.</p>
  <p><strong>The bots don't cheat.</strong> Every crewmate — human or not — sees only its own hand,
  the cards already played and the public tasks. That is enforced by the code, not promised by it.</p>
  <p><strong>No server.</strong> Multiplayer is peer-to-peer over WebRTC. A public signalling relay
  introduces two browsers to each other and then gets out of the way; no game state ever touches a
  server, and there is no account, no login and no cookie.</p>
  <p>One honest caveat about playing with friends: because there is no referee, the host's browser
  deals the cards and holds everyone's hand. If the host leaves mid-mission, the crew re-attests
  their hands to whoever takes over so the run can continue — which means a crewmate who really
  wanted to could lie about what they were dealt. In a game with no winner, they would only be
  lying to themselves.</p>
  <p>No trackers and no third-party fonts. Anonymous, cookie-less page-view counts come from
  Cloudflare Web Analytics.</p>
  <p>${ATTRIB}</p>
  <button class="btn sheet-close">Close</button>`;
}

export interface ResultRow {
  name: string;
  isYou: boolean;
  /** Tasks this crewmate took on, and how many landed. */
  tasks: Array<{ card: number; done: boolean; order: number; finale: boolean }>;
  tricks: number;
  signalled: string | null;
}

export interface ResultsState {
  success: boolean;
  reason: string;
  mission: number;
  modeName: string;
  best: number;
  rows: ResultRow[];
  /** The exact card that ended it, when a task was lost. */
  lostCard: number | null;
  lostTo: string | null;
  multi: boolean;
}

/**
 * The end-of-mission summary. CO-OP FRAMING (principle #9): it leads with what the CREW did, and the
 * per-crewmate breakdown is there to show what each of them contributed — never to rank them. There
 * is no score column and there is no winner, because inventing one would quietly reward hogging the
 * tasks, which is the opposite of the game.
 */
export function resultsHtml(s: ResultsState): string {
  const done = s.rows.reduce((n, r) => n + r.tasks.filter((t) => t.done).length, 0);
  const total = s.rows.reduce((n, r) => n + r.tasks.length, 0);

  const headline = s.success
    ? `Mission ${s.mission} complete`
    : `Mission ${s.mission} failed`;
  const sub = s.success
    ? `Every task landed. ${s.multi ? 'The crew moves on' : 'On to mission ' + (s.mission + 1)}.`
    : s.lostCard !== null
      ? `${escapeHtml(cardName(s.lostCard))} — ${escapeHtml(s.reason)}${s.lostTo ? `, by ${escapeHtml(s.lostTo)}` : ''}.`
      : escapeHtml(s.reason);

  return `
  <h2 class="res-head ${s.success ? 'good' : 'bad'}">${escapeHtml(headline)}</h2>
  <p class="res-sub">${sub}</p>
  <p class="res-tally">${done} of ${plural(total, 'task')} landed · ${escapeHtml(s.modeName)}${
    s.best > 0 ? ` · best run: mission ${s.best}` : ''
  }</p>

  <ul class="crewlist">
    ${s.rows
      .map(
        (r) => `
      <li class="crewrow${r.isYou ? ' you' : ''}">
        <div class="crewname">${escapeHtml(r.name)}${r.isYou ? ' <span class="tagyou">you</span>' : ''}</div>
        <div class="crewtasks">
          ${
            r.tasks.length === 0
              ? '<span class="notask">no task — cover for the others</span>'
              : r.tasks
                  .map(
                    (t) =>
                      `<span class="restask ${t.done ? 'done' : 'open'}">${
                        t.order > 0 ? `<b>${t.order}</b>` : ''
                      }${t.finale ? '<b>&#937;</b>' : ''}${escapeHtml(cardName(t.card))} ${t.done ? '&#10003;' : '&#10007;'}</span>`,
                  )
                  .join('')
          }
        </div>
        <div class="crewtricks">${plural(r.tricks, 'trick')} won${
          r.signalled ? ` · signalled ${escapeHtml(r.signalled)}` : ''
        }</div>
      </li>`,
      )
      .join('')}
  </ul>`;
}

/** The one-line brief shown above the table, so nobody has to remember the rung's rules. */
export function briefFor(modeId: string, mission: number, players: number): string {
  const rung = rungFor(modeOf(modeId), mission, players);
  const bits = [`${plural(rung.tasks, 'task')} from ${rung.tasks + rung.spare} cards`];
  if (rung.ordered >= 2) bits.push(`first ${rung.ordered} taken are numbered — land them in order`);
  if (rung.finale) bits.push('the last one taken must land in the final trick');
  return bits.join(' · ');
}
