import {
  APP_SURFACE_DESKTOP,
  APP_SURFACE_HEADER_NAME,
  APP_SURFACE_WEB,
  type RequestAppSurface,
} from "@bb/config/app-surface";
import { isInsideNativeShell } from "@/lib/native-shell";

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

const CAPABILITY_BOOTSTRAP_PATH = "/api/v1/system/capability-bootstrap";
let capabilityBootstrapPromise: Promise<boolean> | null = null;

function bootstrapCapability(): Promise<boolean> {
  capabilityBootstrapPromise ??= (async () => {
    try {
      const response = await fetch(CAPABILITY_BOOTSTRAP_PATH);
      return response.status === 204;
    } catch {
      return false;
    }
  })();
  return capabilityBootstrapPromise;
}

export function fetchWithAppSurface(
  input: Parameters<typeof fetch>[0],
  init?: RequestInit,
): ReturnType<typeof fetch> {
  const request = () => fetch(input, appSurfaceRequestInit(init));
  const first = request();
  if (typeof window === "undefined") {
    return first;
  }
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
    if (code !== "missing_or_invalid_capability") {
      return response;
    }
    if (!(await bootstrapCapability())) {
      return response;
    }
    try {
      return await request();
    } catch {
      return response;
    }
  });
}
