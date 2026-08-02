/**
 * source-hygiene.test.ts — the checks that catch "it built fine and shipped broken": stray control
 * bytes, console.log left in, a canonical link on a single-page game, a missing analytics beacon, a
 * vendored copy of the engine, and the [hidden] Safari safety net.
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const SRC_DIR = join(ROOT, 'src');
const TESTS_DIR = join(ROOT, 'tests');
const allSources = [...walk(SRC_DIR), ...walk(TESTS_DIR)];
const read = (p: string): string => readFileSync(p, 'utf8');
const rel = (p: string): string => relative(ROOT, p);

describe('no control bytes anywhere in the tree', () => {
  // eslint-disable-next-line no-control-regex
  const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;

  it('finds none in src/ or tests/', () => {
    expect(allSources.length, 'walked no files at all').toBeGreaterThan(5);
    const bad: string[] = [];
    for (const file of allSources) {
      const text = read(file);
      const m = CONTROL.exec(text);
      if (!m) continue;
      const at = m.index;
      const line = text.slice(0, at).split('\n').length;
      const code = `\\x${text.charCodeAt(at).toString(16).padStart(2, '0')}`;
      bad.push(`${rel(file)}:${line} contains ${code}`);
    }
    expect(bad, 'control bytes survive the build and corrupt strings at runtime').toEqual([]);
  });
});

describe('shipped code is quiet', () => {
  it('has no console.log / console.error in src/', () => {
    const noisy: string[] = [];
    for (const file of walk(SRC_DIR)) {
      read(file)
        .split('\n')
        .forEach((line, i) => {
          if (/console\.(log|error)\(/.test(line)) noisy.push(`${rel(file)}:${i + 1}`);
        });
    }
    expect(noisy, 'debug logging left in a production build').toEqual([]);
  });
});

describe('index.html', () => {
  const html = read(join(ROOT, 'index.html'));
  it('carries no canonical link', () => {
    expect(html).not.toMatch(/<link[^>]+rel=["']canonical["']/i);
  });
  it('carries the Cloudflare beacon token', () => {
    expect(html).toContain('ba2bab2193ba42c1bea3d6714fcd0e28');
  });
});

describe('the engine is a package, not a copy', () => {
  it('has no src/engine/ directory', () => {
    expect(existsSync(join(SRC_DIR, 'engine'))).toBe(false);
  });
  it('imports the engine by package specifier where it imports it at all', () => {
    const offenders: string[] = [];
    for (const file of allSources) {
      for (const m of read(file).matchAll(/from\s+['"]([^'"]+)['"]/g)) {
        if (/(^|\/)engine\/(net|rematch|lobby|rng|turn|storage)/.test(m[1])) {
          offenders.push(`${rel(file)} -> ${m[1]}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('the [hidden] safety net', () => {
  const css = join(ROOT, 'src/styles/main.css');
  it('main.css forces [hidden] to display:none', () => {
    expect(existsSync(css), 'src/styles/main.css must exist for this guard to fire').toBe(true);
    const text = read(css).replace(/\s+/g, ' ');
    expect(text).toMatch(/\[hidden\][^{]*\{[^}]*display:\s*none\s*!important/i);
  });
});
