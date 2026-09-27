import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PUBLIC_API_CAPABILITY_FILE_NAME } from "../../src/services/public-api-capability.js";
import { withTestHarness } from "../helpers/test-app.js";

/**
 * Permanent invariant from verdict-04 advisory 1 (TG1 round 3 follow-up):
 * no /api/v1 route may return the capability token in a response body or
 * headers. The capability is a secret between local processes (0600 token
 * file); round 3 removed the one route that handed it out over HTTP. This
 * test encodes the property as a sweep over every mounted GET route, so any
 * future issuance mechanism — regardless of the path chosen — fails here.
 *
 * GET-only by design: GETs are read-only, so executing them with a valid
 * credential is safe, while POST/PUT sweeps could spawn terminals or mutate
 * state. The round-1/round-2 defects were both reachable via GET.
 */
describe("capability token leak sweep (verdict-04 advisory)", () => {
  it("no /api/v1 GET route returns the token in body or headers", async () => {
    await withTestHarness(
      { requirePublicApiCapability: true },
      async (harness) => {
        const token = (
          await readFile(
            join(harness.config.dataDir, PUBLIC_API_CAPABILITY_FILE_NAME),
            "utf8",
          )
        ).trim();

        const getPaths = [
          ...new Set(
            harness.app.routes
              .filter(
                (route) =>
                  route.method === "GET" && route.path.startsWith("/api/v1"),
              )
              .map((route) => route.path),
          ),
        ];
        // Sanity: the sweep must cover a real route population. The verdict-04
        // sweep enumerated 102 authenticated GET routes on the full tree.
        expect(getPaths.length).toBeGreaterThan(50);

        for (const path of getPaths) {
          const response = await harness.app.request(path, {
            headers: { "x-bb-capability": token },
          });
          const body = await response.text();
          expect(
            body.includes(token),
            `GET ${path} leaked the capability token in its body`,
          ).toBe(false);
          for (const [name, value] of response.headers.entries()) {
            expect(
              value.includes(token),
              `GET ${path} leaked the capability token in the ${name} header`,
            ).toBe(false);
          }
        }
      },
    );
  });
});
