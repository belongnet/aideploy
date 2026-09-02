// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
  // The exact region set is pinned to the CLI's fallback catalog by its own
  // test; duplicating the list here would just be a second thing to forget.
  assert.ok(REGIONS.length >= 8, 'region catalog looks truncated');
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

test('offers only regions the CLI will still accept when its API is down', async () => {
  const validate = await read('cli/src/validate.ts');
  const fallback = validate.match(/FALLBACK_REGIONS = \[([^\]]+)\]/);
  assert.ok(fallback, 'could not read FALLBACK_REGIONS from cli/src/validate.ts');
  const cliRegions = [...fallback[1].matchAll(/'([a-z0-9]+)'/g)].map((m) => m[1]);

  // The CLI prefers the account's live DigitalOcean catalog but falls back to
  // this fixed list when the API is unreachable. Publishing a region the
  // fallback lacks hands the user a command their own CLI rejects.
  assert.deepEqual(
    REGIONS.map(({ value }) => value).sort(),
    [...cliRegions].sort(),
    'web region list drifted from the CLI fallback catalog',
  );

  const html = await read('web/index.html');
  for (const { value } of REGIONS) assert.match(html, new RegExp(`value="${value}"`));
  const offered = [...html.matchAll(/<option value="([a-z0-9]+)"/g)].map((m) => m[1]);
  assert.deepEqual(offered.sort(), [...cliRegions].sort(), 'markup drifted from the catalog');
});

test('refuses to show a copyable command when framed or when JS is off', async () => {
  const [html, app, css] = await Promise.all([
    read('web/index.html'),
    read('web/app.js'),
    read('web/styles.css'),
  ]);

  // GitHub Pages cannot send `frame-ancestors` and a <meta> CSP cannot express
  // it, so framing is refused in script and enforced in CSS.
  assert.match(app, /window\.top !== window\.self/);
  assert.match(app, /dataset\.framed = 'true'/);
  assert.match(css, /\[data-framed='true'\][\s\S]*?\.copy-button/);
  // The warning is a real element, not ::after content: a pseudo-element is
  // invisible to assistive tech and vanishes with the stylesheet.
  assert.match(html, /class="framed-warning"/);
  assert.match(css, /\[data-framed='true'\] \.framed-warning/);

  // Without JS the controls would still move while the command stayed frozen
  // at the default, so the command is hidden until this script proves it ran.
  assert.match(html, /<html lang="en" class="no-js">/);
  assert.match(app, /classList\.remove\('no-js'\)/);
  for (const hidden of ['.no-js .terminal', '.no-js .copy-button']) {
    assert.ok(css.includes(hidden), `styles.css is missing ${hidden}`);
  }
  assert.match(html, /class="noscript-warning"/);

  // An inline <style> would need style-src 'unsafe-inline'; the class does not.
  assert.match(html, /style-src 'self'/);
  assert.doesNotMatch(html, /<style/);
});

test('self-hosts its fonts and pins them to recorded provenance', async () => {
  const provenance = await read('web/fonts/PROVENANCE');
  const expected = {
    'inter-latin-400-normal.woff2':
      '8909904ab6c872eb994093482a88a28eca2cd95912d7b6fecd72103b0dc07edc',
    'inter-latin-500-normal.woff2':
      'f3779f1efccc4bdcdf9c0a02ab95bf6bd092ed09c48c08cedc725889edd1d19f',
    'inter-latin-600-normal.woff2':
      'f9a06e79cd3a2a20951c0f0e28f66dd0e6d3fda73911d640a2125c8fcb78f21a',
  };

  for (const [file, digest] of Object.entries(expected)) {
    const bytes = await readFile(join(repoRoot, 'web/fonts', file));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), digest, `${file} changed`);
    assert.ok(provenance.includes(digest), `PROVENANCE is missing the digest for ${file}`);
  }

  // Every @font-face must resolve to this origin, or the page starts making
  // the external request its own copy says it never makes.
  const css = await read('web/styles.css');
  const sources = [...css.matchAll(/src:\s*url\('([^']+)'\)/g)].map((m) => m[1]);
  assert.equal(sources.length, Object.keys(expected).length);
  for (const src of sources) assert.match(src, /^\.\/fonts\//);
  assert.doesNotMatch(css, /@import|https?:\/\//);
  assert.match(await read('NOTICE'), /Inter \(https:\/\/github\.com\/rsms\/inter\)/);
});

test('pins the custom domain that serves the page', async () => {
  const cname = (await read('web/CNAME')).trim();

  // GitHub Pages reads the custom domain from this file in the deployed
  // artifact. Drop it and a deploy resets the site to belongnet.github.io,
  // which every canonical, OG url and README link below would then contradict.
  assert.equal(cname, 'build.aideploy.co');
  assert.doesNotMatch(cname, /\s/, 'CNAME must be a bare hostname');

  const [html, robots, sitemap, readme] = await Promise.all([
    read('web/index.html'),
    read('web/robots.txt'),
    read('web/sitemap.xml'),
    read('README.md'),
  ]);

  for (const [label, text] of [
    ['index.html', html],
    ['robots.txt', robots],
    ['sitemap.xml', sitemap],
    ['README.md', readme],
  ]) {
    assert.ok(
      !text.includes('belongnet.github.io/aideploy'),
      `${label} still points at the pre-custom-domain host`
    );
  }

  assert.match(html, /<link rel="canonical" href="https:\/\/build\.aideploy\.co\/" \/>/);
  assert.match(html, /property="og:url" content="https:\/\/build\.aideploy\.co\/"/);
  assert.match(sitemap, /<loc>https:\/\/build\.aideploy\.co\/<\/loc>/);
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
  assert.match(build, /const fontFiles = \[/);
  for (const font of ['inter-latin-400-normal', 'Inter.LICENSE']) {
    assert.ok(build.includes(font), `build.mjs does not ship ${font}`);
  }
  for (const file of ['CNAME', 'index.html', 'styles.css', 'app.js', 'command.js', 'favicon.svg']) {
    assert.match(build, new RegExp(`'${file.replace('.', '\\.')}[^']*'`));
  }
  assert.doesNotMatch(build, /cp\(root, output/);
});
