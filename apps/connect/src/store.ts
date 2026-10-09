const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";
const HANDLE_ALPHABET = "abcdefghjkmnpqrstvwxyz23456789";
const SERVER_CACHE_MS = 15_000;
const SESSION_CACHE_MS = 20_000;
const SEEN_WRITE_INTERVAL_MS = 60_000;
export const PHONE_CODE_TTL_MS = 10 * 60_000;
export const SHARE_CODE_TTL_MS = 60_000;
export const SESSION_TTL_MS = 365 * 24 * 60 * 60_000;

export interface Server {
  id: string;
  userId: string;
  handle: string;
  credentialHash: string;
  lastSeenAt: number | null;
}

export interface Session {
  serverId: string;
  target: string | null;
}

interface Cached<T> {
  value: Promise<T>;
  expires: number;
}

const servers = new Map<string, Cached<Server | null>>();
const sessions = new Map<string, Cached<Session | null>>();
const seenWrites = new Map<string, number>();

function cached<T>(
  map: Map<string, Cached<T>>,
  key: string,
  ttl: number,
  load: () => Promise<T>,
  fresh = false,
): Promise<T> {
  const now = Date.now();
  const hit = map.get(key);
  if (!fresh && hit && hit.expires > now) return hit.value;
  const value = load();
  map.set(key, { value, expires: now + ttl });
  value.catch(() => map.delete(key));
  return value;
}

function randomString(alphabet: string, length: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return [...bytes].map((byte) => alphabet[byte % alphabet.length]).join("");
}

function randomToken(): string {
  return [...crypto.getRandomValues(new Uint8Array(32))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function normalizeCode(raw: string): string | null {
  const code = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return code.length === 8 && [...code].every((c) => CODE_ALPHABET.includes(c))
    ? code
    : null;
}

export function formatCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

interface ServerRow {
  id: string;
  user_id: string;
  handle: string;
  credential_hash: string;
  last_seen_at: number | null;
}

function toServer(row: ServerRow | null): Server | null {
  return row
    ? {
        id: row.id,
        userId: row.user_id,
        handle: row.handle,
        credentialHash: row.credential_hash,
        lastSeenAt: row.last_seen_at,
      }
    : null;
}

export function serverByHandle(
  db: D1Database,
  handle: string,
  fresh = false,
): Promise<Server | null> {
  return cached(
    servers,
    handle,
    SERVER_CACHE_MS,
    async () =>
      toServer(
        await db
          .prepare("SELECT * FROM server WHERE handle = ?")
          .bind(handle)
          .first<ServerRow>(),
      ),
    fresh,
  );
}

export async function serverByCredential(
  db: D1Database,
  credential: string,
): Promise<Server | null> {
  if (!credential) return null;
  return toServer(
    await db
      .prepare("SELECT * FROM server WHERE credential_hash = ?")
      .bind(await sha256Hex(credential))
      .first<ServerRow>(),
  );
}

export async function registerServer(
  db: D1Database,
  userId: string,
  installId: string,
): Promise<{ handle: string; credential: string }> {
  const credential = randomToken();
  const credentialHash = await sha256Hex(credential);
  const existing = await db
    .prepare(
      "UPDATE server SET credential_hash = ? WHERE user_id = ? AND install_id = ? RETURNING handle",
    )
    .bind(credentialHash, userId, installId)
    .first<{ handle: string }>();
  if (existing) {
    servers.delete(existing.handle);
    return { handle: existing.handle, credential };
  }
  const handle = randomString(HANDLE_ALPHABET, 10);
  await db
    .prepare(
      "INSERT INTO server (id, user_id, install_id, handle, credential_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(crypto.randomUUID(), userId, installId, handle, credentialHash, Date.now())
    .run();
  return { handle, credential };
}

export async function markServerSeen(
  db: D1Database,
  serverId: string,
): Promise<void> {
  const now = Date.now();
  const previous = seenWrites.get(serverId);
  if (previous !== undefined && now - previous < SEEN_WRITE_INTERVAL_MS) return;
  seenWrites.set(serverId, now);
  await db
    .prepare("UPDATE server SET last_seen_at = ? WHERE id = ?")
    .bind(now, serverId)
    .run();
}

export async function createCode(
  db: D1Database,
  serverId: string,
  target: string | null,
  ttlMs: number,
): Promise<{ code: string; expiresAt: number }> {
  const now = Date.now();
  const code = randomString(CODE_ALPHABET, 8);
  const expiresAt = now + ttlMs;
  await db.batch([
    db.prepare("DELETE FROM code WHERE expires_at < ?").bind(now),
    db
      .prepare(
        "INSERT INTO code (code_hash, server_id, target, expires_at) VALUES (?, ?, ?, ?)",
      )
      .bind(await sha256Hex(code), serverId, target, expiresAt),
  ]);
  return { code, expiresAt };
}

export async function codeHandle(
  db: D1Database,
  code: string,
): Promise<string | null> {
  const row = await db
    .prepare(
      "SELECT server.handle FROM code JOIN server ON server.id = code.server_id WHERE code.code_hash = ? AND code.target IS NULL AND code.expires_at > ?",
    )
    .bind(await sha256Hex(code), Date.now())
    .first<{ handle: string }>();
  return row?.handle ?? null;
}

export async function consumeCode(
  db: D1Database,
  code: string,
  serverId: string,
  target: string | null,
): Promise<boolean> {
  const row = await db
    .prepare(
      "DELETE FROM code WHERE code_hash = ? AND server_id = ? AND target IS ? AND expires_at > ? RETURNING server_id",
    )
    .bind(await sha256Hex(code), serverId, target, Date.now())
    .first<{ server_id: string }>();
  return row !== null;
}

export async function createSession(
  db: D1Database,
  serverId: string,
  target: string | null,
): Promise<string> {
  const now = Date.now();
  const token = randomToken();
  await db.batch([
    db.prepare("DELETE FROM session WHERE expires_at < ?").bind(now),
    db
      .prepare(
        "INSERT INTO session (token_hash, server_id, target, expires_at, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .bind(await sha256Hex(token), serverId, target, now + SESSION_TTL_MS, now),
  ]);
  return token;
}

export function sessionByToken(
  db: D1Database,
  token: string,
): Promise<Session | null> {
  return cached(sessions, token, SESSION_CACHE_MS, async () => {
    const row = await db
      .prepare(
        "SELECT server_id, target FROM session WHERE token_hash = ? AND expires_at > ?",
      )
      .bind(await sha256Hex(token), Date.now())
      .first<{ server_id: string; target: string | null }>();
    return row ? { serverId: row.server_id, target: row.target } : null;
  });
}

export async function revokeSessions(
  db: D1Database,
  serverId: string,
): Promise<number> {
  sessions.clear();
  const result = await db
    .prepare("DELETE FROM session WHERE server_id = ?")
    .bind(serverId)
    .run();
  return result.meta.changes;
}
