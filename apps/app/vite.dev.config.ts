import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vite";
import { publicApiCapabilityFilePath } from "@bb/config/public-api-capability";
import { loadViteDevConfig } from "@bb/config/vite-dev";
import { sharedViteConfig } from "./vite.config.js";

const viteDevConfig = loadViteDevConfig();
const devWebSocketBrowserHostPortDefine = JSON.stringify(
  viteDevConfig.serverPort,
);

// The local server requires the per-install capability on /api/v1 and /ws.
// The Vite process is started by run-dev with BB_DATA_DIR set, so it can read
// the 0600 token file the server writes and inject the credential into
// proxied requests on behalf of plain browsers. Lazy + memoized: the server
// may create the file after Vite starts.
let capabilityToken: string | undefined;
let capabilityTokenResolved = false;
function resolveCapabilityToken(): string | undefined {
  if (!capabilityTokenResolved) {
    capabilityTokenResolved = true;
    const dataDir =
      process.env.BB_DATA_DIR ?? join(homedir(), ".gui-cloudroom");
    const filePath = publicApiCapabilityFilePath({ dataDir });
    try {
      if (existsSync(filePath)) {
        const token = readFileSync(filePath, "utf8").trim();
        capabilityToken = token.length > 0 ? token : undefined;
      }
    } catch {
      capabilityToken = undefined;
    }
  }
  return capabilityToken;
}

function injectCapabilityHeader(proxy: {
  on(
    event: "proxyReq" | "proxyReqWs",
    listener: (proxyReq: {
      setHeader(name: string, value: string): void;
    }) => void,
  ): void;
}): void {
  proxy.on("proxyReq", (proxyReq) => {
    const token = resolveCapabilityToken();
    if (token !== undefined) {
      proxyReq.setHeader("x-bb-capability", token);
    }
  });
  proxy.on("proxyReqWs", (proxyReq) => {
    const token = resolveCapabilityToken();
    if (token !== undefined) {
      proxyReq.setHeader("x-bb-capability", token);
    }
  });
}

export default defineConfig({
  ...sharedViteConfig,
  css: {
    transformer: "lightningcss",
  },
  define: {
    __BB_DEV_WS_BROWSER_HOST_PORT__: devWebSocketBrowserHostPortDefine,
    __BB_DEV_APP_BROWSER_HOST_PORT__: JSON.stringify(viteDevConfig.appPort),
  },
  server: {
    allowedHosts: [".ts.net"],
    host: viteDevConfig.appHost,
    port: viteDevConfig.appPort,
    proxy: {
      "/api": {
        target: viteDevConfig.serverHttpOrigin,
        changeOrigin: true,
        xfwd: true,
        configure: injectCapabilityHeader,
      },
      "/ws": {
        target: viteDevConfig.serverHttpOrigin,
        changeOrigin: true,
        ws: true,
        xfwd: true,
        configure: injectCapabilityHeader,
      },
    },
  },
});
