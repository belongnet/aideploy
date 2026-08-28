// SPDX-License-Identifier: Apache-2.0

import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const output = join(root, '.pages');
const publicFiles = [
  'index.html',
  'styles.css',
  'app.js',
  'command.js',
  'favicon.svg',
  'robots.txt',
  'sitemap.xml',
];

// Self-hosted so the page makes zero external requests. Data, not code: the
// site still executes only first-party script.
const fontFiles = [
  'inter-latin-400-normal.woff2',
  'inter-latin-500-normal.woff2',
  'inter-latin-600-normal.woff2',
  'Inter.LICENSE',
];

await rm(output, { recursive: true, force: true });
await mkdir(join(output, 'fonts'), { recursive: true });
await Promise.all(publicFiles.map((file) => cp(join(root, file), join(output, file))));
await Promise.all(
  fontFiles.map((file) => cp(join(root, 'fonts', file), join(output, 'fonts', file))),
);
await writeFile(join(output, '.nojekyll'), '');

process.stdout.write(
  `Built ${publicFiles.length + fontFiles.length + 1} static files in ${output}\n`,
);
