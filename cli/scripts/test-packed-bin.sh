#!/usr/bin/env bash
set -euo pipefail

CLI_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/aideploy-packed-bin.XXXXXX")"
cleanup() {
  rm -rf "$TEST_ROOT"
}
trap cleanup EXIT

cd "$CLI_ROOT"
TARBALL_NAME="$(npm pack --silent --pack-destination "$TEST_ROOT")"
mkdir -p "$TEST_ROOT/consumer"
cd "$TEST_ROOT/consumer"
npm init --yes >/dev/null 2>&1
npm install --ignore-scripts --no-audit --no-fund "$TEST_ROOT/$TARBALL_NAME" >/dev/null

HELP_OUTPUT="$(./node_modules/.bin/aideploy help)"
VERSION_OUTPUT="$(./node_modules/.bin/aideploy --version)"

grep -q '^aideploy —' <<<"$HELP_OUTPUT"
grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+([-.+][0-9A-Za-z.-]+)?$' <<<"$VERSION_OUTPUT"

# Exercise terminal Ctrl-C, not only process.kill(). The PTY catches readline
# behavior and npm's duplicate signal forwarding on the documented npx path.
cat >"$TEST_ROOT/signal-child.mjs" <<'NODE'
import { appendFileSync } from 'node:fs';

const signalLog = process.env.AIDEPLOY_SIGNAL_LOG;
if (!signalLog) throw new Error('AIDEPLOY_SIGNAL_LOG is required');
process.on('SIGINT', () => {
  appendFileSync(signalLog, 'SIGINT\n');
  setTimeout(() => process.exit(0), 100);
});
process.stdout.write('CHILD_READY\n');
setInterval(() => {}, 1000);
NODE

cat >"$TEST_ROOT/signal-harness.mjs" <<'NODE'
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const packageRoot = process.env.AIDEPLOY_PACKED_ROOT;
const childScript = process.env.AIDEPLOY_SIGNAL_CHILD;
if (!packageRoot || !childScript) throw new Error('packed signal fixture paths are required');
const { runWithSignals } = await import(pathToFileURL(join(packageRoot, 'dist', 'index.js')).href);
const { execCommand, InterruptedError } = await import(pathToFileURL(join(packageRoot, 'dist', 'tofu.js')).href);

const code = await runWithSignals(async (signal) => {
  try {
    await execCommand(process.execPath, [childScript], { signal, stdio: 'inherit' });
    return 0;
  } catch (error) {
    if (error instanceof InterruptedError) return error.exitCode;
    throw error;
  }
});
process.exitCode = code;
NODE

AIDEPLOY_PACKED_CONSUMER="$PWD" \
AIDEPLOY_PACKED_ROOT="$PWD/node_modules/aideploy" \
AIDEPLOY_SIGNAL_CHILD="$TEST_ROOT/signal-child.mjs" \
AIDEPLOY_SIGNAL_HARNESS="$TEST_ROOT/signal-harness.mjs" \
AIDEPLOY_SIGNAL_LOG="$TEST_ROOT/signal-count.log" \
python3 - <<'PY'
import errno
import os
import pty
import select
import shutil
import signal
import time
from pathlib import Path

consumer = os.environ['AIDEPLOY_PACKED_CONSUMER']
signal_harness = os.environ['AIDEPLOY_SIGNAL_HARNESS']
signal_log = Path(os.environ['AIDEPLOY_SIGNAL_LOG'])
env = os.environ.copy()
for key in (
    'DIGITALOCEAN_TOKEN',
    'AIDEPLOY_AI_KEY',
    'AIDEPLOY_AI_PROVIDER',
    'AIDEPLOY_TG_TOKEN',
    'AIDEPLOY_TG_USER_ID',
    'AIDEPLOY_TS_KEY',
):
    env.pop(key, None)


def read_chunk(fd):
    try:
        return os.read(fd, 4096)
    except OSError as error:
        if error.errno == errno.EIO:  # PTY reports EOF as EIO on Linux.
            return b''
        raise


def run_ctrl_c(command, ready_text, timeout_seconds=12):
    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(consumer)
        os.execvpe(command[0], command, env)

    output = bytearray()
    status = None
    deadline = time.monotonic() + timeout_seconds
    try:
        while ready_text.encode() not in output:
            if time.monotonic() >= deadline:
                raise TimeoutError(f'PTY command did not reach {ready_text!r}: {output.decode(errors="replace")}')
            ready, _, _ = select.select([fd], [], [], 0.05)
            if ready:
                chunk = read_chunk(fd)
                if chunk:
                    output.extend(chunk)
            finished, candidate = os.waitpid(pid, os.WNOHANG)
            if finished:
                status = candidate
                raise RuntimeError(f'PTY command exited before Ctrl-C: {output.decode(errors="replace")}')

        os.write(fd, b'\x03')
        while status is None:
            if time.monotonic() >= deadline:
                raise TimeoutError(f'PTY command ignored Ctrl-C: {output.decode(errors="replace")}')
            ready, _, _ = select.select([fd], [], [], 0.05)
            if ready:
                chunk = read_chunk(fd)
                if chunk:
                    output.extend(chunk)
            finished, candidate = os.waitpid(pid, os.WNOHANG)
            if finished:
                status = candidate
        while True:
            ready, _, _ = select.select([fd], [], [], 0)
            if not ready:
                break
            chunk = read_chunk(fd)
            if not chunk:
                break
            output.extend(chunk)
    finally:
        if status is None:
            try:
                os.killpg(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            _, status = os.waitpid(pid, 0)
        os.close(fd)

    return os.waitstatus_to_exitcode(status), output.decode(errors='replace')


npx = shutil.which('npx')
node = shutil.which('node')
if not npx or not node:
    raise RuntimeError('node and npx are required for the packed CLI signal smoke')

code, output = run_ctrl_c(
    [npx, '--no-install', 'aideploy', 'up', '--yes-telemetry'],
    'DigitalOcean API token',
)
if code != 130 or 'Interrupted safely' not in output or 'AbortError' in output:
    raise RuntimeError(f'npx prompt SIGINT contract failed: code={code}, output={output!r}')

code, output = run_ctrl_c([node, signal_harness], 'CHILD_READY')
signals = signal_log.read_text().splitlines() if signal_log.exists() else []
if code != 130 or signals != ['SIGINT']:
    raise RuntimeError(
        f'child process-group SIGINT contract failed: code={code}, signals={signals!r}, output={output!r}'
    )
PY
printf 'Packed npm bin executed successfully (%s).\n' "$VERSION_OUTPUT"
printf 'Packed npx and child process groups handle terminal SIGINT safely (exit 130).\n'
