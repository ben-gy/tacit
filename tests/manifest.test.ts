/**
 * manifest.test.ts — the parts of the game nobody plays and everybody would notice if they broke:
 * the install metadata, the share card, the SEO assets, and the promise that this page loads nothing
 * from anybody else's server. The sharpest guard here is the icon-existence one: a manifest can name
 * /icons/icon-512.png forever without anybody generating it, and the failure only shows up as a
 * blank home-screen tile on somebody else's phone.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8');
const html = read('index.html');
const SLUG = 'tacit';
const NAME = 'Tacit';
const HOST = `${SLUG}.benrichardson.dev`;
const manifest = JSON.parse(read('public/manifest.webmanifest'));
const themeColor = html.match(/<meta name="theme-color" content="([^"]+)"/)?.[1];

describe('the page loads nothing from anybody else', () => {
  it('has exactly two external scripts: the analytics beacon and the feedback widget', () => {
    // The cap is the point. Anything past these two is a third party watching our players, and it
    // gets in by accident — a snippet pasted from a tutorial, a "quick" polyfill CDN.
    const scripts = [...html.matchAll(/<script[^>]*src="([^"]+)"/g)].map((m) => m[1]);
    const external = scripts.filter((s) => /^https?:/.test(s));
    expect(external.sort()).toEqual([
      'https://feedback.benrichardson.dev/w.js',
      'https://static.cloudflareinsights.com/beacon.min.js',
    ]);
  });

  it('pulls in no third-party stylesheet or font', () => {
    const links = [...html.matchAll(/<link[^>]*href="([^"]+)"/g)].map((m) => m[1]);
    for (const href of links) {
      expect(href, `${href} is loaded from someone else's server`).not.toMatch(/^https?:\/\//);
    }
    expect(html).not.toMatch(/fonts\.(googleapis|gstatic)\.com/);
    expect(html).not.toMatch(/@import\s+url\(/);
  });

  it('carries no canonical link — a single-page game has nothing to point at but itself', () => {
    expect(html).not.toMatch(/<link[^>]+rel=["']canonical["']/i);
  });
});

describe('the head carries the metadata a share and an install need', () => {
  const meta = (attr: 'name' | 'property', key: string): string | undefined =>
    html.match(new RegExp(`<meta ${attr}="${key}" content="([^"]*)"`))?.[1];

  it('describes itself for a search result and a link preview', () => {
    for (const key of ['description', 'twitter:card', 'twitter:title', 'twitter:description', 'twitter:image']) {
      expect(meta('name', key), `<meta name="${key}"> is missing`).toBeTruthy();
    }
    for (const key of ['og:title', 'og:description', 'og:type', 'og:url', 'og:image']) {
      expect(meta('property', key), `<meta property="${key}"> is missing`).toBeTruthy();
    }
    expect(meta('name', 'twitter:card')).toBe('summary_large_image');
    expect(meta('property', 'og:url')).toBe(`https://${HOST}/`);
  });

  it('carries the iOS set too, because iOS ignores the manifest entirely', () => {
    expect(html).toMatch(/<link rel="manifest" href="\/manifest\.webmanifest"/);
    expect(html).toMatch(/<link rel="apple-touch-icon"/);
    expect(meta('name', 'apple-mobile-web-app-capable')).toBe('yes');
    expect(meta('name', 'apple-mobile-web-app-status-bar-style')).toBeTruthy();
    expect(meta('name', 'apple-mobile-web-app-title')).toBe(NAME);
    expect(themeColor, '<meta name="theme-color"> is missing').toMatch(/^#[0-9A-Fa-f]{6}$/);
  });

  it('points every absolute URL at this game’s own host', () => {
    for (const m of html.matchAll(/content="(https:\/\/[^"]+)"/g)) {
      if (m[1].startsWith('https://schema.org')) continue;
      expect(m[1], `${m[1]} points somewhere else`).toContain('benrichardson.dev');
    }
  });

  it('describes itself as a game, in JSON-LD that actually parses', () => {
    // A trailing comma here is invisible in the browser and silently costs the rich result.
    const block = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
    expect(block, 'the JSON-LD block is missing').toBeTruthy();
    const ld = JSON.parse(block![1]);
    expect(ld['@type']).toBe('VideoGame');
    expect(ld.name).toBe(NAME);
    expect(ld.url).toBe(`https://${HOST}/`);
  });
});

describe('it installs to a home screen', () => {
  it('is a standalone app with a name and a theme', () => {
    expect(manifest.name).toBe(NAME);
    expect(manifest.display).toBe('standalone');
    expect(manifest.start_url).toBe('/');
    expect(manifest.theme_color).toMatch(/^#[0-9A-Fa-f]{6}$/);
    expect(manifest.background_color).toBe(manifest.theme_color);
  });

  it('agrees with index.html about the theme colour', () => {
    // Two files, one colour: a mismatch shows up as the status bar flashing a different shade the
    // instant the installed app launches.
    expect(manifest.theme_color.toLowerCase()).toBe(themeColor?.toLowerCase());
    expect(manifest.background_color.toLowerCase()).toBe(themeColor?.toLowerCase());
  });

  it('ships 192, 512 and a MASKABLE 512 — Android crops a non-maskable one', () => {
    const sizes = manifest.icons.map((i: { sizes: string }) => i.sizes).sort();
    expect(sizes).toEqual(['192x192', '512x512', '512x512']);
    expect(manifest.icons.some((i: { purpose: string }) => i.purpose === 'maskable')).toBe(true);
  });
});

describe('every referenced image is really on disk', () => {
  // The check that catches a manifest pointing at an icon nobody generated. `existsSync` alone is
  // not enough — a half-written or zero-byte PNG installs as a blank tile just the same.
  const referenced = new Set<string>();
  for (const icon of manifest.icons as Array<{ src: string }>) referenced.add(icon.src);
  for (const m of html.matchAll(/<link[^>]*href="(\/[^"]+)"/g)) {
    if (!m[1].endsWith('.webmanifest')) referenced.add(m[1]);
  }
  for (const m of html.matchAll(/content="https:\/\/[^"]+(\/[^"/]+\.(?:png|svg|jpg))"/g)) referenced.add(m[1]);

  it('references a plausible set of images at all', () => {
    expect(referenced.size, 'nothing was scraped — the scrape regexes have drifted').toBeGreaterThan(3);
  });

  for (const src of [...referenced].sort()) {
    it(`public${src} exists and is non-empty`, () => {
      const path = join(ROOT, 'public', src);
      expect(existsSync(path), `${src} is referenced but was never generated`).toBe(true);
      expect(statSync(path).size, `${src} is a zero-byte file`).toBeGreaterThan(0);
    });
  }
});

describe('the invisible SEO assets', () => {
  it('names the sitemap in robots.txt and lists the site root in it', () => {
    expect(read('public/robots.txt')).toContain(`https://${HOST}/sitemap.xml`);
    const sitemap = read('public/sitemap.xml');
    expect(sitemap).toMatch(/^<\?xml version="1\.0" encoding="UTF-8"\?>/);
    expect(sitemap).toContain('<urlset');
    expect(sitemap).toContain('</urlset>');
    expect(sitemap).toContain(`<loc>https://${HOST}/</loc>`);
  });

  it('ships an IndexNow key file that contains its own filename stem', () => {
    // Bing rejects the whole submission if the file body is anything but the key itself.
    const key = '133936b7b2ab337d2e2288fd7dd7c30f';
    expect(read(`public/${key}.txt`).trim()).toBe(key);
  });

  it('pins the custom domain so a Pages deploy keeps it', () => {
    expect(read('public/CNAME').trim()).toBe(HOST);
  });
});

describe('the dependency shape', () => {
  const pkg = JSON.parse(read('package.json'));

  it('is AGPL', () => {
    expect(pkg.license).toBe('AGPL-3.0-or-later');
  });

  it('depends on the engine by github tag, never by path or floating ref', () => {
    expect(pkg.dependencies['@ben-gy/game-engine']).toMatch(/^github:ben-gy\/gh-game-engine#v\d+\.\d+\.\d+$/);
  });

  it('does NOT depend on trystero directly — it arrives through the engine, pinned', () => {
    expect(pkg.dependencies?.trystero, 'a direct trystero re-opens the two-versions-in-one-page trap').toBeUndefined();
    expect(pkg.devDependencies?.trystero).toBeUndefined();
  });
});
