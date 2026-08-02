// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// See ADDITIONAL-TERMS.md for the section 7(b) attribution requirement.
//
// Tacit — the table screen: the draft, the tricks, your hand, and the one button you are allowed to
// say anything with. It owns no rules; it reads a Mission and submits packed actions back.

import { SUIT_NAMES, cardName, rankOf, sortHand, suitOf } from './cards';
import { escapeHtml, plural } from './dom';
import {
  A_DRAFT,
  A_PLAY,
  A_SIGNAL,
  SIG_LABEL,
  draftableFor,
  isBlocked,
  isLive,
  isOver,
  isSqueezed,
  legalFor,
  liveTasks,
  packAct,
  packSignal,
  signalKindsFor,
  type Mission,
} from './mission';
import { backHtml, cardHtml } from './render';
import { briefFor } from './ui';

export interface TableDeps {
  submit: (action: number) => boolean;
  quit: () => void;
  names: () => string[];
  mySeat: () => number | null;
  /** Non-null while a promoted host is rebuilding the deal from the crew's answers. */
  rebuilding: () => boolean;
  abandoned: () => Set<number>;
  ping: (cue: string, pitch?: number) => void;
}

export class TableView {
  private root: HTMLElement;
  private deps: TableDeps;
  private signalCard: number | null = null;
  private destroyed = false;

  constructor(root: HTMLElement, deps: TableDeps) {
    this.root = root;
    this.deps = deps;
    this.root.addEventListener('click', (e) => this.onClick(e));
  }

  destroy(): void {
    this.destroyed = true;
  }

  private onClick(e: Event): void {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
    if (!el) return;
    const [kind, value] = (el.dataset.act ?? '').split(':');
    const n = Number(value);

    if (kind === 'draft') {
      this.deps.ping('select');
      this.deps.submit(packAct(A_DRAFT, this.deps.mySeat() ?? 0, n));
    } else if (kind === 'play') {
      this.deps.ping('blip', 1.1);
      this.deps.submit(packAct(A_PLAY, this.deps.mySeat() ?? 0, n));
    } else if (kind === 'sigopen') {
      this.signalCard = this.signalCard === n ? null : n;
      this.deps.ping('blip', 1.3);
      this.repaint();
    } else if (kind === 'sig') {
      const [c, k] = value.split('/').map(Number);
      this.signalCard = null;
      this.deps.ping('select');
      this.deps.submit(packAct(A_SIGNAL, this.deps.mySeat() ?? 0, packSignal(k, c)));
    } else if (kind === 'sigcancel') {
      this.signalCard = null;
      this.repaint();
    } else if (kind === 'quit') {
      this.deps.quit();
    }
  }

  private current: Mission | null = null;

  paint(m: Mission | null): void {
    this.current = m;
    this.repaint();
  }

  private repaint(): void {
    if (this.destroyed) return;
    const m = this.current;
    if (!m) {
      this.root.innerHTML = `<div class="waiting"><span class="spinner"></span> Waiting for the deal…</div>`;
      return;
    }
    if (this.deps.rebuilding()) {
      this.root.innerHTML = `<div class="waiting"><span class="spinner"></span> You're the host now — rebuilding the table…</div>`;
      return;
    }
    this.root.innerHTML = m.phase === 'draft' ? this.draftHtml(m) : this.playHtml(m);
  }

  // ── the draft ──────────────────────────────────────────────────────────────

  private draftHtml(m: Mission): string {
    const me = this.deps.mySeat();
    const names = this.deps.names();
    const mine = me !== null && m.draftTurn === me;
    const taken = m.tasks.filter((t) => t.owner !== -1).length;
    const nextOrder = taken < m.setup.ordered ? taken + 1 : 0;
    const nextFinale = m.setup.finale && taken === m.setup.take - 1;
    const canTake = me === null ? [] : draftableFor(m, me, m.draftRelaxed);

    const note = nextOrder > 0
      ? `The next task taken becomes <b>link ${nextOrder}</b>.`
      : nextFinale
        ? 'The next task taken must land in the <b>final trick</b>.'
        : '';

    return `
    <div class="hud">
      <span class="hud-mission">Mission ${m.setup.mission}</span>
      <span class="hud-brief">${escapeHtml(briefFor(m.setup.modeId, m.setup.mission, m.setup.players))}</span>
      <button class="btn ghost tiny" data-act="quit:0">Quit</button>
    </div>

    <div class="draft">
      <h2 class="draft-head">${mine ? 'Claim a task' : `${escapeHtml(names[m.draftTurn] ?? '…')} is choosing…`}</h2>
      <p class="draft-note">${note} Take <b>${m.setup.take - taken}</b> more of these ${m.tasks.filter((t) => t.owner === -1).length}.</p>
      <div class="pool">
        ${m.tasks
          .map((t, i) => {
            if (t.owner !== -1) {
              return `<div class="poolslot claimed">${cardHtml(t.card, { small: true, task: true })}<span class="who">${escapeHtml(
                names[t.owner] ?? '?',
              )}${t.order > 0 ? ` · link ${t.order}` : ''}${t.finale ? ' · final trick' : ''}</span></div>`;
            }
            const allowed = mine && canTake.includes(i);
            const why = mine && !allowed ? "it's in your hand" : '';
            return `<div class="poolslot">${
              mine
                ? `<button type="button" class="pickbtn${allowed ? '' : ' no'}" data-act="${
                    allowed ? `draft:${i}` : 'none:0'
                  }"${allowed ? '' : ' disabled'} aria-label="Claim ${escapeHtml(cardName(t.card))}">${cardHtml(t.card, {
                    small: true,
                  })}</button>`
                : cardHtml(t.card, { small: true })
            }<span class="who">${escapeHtml(why)}</span></div>`;
          })
          .join('')}
      </div>
      ${
        mine && canTake.length === 0
          ? '<p class="draft-note warn">Every card left is in your hand, so this pass goes to the next crewmate.</p>'
          : ''
      }
    </div>

    ${this.handHtml(m, false)}`;
  }

  // ── the table ──────────────────────────────────────────────────────────────

  private playHtml(m: Mission): string {
    const me = this.deps.mySeat();
    const names = this.deps.names();
    const over = isOver(m);
    const yourTurn = me !== null && m.turn === me && !over;
    const gone = this.deps.abandoned();

    const seats = Array.from({ length: m.setup.players }, (_, s) => {
      const isMe = s === me;
      const hand = m.hands[s];
      const count = hand ? hand.length : m.setup.tricks - m.trickNo - (this.playedThisTrick(m, s) ? 1 : 0);
      const tasks = liveTasks(m).filter((t) => t.owner === s);
      return `
      <div class="seat${isMe ? ' me' : ''}${m.turn === s && !over ? ' active' : ''}">
        <div class="seat-top">
          <span class="seat-name">${escapeHtml(names[s] ?? `Seat ${s + 1}`)}${
            gone.has(s) ? ' <span class="tag">left — crew covering</span>' : ''
          }${s === m.setup.commander ? ' <span class="tag lead">led first</span>' : ''}</span>
          <span class="seat-tricks">${m.tricksWon[s]}</span>
        </div>
        <div class="seat-tasks">
          ${
            tasks.length === 0
              ? '<span class="notask">no task</span>'
              : tasks
                  .map((t) =>
                    cardHtml(t.card, {
                      small: true,
                      task: true,
                      locked: !t.done && isBlocked(m, t),
                      klass: t.done ? 'landed' : '',
                      label: `${names[s]}'s task: ${cardName(t.card)}${t.done ? ', landed' : isBlocked(m, t) ? ', locked' : ''}`,
                    }),
                  )
                  .join('')
          }
        </div>
        ${isMe ? '' : backHtml(Math.max(0, count), names[s] ?? `Seat ${s + 1}`)}
        ${this.signalNote(m, s)}
      </div>`;
    }).join('');

    const trick = m.trick
      .map((c, i) => {
        const seat = (m.lead + i) % m.setup.players;
        return `<div class="played"><span class="played-who">${escapeHtml(names[seat] ?? '')}</span>${cardHtml(c, {
          small: true,
        })}</div>`;
      })
      .join('');

    const squeezed = yourTurn && isSqueezed(m, me);

    return `
    <div class="hud">
      <span class="hud-mission">Mission ${m.setup.mission}</span>
      <span class="hud-brief">Trick ${Math.min(m.trickNo + 1, m.setup.tricks)} of ${m.setup.tricks}</span>
      <button class="btn ghost tiny" data-act="quit:0">Quit</button>
    </div>

    <div class="seats">${seats}</div>

    <div class="trickzone" aria-live="polite">
      ${m.trick.length === 0 ? `<p class="trickhint">${escapeHtml(this.leadHint(m, names))}</p>` : `<div class="trick">${trick}</div>`}
    </div>

    <p class="prompt${squeezed ? ' warn' : ''}" aria-live="polite">${escapeHtml(this.prompt(m, names, squeezed))}</p>

    ${this.handHtml(m, yourTurn)}
    ${this.signalBar(m)}`;
  }

  private playedThisTrick(m: Mission, seat: number): boolean {
    for (let i = 0; i < m.trick.length; i++) if ((m.lead + i) % m.setup.players === seat) return true;
    return false;
  }

  private leadHint(m: Mission, names: string[]): string {
    if (isOver(m)) return '';
    return `${names[m.lead] ?? '…'} leads`;
  }

  private prompt(m: Mission, names: string[], squeezed: boolean): string {
    const me = this.deps.mySeat();
    if (isOver(m)) return m.success ? 'Every task landed.' : m.reason;
    if (me === null) return "Watching — you're in the next mission.";
    if (m.turn !== me) return `Waiting for ${names[m.turn] ?? '…'}…`;
    if (squeezed) return 'Nothing legal is left but a locked card. Playing it ends the mission.';
    const led = m.trick.length === 0 ? null : suitOf(m.trick[0]);
    return led === null ? 'Your lead.' : `Follow ${SUIT_NAMES[led]} if you can.`;
  }

  private signalNote(m: Mission, seat: number): string {
    const sig = m.signals.filter((s) => s.seat === seat);
    if (sig.length === 0) return '';
    return `<div class="sigs">${sig
      .map(
        (s) =>
          `<span class="sig">${cardHtml(s.card, { small: true, klass: 'tiny' })}<em>${escapeHtml(
            SIG_LABEL[s.kind],
          )} ${escapeHtml(SUIT_NAMES[suitOf(s.card)])}</em></span>`,
      )
      .join('')}</div>`;
  }

  private handHtml(m: Mission, yourTurn: boolean): string {
    const me = this.deps.mySeat();
    if (me === null) return '<div class="hand spectator">You are watching this mission.</div>';
    const hand = m.hands[me];
    if (!hand) return '<div class="hand"><span class="spinner"></span></div>';
    const legal = yourTurn ? legalFor(m, me) : [];
    const tasks = new Map(m.tasks.filter(isLive).map((t) => [t.card, t]));

    return `<div class="hand" role="group" aria-label="Your hand">
      ${sortHand(hand)
        .map((c) => {
          const t = tasks.get(c);
          return cardHtml(c, {
            action: true,
            playable: legal.includes(c),
            task: !!t && !t.done,
            locked: !!t && !t.done && isBlocked(m, t),
            klass: 'inhand',
            label: `${cardName(c)}${t ? (t.owner === me ? ', your task' : `, ${this.deps.names()[t.owner]}'s task`) : ''}${
              legal.includes(c) ? '' : ', not playable now'
            }`,
          }).replace('data-card=', 'data-act="play:' + c + '" data-card=');
        })
        .join('')}
    </div>`;
  }

  /**
   * The comms panel. One tap opens it, one tap spends the signal — and the ONLY claims offered are
   * the ones that are actually true of your hand, because a signal you could lie with is not a
   * signal, it is noise. `signalKindsFor` decides that, not this file.
   */
  private signalBar(m: Mission): string {
    const me = this.deps.mySeat();
    if (me === null || m.setup.signalBudget === 0 || isOver(m)) return '';
    const left = m.signalsLeft[me];
    const hand = m.hands[me];
    if (!hand) return '';
    const mine = m.turn === me;

    if (this.signalCard !== null && mine) {
      const kinds = signalKindsFor(m, me, this.signalCard);
      return `<div class="sigbar open">
        <span class="sigbar-label">Show ${escapeHtml(cardName(this.signalCard))} as your…</span>
        ${kinds
          .map((k) => `<button class="btn tiny" data-act="sig:${this.signalCard}/${k}">${escapeHtml(SIG_LABEL[k])}</button>`)
          .join('')}
        <button class="btn ghost tiny" data-act="sigcancel:0">Cancel</button>
      </div>`;
    }

    return `<div class="sigbar">
      <span class="sigbar-label">${
        left > 0
          ? mine
            ? `${plural(left, 'signal')} left — tap a card to show it`
            : `${plural(left, 'signal')} left`
          : 'No signals left'
      }</span>
      ${
        left > 0 && mine
          ? sortHand(hand)
              .filter((c) => signalKindsFor(m, me, c).length > 0)
              .map((c) => `<button class="sigpick" data-act="sigopen:${c}" aria-label="Signal ${escapeHtml(cardName(c))}">${
                escapeHtml(SUIT_NAMES[suitOf(c)][0] + rankOf(c))
              }</button>`)
              .join('')
          : ''
      }
    </div>`;
  }
}
