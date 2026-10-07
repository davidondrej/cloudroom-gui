import { AsyncLocalStorage } from "node:async_hooks";
import { DEFAULTS } from "@cloudroom/config/defaults";
import { readOrCreateSecretFile } from "@cloudroom/secret-storage";
import type { AppSurface, RequestAppSurface } from "@cloudroom/config/app-surface";
import type { ServerLogger } from "../../types.js";

const POSTHOG_INGESTION_URL = "https://us.i.posthog.com/capture/";
const TELEMETRY_ID_FILE_NAME = "telemetry-id";

const telemetryAppSurfaceStorage = new AsyncLocalStorage<RequestAppSurface>();

/** Where a thread runs: on this computer, in its own cloud sandbox, or on the older shared cloud VM. */
export type TelemetryExecution = "local" | "cloud_sandbox" | "cloud_vm";

/** The desktop app's first-run setup funnel: which step people see, act on, finish, skip, or leave. */
export const SETUP_STEPS = ["account", "agent", "github", "project"] as const;
export const SETUP_ACTIONS = ["viewed", "started", "done", "skipped", "closed", "detected", "waitlist"] as const;
export const SETUP_DETAILS = ["github", "google", "email", "claude", "codex", "both", "none", "existing", "found", "folder", "bb_import", "chat_import"] as const;

export type TelemetryValue = string | number | boolean | null;

export type TelemetryEvent =
  | { name: "app_started"; properties?: { update_needs_password: boolean } }
  /** Onboarding telemetry (ADR 0198); built in services/cloudroom/setup-telemetry.ts. */
  | { name: "setup_snapshot" | "agent_connect" | "cli_install" | "account_sign_in_failed"; properties: Record<string, TelemetryValue> }
  | {
      name: "thread_created";
      properties: {
        execution: TelemetryExecution;
        is_child_thread: boolean;
        provider: string;
      };
    }
  | {
      name: "user_message_sent";
      properties: {
        execution: TelemetryExecution;
        is_child_thread: boolean;
        message_source: "queued_message" | "thread_create" | "thread_send";
        provider: string;
      };
    }
  | {
      name: "first_response";
      properties: {
        execution: TelemetryExecution;
        is_child_thread: boolean;
        message_source: "queued_message" | "thread_create" | "thread_send";
        ms: number;
        provider: string;
        sandbox_woke: boolean | null;
        startup_source?: string | null;
        sandbox_start_ms?: number | null;
        model?: string | null;
        reasoning_level?: string | null;
        service_tier?: string | null;
        harness_version?: string | null;
        seconds_since_first_launch?: number;
      };
    }
  | {
      name: "provider_auth_failed";
      properties: {
        execution: TelemetryExecution;
        provider: string;
        provider_code: string | null;
        running_threads: number;
      };
    }
  | {
      name: "setup_step";
      properties: {
        step: (typeof SETUP_STEPS)[number];
        action: (typeof SETUP_ACTIONS)[number];
        detail: (typeof SETUP_DETAILS)[number] | null;
        seconds_since_first_launch?: number;
        copy_logins?: boolean | null;
        mac_access?: string | null;
      };
    }
  | { name: "settings_search_no_results"; properties: { query: string } }
  | {
      name: "plugin_installed";
      properties: {
        plugin_id: string | null;
        provenance: "builtin" | "catalog" | "direct";
        marketplace: string | null;
        source_kind: "builtin" | "git" | "npm" | "path";
      };
    };

export type PluginTelemetryProperties = Record<string, TelemetryValue>;

export interface TelemetryService {
  capture(event: TelemetryEvent): void;
  capturePlugin(pluginId: string, name: string, properties: PluginTelemetryProperties): void;
  setEnabled(enabled: boolean): void;
}

interface CreateTelemetryServiceArgs {
  apiKey: string;
  appSurface: AppSurface;
  appVersion: string;
  dataDir: string;
  /** Cloudroom release stamp, like "v66". Unset outside the desktop app. */
  desktopVersion?: string | undefined;
  enabled: boolean;
  telemetryEnabled: boolean;
  logger: ServerLogger;
}

const noopTelemetryService: TelemetryService = {
  capture: () => {},
  capturePlugin: () => {},
  setEnabled: () => {},
};

export function createNoopTelemetryService(): TelemetryService {
  return noopTelemetryService;
}

export function runWithTelemetryAppSurface<T>(
  appSurface: RequestAppSurface,
  callback: () => T,
): T {
  return telemetryAppSurfaceStorage.run(appSurface, callback);
}

export async function createTelemetryService(
  args: CreateTelemetryServiceArgs,
): Promise<TelemetryService> {
  if (
    !args.enabled ||
    args.apiKey.length === 0 ||
    args.appVersion === DEFAULTS.appVersion
  ) {
    return noopTelemetryService;
  }
  const distinctId = await readOrCreateSecretFile({
    bytes: 16,
    dataDir: args.dataDir,
    encoding: "hex",
    fileName: TELEMETRY_ID_FILE_NAME,
  });
  let telemetryEnabled = args.telemetryEnabled;
  const commonProperties = {
    app_version: args.appVersion,
    arch: process.arch,
    cloudroom_version: args.desktopVersion ?? null,
    platform: process.platform,
  };
  const send = (name: string, eventProperties: object): void => {
    if (!telemetryEnabled) return;
    const appSurface = telemetryAppSurfaceStorage.getStore() ?? args.appSurface;
    const body = JSON.stringify({
      api_key: args.apiKey,
      distinct_id: distinctId,
      event: name,
      properties: {
        ...commonProperties,
        ...eventProperties,
        app_surface: appSurface,
      },
      timestamp: new Date().toISOString(),
    });
    fetch(POSTHOG_INGESTION_URL, {
      body,
      headers: { "content-type": "application/json" },
      method: "POST",
    }).catch((error: unknown) => {
      args.logger.debug(
        { app_surface: appSurface, err: error, event: name },
        "Telemetry event send failed",
      );
    });
  };
  return {
    setEnabled(enabled: boolean): void {
      telemetryEnabled = enabled;
    },
    capturePlugin(pluginId, name, properties): void {
      send(name, { ...properties, plugin_id: pluginId });
    },
    capture(event: TelemetryEvent): void {
      send(event.name, ("properties" in event ? event.properties : undefined) ?? {});
    },
  };
}
