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

await rm(output, { recursive: true, force: true });
await mkdir(join(output, 'vendor'), { recursive: true });
await Promise.all(publicFiles.map((file) => cp(join(root, file), join(output, file))));
await Promise.all(
  ['pretext.js', 'pretext.LICENSE'].map((file) =>
    cp(join(root, 'vendor', file), join(output, 'vendor', file)),
  ),
);
await writeFile(join(output, '.nojekyll'), '');

process.stdout.write(`Built ${publicFiles.length + 3} static files in ${output}\n`);
