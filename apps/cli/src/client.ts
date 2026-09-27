import { isLoopbackHostname } from "@bb/config/loopback";
import { publicApiCapabilityFilePath } from "@bb/config/public-api-capability";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { BB_PROD_DATA_DIR_NAME } from "@bb/config/runtime";
import { createNodeBbSdk, type BbSdk } from "@bb/sdk/node";
import type { Dispatcher } from "undici";

type CliRequestInit = RequestInit & { dispatcher?: Dispatcher };

export function cliFetch(
  input: RequestInfo | URL,
  init?: CliRequestInit,
): Promise<Response> {
  return fetch(input, init);
}

// The capability token authorizes the local server only; never send it to a
// remote ROOM_SERVER_URL (Connect gateway or a LAN host).
function readLocalCapabilityForBaseUrl(baseUrl: string): string | undefined {
  let hostname: string;
  try {
    hostname = new URL(baseUrl).hostname;
  } catch {
    return undefined;
  }
  if (!isLoopbackHostname(hostname)) {
    return undefined;
  }
  const dataDir =
    process.env.BB_DATA_DIR ?? join(homedir(), BB_PROD_DATA_DIR_NAME);
  const filePath = publicApiCapabilityFilePath({ dataDir });
  if (!existsSync(filePath)) {
    return undefined;
  }
  const token = readFileSync(filePath, "utf8").trim();
  return token.length > 0 ? token : undefined;
}

export function createCliBbSdk(baseUrl: string): BbSdk {
  return createNodeBbSdk({
    baseUrl,
    capability: readLocalCapabilityForBaseUrl(baseUrl),
    fetch: cliFetch,
  });
}
