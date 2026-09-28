import {
  buildTerminalWebSocketPath,
  type BuildTerminalWebSocketPathArgs,
} from "@bb/client-core";
import { buildBrowserWebSocketUrl } from "@/lib/dev-websocket-url";

type BuildTerminalWebSocketUrlArgs = BuildTerminalWebSocketPathArgs & {
  /** TG3: the terminal's short-lifetime capability token (required by the server). */
  terminalToken?: string;
};

export function buildTerminalWebSocketUrl(
  args: BuildTerminalWebSocketUrlArgs,
): string {
  const base = buildBrowserWebSocketUrl(buildTerminalWebSocketPath(args));
  return args.terminalToken === undefined
    ? base
    : `${base}?terminalToken=${encodeURIComponent(args.terminalToken)}`;
}
