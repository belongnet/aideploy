// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readFile(join(webRoot, file), 'utf8');

test('uses the AI Deploy product shell and keeps the hosted path connected', async () => {
  const html = await read('index.html');

  assert.match(html, /class="site-header"[\s\S]*class="site-header-inner"/);
  assert.match(html, /aria-label="AI Deploy command builder home"/);
  assert.match(html, /<span>AI Deploy<\/span>/);

  const hostedLinks = [...html.matchAll(/href="(https:\/\/www\.aideploy\.co\/\?[^\"]+)"/g)];
  assert.ok(hostedLinks.length >= 4, 'hosted wizard is not connected from every key context');
  for (const [, href] of hostedLinks) {
    const url = new URL(href.replaceAll('&amp;', '&'));
    assert.equal(url.hostname, 'www.aideploy.co');
    assert.equal(url.searchParams.get('utm_campaign'), 'command_builder');
  }
});

/** Escape a CSS selector for use inside a RegExp. */
const escapeSelector = (selector) => selector.replace(/[.*+?^${}()|[\]\\>]/g, '\\$&');

/**
 * Return the declaration body of the first `selector { ... }` rule in `css`.
 *
 * Brace-matched on purpose. The obvious shorthand — `/\.site-header\s*\{[\s\S]*position: sticky/`
 * — is vacuous: `[\s\S]*` walks straight through the closing `}` and happily
 * matches a `position: sticky` that belongs to `.command-panel` 500 lines
 * later, so deleting the declaration under test still passes.
 */
function ruleBody(css, selector) {
  const opener = new RegExp(`^[ \\t]*${escapeSelector(selector)}\\s*\\{`, 'm');
  const match = opener.exec(css);
  assert.ok(match, `no rule found for selector ${selector}`);

  const start = css.indexOf('{', match.index);
  let depth = 0;
  for (let index = start; index < css.length; index += 1) {
    if (css[index] === '{') depth += 1;
    else if (css[index] === '}') {
      depth -= 1;
      if (depth === 0) return css.slice(start + 1, index);
    }
  }
  throw new Error(`unbalanced braces after ${selector}`);
}

test('pins the sticky product header to its own rule, not to any later block', async () => {
  const css = await read('styles.css');

  // Scoped to the rule body, so removing a declaration fails the test even
  // though the same declaration still exists elsewhere in the stylesheet.
  const header = ruleBody(css, '.site-header');
  assert.match(header, /position:\s*sticky/);
  assert.match(header, /top:\s*0/);
  assert.match(header, /backdrop-filter:\s*blur\(/);
  // Unprefixed backdrop-filter is a no-op on iOS Safari before 18, which would
  // silently drop the frosted bar on a large share of the mobile fleet.
  assert.match(header, /-webkit-backdrop-filter:\s*blur\(/);
  assert.match(header, /border-bottom:\s*1px solid/);

  const inner = ruleBody(css, '.site-header-inner');
  assert.match(inner, /max-width:\s*var\(--shell\)/);
  assert.match(inner, /margin:\s*0 auto/);
  // The shell centres the row; the sticky bar itself must stay full-bleed.
  assert.doesNotMatch(header, /max-width:/);

  // Every rule that flips a link to inline-flex swallows the whitespace before
  // its trailing arrow span, so each one has to declare the gap back.
  for (const selector of ['.site-header nav a', '.hosted-options a', '.link-cluster a']) {
    assert.match(ruleBody(css, selector), /gap:/, `${selector} lost the space before its arrow`);
  }

  // Every interactive element in the shell clears the 44px tap target.
  for (const selector of [
    '.brand',
    '.site-header nav a',
    '.step-rail a',
    '.hosted-options a',
    '.future-command summary',
    '.link-cluster a',
    '.site-footer nav a',
  ]) {
    assert.match(
      ruleBody(css, selector),
      /min-height:\s*44px/,
      `${selector} lost its 44px tap target`,
    );
  }
});

test('gives the mobile header one row per nav link instead of a wrapped overflow', async () => {
  const [html, css] = await Promise.all([read('index.html'), read('styles.css')]);

  const mobile = ruleBody(css, '@media (max-width: 720px)');

  // The sticky bar is full-bleed now, so it must not be re-padded here; only
  // the footer keeps the old inline padding.
  assert.doesNotMatch(mobile, /^\s*\.site-header,\s*$/m);

  assert.match(ruleBody(mobile, '.site-header-inner'), /flex-wrap:\s*wrap/);

  const nav = ruleBody(mobile, '.site-header nav');
  assert.match(nav, /display:\s*grid/);
  assert.match(nav, /width:\s*100%/);

  // The grid is fixed-track, so its track count has to keep matching the
  // number of links — a fourth nav link would silently strand itself.
  const tracks = /grid-template-columns:([^;]+);/.exec(nav);
  assert.ok(tracks, 'mobile nav lost its explicit grid tracks');
  const trackCount = [...tracks[1].matchAll(/minmax\(/g)].length;

  const navMarkup = /<nav aria-label="Primary navigation">([\s\S]*?)<\/nav>/.exec(html);
  assert.ok(navMarkup, 'primary navigation is missing from the header');
  const navLinks = [...navMarkup[1].matchAll(/<a\b/g)].length;

  assert.equal(
    trackCount,
    navLinks,
    `mobile nav has ${trackCount} grid tracks for ${navLinks} links`,
  );

  // The CTA beats the shared nav padding on specificity, not with !important.
  // A looser `.nav-cta` selector here would silently lose to `.site-header nav a`.
  assert.match(ruleBody(mobile, '.site-header nav a.nav-cta'), /padding-inline:\s*10px/);
});

test('wins the CTA cascade on specificity rather than !important', async () => {
  const css = await read('styles.css');
  const mobile = ruleBody(css, '@media (max-width: 720px)');

  for (const body of [
    ruleBody(css, '.site-header nav a.nav-cta'),
    ruleBody(css, '.site-header nav a.nav-cta:hover'),
    ruleBody(mobile, '.site-header nav a.nav-cta'),
  ]) {
    assert.doesNotMatch(body, /!important/);
  }

  // The CTA needs a hover of its own; without one it just holds its resting
  // gradient while every other nav link lifts.
  assert.match(ruleBody(css, '.site-header nav a.nav-cta:hover'), /background:\s*linear-gradient/);
});

test('keeps the header on the same gutter as the rest of the page', async () => {
  const css = await read('styles.css');

  // A header that sets its own padding drifts out of the page grid; these have
  // to move together. Both shorthands carry the gutter as their second length.
  const gutter = (body) => {
    const match = /padding:\s*[\d.]+[a-z%]*\s+([\d.]+)px/.exec(body);
    assert.ok(match, `no horizontal padding found in rule body: ${body.trim()}`);
    return match[1];
  };

  assert.equal(gutter(ruleBody(css, '.site-header-inner')), gutter(ruleBody(css, 'main')));

  const mobile = ruleBody(css, '@media (max-width: 720px)');
  assert.equal(
    gutter(ruleBody(mobile, '.site-header-inner')),
    gutter(ruleBody(mobile, 'main')),
  );
});

test('falls back to a wrapping row where three pills cannot fit', async () => {
  const css = await read('styles.css');

  const narrow = ruleBody(css, '@media (max-width: 400px)');
  const nav = ruleBody(narrow, '.site-header nav');
  assert.match(nav, /display:\s*flex/);
  assert.match(nav, /flex-wrap:\s*wrap/);
});

test('renames every wordmark, not just the one in the header', async () => {
  const html = await read('index.html');

  assert.equal([...html.matchAll(/<span>AI Deploy<\/span>/g)].length, 2);
  assert.doesNotMatch(html, /AIDEPLOY/);
});
