import { createNodeBbSdk } from "@bb/sdk/node";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import {
  startTestServer,
  type RunningTestServer,
} from "../helpers/test-app.js";

const sockets = new Set<WebSocket>();
let server: RunningTestServer | null = null;

function websocketUrl(baseUrl: string, path: string): string {
  const url = new URL(path, baseUrl);
  url.protocol = "ws:";
  return url.href;
}

function openWebSocket(url: string, origin?: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket =
      origin === undefined
        ? new WebSocket(url)
        : new WebSocket(url, { origin });
    sockets.add(socket);
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

function rejectedWebSocketStatus(
  url: string,
  origin?: string,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket =
      origin === undefined
        ? new WebSocket(url)
        : new WebSocket(url, { origin });
    sockets.add(socket);
    socket.once("open", () =>
      reject(new Error(`WebSocket unexpectedly opened for ${origin}`)),
    );
    socket.once("unexpected-response", (_request, response) => {
      const status = response.statusCode;
      response.resume();
      if (status === undefined) {
        reject(new Error("WebSocket rejection omitted an HTTP status"));
        return;
      }
      resolve(status);
    });
    socket.once("error", () => {});
  });
}

async function closeSocket(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) {
    sockets.delete(socket);
    return;
  }
  await new Promise<void>((resolve) => {
    socket.once("close", resolve);
    socket.close();
  });
  sockets.delete(socket);
}

afterEach(async () => {
  for (const socket of sockets) {
    socket.terminate();
  }
  sockets.clear();
  if (server !== null) {
    await server.close();
    server = null;
  }
});

describe("browser WebSocket origin boundary", () => {
  it("rejects hostile browser origins on realtime and terminal sockets", async () => {
    server = await startTestServer();
    const realtimeUrl = websocketUrl(server.baseUrl, "/ws");
    const terminalUrl = websocketUrl(
      server.baseUrl,
      "/ws/terminals/known-to-attacker",
    );

    await expect(
      rejectedWebSocketStatus(realtimeUrl, "https://evil.example"),
    ).resolves.toBe(403);
    await expect(
      rejectedWebSocketStatus(terminalUrl, "https://evil.example"),
    ).resolves.toBe(403);
  });

  it("accepts trusted browser origins for both browser-facing sockets", async () => {
    server = await startTestServer({
      appUrl: "https://bb.example.test",
      devAppPort: 5173,
    });
    const realtimeUrl = websocketUrl(server.baseUrl, "/ws");
    const terminalUrl = websocketUrl(
      server.baseUrl,
      "/ws/terminals/missing-terminal",
    );

    const sameOrigin = await openWebSocket(realtimeUrl, server.baseUrl);
    await closeSocket(sameOrigin);

    const configuredApp = await openWebSocket(
      realtimeUrl,
      "https://bb.example.test",
    );
    await closeSocket(configuredApp);

    const devOrigin = new URL(server.baseUrl);
    devOrigin.port = "5173";
    const dev = await openWebSocket(realtimeUrl, devOrigin.origin);
    await closeSocket(dev);

    // TG3: the terminal socket's origin boundary passes for trusted origins;
    // the next layer (terminal capability) rejects the missing terminal with
    // 401. A 403 here would mean the origin boundary regressed.
    await expect(
      rejectedWebSocketStatus(terminalUrl, server.baseUrl),
    ).resolves.toBe(401);
  });

  it("keeps absent-Origin Node SDK realtime and CLI terminal sockets working", async () => {
    server = await startTestServer();
    const sdk = createNodeBbSdk({ baseUrl: server.baseUrl });

    let stopTarget = (): void => {};
    let stopConnection = (): void => {};
    const connected = new Promise<void>((resolve) => {
      stopConnection = sdk.subscribe({
        event: "realtime:connection",
        callback: (event) => {
          if (event.state === "connected") {
            resolve();
          }
        },
      });
      stopTarget = sdk.subscribe({
        event: "system:changed",
        callback: () => {},
      });
    });
    await connected;
    stopTarget();
    stopConnection();

    // TG3: the absent-origin terminal socket passes the origin boundary and
    // reaches the terminal capability layer (401, not 403). A CLI that needs
    // a terminal presents the terminal's capability token.
    await expect(
      rejectedWebSocketStatus(
        websocketUrl(server.baseUrl, "/ws/terminals/missing-terminal"),
      ),
    ).resolves.toBe(401);
  });
});
