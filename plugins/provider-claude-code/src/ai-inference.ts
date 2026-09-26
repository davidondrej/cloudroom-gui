import { spawn } from "node:child_process";
import os from "node:os";
import type {
  ExperimentalAiInferenceCompleteInput,
  ExperimentalAiInferenceCompleteOutput,
  ExperimentalAiServiceErrorCode,
} from "@get-bb/plugin-sdk/ai-services";
import { claudeExecutable } from "./bridge/provider-maintenance.js";

type InferenceValue = Extract<
  ExperimentalAiInferenceCompleteOutput,
  { ok: true }
>["value"];

interface ClaudePrintResult {
  is_error?: boolean;
  result?: string;
  structured_output?: unknown;
}

function failure(
  code: ExperimentalAiServiceErrorCode,
  message: string,
): ExperimentalAiInferenceCompleteOutput {
  return { ok: false, code, message };
}

function parseResult(
  stdout: string,
  model: string,
): ExperimentalAiInferenceCompleteOutput {
  let result: ClaudePrintResult;
  try {
    result = JSON.parse(stdout) as ClaudePrintResult;
  } catch {
    return failure("invalid_response", "Claude Code returned no JSON result.");
  }
  const value = result.structured_output;
  if (
    result.is_error ||
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return failure(
      result.is_error ? "request_failed" : "invalid_response",
      result.result?.trim() || "Claude Code returned no structured result.",
    );
  }
  return { ok: true, model, value: value as InferenceValue };
}

/** One-shot structured inference through the signed-in `claude` CLI. */
export function completeClaudeInference(
  input: ExperimentalAiInferenceCompleteInput,
): Promise<ExperimentalAiInferenceCompleteOutput> {
  return new Promise((resolve) => {
    const child = spawn(
      claudeExecutable(),
      [
        "-p",
        "--model",
        input.model,
        "--no-session-persistence",
        "--tools",
        "",
        "--no-chrome",
        "--setting-sources",
        "user",
        "--settings",
        '{"disableAllHooks":true}',
        "--strict-mcp-config",
        "--mcp-config",
        '{"mcpServers":{}}',
        "--output-format",
        "json",
        "--json-schema",
        JSON.stringify(input.outputSchema),
      ],
      { cwd: os.homedir(), stdio: "pipe" },
    );
    let stdout = "";
    const timer = setTimeout(() => {
      child.kill();
      resolve(
        failure(
          "timeout",
          `Claude Code did not answer within ${input.timeoutMs}ms.`,
        ),
      );
    }, input.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      resolve(
        failure(
          "request_failed",
          `Could not run Claude Code: ${error.message}`,
        ),
      );
    });
    child.once("close", () => {
      clearTimeout(timer);
      resolve(parseResult(stdout, input.model));
    });
    // Spawn failures already surface through the child's error event.
    child.stdin.once("error", () => {});
    child.stdin.end(input.prompt);
  });
}
