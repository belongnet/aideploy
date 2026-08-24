import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { UserError } from './config.js';

/**
 * Interactive prompts (readline, injectable for tests). The README's promise
 * is "prerequisites first, then one command" — each credential prompt links
 * the exact page where the key is created.
 */
export interface PromptIO {
  ask(question: string, opts?: { secret?: boolean }): Promise<string>;
  close(): void;
}

export function makeIO(
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stderr
): PromptIO {
  let muted = false;
  const terminalOutput = new Writable({
    write(chunk, encoding, callback) {
      if (!muted) output.write(chunk, encoding as BufferEncoding);
      callback();
    },
  });
  const rl = createInterface({ input, output: terminalOutput, terminal: Boolean((input as NodeJS.ReadStream).isTTY) });
  return {
    async ask(question: string, opts: { secret?: boolean } = {}): Promise<string> {
      const secret = Boolean(opts.secret && (input as NodeJS.ReadStream).isTTY);
      if (secret) output.write(question);
      muted = secret;
      try {
        return (await rl.question(secret ? '' : question)).trim();
      } finally {
        muted = false;
        if (secret) output.write('\n');
      }
    },
    close: () => rl.close(),
  };
}

export async function askRequired(
  io: PromptIO,
  label: string,
  help: string,
  validate?: (v: string) => void,
  opts: { secret?: boolean } = {}
): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const value = await io.ask(`${label}\n  (${help})\n> `, opts);
    if (!value) continue;
    try {
      validate?.(value);
      return value;
    } catch (err) {
      if (err instanceof UserError) {
        process.stderr.write(`  ${err.message}\n`);
        continue;
      }
      throw err;
    }
  }
  throw new UserError(`Gave up after 3 attempts on: ${label}`);
}

export async function askYesNo(io: PromptIO, question: string, defaultYes: boolean): Promise<boolean> {
  const suffix = defaultYes ? '[Y/n]' : '[y/N]';
  const answer = (await io.ask(`${question} ${suffix} `)).toLowerCase();
  if (answer === '') return defaultYes;
  return answer.startsWith('y');
}

export const TELEMETRY_CONSENT_QUESTION =
  'Share one anonymous ping when this deploy finishes (version, cloud, runtime, success/fail — ' +
  'no keys, no identifiers)? It is how the project counts real deploys.';
