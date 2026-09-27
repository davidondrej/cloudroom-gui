import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import {
  PUBLIC_API_CAPABILITY_FILE_NAME,
  readCapabilityCookie,
} from "@bb/config/public-api-capability";

export { PUBLIC_API_CAPABILITY_FILE_NAME };
const CAPABILITY_TOKEN_BYTES = 32;

export interface PublicApiCapabilityService {
  token: string;
  verify(presented: string | undefined): boolean;
}

export function presentedCapability(
  header: (name: string) => string | undefined,
): string | undefined {
  const direct = header("x-bb-capability");
  if (direct !== undefined && direct.trim().length > 0) {
    return direct.trim();
  }
  const authorization = header("authorization");
  if (authorization !== undefined) {
    const normalized = authorization.trim();
    if (
      normalized.length > "bearer ".length &&
      normalized.slice(0, "bearer ".length).toLowerCase() === "bearer "
    ) {
      const bearer = normalized.slice("bearer ".length).trim();
      if (bearer.length > 0) {
        return bearer;
      }
    }
  }
  return readCapabilityCookie({ cookieHeader: header("cookie") });
}

export function loadOrCreatePublicApiCapability(args: {
  dataDir: string;
}): PublicApiCapabilityService {
  const filePath = join(args.dataDir, PUBLIC_API_CAPABILITY_FILE_NAME);
  let token = readStoredToken(filePath);
  if (token === null) {
    token = randomBytes(CAPABILITY_TOKEN_BYTES).toString("base64url");
    writeFileSync(filePath, `${token}\n`, { mode: 0o600 });
    chmodSync(filePath, 0o600);
  }
  return {
    token,
    verify(presented) {
      if (presented === undefined) {
        return false;
      }
      return constantTimeTokenEqual(presented, token);
    },
  };
}

function readStoredToken(filePath: string): string | null {
  if (!existsSync(filePath)) {
    return null;
  }
  const raw = readFileSync(filePath, "utf8").trim();
  return raw.length > 0 ? raw : null;
}

function constantTimeTokenEqual(presented: string, expected: string): boolean {
  const presentedDigest = createHash("sha256").update(presented).digest();
  const expectedDigest = createHash("sha256").update(expected).digest();
  return timingSafeEqual(presentedDigest, expectedDigest);
}
