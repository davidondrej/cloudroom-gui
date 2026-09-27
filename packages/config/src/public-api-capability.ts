import { join } from "node:path";

export const PUBLIC_API_CAPABILITY_FILE_NAME = "public-api-capability";

export function publicApiCapabilityFilePath(args: { dataDir: string }): string {
  return join(args.dataDir, PUBLIC_API_CAPABILITY_FILE_NAME);
}
