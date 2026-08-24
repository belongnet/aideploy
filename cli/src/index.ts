#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFileSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  UserError,
  VALID_CHANNELS,
  VALID_CLOUDS,
  VALID_RUNTIMES,
  assertNodeVersion,
} from './config.js';
import { assertCredentialShapes } from './validate.js';
import { up } from './deploy.js';
import { down } from './down.js';
import { doctor } from './doctor.js';
import { TELEMETRY_CONSENT_QUESTION, askRequired, askYesNo, makeIO } from './prompts.js';

function cliVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')
    );
    return String(pkg.version ?? '0.0.0');
  } catch {
    return '0.0.0';
  }
}

const HELP = `aideploy — production deployment kit for OpenClaw and Hermes agents, on your own cloud

Usage:
  aideploy up   [--cloud do] [--runtime openclaw|hermes] [--region nyc3] [--size s-2vcpu-4gb]
                [--channel telegram] [--deploy-id adp-xxxx] [--yes-telemetry|--no-telemetry]
  aideploy down <deploy-id>
  DIGITALOCEAN_TOKEN=... aideploy doctor

Prerequisites for \`up\` (have these 4 ready — creating them takes ~10 minutes):
  1. DigitalOcean API token (read+write)  https://cloud.digitalocean.com/account/api/tokens
  2. AI provider API key (OpenAI, Anthropic, or Kimi)
  3. Telegram bot token + your account ID  @BotFather -> /newbot, @userinfobot -> /start
  4. One-off Tailscale auth key (Reusable off) + signed-in device
     https://login.tailscale.com/admin/settings/keys

Zero-setup alternative: the hosted wizard deploys with 3 OAuth logins, no API keys —
https://www.aideploy.co/?utm_source=cli&utm_medium=help
`;

function withArgumentErrors<T>(parse: () => T): T {
  try {
    return parse();
  } catch (err) {
    const parseError = err as { code?: unknown; message?: unknown; name?: unknown };
    if (
      (typeof parseError.code === 'string' && parseError.code.startsWith('ERR_PARSE_ARGS_')) ||
      parseError.name === 'TypeError'
    ) {
      throw new UserError(
        `Invalid command arguments: ${String(parseError.message ?? 'unable to parse options')}. ` +
          'Run `aideploy help` for usage.'
      );
    }
    throw err;
  }
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  try {
    assertNodeVersion();
    const command = argv[0];
    if (!command || command === 'help' || command === '--help' || command === '-h') {
      process.stdout.write(HELP);
      return 0;
    }
    if (command === '--version' || command === 'version') {
      process.stdout.write(`${cliVersion()}\n`);
      return 0;
    }
    if (command === 'up') return await cmdUp(argv.slice(1));
    if (command === 'down') return await cmdDown(argv.slice(1));
    if (command === 'doctor') return await cmdDoctor(argv.slice(1));
    throw new UserError(`Unknown command "${command}". Run \`aideploy help\`.`);
  } catch (err) {
    if (err instanceof UserError) {
      process.stderr.write(`\nError: ${err.message}\n`);
      return 1;
    }
    throw err;
  }
}

async function cmdUp(rest: string[]): Promise<number> {
  const { values } = withArgumentErrors(() =>
    parseArgs({
      args: rest,
      options: {
        cloud: { type: 'string', default: 'do' },
        runtime: { type: 'string', default: 'openclaw' },
        region: { type: 'string', default: 'nyc3' },
        size: { type: 'string' },
        channel: { type: 'string', default: 'telegram' },
        'deploy-id': { type: 'string' },
        'yes-telemetry': { type: 'boolean', default: false },
        'no-telemetry': { type: 'boolean', default: false },
      },
    })
  );
  const cloud = values.cloud as string;
  const runtime = values.runtime as string;
  const channel = values.channel as string;
  if (!VALID_CLOUDS.includes(cloud as any)) {
    throw new UserError(`Cloud "${cloud}" is not supported by the CLI yet (golden path: do). AWS/GCP/Azure are community-supported via the terraform/ modules directly.`);
  }
  if (!VALID_RUNTIMES.includes(runtime as any)) {
    throw new UserError(`Runtime "${runtime}" unknown — choose openclaw or hermes.`);
  }
  if (!VALID_CHANNELS.includes(channel as any)) {
    throw new UserError(`Channel "${channel}" is not in the golden path yet — start with telegram.`);
  }

  const io = makeIO();
  try {
    // Env fallbacks make the CLI scriptable (CI live E2E, power users):
    // DIGITALOCEAN_TOKEN, AIDEPLOY_AI_KEY (+AIDEPLOY_AI_PROVIDER),
    // AIDEPLOY_TG_TOKEN, AIDEPLOY_TG_USER_ID, AIDEPLOY_TS_KEY.
    process.stderr.write('\naideploy up — 4 credentials, then one deploy. Ctrl-C anytime; nothing is created until all prompts pass.\n\n');
    const doToken =
      process.env.DIGITALOCEAN_TOKEN ??
      (await askRequired(io, 'DigitalOcean API token', 'cloud.digitalocean.com/account/api/tokens', (v) =>
        assertCredentialShapes({ doToken: v, telegramBotToken: '0'.repeat(9) + ':' + 'A'.repeat(35), telegramUserId: '123456789', aiApiKey: 'x'.repeat(24), tailscaleAuthKey: 'tskey-auth-placeholder' }),
        { secret: true }
      ));
    const providerFromEnv = process.env.AIDEPLOY_AI_PROVIDER;
    if (providerFromEnv && !['openai', 'anthropic', 'kimi'].includes(providerFromEnv)) {
      throw new UserError('AIDEPLOY_AI_PROVIDER must be openai, anthropic, or kimi.');
    }
    const aiProvider: 'openai' | 'anthropic' | 'kimi' = providerFromEnv
      ? (providerFromEnv as 'openai' | 'anthropic' | 'kimi')
      : (await askYesNo(io, 'Use OpenAI as the AI provider?', true))
        ? 'openai'
        : (await askYesNo(io, 'Use Kimi as the AI provider? (No = Anthropic)', true))
          ? 'kimi'
          : 'anthropic';
    const aiApiKey =
      process.env.AIDEPLOY_AI_KEY ??
      (await askRequired(
        io,
        `${aiProvider === 'openai' ? 'OpenAI' : aiProvider === 'kimi' ? 'Kimi' : 'Anthropic'} API key`,
        'from your AI provider dashboard',
        undefined,
        { secret: true }
      ));
    const telegramBotToken =
      process.env.AIDEPLOY_TG_TOKEN ??
      (await askRequired(io, 'Telegram bot token', 'message @BotFather, /newbot', (v) =>
        assertCredentialShapes({ doToken: 'dop_v1_' + 'a'.repeat(64), telegramBotToken: v, telegramUserId: '123456789', aiApiKey: 'x'.repeat(24), tailscaleAuthKey: 'tskey-auth-placeholder' }),
        { secret: true }
      ));
    const telegramUserId =
      process.env.AIDEPLOY_TG_USER_ID ??
      (await askRequired(
        io,
        'Your numeric Telegram account ID',
        'send /start to @userinfobot, then copy the number',
        (v) =>
          assertCredentialShapes({
            doToken: 'dop_v1_' + 'a'.repeat(64),
            telegramBotToken: '0'.repeat(9) + ':' + 'A'.repeat(35),
            telegramUserId: v,
            aiApiKey: 'x'.repeat(24),
            tailscaleAuthKey: 'tskey-auth-placeholder',
          })
      ));
    const tailscaleAuthKey =
      process.env.AIDEPLOY_TS_KEY ??
      (await askRequired(io, 'One-off Tailscale auth key (Reusable off)', 'login.tailscale.com/admin/settings/keys', (v) =>
        assertCredentialShapes({ doToken: 'dop_v1_' + 'a'.repeat(64), telegramBotToken: '0'.repeat(9) + ':' + 'A'.repeat(35), telegramUserId: '123456789', aiApiKey: 'x'.repeat(24), tailscaleAuthKey: v }),
        { secret: true }
      ));
    assertCredentialShapes({ doToken, telegramBotToken, telegramUserId, aiApiKey, tailscaleAuthKey });

    let consent: boolean;
    if (values['yes-telemetry']) consent = true;
    else if (values['no-telemetry']) consent = false;
    else consent = await askYesNo(io, TELEMETRY_CONSENT_QUESTION, true);

    const result = await up(
      {
        cloud: cloud as 'do',
        runtime: runtime as 'openclaw' | 'hermes',
        region: values.region as string,
        size: values.size as string | undefined,
        channel: channel as 'telegram',
        deployId: values['deploy-id'] as string | undefined,
        telemetryConsent: consent,
        cliVersion: cliVersion(),
      },
      { doToken, aiApiKey, aiProvider, telegramBotToken, telegramUserId, tailscaleAuthKey }
    );

    const completionLines = [
        '',
        `✔ Deploy ${result.deployId} complete${result.resumed ? ' (resumed)' : ''}.`,
        result.browserSignInUrl
          ? `  Browser sign-in: ${result.browserSignInUrl} (private via Tailscale HTTPS)`
          : '  Dashboard: check `aideploy doctor` for the VM IP.',
        '  Test it:  open Telegram, message your bot: "hello"',
        runtime === 'openclaw'
          ? `  Logs:     tailscale ssh root@${result.tailscaleHostname ?? '<hostname>'}, then: docker logs -f aideploy-openclaw`
          : `  Logs:     tailscale ssh root@${result.tailscaleHostname ?? '<hostname>'}, then: journalctl -u hermes-gateway -f`,
      ];
    if (runtime === 'hermes') {
      completionLines.push(
        `  Browser email:    ${result.hermesWebuiOwnerEmail}`,
        `  Browser password: ${result.hermesWebuiOwnerPassword}`,
        `  Saved privately:  ${result.accessFile}`
      );
    } else {
      completionLines.push(`  Saved privately:  ${result.accessFile}`);
    }
    completionLines.push(`  Teardown: npx aideploy@${cliVersion()} down ${result.deployId}`, '');
    process.stdout.write(completionLines.join('\n'));
    return 0;
  } finally {
    io.close();
  }
}

async function cmdDown(rest: string[]): Promise<number> {
  const deployId = rest[0];
  if (!deployId || rest.length !== 1) throw new UserError('Usage: aideploy down <deploy-id>');
  await down(deployId, { cliVersion: cliVersion() });
  return 0;
}

async function cmdDoctor(rest: string[]): Promise<number> {
  if (rest.length !== 0) {
    throw new UserError('Usage: DIGITALOCEAN_TOKEN=... aideploy doctor (tokens are never accepted on the command line).');
  }
  await doctor(process.env.DIGITALOCEAN_TOKEN);
  return 0;
}

export function isDirectExecution(moduleUrl: string, argvPath: string | undefined): boolean {
  if (!argvPath) return false;
  try {
    // npm exposes package bins through symlinks. Resolve argv[1] so the
    // installed `aideploy` command and direct `node dist/index.js` both run.
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(argvPath);
  } catch {
    return false;
  }
}

// Only run when executed directly (not when imported by tests).
if (isDirectExecution(import.meta.url, process.argv[1])) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(err);
      process.exit(1);
    }
  );
}
