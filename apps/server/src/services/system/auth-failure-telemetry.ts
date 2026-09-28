import { countThreads, getThread, type DbConnection } from "@bb/db";
import type { ServerLogger } from "../../types.js";
import { buildTurnFailedEvent } from "../threads/turn-failed.js";
import type { TelemetryService } from "./telemetry.js";

interface Deps {
  db: DbConnection;
  logger: ServerLogger;
  telemetry: TelemetryService;
}

let deps: Deps | null = null;

export function installAuthFailureTelemetry(next: Deps): () => void {
  deps = next;
  return () => {
    if (deps === next) deps = null;
  };
}

export function noteTurnFailed(threadId: string): void {
  const current = deps;
  if (!current) return;
  setImmediate(() => {
    const failed = buildTurnFailedEvent(current.db, threadId);
    if (failed?.errorInfo?.category !== "unauthorized") return;
    const thread = getThread(current.db, threadId);
    if (!thread) return;
    const running = countThreads(current.db, {
      status: "active",
      providerId: thread.providerId,
      includeHidden: true,
    }).total;
    const execution = thread.executionTarget === "cloud" ? "cloud_sandbox" : "local";
    current.logger.warn(
      {
        threadId,
        provider: thread.providerId,
        providerCode: failed.errorInfo.providerCode,
        execution,
        runningThreads: running,
      },
      "Provider login failed",
    );
    current.telemetry.capture({
      name: "provider_auth_failed",
      properties: {
        execution,
        provider: thread.providerId,
        provider_code: failed.errorInfo.providerCode,
        running_threads: running,
      },
    });
  });
}
