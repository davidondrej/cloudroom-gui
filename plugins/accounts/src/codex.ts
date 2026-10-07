import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { UsageWindow } from "./contract.js";
import {
  jwtClaims,
  postToken,
  readReset,
  type Secret,
  type SignedIn,
} from "./tokens.js";

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTH = "https://auth.openai.com";
const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const AUTH_CLAIM = "https://api.openai.com/auth";
const PROFILE_CLAIM = "https://api.openai.com/profile";
const SESSION_MS = 10 * 60_000;

const tokenSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  id_token: z.string().min(1).optional(),
});
const windowSchema = z
  .object({
    used_percent: z.number(),
    reset_at: z.number().nullish(),
    limit_window_seconds: z.number().nullish(),
  })
  .nullish();
const usageSchema = z.object({
  plan_type: z.string().nullish(),
  rate_limit: z
    .object({ primary_window: windowSchema, secondary_window: windowSchema })
    .nullish(),
});

const nested = (
  claims: Record<string, unknown>,
  claim: string,
  field: string,
): string | null => {
  const value = (claims[claim] as Record<string, unknown> | undefined)?.[field];
  return typeof value === "string" && value ? value : null;
};

export const codexPlanLabel = (
  plan: string | null | undefined,
): string | null =>
  plan ? plan.charAt(0).toUpperCase() + plan.slice(1) : null;

function toSecret(
  tokens: z.infer<typeof tokenSchema>,
  previous?: Secret,
): Secret {
  const refreshToken = tokens.refresh_token ?? previous?.refreshToken;
  if (!refreshToken) throw new Error("Codex did not return a refresh token.");
  const exp = jwtClaims(tokens.access_token).exp;
  const idToken = tokens.id_token ?? previous?.idToken;
  return {
    accessToken: tokens.access_token,
    refreshToken,
    expiresAt: typeof exp === "number" ? exp * 1_000 : null,
    ...(idToken ? { idToken } : {}),
  };
}

export function codexAccountId(secret: Secret): string | null {
  return (
    nested(jwtClaims(secret.idToken), AUTH_CLAIM, "chatgpt_account_id") ??
    nested(jwtClaims(secret.accessToken), AUTH_CLAIM, "chatgpt_account_id")
  );
}

export function codexPlan(secret: Secret): string | null {
  return nested(jwtClaims(secret.accessToken), AUTH_CLAIM, "chatgpt_plan_type");
}

export class CodexLogin {
  private readonly sessions = new Map<
    string,
    { authId: string; userCode: string; expiresAt: number }
  >();

  async start() {
    const started = z
      .object({ device_auth_id: z.string(), user_code: z.string() })
      .parse(
        await postToken(`${AUTH}/api/accounts/deviceauth/usercode`, "json", {
          client_id: CLIENT_ID,
        }),
      );
    const sessionId = randomUUID();
    const expiresAt = Date.now() + SESSION_MS;
    this.sessions.set(sessionId, {
      authId: started.device_auth_id,
      userCode: started.user_code,
      expiresAt,
    });
    return {
      sessionId,
      verificationUri: `${AUTH}/codex/device`,
      userCode: started.user_code,
      expiresAt,
    };
  }

  async poll(sessionId: string): Promise<SignedIn | null> {
    const session = this.sessions.get(sessionId);
    if (!session || Date.now() > session.expiresAt) {
      this.sessions.delete(sessionId);
      throw new Error("This code expired. Start again.");
    }
    const response = await fetch(`${AUTH}/api/accounts/deviceauth/token`, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        device_auth_id: session.authId,
        user_code: session.userCode,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const body: unknown = await response.json().catch(() => null);
    const authorized = z
      .object({ authorization_code: z.string(), code_verifier: z.string() })
      .safeParse(body);
    if (!response.ok || !authorized.success) {
      if (JSON.stringify(body ?? "").match(/denied|declined/iu)) {
        this.sessions.delete(sessionId);
        throw new Error("Codex sign-in was declined.");
      }
      return null;
    }
    this.sessions.delete(sessionId);
    const secret = toSecret(
      tokenSchema.parse(
        await postToken(`${AUTH}/oauth/token`, "form", {
          grant_type: "authorization_code",
          code: authorized.data.authorization_code,
          redirect_uri: `${AUTH}/deviceauth/callback`,
          client_id: CLIENT_ID,
          code_verifier: authorized.data.code_verifier,
        }),
      ),
    );
    const claims = jwtClaims(secret.idToken);
    return {
      email:
        (typeof claims.email === "string" ? claims.email : null) ??
        nested(claims, PROFILE_CLAIM, "email"),
      plan: codexPlanLabel(codexPlan(secret)),
      accountKey: codexAccountId(secret),
      secret,
    };
  }
}

export async function refreshCodex(secret: Secret): Promise<Secret> {
  return toSecret(
    tokenSchema.parse(
      await postToken(`${AUTH}/oauth/token`, "json", {
        client_id: CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: secret.refreshToken,
      }),
    ),
    secret,
  );
}

const windowLabel = (seconds: number | null | undefined, fallback: string) =>
  seconds === 18_000
    ? "Five-hour limit"
    : seconds === 604_800
      ? "Weekly limit"
      : fallback;

export async function codexUsage(
  secret: Secret,
): Promise<{ plan: string | null; windows: UsageWindow[] }> {
  const response = await fetch(USAGE_URL, {
    headers: {
      authorization: `Bearer ${secret.accessToken}`,
      "chatgpt-account-id": codexAccountId(secret) ?? "",
      originator: "cloudroom",
      accept: "application/json",
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok)
    throw new Error(`Codex usage failed (HTTP ${response.status}).`);
  const usage = usageSchema.parse(await response.json());
  const windows: Array<[string, z.infer<typeof windowSchema>]> = [
    ["Primary limit", usage.rate_limit?.primary_window],
    ["Secondary limit", usage.rate_limit?.secondary_window],
  ];
  return {
    plan: codexPlanLabel(usage.plan_type),
    windows: windows.flatMap(([fallback, window]) =>
      window
        ? [
            {
              label: windowLabel(window.limit_window_seconds, fallback),
              usedPercent: window.used_percent,
              resetsAt: readReset(window.reset_at),
            },
          ]
        : [],
    ),
  };
}

export async function localCodexEmail(): Promise<string | null> {
  try {
    const home =
      process.env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex");
    const auth = JSON.parse(
      await fs.readFile(path.join(home, "auth.json"), "utf8"),
    ) as { tokens?: { id_token?: string } };
    const claims = jwtClaims(auth.tokens?.id_token);
    return (
      (typeof claims.email === "string" ? claims.email : null) ??
      nested(claims, PROFILE_CLAIM, "email")
    );
  } catch {
    return null;
  }
}
