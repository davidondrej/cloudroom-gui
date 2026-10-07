import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { BbPluginApi, PluginTurnFailedEvent } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { ClaudeLogin, claudeSecret, localClaudeEmail } from "./src/claude.js";
import {
  CodexLogin,
  codexAccountId,
  codexPlan,
  codexUsage,
  localCodexEmail,
  refreshCodex,
} from "./src/codex.js";
import {
  ACCOUNTS_CHANGED,
  LOCAL,
  MAX_ACCOUNTS,
  accountsRpcContract,
  providerSchema,
  type AccountView,
  type Provider,
  type UsageWindow,
} from "./src/contract.js";
import { SignInAgainError, type Secret, type SignedIn } from "./src/tokens.js";

const PROVIDERS = providerSchema.options;
const USAGE_EVERY_MS = 5 * 60_000;
const REFRESH_EARLY_MS = 2 * 60 * 60_000;
const DEFAULT_REST_MS = 60 * 60_000;

const storedSchema = z.object({
  id: z.string(),
  provider: providerSchema,
  name: z.string().nullish(),
  email: z.string().nullable(),
  plan: z.string().nullable(),
  accountKey: z.string().nullable(),
  createdAt: z.number(),
});
type Stored = z.infer<typeof storedSchema>;
const secretSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresAt: z.number().nullable(),
  idToken: z.string().optional(),
  issuedAt: z.number().optional(),
});
type Usage = {
  windows: UsageWindow[];
  error: string | null;
  signInAgain: boolean;
  at: number;
};

function blockedUntil(
  rateLimits: PluginTurnFailedEvent["rateLimits"],
): number | null {
  const windows = rateLimits?.windows ?? [];
  const blocked = windows.filter((window) => window.status === "blocked");
  const resets = (blocked.length > 0 ? blocked : windows).flatMap((window) =>
    window.resetsAtMs === null ? [] : [window.resetsAtMs],
  );
  return resets.length === 0 ? null : Math.max(...resets);
}

export default async function plugin(bb: BbPluginApi) {
  const kv = bb.storage.kv;
  const secretsDir = path.join(
    bb.server.experimental_dataDir,
    "plugins",
    bb.pluginId,
    "secrets",
  );
  await fs.mkdir(secretsDir, { recursive: true, mode: 0o700 });
  let accounts = z
    .array(storedSchema)
    .catch([])
    .parse(await kv.get("accounts:v1"));
  const order: Record<Provider, string[]> = z
    .object({ "claude-code": z.array(z.string()), codex: z.array(z.string()) })
    .catch({ "claude-code": [LOCAL], codex: [LOCAL] })
    .parse(await kv.get("order:v1"));
  const limits = z
    .record(z.string(), z.number())
    .catch({})
    .parse(await kv.get("limits:v1"));
  let inCloud = z.string().nullable().catch(null).parse(await kv.get("cloud:v1"));
  const usage = new Map<string, Usage>();
  const threadAccount = new Map<string, string>();
  const refreshing = new Map<string, Promise<Secret>>();
  const claudeLogin = new ClaudeLogin();
  const codexLogin = new CodexLogin();

  const changed = async () => {
    await Promise.all([
      kv.set("accounts:v1", accounts),
      kv.set("order:v1", order),
      kv.set("limits:v1", limits),
    ]);
    bb.realtime.publish(ACCOUNTS_CHANGED, {});
    void followInCloud();
  };
  const ids = (provider: Provider): string[] => {
    const saved = accounts
      .filter((account) => account.provider === provider)
      .map((account) => account.id);
    const kept = order[provider].filter(
      (id) => id === LOCAL || saved.includes(id),
    );
    order[provider] = [
      ...(kept.includes(LOCAL) ? [] : [LOCAL]),
      ...kept,
      ...saved.filter((id) => !kept.includes(id)),
    ];
    // Claude's own Mac login has no one-year token, so Cloud can't follow it (ADR 0197).
    return provider === "claude-code" && saved.length > 0
      ? order[provider].filter((id) => id !== LOCAL)
      : order[provider];
  };
  // The top account is the one every thread uses (ADR 0197).
  const current = (provider: Provider): string => ids(provider)[0] ?? LOCAL;
  const limitedUntil = (provider: Provider, id: string): number | null => {
    const until = limits[`${provider}:${id}`];
    return until !== undefined && until > Date.now() ? until : null;
  };

  const secretPath = (id: string) => path.join(secretsDir, `${id}.json`);
  const writeSecret = async (id: string, secret: Secret) => {
    const temp = `${secretPath(id)}.${randomUUID()}.tmp`;
    await fs.writeFile(temp, JSON.stringify(secret), { mode: 0o600 });
    await fs.rename(temp, secretPath(id));
  };
  const freshSecret = (account: Stored): Promise<Secret> => {
    const running = refreshing.get(account.id);
    if (running) return running;
    const flight = (async () => {
      const secret = secretSchema.parse(
        JSON.parse(await fs.readFile(secretPath(account.id), "utf8")),
      );
      const lifetime =
        secret.expiresAt !== null && secret.issuedAt !== undefined
          ? secret.expiresAt - secret.issuedAt
          : Infinity;
      if (
        account.provider === "claude-code" ||
        secret.expiresAt === null ||
        secret.expiresAt - Date.now() > Math.min(REFRESH_EARLY_MS, lifetime / 2)
      )
        return secret;
      const next = {
        ...(await refreshCodex(secret)),
        issuedAt: Date.now(),
      };
      await writeSecret(account.id, next);
      return next;
    })().finally(() => refreshing.delete(account.id));
    refreshing.set(account.id, flight);
    return flight;
  };
  // Cloud keeps one Claude login per user, so it follows the account in use (ADR 0197).
  const followInCloud = async () => {
    const id = current("claude-code");
    const account = accounts.find((entry) => entry.id === id);
    if (!account || id === inCloud) return;
    try {
      const secret = await freshSecret(account);
      await bb.sdk.cloudroom.claudeAuth({
        action: "token",
        requestId: randomUUID(),
        token: secret.accessToken,
        ...(account.plan ? { plan: account.plan } : {}),
      });
      inCloud = id;
      await kv.set("cloud:v1", id);
    } catch (error) {
      bb.log.warn(
        `Cloud could not switch Claude accounts: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  const refreshUsage = async (account: Stored, force = false) => {
    const previous = usage.get(account.id);
    if (!force && previous && Date.now() - previous.at < USAGE_EVERY_MS) return;
    const before = [account.plan, previous?.error].join();
    try {
      const secret = await freshSecret(account);
      {
        const measured = await codexUsage(secret);
        account.plan = measured.plan ?? account.plan;
        usage.set(account.id, {
          windows: measured.windows,
          error: null,
          signInAgain: false,
          at: Date.now(),
        });
      }
    } catch (error) {
      usage.set(account.id, {
        windows: previous?.windows ?? [],
        error: error instanceof Error ? error.message : String(error),
        signInAgain: error instanceof SignInAgainError,
        at: Date.now(),
      });
    }
    if ([account.plan, usage.get(account.id)?.error].join() !== before)
      await changed();
  };
  const refreshAll = (force = false) =>
    Promise.all(
      accounts
        .filter((account) => account.provider === "codex")
        .map((account) => refreshUsage(account, force)),
    );
  const timer = setInterval(() => void refreshAll(), USAGE_EVERY_MS);
  timer.unref();
  bb.onDispose(() => clearInterval(timer));
  void refreshAll();

  const add = async (provider: Provider, signedIn: SignedIn) => {
    const existing = accounts.find(
      (account) =>
        account.provider === provider &&
        signedIn.accountKey !== null &&
        account.accountKey === signedIn.accountKey,
    );
    if (!existing && ids(provider).length >= MAX_ACCOUNTS)
      throw new Error(
        `You can connect up to ${MAX_ACCOUNTS} accounts per provider.`,
      );
    const account: Stored = existing ?? {
      id: randomUUID(),
      provider,
      email: null,
      plan: null,
      accountKey: signedIn.accountKey,
      createdAt: Date.now(),
    };
    account.email = signedIn.email;
    account.plan = signedIn.plan;
    await writeSecret(account.id, { ...signedIn.secret, issuedAt: Date.now() });
    usage.delete(account.id);
    if (!existing) accounts = [...accounts, account];
    ids(provider);
    await changed();
    if (provider === "codex") void refreshUsage(account, true);
  };

  const view = async (provider: Provider): Promise<AccountView[]> => {
    const using = current(provider);
    const localEmail = await (provider === "claude-code"
      ? localClaudeEmail()
      : localCodexEmail());
    return ids(provider).map((id) => {
      const account = accounts.find((entry) => entry.id === id);
      const measured = usage.get(id);
      return {
        id,
        name: account?.name ?? null,
        email: id === LOCAL ? localEmail : (account?.email ?? null),
        plan: account?.plan ?? null,
        inUse: id === using,
        limitedUntil: limitedUntil(provider, id),
        error: measured?.error ?? null,
        windows: measured?.windows ?? [],
      };
    });
  };
  const move = (provider: Provider, id: string, to: number) => {
    const list = ids(provider).filter((entry) => entry !== id);
    list.splice(Math.max(0, Math.min(list.length, to)), 0, id);
    order[provider] = list;
  };

  bb.rpc.register(
    accountsRpcContract,
    {
      "accounts.list": ({ provider }) => view(provider),
      "accounts.use": async ({ provider, id }) => {
        move(provider, id, 0);
        delete limits[`${provider}:${id}`];
        await changed();
        return null;
      },
      "accounts.move": async ({ provider, id, direction }) => {
        move(
          provider,
          id,
          ids(provider).indexOf(id) + (direction === "up" ? -1 : 1),
        );
        await changed();
        return null;
      },
      "accounts.remove": async ({ provider, id }) => {
        if (id === LOCAL)
          throw new Error("This machine's own login can't be removed here.");
        accounts = accounts.filter((account) => account.id !== id);
        order[provider] = order[provider].filter((entry) => entry !== id);
        delete limits[`${provider}:${id}`];
        usage.delete(id);
        await fs.rm(secretPath(id), { force: true });
        await changed();
        return null;
      },
      "accounts.rename": async ({ id, name }) => {
        const account = accounts.find((entry) => entry.id === id);
        if (!account) throw new Error("This account is no longer connected.");
        account.name = name.trim() || null;
        await changed();
        return null;
      },
      "claude.start": async () => claudeLogin.start(),
      "claude.poll": async ({ sessionId }) => {
        try {
          const token = claudeLogin.poll(sessionId);
          if (!token) return { status: "pending" as const, message: null };
          await add("claude-code", {
            email: null,
            plan: null,
            accountKey: null,
            secret: claudeSecret(token),
          });
          return { status: "complete" as const, message: null };
        } catch (error) {
          return {
            status: "error" as const,
            message: error instanceof Error ? error.message : String(error),
          };
        }
      },
      "codex.start": () => codexLogin.start(),
      "codex.poll": async ({ sessionId }) => {
        try {
          const signedIn = await codexLogin.poll(sessionId);
          if (!signedIn) return { status: "pending" as const, message: null };
          await add("codex", signedIn);
          return { status: "complete" as const, message: null };
        } catch (error) {
          return {
            status: "error" as const,
            message: error instanceof Error ? error.message : String(error),
          };
        }
      },
    },
    {
      experimental_discoverable: true,
      experimental_description:
        "Several subscriptions per provider. accounts.list returns one provider's accounts in order, with usage and which one is in use.",
    },
  );

  const contribute =
    (provider: Provider) => async (context: { threadId: string }) => {
      const id = current(provider);
      threadAccount.set(context.threadId, id);
      const account = accounts.find((entry) => entry.id === id);
      if (!account) return [];
      const secret = await freshSecret(account).catch(() => null);
      if (!secret) return [];
      const reason = `Cloudroom account ${account.email ?? account.id}`;
      if (provider === "claude-code")
        return [
          {
            name: "CLAUDE_CODE_OAUTH_TOKEN",
            value: secret.accessToken,
            reason,
          },
          { name: "ANTHROPIC_API_KEY", value: "", reason },
        ];
      return [
        {
          name: "CLOUDROOM_CODEX_ACCESS_TOKEN",
          value: secret.accessToken,
          reason,
        },
        {
          name: "CLOUDROOM_CODEX_ACCOUNT_ID",
          value: codexAccountId(secret) ?? account.accountKey ?? "",
          reason,
        },
        {
          name: "CLOUDROOM_CODEX_PLAN_TYPE",
          value: codexPlan(secret) ?? "",
          reason,
        },
      ];
    };
  for (const provider of PROVIDERS)
    bb.providers.experimental_contributeEnv(provider, contribute(provider));

  bb.events.on("turn.failed", async (event) => {
    if (event.errorInfo?.category !== "rate-limit") return;
    const thread = await bb.sdk.threads
      .get({ threadId: event.threadId })
      .catch(() => null);
    const provider = providerSchema.safeParse(thread?.providerId);
    if (!provider.success || ids(provider.data).length < 2) return;
    const used = threadAccount.get(event.threadId);
    if (!used) return;
    limits[`${provider.data}:${used}`] =
      blockedUntil(event.rateLimits) ?? Date.now() + DEFAULT_REST_MS;
    await changed();
  });
}
