import { PassThrough } from 'node:stream';
import { jest } from '@jest/globals';
import { askRequired, makeIO, PromptIO } from '../src/prompts.js';

describe('secret prompts', () => {
  it('passes the secret flag through retries', async () => {
    const ask = jest.fn(async () => 'secret-value');
    const io: PromptIO = { ask, close: () => {} };
    await expect(askRequired(io, 'API key', 'provider dashboard', undefined, { secret: true })).resolves.toBe('secret-value');
    expect(ask).toHaveBeenCalledWith(expect.stringContaining('API key'), { secret: true });
  });

  it('does not echo a secret entered on a TTY', async () => {
    const input = new PassThrough() as PassThrough & { isTTY: boolean };
    input.isTTY = true;
    const output = new PassThrough();
    let rendered = '';
    output.on('data', (chunk) => (rendered += String(chunk)));
    const io = makeIO(input, output);
    const answer = io.ask('Secret: ', { secret: true });
    input.write('do-not-echo-me\n');
    await expect(answer).resolves.toBe('do-not-echo-me');
    io.close();
    expect(rendered).toContain('Secret: ');
    expect(rendered).not.toContain('do-not-echo-me');
  });
});
