import {
  APP_SURFACE_DESKTOP,
  APP_SURFACE_HEADER_NAME,
  APP_SURFACE_WEB,
  type RequestAppSurface,
} from "@bb/config/app-surface";
import { isInsideNativeShell } from "@/lib/native-shell";
import {
  getTerminalCapability,
  storeTerminalCapability,
} from "@/lib/terminal-capability-store";

const APP_SURFACE_MOBILE: RequestAppSurface = "mobile";

export function getAppSurface(): RequestAppSurface {
  if (typeof window !== "undefined" && window.bbDesktop !== undefined) {
    return APP_SURFACE_DESKTOP;
  }
  if (isInsideNativeShell()) {
    return APP_SURFACE_MOBILE;
  }
  return APP_SURFACE_WEB;
}

export function appSurfaceRequestInit(init?: RequestInit): RequestInit {
  const headers = new Headers(init?.headers);
  headers.set(APP_SURFACE_HEADER_NAME, getAppSurface());
  return {
    ...init,
    headers,
  };
}

// TG3 (HI-1): terminal mutations and output reads require the terminal's own
// short-lifetime capability (issued at creation, re-issued on authenticated
// GET). Inject it from the in-memory store when the URL addresses a terminal.
const TERMINAL_URL_PATTERN = /\/api\/v1\/terminals\/([^/?]+)/u;

function terminalCapabilityFor(
  input: Parameters<typeof fetch>[0],
): string | undefined {
  const path =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.pathname + input.search
        : input.url;
  const match = TERMINAL_URL_PATTERN.exec(path);
  if (match === null) {
    return undefined;
  }
  return getTerminalCapability(decodeURIComponent(match[1]));
}

export async function ensureTerminalCapability(
  terminalId: string,
): Promise<string> {
  const existing = getTerminalCapability(terminalId);
  if (existing !== undefined) {
    return existing;
  }
  const response = await fetchWithAppSurface(
    `/api/v1/terminals/${encodeURIComponent(terminalId)}`,
  );
  if (!response.ok) {
    throw new Error(
      `Failed to obtain the terminal capability (${String(response.status)})`,
    );
  }
  const body = (await response.json()) as {
    capability?: { token?: string };
  };
  const token = body.capability?.token;
  if (token === undefined || token.length === 0) {
    throw new Error("Terminal capability was not issued");
  }
  storeTerminalCapability(terminalId, token);
  return token;
}

export function fetchWithAppSurface(
  input: Parameters<typeof fetch>[0],
  init?: RequestInit,
): ReturnType<typeof fetch> {
  const terminalCapability = terminalCapabilityFor(input);
  const request = () =>
    fetch(
      input,
      appSurfaceRequestInit(mergeTerminalCapability(init, terminalCapability)),
    );
  const first = request();
  const terminalId =
    terminalCapability === undefined ? undefined : terminalIdFor(input);
  if (terminalId === undefined) {
    return first;
  }
  // Expired capability: re-issue via the authenticated GET and retry once.
  return first.then(async (response) => {
    if (response.status !== 401) {
      return response;
    }
    const code = await response
      .clone()
      .json()
      .then((body: unknown) =>
        typeof body === "object" && body !== null && "code" in body
          ? (body as { code: unknown }).code
          : undefined,
      )
      .catch(() => undefined);
    if (code !== "missing_or_invalid_terminal_capability") {
      return response;
    }
    try {
      const token = await ensureTerminalCapability(terminalId);
      return await fetch(
        input,
        appSurfaceRequestInit(mergeTerminalCapability(init, token)),
      );
    } catch {
      return response;
    }
  });
}

function terminalIdFor(input: Parameters<typeof fetch>[0]): string | undefined {
  const path =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.pathname + input.search
        : input.url;
  const match = TERMINAL_URL_PATTERN.exec(path);
  return match === null ? undefined : decodeURIComponent(match[1]);
}

function mergeTerminalCapability(
  init: RequestInit | undefined,
  token: string | undefined,
): RequestInit | undefined {
  if (token === undefined) {
    return init;
  }
  const headers = new Headers(init?.headers);
  headers.set("x-bb-terminal-capability", token);
  return { ...init, headers };
}
