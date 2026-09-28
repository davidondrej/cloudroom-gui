/**
 * TG3 (HI-1): client-side store for per-terminal capabilities. Tokens are
 * issued by the server at terminal creation (and re-issued on authenticated
 * GET of the terminal). They live in memory only — never persisted — and the
 * server expires them after a sliding window of inactivity.
 */
const tokens = new Map<string, string>();

export function storeTerminalCapability(
  terminalId: string,
  token: string,
): void {
  tokens.set(terminalId, token);
}

export function getTerminalCapability(terminalId: string): string | undefined {
  return tokens.get(terminalId);
}

export function clearTerminalCapability(terminalId: string): void {
  tokens.delete(terminalId);
}
