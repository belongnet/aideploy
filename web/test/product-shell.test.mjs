// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readFile(join(webRoot, file), 'utf8');

test('uses the AI Deploy product shell and keeps the hosted path connected', async () => {
  const [html, css] = await Promise.all([read('index.html'), read('styles.css')]);

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

  assert.match(css, /\.site-header\s*\{[\s\S]*position: sticky/);
  assert.match(css, /\.site-header-inner\s*\{[\s\S]*max-width: var\(--shell\)/);
  assert.match(css, /\.site-header nav a\s*\{[\s\S]*min-height: 44px/);
});
