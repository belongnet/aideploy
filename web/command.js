// SPDX-License-Identifier: Apache-2.0

export const CLOUDS = Object.freeze([
  { value: 'do', label: 'DigitalOcean', deployable: true },
]);

export const RUNTIMES = Object.freeze([
  { value: 'hermes', label: 'Hermes Agent' },
  { value: 'openclaw', label: 'OpenClaw' },
]);

// These are the CLI's deliberately small offline fallback set. The CLI checks
// the signed-in account's live DigitalOcean catalog before creating anything.
export const REGIONS = Object.freeze([
  { value: 'nyc3', label: 'New York 3', area: 'United States' },
  { value: 'nyc1', label: 'New York 1', area: 'United States' },
  { value: 'sfo3', label: 'San Francisco 3', area: 'United States' },
  { value: 'tor1', label: 'Toronto 1', area: 'Canada' },
  { value: 'ams3', label: 'Amsterdam 3', area: 'Netherlands' },
  { value: 'lon1', label: 'London 1', area: 'United Kingdom' },
  { value: 'fra1', label: 'Frankfurt 1', area: 'Germany' },
  { value: 'blr1', label: 'Bangalore 1', area: 'India' },
  { value: 'sgp1', label: 'Singapore 1', area: 'Singapore' },
  { value: 'syd1', label: 'Sydney 1', area: 'Australia' },
]);

export const CHANNELS = Object.freeze([
  { value: 'telegram', label: 'Telegram' },
]);

export const DEFAULT_CHOICES = Object.freeze({
  cloud: 'do',
  runtime: 'hermes',
  region: 'nyc3',
  channel: 'telegram',
});

const allowed = Object.freeze({
  cloud: new Set(CLOUDS.map(({ value }) => value)),
  runtime: new Set(RUNTIMES.map(({ value }) => value)),
  region: new Set(REGIONS.map(({ value }) => value)),
  channel: new Set(CHANNELS.map(({ value }) => value)),
});

function validatedChoice(name, value) {
  if (!allowed[name]?.has(value)) {
    throw new TypeError(`Unsupported ${name} choice.`);
  }
  return value;
}

export function normalizeChoices(input = {}) {
  return Object.fromEntries(
    Object.entries(DEFAULT_CHOICES).map(([name, fallback]) => {
      const candidate = input[name];
      return [name, allowed[name].has(candidate) ? candidate : fallback];
    }),
  );
}

function choiceFlags(input) {
  const choices = {
    cloud: validatedChoice('cloud', input.cloud),
    runtime: validatedChoice('runtime', input.runtime),
    region: validatedChoice('region', input.region),
    channel: validatedChoice('channel', input.channel),
  };
  return [
    '--cloud',
    choices.cloud,
    '--runtime',
    choices.runtime,
    '--region',
    choices.region,
    '--channel',
    choices.channel,
    '--no-telemetry',
  ].join(' ');
}

/** The working command after completing the repository's verified source setup. */
export function buildSourceCommand(input = DEFAULT_CHOICES) {
  return `node cli/dist/index.js up ${choiceFlags(input)}`;
}

/** Preview of the package command; npm publication is not enabled yet. */
export function buildNpxCommand(input = DEFAULT_CHOICES) {
  return `npx aideploy up ${choiceFlags(input)}`;
}

export function choicesFromSearch(search) {
  const params = new URLSearchParams(search);
  return normalizeChoices({
    cloud: params.get('cloud'),
    runtime: params.get('runtime'),
    region: params.get('region'),
    channel: params.get('channel'),
  });
}

export function choicesToSearch(input) {
  const choices = normalizeChoices(input);
  const params = new URLSearchParams();
  for (const name of Object.keys(DEFAULT_CHOICES)) params.set(name, choices[name]);
  return `?${params.toString()}`;
}
