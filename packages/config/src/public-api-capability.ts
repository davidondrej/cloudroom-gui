import { join } from "node:path";

export const PUBLIC_API_CAPABILITY_FILE_NAME = "public-api-capability";

export function publicApiCapabilityFilePath(args: { dataDir: string }): string {
  return join(args.dataDir, PUBLIC_API_CAPABILITY_FILE_NAME);
}

export const CAPABILITY_COOKIE_NAME = "bb_capability";

export function formatCapabilityCookie(args: { token: string }): string {
  return `${CAPABILITY_COOKIE_NAME}=${args.token}; HttpOnly; SameSite=Strict; Path=/`;
}

export function readCapabilityCookie(args: {
  cookieHeader: string | undefined;
}): string | undefined {
  const cookieHeader = args.cookieHeader;
  if (cookieHeader === undefined) {
    return undefined;
  }
  for (const pair of cookieHeader.split(";")) {
    const separator = pair.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const name = pair.slice(0, separator).trim();
    if (name === CAPABILITY_COOKIE_NAME) {
      const value = pair.slice(separator + 1).trim();
      return value.length > 0 ? value : undefined;
    }
  }
  return undefined;
}
