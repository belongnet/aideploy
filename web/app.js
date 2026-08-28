// SPDX-License-Identifier: Apache-2.0

import {
  DEFAULT_CHOICES,
  REGIONS,
  RUNTIMES,
  buildNpxCommand,
  buildSourceCommand,
  choicesFromSearch,
  choicesToSearch,
  normalizeChoices,
} from './command.js';

const labelOf = (options, value) =>
  options.find((option) => option.value === value)?.label ?? value;

const form = document.querySelector('#command-form');
const commandOutput = document.querySelector('#command-output');
const npxOutput = document.querySelector('#npx-output');
const copyButton = document.querySelector('#copy-command');
const copyStatus = document.querySelector('#copy-status');
const runtimeSummary = document.querySelector('#summary-runtime');
const regionSummary = document.querySelector('#summary-region');

if (!(form instanceof HTMLFormElement)) throw new Error('Command form is missing.');
if (!(commandOutput instanceof HTMLElement)) throw new Error('Command output is missing.');
if (!(npxOutput instanceof HTMLElement)) throw new Error('npm command preview is missing.');
if (!(copyButton instanceof HTMLButtonElement)) throw new Error('Copy button is missing.');

function selectedChoices() {
  const values = Object.fromEntries(new FormData(form));
  return normalizeChoices(values);
}

function applyChoices(choices) {
  for (const [name, value] of Object.entries(choices)) {
    const control = form.elements.namedItem(name);
    if (control instanceof RadioNodeList) control.value = value;
    else if (control instanceof HTMLSelectElement) control.value = value;
  }
}

function render() {
  const choices = selectedChoices();
  commandOutput.textContent = buildSourceCommand(choices);
  npxOutput.textContent = buildNpxCommand(choices);
  runtimeSummary.textContent = labelOf(RUNTIMES, choices.runtime);
  regionSummary.textContent = labelOf(REGIONS, choices.region);

  const nextSearch = choicesToSearch(choices);
  if (window.location.search !== nextSearch) {
    window.history.replaceState(null, '', `${window.location.pathname}${nextSearch}${window.location.hash}`);
  }
}

async function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const fallback = document.createElement('textarea');
  fallback.value = text;
  fallback.setAttribute('readonly', '');
  fallback.style.position = 'fixed';
  fallback.style.opacity = '0';
  document.body.append(fallback);
  fallback.select();
  const copied = document.execCommand('copy');
  fallback.remove();
  if (!copied) throw new Error('Clipboard access was denied.');
}

form.addEventListener('change', render);
copyButton.addEventListener('click', async () => {
  copyButton.disabled = true;
  try {
    await copyText(commandOutput.textContent ?? '');
    copyButton.dataset.state = 'copied';
    copyButton.querySelector('[data-copy-label]').textContent = 'Copied';
    copyStatus.textContent = 'Copied. Paste it in the verified source checkout.';
  } catch {
    copyStatus.textContent = 'Copy was blocked. Select the command and copy it manually.';
  } finally {
    window.setTimeout(() => {
      copyButton.disabled = false;
      copyButton.dataset.state = '';
      copyButton.querySelector('[data-copy-label]').textContent = 'Copy command';
    }, 1800);
  }
});

applyChoices(choicesFromSearch(window.location.search || choicesToSearch(DEFAULT_CHOICES)));
render();
