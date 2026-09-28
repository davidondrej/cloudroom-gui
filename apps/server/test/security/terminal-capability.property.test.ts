import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createTerminalCapabilityStore } from "../../src/services/terminals/terminal-capabilities.js";

/**
 * SP-5 (HI-1 / TG3): terminal capabilities are short-lifetime credentials
 * bound to a single terminal. Property: verify(terminalId, presented)
 * admits ONLY the exact, unexpired token issued for THAT terminal.
 * Forged tokens, foreign-terminal tokens, absent credentials, and expired
 * capabilities are all rejected.
 *
 * Written property-first per verdict-06's process recommendation: this test
 * failed against the pre-TG3 lifecycle (no capability verification existed
 * — any unauthenticated caller could drive any terminal).
 */

const TTL_MS = 60 * 60 * 1_000;

describe("SP-5 terminal capability security", () => {
  it("admits only the exact unexpired token for the same terminal", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 8, maxLength: 16 }),
        fc.string({ minLength: 8, maxLength: 16 }),
        fc.string({ minLength: 1, maxLength: 64 }),
        fc.integer({ min: 1, max: TTL_MS * 2 }),
        (terminalA, terminalB, forged, elapsed) => {
          fc.pre(terminalA !== terminalB);
          let clock = 1_000_000;
          const store = createTerminalCapabilityStore({
            now: () => clock,
            ttlMs: TTL_MS,
          });
          const issued = store.issueOrRefresh(terminalA, "host-1");

          // Exact token, unexpired: admitted (and the sliding window refreshes)
          expect(store.verify(terminalA, issued.token)).toBe(true);
          clock += Math.min(elapsed, TTL_MS - 1);
          expect(store.verify(terminalA, issued.token)).toBe(true);

          // Forged and absent credentials: rejected
          if (forged !== issued.token) {
            expect(store.verify(terminalA, forged)).toBe(false);
          }
          expect(store.verify(terminalA, undefined)).toBe(false);

          // Wrong terminal: the capability is bound to its own terminal
          expect(store.verify(terminalB, issued.token)).toBe(false);

          // Expiry: past TTL since last use, the credential is dead
          clock += TTL_MS + 1;
          expect(store.verify(terminalA, issued.token)).toBe(false);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("revocation kills the credential even before expiry", () => {
    let clock = 1_000_000;
    const store = createTerminalCapabilityStore({
      now: () => clock,
      ttlMs: TTL_MS,
    });
    const issued = store.issueOrRefresh("term_1", "host-1");
    expect(store.verify("term_1", issued.token)).toBe(true);
    store.revoke("term_1");
    expect(store.verify("term_1", issued.token)).toBe(false);
    expect(store.verify("term_1", undefined)).toBe(false);
  });

  it("sliding window: each successful verification extends the lifetime", () => {
    let clock = 1_000_000;
    const store = createTerminalCapabilityStore({
      now: () => clock,
      ttlMs: TTL_MS,
    });
    const issued = store.issueOrRefresh("term_1", "host-1");
    for (let step = 0; step < 10; step += 1) {
      clock += (TTL_MS * 3) / 4;
      expect(store.verify("term_1", issued.token)).toBe(true);
    }
  });
});
