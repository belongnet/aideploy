import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { execFile } from "node:child_process";

const SECRETS_ROOT =
  process.env.AIDEPLOY_RUNTIME_SECRETS_ROOT || "/run/aideploy-secrets";
const HOME_ROOT = process.env.AIDEPLOY_HOME_ROOT || "/home/aideploy";

const RUNTIME_AUTH_PROFILES = `${SECRETS_ROOT}/default/.openclaw/agents/main/agent/auth-profiles.json`;
const SOURCE_AUTH_PROFILES = `${HOME_ROOT}/.openclaw/agents/main/agent/auth-profiles.json`;

export interface AuthProfile {
  provider: string;
  authType: string;
  updatedAt: string;
  apiKey?: string;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: string;
}

export interface AuthProfileStore {
  version: number;
  profiles: Record<string, AuthProfile>;
}

export async function readAuthProfiles(): Promise<AuthProfileStore> {
  for (const path of [RUNTIME_AUTH_PROFILES, SOURCE_AUTH_PROFILES]) {
    try {
      const raw = await readFile(path, "utf-8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.profiles === "object") {
        return parsed as AuthProfileStore;
      }
    } catch {
      // try next path
    }
  }
  return { version: 1, profiles: {} };
}

export async function writeAuthProfiles(
  store: AuthProfileStore,
): Promise<void> {
  const json = JSON.stringify(store, null, 2);
  for (const path of [RUNTIME_AUTH_PROFILES, SOURCE_AUTH_PROFILES]) {
    try {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, json, { mode: 0o600 });
    } catch {
      // best effort for source path
    }
  }
}

export async function restartGateway(): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      "docker",
      ["restart", "openclaw-gateway"],
      { timeout: 30_000 },
      (error) => {
        if (error) reject(error);
        else resolve();
      },
    );
  });
}
