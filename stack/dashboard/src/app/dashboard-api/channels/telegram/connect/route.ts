import { NextResponse } from "next/server";

import { agentRequest } from "@/lib/agent-server-api";
import { gatewayRequest } from "@/lib/gateway-server-api";
import {
  configureTelegramOwnerPrivilegedAccess,
  isTelegramPrivateChatId,
} from "@/lib/openclaw-runtime";
import { readJsonBody, requestBodyErrorResponse } from "@/lib/request-body";

interface AgentChannel {
  id: string;
  type: string;
  name: string;
  config?: Record<string, unknown>;
  status?: string;
}

interface SetupStatus {
  setupRequired?: boolean;
}

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export async function POST(request: Request) {
  try {
    const body = await readJsonBody<{
      token?: string;
      ownerChatId?: string;
      ownerUserId?: string;
      name?: string;
    }>(request);
    const token = normalizeString(body.token);
    const ownerChatId = normalizeString(body.ownerChatId);
    const ownerUserId = normalizeString(body.ownerUserId) || ownerChatId;
    const name = normalizeString(body.name) || "Telegram";

    if (!token) {
      return NextResponse.json(
        { error: "Telegram bot token is required" },
        { status: 400 },
      );
    }
    if (!ownerChatId) {
      return NextResponse.json(
        { error: "Telegram owner chat ID is required" },
        { status: 400 },
      );
    }
    if (!isTelegramPrivateChatId(ownerChatId)) {
      return NextResponse.json(
        { error: "Telegram owner chat ID must be a private numeric chat ID" },
        { status: 400 },
      );
    }

    const channels = await agentRequest<AgentChannel[]>("/api/channels");
    const existing = channels.find((channel) => channel.type === "telegram");
    const config = {
      ...(existing?.config ?? {}),
      botToken: token,
      ownerChatId,
      ownerUserId,
      verifiedAt: new Date().toISOString(),
    };

    const channel = existing
      ? await agentRequest<AgentChannel>(`/api/channels/${existing.id}`, {
          method: "PUT",
          body: JSON.stringify({
            name,
            status: "connected",
            config,
          }),
        })
      : await agentRequest<AgentChannel>("/api/channels", {
          method: "POST",
          body: JSON.stringify({
            type: "telegram",
            name,
            status: "connected",
            config,
          }),
        });

    await configureTelegramOwnerPrivilegedAccess(ownerChatId);

    const setupStatus = await agentRequest<SetupStatus>("/api/setup/status");
    let promptTriggered = false;
    let promptResult: Record<string, unknown> | null = null;

    if (setupStatus.setupRequired) {
      try {
        promptResult = await gatewayRequest<Record<string, unknown>>(
          "/internal/telegram/setup-prompt",
          {
            method: "POST",
            body: JSON.stringify({ trigger: "owner_verified" }),
          },
        );
        promptTriggered = promptResult?.sent === true;
      } catch (error) {
        promptResult = {
          error:
            error instanceof Error
              ? error.message
              : "Could not trigger Telegram setup prompt",
        };
      }
    }

    return NextResponse.json({
      success: true,
      channel,
      promptTriggered,
      promptResult,
    });
  } catch (error) {
    const bodyError = requestBodyErrorResponse(error);
    if (bodyError) return bodyError;

    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Could not connect Telegram",
      },
      { status: 500 },
    );
  }
}
