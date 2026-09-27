import { createApiClient } from "@bb/server-contract";
import {
  readJsonResponse,
  readVoidResponse,
  resolveResponse,
} from "./response.js";
import type { BbSdkTransport, CreateHttpTransportArgs } from "./transport.js";
import { PUBLIC_API_CAPABILITY_HEADER_NAME } from "./transport.js";

const SAME_ORIGIN_BASE_URL = "";

function createCapabilityFetch(
  capability: string,
  fetchImpl: typeof fetch,
): typeof fetch {
  return (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set(PUBLIC_API_CAPABILITY_HEADER_NAME, capability);
    return fetchImpl(input, { ...init, headers });
  };
}

export function createHttpTransport(
  args: CreateHttpTransportArgs,
): BbSdkTransport {
  const baseUrl = args.baseUrl ?? SAME_ORIGIN_BASE_URL;
  const fetchImpl =
    args.capability === undefined
      ? (args.fetch ?? fetch)
      : createCapabilityFetch(args.capability, args.fetch ?? fetch);
  const client = createApiClient(baseUrl, { fetch: fetchImpl });

  return {
    api: client.api,
    baseUrl,
    fetch: fetchImpl,
    ...(args.realtimeUrl ? { realtimeUrl: args.realtimeUrl } : {}),
    runtime: args.runtime,
    websocket: args.websocket,
    readJson: readJsonResponse,
    readVoid: readVoidResponse,
    resolve: resolveResponse,
  };
}
