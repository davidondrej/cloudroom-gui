import { randomBytes, timingSafeEqual } from "node:crypto";

/**
 * TG3 (HI-1): short-lifetime credentials bound to a single terminal. Issued
 * when a terminal is created (and re-issued on authenticated reads), required
 * for every REST mutation and the WebSocket upgrade. The token is in-memory
 * only — never persisted, never served to a client that does not already
 * hold the install capability — and expires after a sliding window of
 * inactivity.
 *
 * Ownership note (gateway-only resolution): in the single-owner install the
 * terminal identity is the binding — possession of the token issued for
 * terminal X is the owner/target proof for X (using X's capability against
 * terminal Y is rejected structurally). A future direct-mode spec replaces
 * the terminal-scoped binding with per-session ownership.
 */

export const DEFAULT_TERMINAL_CAPABILITY_TTL_MS = 60 * 60 * 1_000;

export interface IssuedTerminalCapability {
  token: string;
  expiresAt: number;
}

export interface TerminalCapabilityStore {
  /** Issues a fresh credential, or refreshes the existing one in place. */
  issueOrRefresh(terminalId: string, hostId: string): IssuedTerminalCapability;
  /** Constant-time verification; refreshes the sliding window on success. */
  verify(terminalId: string, presented: string | undefined): boolean;
  revoke(terminalId: string): void;
}

interface StoredCapability {
  token: string;
  hostId: string;
  expiresAt: number;
}

export function createTerminalCapabilityStore(args: {
  now?: () => number;
  ttlMs?: number;
}): TerminalCapabilityStore {
  const now = args.now ?? (() => Date.now());
  const ttlMs = args.ttlMs ?? DEFAULT_TERMINAL_CAPABILITY_TTL_MS;
  const records = new Map<string, StoredCapability>();

  return {
    issueOrRefresh(terminalId, hostId) {
      const existing = records.get(terminalId);
      const expiresAt = now() + ttlMs;
      if (existing !== undefined && existing.hostId === hostId) {
        // Refresh in place: the token stays stable for the terminal's
        // lifetime so multiple client surfaces (tabs, reconnects) keep
        // working through re-issued reads.
        existing.expiresAt = expiresAt;
        return { token: existing.token, expiresAt };
      }
      const token = randomBytes(32).toString("base64url");
      records.set(terminalId, { token, hostId, expiresAt });
      return { token, expiresAt };
    },

    verify(terminalId, presented) {
      const record = records.get(terminalId);
      if (record === undefined || presented === undefined) {
        return false;
      }
      if (now() >= record.expiresAt) {
        records.delete(terminalId);
        return false;
      }
      const presentedBuffer = Buffer.from(presented, "utf8");
      const recordBuffer = Buffer.from(record.token, "utf8");
      const matches =
        presentedBuffer.length === recordBuffer.length &&
        timingSafeEqual(presentedBuffer, recordBuffer);
      if (!matches) {
        return false;
      }
      record.expiresAt = now() + ttlMs;
      return true;
    },

    revoke(terminalId) {
      records.delete(terminalId);
    },
  };
}
