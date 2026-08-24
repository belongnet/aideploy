import { NextRequest, NextResponse } from "next/server";
import { execFileSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { timingSafeEqual } from "crypto";
import { readJsonBody, requestBodyErrorResponse } from "@/lib/request-body";

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

function constantTimeEqual(provided: string, expected: string) {
  if (!provided || !expected) return false;
  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);
  if (providedBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(providedBuffer, expectedBuffer);
}

function bearerToken(req: NextRequest) {
  const value = req.headers.get("authorization")?.trim() ?? "";
  return value.toLowerCase().startsWith("bearer ") ? value.slice(7).trim() : "";
}

function maintenanceAuthorized(req: NextRequest) {
  const maintenanceToken = process.env.AIDEPLOY_MAINTENANCE_TOKEN?.trim() ?? "";

  if (!maintenanceToken) return false;

  const headerTokens = [
    req.headers.get("x-aideploy-maintenance-token")?.trim() ?? "",
    bearerToken(req),
  ];

  return headerTokens.some((token) => constantTimeEqual(token, maintenanceToken));
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

  if (!maintenanceAuthorized(req)) {
    return NextResponse.json(
      {
        ok: false,
        error: "A dedicated maintenance token is required.",
      },
      { status: 401 },
    );
  }

  let body: { script?: string };
  try {
    body = await readJsonBody(req);
  } catch (error) {
    const bodyError = requestBodyErrorResponse(error);
    if (bodyError) return bodyError;

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

  const tmpDir = mkdtempSync(join(tmpdir(), "aideploy-patch-"));
  const scriptPath = join(tmpDir, "patch.sh");

  try {
    writeFileSync(scriptPath, script, { mode: 0o755 });

    const output = execFileSync("/bin/sh", [scriptPath], {
      timeout: EXEC_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
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
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore cleanup errors */
    }
  }
}
