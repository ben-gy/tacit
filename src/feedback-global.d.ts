// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// See ADDITIONAL-TERMS.md for the section 7(b) attribution requirement.
//
// The hosted feedback widget mounts itself and exposes window.feedback. It is never imported —
// this is the one line of typing that lets the results screen call open() and still typecheck.

declare global {
  interface Window {
    feedback?: {
      open(o?: { returnFocusTo?: HTMLElement | null; build?: string; label?: string }): void;
      mount(o?: object): void;
    };
  }
}
export {};
