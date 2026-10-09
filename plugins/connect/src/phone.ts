import { deriveConnectBaseUrl } from "@cloudroom/connect-client";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { ConnectTunnel } from "./tunnel.js";
import type { PhoneCode } from "./types.js";

const ACCOUNT_KV_KEY = "relay-account";
const CHECK_INTERVAL_MS = 60_000;

export class PhoneRelay {
  signedIn = false;
  error: string | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  private checking: Promise<void> | null = null;

  constructor(
    private readonly bb: Pick<BbPluginApi, "sdk" | "storage" | "log">,
    private readonly tunnel: ConnectTunnel,
    private readonly onChange: () => void,
  ) {}

  async start(): Promise<void> {
    await this.tunnel.start();
    await this.check();
    this.timer = setInterval(() => void this.check(), CHECK_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    clearInterval(this.timer);
    this.tunnel.stop();
  }

  check(force = false): Promise<void> {
    this.checking ??= this.reconcile(force)
      .then(() => {
        this.error = null;
      })
      .catch((error: unknown) => {
        this.error = error instanceof Error ? error.message : String(error);
        this.bb.log.warn(`Cloudroom Connect registration failed: ${this.error}`);
      })
      .finally(() => {
        this.checking = null;
        this.onChange();
      });
    return this.checking;
  }

  phoneCode(): Promise<PhoneCode> {
    return this.call<PhoneCode>("/api/phone-code");
  }

  signOutPhones(): Promise<{ revoked: number }> {
    return this.call<{ revoked: number }>("/api/phone-sessions/revoke");
  }

  private async reconcile(force: boolean): Promise<void> {
    const { accountId } = await this.bb.sdk.cloudroom.connectAccount();
    this.signedIn = accountId !== null;
    if (accountId === null) {
      if (this.tunnel.getCredential() !== null) await this.tunnel.forget();
      return;
    }
    const registeredFor = await this.bb.storage.kv.get<string>(ACCOUNT_KV_KEY);
    if (!force && registeredFor === accountId && this.tunnel.getCredential() !== null) {
      return;
    }
    const registration = await this.bb.sdk.cloudroom.connectRegister();
    await this.bb.storage.kv.set(ACCOUNT_KV_KEY, registration.accountId);
    await this.tunnel.useCredential({
      serverUrl: registration.serverUrl,
      handle: registration.handle,
      credential: registration.credential,
    });
  }

  private async call<T>(path: string): Promise<T> {
    const credential = this.tunnel.getCredential();
    if (credential === null) {
      throw new Error(
        this.signedIn
          ? "Cloudroom Connect is still setting up. Try again in a moment."
          : "Sign in to Cloudroom to use it on your phone.",
      );
    }
    const response = await fetch(
      new URL(path, deriveConnectBaseUrl(credential.serverUrl)),
      {
        method: "POST",
        headers: { authorization: `Bearer ${credential.credential}` },
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (response.status === 401) {
      void this.check(true);
      throw new Error("Cloudroom Connect is setting up this Mac again. Try again in a moment.");
    }
    if (!response.ok) {
      throw new Error(`Cloudroom Connect returned HTTP ${response.status}.`);
    }
    return (await response.json()) as T;
  }
}
