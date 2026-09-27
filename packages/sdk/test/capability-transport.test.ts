import { describe, expect, it, vi } from "vitest";
import { createNodeTransport } from "../src/node.js";
import { PUBLIC_API_CAPABILITY_HEADER_NAME } from "../src/transport.js";

describe("node transport capability header", () => {
  it("injects the capability header on every request when provided", async () => {
    const seen: string[] = [];
    const fetchStub = vi.fn(
      async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        seen.push(
          new Headers(init?.headers).get(PUBLIC_API_CAPABILITY_HEADER_NAME) ??
            "",
        );
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    );

    const transport = createNodeTransport({
      baseUrl: "http://127.0.0.1:1",
      capability: "token-value",
      fetch: fetchStub as unknown as typeof fetch,
    });
    await transport.api.v1.threads.$get().catch(() => undefined);

    expect(seen.length).toBeGreaterThan(0);
    for (const header of seen) {
      expect(header).toBe("token-value");
    }
  });

  it("does not inject the header when no capability is provided", async () => {
    const seen: (string | null)[] = [];
    const fetchStub = vi.fn(
      async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        seen.push(
          new Headers(init?.headers).get(PUBLIC_API_CAPABILITY_HEADER_NAME),
        );
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    );

    const transport = createNodeTransport({
      baseUrl: "http://127.0.0.1:1",
      fetch: fetchStub as unknown as typeof fetch,
    });
    await transport.api.v1.threads.$get().catch(() => undefined);

    expect(seen.length).toBeGreaterThan(0);
    for (const header of seen) {
      expect(header).toBeNull();
    }
  });
});
