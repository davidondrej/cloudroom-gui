import { renderTemplate } from "@cloudroom/templates";
import { getThread, updateThread } from "@cloudroom/db";
import type { PromptInput } from "@cloudroom/domain";
import type { AppDeps, LoggedWorkSessionDeps } from "../../types.js";
import { Type } from "@earendil-works/pi-ai";
import {
  INFERENCE_POLICY,
  InferenceTimeoutError,
  inferenceCompleteWithFallback,
} from "../ai/inference.js";
import { readUiPreferences } from "../system/ui-preferences.js";

const MAX_GENERATED_TITLE_LENGTH = 80;
const MAX_BRANCH_SLUG_LENGTH = 40;

interface ApplyGeneratedThreadTitleArgs {
  threadId: string;
  title: string;
  /** Replace only this earlier generated title. Without it, only an untitled thread is named. */
  replaces?: string;
}

interface ThreadMetadataGenerationArgs {
  /** The agent's first reply, when renaming a vague title after the first turn. */
  agentReply?: string;
  input: PromptInput[];
  threadId: string;
  timeoutMaxAttempts?: number;
  timeoutMs?: number;
}

interface GeneratedThreadMetadata {
  title?: string;
}

type ThreadMetadataGenerationOutcomeReason =
  | "empty-input"
  | "failed"
  | "inference-unavailable"
  | "timeout";

export interface ThreadMetadataGenerationOutcome {
  durationMs: number;
  metadata: GeneratedThreadMetadata | null;
  reason?: ThreadMetadataGenerationOutcomeReason;
}

interface RawGeneratedThreadMetadata {
  title: string;
}

export function cleanPromptText(input: PromptInput[]): string {
  return input
    .filter((part) => part.type === "text")
    .map((part) => part.text.trim())
    .join(" ")
    .replace(/\s+/gu, " ")
    .trim();
}

export function deriveTitleFallback(input: PromptInput[]): string | null {
  const text = cleanPromptText(input);
  if (text.length === 0) {
    return null;
  }
  return text.length <= 80 ? text : `${text.slice(0, 77)}...`;
}

export function shouldGenerateThreadTitle(input: PromptInput[]): boolean {
  return cleanPromptText(input).length > 0;
}

export function sanitizeGeneratedTitle(value: string): string | null {
  const title = value
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/^["'`]+|["'`.]+$/gu, "")
    .slice(0, MAX_GENERATED_TITLE_LENGTH)
    .trim();
  return title.length > 0 ? title : null;
}

export function sanitizeGeneratedBranchSlug(value: string): string | null {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/-{2,}/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, MAX_BRANCH_SLUG_LENGTH)
    .replace(/-+$/u, "");

  return slug.length > 0 ? slug : null;
}

const threadMetadataSchema = Type.Object({
  title: Type.String(),
});

function normalizeGeneratedThreadMetadata(
  parsed: RawGeneratedThreadMetadata | null,
): GeneratedThreadMetadata | null {
  if (!parsed) {
    return null;
  }

  const title = parsed.title ? sanitizeGeneratedTitle(parsed.title) : null;
  if (!title) {
    return null;
  }

  return { title };
}

export async function generateThreadMetadataWithOutcome(
  deps: LoggedWorkSessionDeps,
  args: ThreadMetadataGenerationArgs,
): Promise<ThreadMetadataGenerationOutcome> {
  const startedAt = Date.now();
  const fallback = deriveTitleFallback(args.input);
  const complete = (
    metadata: GeneratedThreadMetadata | null,
    reason?: ThreadMetadataGenerationOutcomeReason,
  ): ThreadMetadataGenerationOutcome => ({
    durationMs: Date.now() - startedAt,
    metadata,
    ...(reason ? { reason } : {}),
  });

  if (!fallback) {
    return complete(null, "empty-input");
  }

  const preferences = readUiPreferences(deps);
  const model = preferences["threadNaming.model"].value;
  const fallbackModel =
    preferences["threadNaming.fallbackModel"].value ?? model;
  const prompt = renderTemplate("generateThreadMetadata", {
    agentReply: args.agentReply ?? "",
    cleanedPrompt: fallback,
    rules: preferences["threadNaming.rules"].value,
  });
  const maxAttempts = Math.max(1, args.timeoutMaxAttempts ?? 1);

  try {
    const inference = await inferenceCompleteWithFallback(deps, {
      fallbackOnAnyError: true,
      label: "Thread metadata inference",
      logContext: { threadId: args.threadId },
      maxAttempts,
      ...(model ? { primaryModel: model } : {}),
      ...(fallbackModel ? { fallbackModel } : {}),
      prompt,
      retryDelayMs: INFERENCE_POLICY.threadMetadata.retryDelayMs,
      schema: threadMetadataSchema,
      timeoutMs: args.timeoutMs ?? INFERENCE_POLICY.threadMetadata.timeoutMs,
    });
    const metadata = normalizeGeneratedThreadMetadata(inference);
    return complete(metadata, metadata ? undefined : "inference-unavailable");
  } catch (error) {
    return complete(
      null,
      error instanceof InferenceTimeoutError ? "timeout" : "failed",
    );
  }
}

export function applyGeneratedThreadTitle(
  deps: Pick<AppDeps, "db" | "hub">,
  args: ApplyGeneratedThreadTitleArgs,
): boolean {
  const title = args.title.trim();
  if (title.length === 0) {
    return false;
  }

  const currentThread = getThread(deps.db, args.threadId);
  const current = currentThread?.title ?? null;
  if (
    !currentThread ||
    currentThread.archivedAt !== null ||
    currentThread.deletedAt !== null ||
    title === current ||
    (args.replaces === undefined ? current : current !== args.replaces)
  ) {
    return false;
  }

  updateThread(deps.db, deps.hub, args.threadId, {
    title,
  });

  return true;
}
