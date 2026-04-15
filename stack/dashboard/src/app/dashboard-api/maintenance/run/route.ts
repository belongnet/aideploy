import { NextRequest, NextResponse } from "next/server";
import { execSync } from "child_process";
import { writeFileSync, unlinkSync, mkdirSync } from "fs";
import { join } from "path";
import { randomBytes } from "crypto";

const MAX_SCRIPT_LENGTH = 32_000;
const EXEC_TIMEOUT_MS = 120_000;
const REQUIRED_MAINTENANCE_POLICY = "ssh-equivalent";

function maintenancePolicyEnabled() {
  // This endpoint is shell-equivalent; only managed deployments whose
  // Tailscale ACLs make dashboard access match SSH access should enable it.
  return (
    (process.env.AIDEPLOY_MAINTENANCE_TAILSCALE_POLICY ?? "")
      .trim()
      .toLowerCase() === REQUIRED_MAINTENANCE_POLICY
  );
}

export async function POST(req: NextRequest) {
  if (!maintenancePolicyEnabled()) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "Maintenance patches are disabled until Tailscale policy restricts dashboard access to SSH-equivalent admins.",
      },
      { status: 403 },
    );
  }

  let body: { script?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid request body" },
      { status: 400 },
    );
  }

  const script = (body.script ?? "").trim();
  if (!script) {
    return NextResponse.json(
      { ok: false, error: "No script provided" },
      { status: 400 },
    );
  }
  if (script.length > MAX_SCRIPT_LENGTH) {
    return NextResponse.json(
      {
        ok: false,
        error: `Script too long (${script.length} chars, max ${MAX_SCRIPT_LENGTH})`,
      },
      { status: 400 },
    );
  }

  const tmpDir = "/tmp/aideploy-patches";
  const id = randomBytes(8).toString("hex");
  const scriptPath = join(tmpDir, `patch-${id}.sh`);

  try {
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(scriptPath, script, { mode: 0o755 });

    const output = execSync(`/bin/sh ${scriptPath} 2>&1`, {
      timeout: EXEC_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      encoding: "utf-8",
      env: {
        ...process.env,
        PATH: `/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${process.env.PATH ?? ""}`,
      },
    });

    return NextResponse.json({ ok: true, output: output ?? "(no output)" });
  } catch (err: unknown) {
    const execErr = err as {
      stdout?: string;
      stderr?: string;
      status?: number;
      message?: string;
    };
    const combined =
      [execErr.stdout, execErr.stderr].filter(Boolean).join("\n").trim() ||
      execErr.message ||
      "Unknown error";

    return NextResponse.json({
      ok: false,
      exitCode: execErr.status ?? 1,
      output: combined,
    });
  } finally {
    try {
      unlinkSync(scriptPath);
    } catch {
      /* ignore cleanup errors */
    }
  }
}
