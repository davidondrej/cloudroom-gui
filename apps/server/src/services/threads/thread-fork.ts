import { getEnvironment, getThread } from "@bb/db";
import type { EnvironmentRow } from "@bb/db";
import type { PromptInput, Thread } from "@bb/domain";
import type { ForkThreadRequest } from "@bb/server-contract";
import type { LoggedPendingInteractionWorkSessionDeps } from "../../types.js";
import { ApiError } from "../../errors.js";
import { resolveExistingThreadPermissionMode } from "./thread-execution-plan.js";
import { getLastExecutionOptions } from "./thread-events.js";
import { createThreadFromRequest } from "./thread-create.js";
import { cloudExecution, cloudroom, isCloudThread } from "../cloudroom/commands.js";

type ThreadForkDeps = LoggedPendingInteractionWorkSessionDeps;

function requireForkSourceThread(
  deps: Pick<ThreadForkDeps, "db">,
  sourceThreadId: string,
): Thread {
  const sourceThread = getThread(deps.db, sourceThreadId);
  if (!sourceThread || sourceThread.deletedAt !== null) {
    throw new ApiError(404, "thread_not_found", "Source thread not found");
  }
  if (sourceThread.archivedAt !== null) {
    throw new ApiError(
      400,
      "invalid_request",
      "Cannot fork an archived source thread",
    );
  }
  return sourceThread;
}

function requireForkCapableProvider(
  deps: Pick<ThreadForkDeps, "providerRegistry">,
  sourceThread: Thread,
): void {
  if (!deps.providerRegistry.supportsFork(sourceThread.providerId)) {
    throw new ApiError(
      400,
      "invalid_request",
      `Provider ${sourceThread.providerId} does not support thread forks`,
    );
  }
}

function requireSourceEnvironment(
  deps: Pick<ThreadForkDeps, "db">,
  sourceThread: Thread,
): EnvironmentRow {
  const environment =
    sourceThread.environmentId === null
      ? null
      : getEnvironment(deps.db, sourceThread.environmentId);
  if (!environment || environment.status !== "ready" || !environment.path) {
    throw new ApiError(
      400,
      "invalid_request",
      "Source thread must have a ready environment to fork",
    );
  }
  return environment;
}

/** A Cloud thread forks into a new sandbox, and its first message makes the native fork, so it needs one. */
function createCloudForkFromRequest(
  deps: ThreadForkDeps,
  sourceThread: Thread,
  request: ForkThreadRequest,
) {
  if (!request.input || request.agentContextSeed) {
    throw new ApiError(
      400,
      "invalid_request",
      "A Cloud fork needs a first message and takes no agent-only context",
    );
  }
  return createThreadFromRequest(deps, {
    environment: { type: "project-default" },
    executionTarget: "cloud",
    input: request.input,
    origin: request.origin,
    originKind: "fork",
    projectId: sourceThread.projectId,
    providerId: sourceThread.providerId,
    ...(request.sourceSeqEnd === undefined
      ? {}
      : { sourceSeqEnd: request.sourceSeqEnd }),
    sourceThreadId: sourceThread.id,
    startedOnBehalfOf: null,
    ...(request.title === undefined ? {} : { title: request.title }),
    visibility: request.visibility,
  });
}

export async function createThreadForkFromRequest(
  deps: ThreadForkDeps,
  request: ForkThreadRequest,
) {
  const sourceThread = requireForkSourceThread(deps, request.sourceThreadId);
  // A fork without a first message (a side chat) stays in its source's sandbox, like a Local one (ADR 0189).
  if (isCloudThread(sourceThread) && !request.input) {
    const thread = await cloudroom(deps).sideChat(sourceThread, request);
    deps.telemetry.capture({ name: "thread_created", properties: { execution: cloudExecution(deps, thread.id), is_child_thread: false, provider: thread.providerId } });
    return thread;
  }
  if (isCloudThread(sourceThread)) {
    return createCloudForkFromRequest(deps, sourceThread, request);
  }
  requireForkCapableProvider(deps, sourceThread);
  const sourceEnvironment = requireSourceEnvironment(deps, sourceThread);
  const sourceExecution = getLastExecutionOptions(deps, sourceThread.id);
  const visibleInput = request.input ?? [];
  const agentContextSeed = request.agentContextSeed ?? [];
  const input: PromptInput[] = [...agentContextSeed, ...visibleInput];
  const isSeedOnlyIdleFork =
    visibleInput.length === 0 && agentContextSeed.length > 0;

  return createThreadFromRequest(
    deps,
    {
      environment: request.environment ?? {
        type: "reuse",
        environmentId: sourceEnvironment.id,
      },
      input,
      origin: request.origin,
      ...(request.originPluginId === undefined
        ? {}
        : { originPluginId: request.originPluginId }),
      ...(request.pluginMetadata === undefined
        ? {}
        : { pluginMetadata: request.pluginMetadata }),
      originKind: "fork",
      permissionMode:
        request.permissionMode ??
        resolveExistingThreadPermissionMode(deps, sourceThread.id),
      ...(sourceExecution?.model ? { model: sourceExecution.model } : {}),
      ...(sourceExecution?.reasoningLevel
        ? { reasoningLevel: sourceExecution.reasoningLevel }
        : {}),
      ...(sourceExecution?.serviceTier
        ? { serviceTier: sourceExecution.serviceTier }
        : {}),
      projectId: sourceThread.projectId,
      providerId: sourceThread.providerId,
      ...(request.sourceSeqEnd === undefined
        ? {}
        : { sourceSeqEnd: request.sourceSeqEnd }),
      sourceThreadId: sourceThread.id,
      startedOnBehalfOf: isSeedOnlyIdleFork
        ? { initiator: "agent", senderThreadId: sourceThread.id }
        : null,
      ...(request.title === undefined ? {} : { title: request.title }),
      visibility: request.visibility,
    },
    {
      forkSourceEnvironmentId: sourceEnvironment.id,
      ...(isSeedOnlyIdleFork ? { providerInput: [] } : {}),
    },
  );
}
