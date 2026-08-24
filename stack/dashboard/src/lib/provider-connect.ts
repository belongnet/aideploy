import { pathToFileURL } from "node:url";
import {
  readAuthProfilesForUpdate,
  writeAuthProfiles,
  ensureModelForProvider,
  restartGateway,
} from "@/lib/openclaw-runtime";

type ProviderId = "openai" | "anthropic";

type SessionStatus =
  | "idle"
  | "running"
  | "awaiting_input"
  | "completed"
  | "error"
  | "cancelled";

interface ConnectSessionInternal {
  id: string;
  provider: ProviderId;
  status: SessionStatus;
  url: string;
  logs: string;
  inputLabel: string;
  inputPlaceholder: string;
  startedAt: number;
  finishedAt: number;
  pendingInputs: string[];
  resolveInput: ((value: string) => void) | null;
  rejectInput: ((reason?: unknown) => void) | null;
  cancelled: boolean;
  runPromise: Promise<void> | null;
}

export interface ConnectSessionSnapshot {
  id: string;
  provider: ProviderId;
  status: SessionStatus;
  url: string;
  logs: string;
  inputLabel: string;
  inputPlaceholder: string;
  startedAt: number;
  finishedAt: number;
}

const OAUTH_MODULE_CANDIDATES = [
  process.env.AIDEPLOY_PI_AI_OAUTH_MODULE || "",
  "@mariozechner/pi-ai/dist/utils/oauth/index.js",
  "/app/node_modules/@mariozechner/pi-ai/dist/utils/oauth/index.js",
  "/usr/lib/node_modules/openclaw/node_modules/@mariozechner/pi-ai/dist/utils/oauth/index.js",
  "@mariozechner/pi-ai/dist/oauth.js",
  "/app/node_modules/@mariozechner/pi-ai/dist/oauth.js",
  "/usr/lib/node_modules/openclaw/node_modules/@mariozechner/pi-ai/dist/oauth.js",
].filter(Boolean);

const PROVIDER_CONNECT_CONFIG: Record<
  ProviderId,
  {
    providerId: string;
    libraryExport: string;
    providerExport: string;
    inputLabel: string;
    inputPlaceholder: string;
    callbackHelpText: string;
  }
> = {
  openai: {
    providerId: "openai",
    libraryExport: "loginOpenAICodex",
    providerExport: "openaiCodexOAuthProvider",
    inputLabel: "Paste the full localhost URL or code from your browser",
    inputPlaceholder: "Paste http://localhost:1455/... or the code",
    callbackHelpText:
      "After login, ChatGPT will redirect your browser to localhost. Copy that full localhost URL from the address bar and paste it back here.",
  },
  anthropic: {
    providerId: "anthropic",
    libraryExport: "loginAnthropic",
    providerExport: "anthropicOAuthProvider",
    inputLabel: "Paste the Claude code or redirect URL from your browser",
    inputPlaceholder: "Paste the Claude code or redirect URL",
    callbackHelpText:
      "After login, Claude may show you a code or final redirect URL. Copy that value and paste it back here.",
  },
};

const sessions = new Map<ProviderId, ConnectSessionInternal>();

function snapshotSession(
  session: ConnectSessionInternal | undefined,
): ConnectSessionSnapshot | null {
  if (!session) return null;
  return {
    id: session.id,
    provider: session.provider,
    status: session.status,
    url: session.url,
    logs: session.logs.slice(-16000),
    inputLabel: session.inputLabel,
    inputPlaceholder: session.inputPlaceholder,
    startedAt: session.startedAt,
    finishedAt: session.finishedAt,
  };
}

function appendSessionLog(session: ConnectSessionInternal, chunk: string) {
  if (!chunk) return;
  session.logs += chunk;
  if (session.logs.length > 32000) {
    session.logs = session.logs.slice(-32000);
  }
  const match = chunk.match(/https?:\/\/[^\s"'<>]+/);
  if (match && !session.url) {
    session.url = match[0].replace(/[),.;]+$/, "");
  }
}

async function loadOAuthApi(): Promise<any> {
  let lastError: unknown = null;
  const runtimeImport = new Function(
    "specifier",
    "return import(specifier)",
  ) as (specifier: string) => Promise<any>;
  for (const candidate of OAUTH_MODULE_CANDIDATES) {
    try {
      if (candidate.startsWith("/")) {
        return await runtimeImport(pathToFileURL(candidate).href);
      }
      return await runtimeImport(candidate);
    } catch (error) {
      lastError = error;
    }
  }

  const detail =
    lastError instanceof Error && lastError.message
      ? `: ${lastError.message}`
      : "";
  throw new Error(`OAuth helper is unavailable for dashboard connect flows${detail}`);
}

function normalizeCredentialValue(
  value: unknown,
  fallback = "",
): string {
  return typeof value === "string" ? value.trim() : fallback;
}

async function saveOAuthCredentials(provider: ProviderId, creds: any) {
  const accessToken = normalizeCredentialValue(
    creds?.accessToken ?? creds?.access_token ?? creds?.access,
  );
  const refreshToken = normalizeCredentialValue(
    creds?.refreshToken ?? creds?.refresh_token ?? creds?.refresh,
  );
  const expiresAt =
    normalizeCredentialValue(
      creds?.expiresAt ??
        creds?.expires_at ??
        (typeof creds?.expires === "number"
          ? new Date(creds.expires).toISOString()
          : ""),
    ) ||
    new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();

  if (!accessToken) {
    throw new Error("Connect flow finished without an access token.");
  }

  const config = PROVIDER_CONNECT_CONFIG[provider];
  const profileId = `${config.providerId}:default`;
  const store = await readAuthProfilesForUpdate();
  store.profiles[profileId] = {
    provider: config.providerId,
    authType: "oauth",
    updatedAt: new Date().toISOString(),
    accessToken,
    refreshToken,
    expiresAt,
  };
  await writeAuthProfiles(store);
}

function nextProviderInput(session: ConnectSessionInternal, prompt?: any) {
  if (session.cancelled) {
    return Promise.reject(new Error("Connect flow cancelled"));
  }

  if (prompt?.message) session.inputLabel = String(prompt.message);
  if (prompt?.placeholder) {
    session.inputPlaceholder = String(prompt.placeholder);
  }

  const queued = session.pendingInputs.shift();
  if (queued) {
    appendSessionLog(session, "\n[using queued input]\n");
    return Promise.resolve(queued);
  }

  session.status = "awaiting_input";
  appendSessionLog(
    session,
    `\nAwaiting input: ${session.inputLabel || "Paste the requested value"}\n`,
  );
  return new Promise<string>((resolve, reject) => {
    session.resolveInput = resolve;
    session.rejectInput = reject;
  });
}

async function runConnectSession(session: ConnectSessionInternal) {
  const config = PROVIDER_CONNECT_CONFIG[session.provider];
  const oauthApi = await loadOAuthApi();
  const oauthProvider =
    typeof oauthApi.getOAuthProvider === "function"
      ? oauthApi.getOAuthProvider(config.providerId)
      : oauthApi[config.providerExport] &&
          typeof oauthApi[config.providerExport].login === "function"
        ? oauthApi[config.providerExport]
        : null;
  const loginFn =
    typeof oauthApi[config.libraryExport] === "function"
      ? oauthApi[config.libraryExport]
      : null;

  if (!oauthProvider && !loginFn) {
    throw new Error(`OAuth helper is unavailable for ${session.provider}`);
  }

  appendSessionLog(session, `\nStarting ${session.provider} auth flow...\n`);

  const callbacks: any = {
    onAuth: (info: any) => {
      if (session.cancelled) return;
      if (info?.url) session.url = String(info.url);
      appendSessionLog(
        session,
        "\nOpen this URL in a browser on your own device:\n" +
          `${info?.url || ""}\n` +
          `${config.callbackHelpText}\n` +
          `${info?.instructions ? `${String(info.instructions)}\n` : ""}`,
      );
    },
    onPrompt: (prompt: any) => nextProviderInput(session, prompt),
    onManualCodeInput: () =>
      nextProviderInput(session, {
        message: config.inputLabel,
        placeholder: config.inputPlaceholder,
      }),
    onProgress: (message: string) => {
      if (session.cancelled) return;
      appendSessionLog(session, `\n${String(message || "")}\n`);
    },
  };

  if (session.provider === "openai") {
    callbacks.originator = "aideploy";
  }

  const creds =
    oauthProvider && typeof oauthProvider.login === "function"
      ? await oauthProvider.login(callbacks)
      : session.provider === "anthropic"
        ? await loginFn(
            (url: string) => callbacks.onAuth({ url }),
            () =>
              callbacks.onPrompt({
                message: config.inputLabel,
                placeholder: config.inputPlaceholder,
              }),
          )
        : await loginFn(callbacks);

  if (session.cancelled) {
    throw new Error("Connect flow cancelled");
  }

  await saveOAuthCredentials(session.provider, creds);
  await ensureModelForProvider(session.provider);
  await restartGateway();
}

export async function startProviderConnectSession(
  provider: ProviderId,
): Promise<ConnectSessionSnapshot | null> {
  const existing = sessions.get(provider);
  if (
    existing &&
    (existing.status === "running" || existing.status === "awaiting_input")
  ) {
    return snapshotSession(existing);
  }

  const config = PROVIDER_CONNECT_CONFIG[provider];
  const session: ConnectSessionInternal = {
    id: `auth-${Math.random().toString(36).slice(2, 10)}`,
    provider,
    status: "running",
    url: "",
    logs: "",
    inputLabel: config.inputLabel,
    inputPlaceholder: config.inputPlaceholder,
    startedAt: Date.now(),
    finishedAt: 0,
    pendingInputs: [],
    resolveInput: null,
    rejectInput: null,
    cancelled: false,
    runPromise: null,
  };

  sessions.set(provider, session);
  session.runPromise = Promise.resolve()
    .then(() => runConnectSession(session))
    .then(() => {
      if (session.cancelled) return;
      session.status = "completed";
      session.finishedAt = Date.now();
      appendSessionLog(session, "\nAuth complete.\n");
    })
    .catch((error: unknown) => {
      if (session.cancelled) return;
      session.status = "error";
      session.finishedAt = Date.now();
      appendSessionLog(
        session,
        `\n${error instanceof Error ? error.message : "Auth flow failed"}\n`,
      );
    });

  const startedAt = Date.now();
  while (Date.now() - startedAt < 5000) {
    const active = sessions.get(provider);
    if (active?.url || active?.status !== "running") {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  return snapshotSession(sessions.get(provider));
}

export async function submitProviderConnectInput(
  provider: ProviderId,
  input: string,
): Promise<ConnectSessionSnapshot | null> {
  const session = sessions.get(provider);
  if (!session) {
    throw new Error("This browser link expired. Start a fresh connect flow.");
  }

  const normalized = input.trim();
  if (!normalized) {
    throw new Error("Paste the redirect URL or code first.");
  }

  if (typeof session.resolveInput === "function") {
    const resolve = session.resolveInput;
    session.resolveInput = null;
    session.rejectInput = null;
    session.status = "running";
    resolve(normalized);
  } else {
    session.pendingInputs.push(normalized);
  }

  if (session.runPromise) {
    await Promise.race([
      session.runPromise.catch(() => null),
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ]);
  }

  return snapshotSession(sessions.get(provider));
}

export function getProviderConnectSession(
  provider: ProviderId,
): ConnectSessionSnapshot | null {
  return snapshotSession(sessions.get(provider));
}

export function cancelProviderConnectSession(
  provider: ProviderId,
): ConnectSessionSnapshot | null {
  const session = sessions.get(provider);
  if (!session) return null;
  session.cancelled = true;
  session.status = "cancelled";
  session.finishedAt = Date.now();
  if (typeof session.rejectInput === "function") {
    session.rejectInput(new Error("Connect flow cancelled"));
  }
  session.resolveInput = null;
  session.rejectInput = null;
  appendSessionLog(session, "\nConnect flow cancelled.\n");
  return snapshotSession(session);
}
