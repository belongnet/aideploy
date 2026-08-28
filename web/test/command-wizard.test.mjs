// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CHANNELS,
  CLOUDS,
  DEFAULT_CHOICES,
  REGIONS,
  RUNTIMES,
  buildNpxCommand,
  buildSourceCommand,
  choicesFromSearch,
  choicesToSearch,
} from '../command.js';

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(webRoot, '..');
const read = (path) => readFile(join(repoRoot, path), 'utf8');

test('builds a working, explicit command for the verified source checkout', () => {
  assert.equal(
    buildSourceCommand(DEFAULT_CHOICES),
    'node cli/dist/index.js up --cloud do --runtime hermes --region nyc3 --channel telegram --no-telemetry',
  );
  assert.equal(
    buildNpxCommand(DEFAULT_CHOICES),
    'npx aideploy up --cloud do --runtime hermes --region nyc3 --channel telegram --no-telemetry',
  );
});

test('accepts every published choice and rejects anything outside the allowlists', () => {
  for (const cloud of CLOUDS) {
    for (const runtime of RUNTIMES) {
      for (const region of REGIONS) {
        for (const channel of CHANNELS) {
          const command = buildSourceCommand({
            cloud: cloud.value,
            runtime: runtime.value,
            region: region.value,
            channel: channel.value,
          });
          assert.match(command, new RegExp(`--runtime ${runtime.value}`));
          assert.match(command, new RegExp(`--region ${region.value}`));
        }
      }
    }
  }

  assert.throws(
    () => buildSourceCommand({ ...DEFAULT_CHOICES, runtime: 'unsupported-runtime' }),
    /Unsupported runtime choice/,
  );
  assert.throws(
    () => buildSourceCommand({ ...DEFAULT_CHOICES, region: 'nyc3 extra-argument' }),
    /Unsupported region choice/,
  );
});

test('round-trips shareable choice URLs and fails closed to defaults', () => {
  const selected = { cloud: 'do', runtime: 'openclaw', region: 'fra1', channel: 'telegram' };
  assert.deepEqual(choicesFromSearch(choicesToSearch(selected)), selected);
  assert.deepEqual(
    choicesFromSearch('?cloud=unknown&runtime=unknown&region=unknown&channel=unknown'),
    DEFAULT_CHOICES,
  );
});

test('contains choices only and disables outbound data paths in the page policy', async () => {
  const [html, app] = await Promise.all([read('web/index.html'), read('web/app.js')]);

  assert.doesNotMatch(html, /<input[^>]+type=["'](?:password|text|email|hidden)["']/i);
  assert.doesNotMatch(html, /name=["'][^"']*(?:token|secret|key|password|credential)/i);
  assert.match(html, /connect-src 'none'/);
  assert.match(html, /No secrets enter this page/);
  assert.match(html, /No credential fields\. No analytics\. No network requests\./);
  assert.match(html, /Not published yet/);
  assert.match(html, /verified source setup/);

  assert.doesNotMatch(app, /\bfetch\s*\(/);
  assert.doesNotMatch(app, /\b(?:XMLHttpRequest|WebSocket|EventSource|sendBeacon)\b/);
  assert.doesNotMatch(app, /\b(?:localStorage|sessionStorage|indexedDB)\b/);
});

test('documents the public support boundary instead of emitting hosted-only flags', async () => {
  const html = await read('web/index.html');
  assert.deepEqual(CLOUDS.map(({ value }) => value), ['do']);
  assert.deepEqual(CHANNELS.map(({ value }) => value), ['telegram']);
  assert.deepEqual(RUNTIMES.map(({ value }) => value), ['hermes', 'openclaw']);
  assert.deepEqual(
    REGIONS.map(({ value }) => value),
    ['nyc3', 'nyc1', 'sfo3', 'tor1', 'ams3', 'lon1', 'fra1', 'blr1', 'sgp1', 'syd1'],
  );
  assert.match(html, /Hosted wizard adds/);
  assert.match(html, /Hosted channels/);
  assert.doesNotMatch(buildSourceCommand(DEFAULT_CHOICES), /(?:ovh|aws|gcp|azure|whatsapp|slack)/);
});

test('uses immutable Node 24-native GitHub Pages actions and least-privilege deploy permissions', async () => {
  const workflow = await read('.github/workflows/pages.yml');
  const externalActions = [...workflow.matchAll(/uses:\s+([^\s#]+)/g)].map((match) => match[1]);

  assert.deepEqual(externalActions, [
    'actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd',
    'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
    'actions/configure-pages@45bfe0192ca1faeb007ade9deae92b16b8254a0d',
    'actions/upload-pages-artifact@fc324d3547104276b827a68afc52ff2a11cc49c9',
    'actions/deploy-pages@cd2ce8fcbc39b97be8ca5fce6e763baed58fa128',
  ]);
  assert.ok(externalActions.every((action) => /@[a-f0-9]{40}$/.test(action)));
  assert.match(workflow, /permissions: \{\}/);
  assert.match(workflow, /github\.event_name != 'pull_request' && github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /pages: write/);
  assert.match(workflow, /id-token: write/);
  assert.match(workflow, /path: web\/\.pages/);
});

test('wires every element and form control the page script reads', async () => {
  const [html, app] = await Promise.all([read('web/index.html'), read('web/app.js')]);

  // Every `#id` app.js queries must exist in the markup. app.js throws at boot
  // when one is missing, so an id renamed in only one file kills the builder.
  const queried = [...app.matchAll(/querySelector(?:All)?\('#([a-z0-9-]+)'\)/g)].map((m) => m[1]);
  assert.ok(queried.length >= 7, `expected app.js to query ids, found ${queried.length}`);
  for (const id of new Set(queried)) {
    assert.match(html, new RegExp(`id="${id}"`), `index.html is missing #${id}`);
  }

  // Attribute hooks the copy button depends on.
  for (const attribute of ['data-copy-label']) {
    assert.match(app, new RegExp(`\\[${attribute}\\]`));
    assert.match(html, new RegExp(`${attribute}\\b`), `index.html is missing [${attribute}]`);
  }

  // FormData keys must match the choice names, or normalizeChoices silently
  // falls back to defaults and the form stops driving the command.
  for (const name of Object.keys(DEFAULT_CHOICES)) {
    assert.match(html, new RegExp(`name="${name}"`), `index.html is missing name="${name}"`);
  }

  // The summary labels come from the exported catalogs, not a second copy.
  assert.match(app, /labelOf\(RUNTIMES, choices\.runtime\)/);
  assert.match(app, /labelOf\(REGIONS, choices\.region\)/);
  for (const { label } of [...RUNTIMES, ...REGIONS]) assert.doesNotMatch(app, new RegExp(`'${label}'`));
});

test('offers exactly the catalog choices in the markup, with no drift either way', async () => {
  const html = await read('web/index.html');
  const radioValues = (name) =>
    [...html.matchAll(new RegExp(`name="${name}" value="([a-z0-9-]+)"`, 'g'))].map((m) => m[1]);
  const select = html.match(/<select[^>]+name="region"[\s\S]*?<\/select>/)?.[0] ?? '';
  const optionValues = [...select.matchAll(/<option value="([a-z0-9-]+)"/g)].map((m) => m[1]);

  // A catalog entry with no control is unreachable; a control with no catalog
  // entry fails closed to the default, so the form silently stops working.
  assert.deepEqual(radioValues('cloud'), CLOUDS.map(({ value }) => value));
  assert.deepEqual(radioValues('runtime'), RUNTIMES.map(({ value }) => value));
  assert.deepEqual(radioValues('channel'), CHANNELS.map(({ value }) => value));
  assert.deepEqual(optionValues, REGIONS.map(({ value }) => value));

  // Exactly one preselected control per group, matching the documented defaults.
  for (const [name, value] of Object.entries(DEFAULT_CHOICES)) {
    if (name === 'region') {
      assert.match(select, new RegExp(`<option value="${value}"[^>]*selected`));
      assert.equal(select.match(/selected/g)?.length, 1);
      continue;
    }
    const checked = [...html.matchAll(new RegExp(`name="${name}" value="([a-z0-9-]+)" checked`, 'g'))];
    assert.deepEqual(checked.map((m) => m[1]), [value]);
  }
});

test('executes no third-party code on the published page', async () => {
  const [html, build] = await Promise.all([read('web/index.html'), read('web/build.mjs')]);

  // Every script the page loads must be one of our own first-party files.
  // A vendored bundle here would be executable third-party code on a public
  // page whose whole claim is a minimal, auditable surface.
  const scriptSrcs = [...html.matchAll(/<script[^>]+src=["']([^"']+)["']/g)].map((m) => m[1]);
  assert.deepEqual(scriptSrcs, ['./app.js']);
  assert.doesNotMatch(html, /<script[^>]*>[^<]*\S[^<]*<\/script>/, 'no inline script');
  assert.doesNotMatch(html, /https?:\/\/[^"']*\.(?:js|css)\b/, 'no remote script or style');

  assert.equal(existsSync(join(repoRoot, 'web/vendor')), false, 'web/vendor must not return');
  assert.doesNotMatch(build, /vendor/);
  assert.doesNotMatch(await read('NOTICE'), /web\/vendor/);
});

test('ships only the explicit static-site allowlist', async () => {
  const build = await read('web/build.mjs');
  assert.match(build, /const publicFiles = \[/);
  for (const file of ['index.html', 'styles.css', 'app.js', 'command.js', 'favicon.svg']) {
    assert.match(build, new RegExp(`'${file.replace('.', '\\.')}[^']*'`));
  }
  assert.doesNotMatch(build, /cp\(root, output/);
});
