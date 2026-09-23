import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  isLoopbackHostname,
  nonLoopbackBindRefusal,
} from "@bb/config/loopback";
import { PUBLIC_API_CAPABILITY_FILE_NAME } from "../../src/services/public-api-capability.js";
import { withTestHarness } from "../helpers/test-app.js";

/**
 * Property-based test catalog for the audit-remediation program
 * (.agents/specs/audit-remediation/spec.md §Security Properties).
 *
 * Each skipped group below activates (skip removed, real property written)
 * as its owning task group lands; the skip label names the activating tasks
 * and the findings the property guards. Traceability matrix lives in
 * .agents/specs/audit-remediation/tasks.md (TG0.5).
 */

describe("SP-1 access control — capability gate (CR-1, HI-1; TG1.8)", () => {
  it("rejects every uncredentialed or wrong-credential request with 401 and admits exactly the per-install token", async () => {
    await withTestHarness(
      { requirePublicApiCapability: true },
      async (harness) => {
        const token = (
          await readFile(
            join(harness.config.dataDir, PUBLIC_API_CAPABILITY_FILE_NAME),
            "utf8",
          )
        ).trim();

        await fc.assert(
          fc.asyncProperty(
            fc.option(fc.string({ minLength: 1 }), { nil: undefined }),
            fc.constantFrom("x-bb-capability", "authorization"),
            async (wrongToken, channel) => {
              const headers: Record<string, string> =
                channel === "x-bb-capability"
                  ? { "x-bb-capability": wrongToken ?? "" }
                  : { authorization: `Bearer ${wrongToken ?? ""}` };
              const response = await harness.app.request("/api/v1/threads", {
                headers,
              });
              expect(response.status).toBe(401);
            },
          ),
          { numRuns: 30 },
        );

        const headerAllowed = await harness.app.request("/api/v1/threads", {
          headers: { "x-bb-capability": token },
        });
        expect(headerAllowed.status).toBe(200);
        const bearerAllowed = await harness.app.request("/api/v1/threads", {
          headers: { authorization: `Bearer ${token}` },
        });
        expect(bearerAllowed.status).toBe(200);
      },
    );
  });
  it.todo(
    "SP-1 residual (TG2.7): denied requests cause zero side effects — no file reads, PTY spawns, or DB writes (deployment-test scope)",
  );
});

describe("SP-1 credential extraction (TG1.9)", () => {
  it("never authenticates a fabricated credential in either channel", async () => {
    await withTestHarness(
      { requirePublicApiCapability: true },
      async (harness) => {
        const token = (
          await readFile(
            join(harness.config.dataDir, PUBLIC_API_CAPABILITY_FILE_NAME),
            "utf8",
          )
        ).trim();

        await fc.assert(
          fc.asyncProperty(
            fc.string({ minLength: 1, maxLength: 64 }),
            fc.constantFrom("header", "bearer"),
            async (fabricated, channel) => {
              // The token is 43-char base64url, so arbitrary strings are
              // vanishingly unlikely to collide; assert the invariant.
              expect(fabricated).not.toBe(token);

              const headers: Record<string, string> =
                channel === "header"
                  ? { "x-bb-capability": fabricated }
                  : { authorization: `Bearer ${fabricated}` };
              const response = await harness.app.request("/api/v1/threads", {
                headers,
              });
              expect(response.status).toBe(401);
            },
          ),
          { numRuns: 50 },
        );

        // Positive control: the real token authenticates in both channels.
        expect(
          (
            await harness.app.request("/api/v1/threads", {
              headers: { "x-bb-capability": token },
            })
          ).status,
        ).toBe(200);
        expect(
          (
            await harness.app.request("/api/v1/threads", {
              headers: { authorization: `Bearer ${token}` },
            })
          ).status,
        ).toBe(200);
      },
    );
  });
});

describe.skip("SP-2 path containment (HI-2 — activates with TG4.7)", () => {
  it.todo(
    "resolve(root, target) stays within canonical(root) or the request is rejected (traversal, symlinks, separators, UNC)",
  );
});

describe.skip("SP-3 credential validation (ME-1, ME-5 — activates with TG5.6, TG6.5)", () => {
  it.todo(
    "query-string tokens are always rejected; openExternal is invoked iff scheme ∈ {http, https} and sender is trusted",
  );
});

describe.skip("SP-4 state integrity and idempotency (HI-3, ME-2, ME-3 — activates with TG8.8, TG9.7)", () => {
  it.todo(
    "same idempotency key applied twice → provider effect exactly once; title and search segments never diverge; pin and section never partially commit",
  );
});

describe.skip("SP-5 capability security (HI-1 — activates with TG3.7)", () => {
  it.todo(
    "expired, wrong-owner, or wrong-target capability → every terminal REST/WS mutation rejected",
  );
});

describe("PBT harness smoke (TG0.2)", () => {
  it("bind-refusal gate admits exactly the loopback-or-explicitly-allowed binds", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(
          "127.0.0.1",
          "localhost",
          "[::1]",
          "0:0:0:0:0:0:0:1",
          "0.0.0.0",
          "192.168.1.50",
          "example.test",
          "::ffff:192.168.1.50",
        ),
        fc.boolean(),
        (bindHost, allowUnauthenticatedRemote) => {
          const refusal = nonLoopbackBindRefusal({
            bindHost,
            allowUnauthenticatedRemote,
          });
          if (isLoopbackHostname(bindHost) || allowUnauthenticatedRemote) {
            expect(refusal).toBeNull();
          } else {
            expect(refusal).toContain(bindHost);
            expect(refusal).toContain("BB_SERVER_ALLOW_NON_LOOPBACK");
          }
        },
      ),
    );
  });
});
