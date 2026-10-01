import { AsyncLocalStorage } from "node:async_hooks";
import { DEFAULTS } from "@bb/config/defaults";
import { readOrCreateSecretFile } from "@bb/secret-storage";
import type { AppSurface, RequestAppSurface } from "@bb/config/app-surface";
import type { ServerLogger } from "../../types.js";

const POSTHOG_INGESTION_URL = "https://us.i.posthog.com/capture/";
const TELEMETRY_ID_FILE_NAME = "telemetry-id";

const telemetryAppSurfaceStorage = new AsyncLocalStorage<RequestAppSurface>();

/** Where a thread runs: on this computer, in its own cloud sandbox, or on the older shared cloud VM. */
export type TelemetryExecution = "local" | "cloud_sandbox" | "cloud_vm";

export type TelemetryEvent =
  | { name: "app_started" }
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
      name: "plugin_installed";
      properties: {
        plugin_id: string | null;
        provenance: "builtin" | "catalog" | "direct";
        marketplace: string | null;
        source_kind: "builtin" | "git" | "npm" | "path";
      };
    };

export type PluginTelemetryProperties = Record<string, string | number | boolean | null>;

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
      send(event.name, "properties" in event ? event.properties : {});
    },
  };
}
