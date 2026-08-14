import { env } from "cloudflare:workers";

const encoder = new TextEncoder();

export class HttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

function base64UrlEncode(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function base64UrlDecode(value: string) {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - value.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export async function sha256(value: string) {
  const hash = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function secureEqual(left: string, right: string) {
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  let mismatch = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) mismatch |= (a[index] ?? 0) ^ (b[index] ?? 0);
  return mismatch === 0;
}

async function hmac(value: string, candidateSecret?: string) {
  const secret = candidateSecret?.trim() || env.RUN_SESSION_SECRET?.trim();
  if (!secret || secret.length < 32) throw new HttpError(503, "Run sessions are not configured");
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
}

export async function createRunToken(teamId: string, ttlSeconds = 60 * 60) {
  const payload = base64UrlEncode(encoder.encode(JSON.stringify({ v: 1, kid: env.RUN_SESSION_SECRET_ID?.trim() || "current", teamId, exp: Math.floor(Date.now() / 1000) + ttlSeconds })));
  return `${payload}.${base64UrlEncode(await hmac(payload))}`;
}

async function verifyRunToken(token: string) {
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra) throw new HttpError(401, "Invalid run session");
  const current = base64UrlEncode(await hmac(payload));
  const previousSecret = env.RUN_SESSION_SECRET_PREVIOUS?.trim();
  const previous = previousSecret ? base64UrlEncode(await hmac(payload, previousSecret)) : "";
  if (!secureEqual(signature, current) && (!previous || !secureEqual(signature, previous))) throw new HttpError(401, "Invalid run session");
  try {
    const parsed = JSON.parse(new TextDecoder().decode(base64UrlDecode(payload))) as { v?: number; teamId?: string; exp?: number };
    if (parsed.v !== 1 || typeof parsed.teamId !== "string" || typeof parsed.exp !== "number" || !Number.isFinite(parsed.exp) || parsed.exp <= Date.now() / 1000) {
      throw new HttpError(401, "Run session expired");
    }
    return { teamId: parsed.teamId, exp: Number(parsed.exp) };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(401, "Invalid run session");
  }
}

export function isLocalDevelopmentRequest(request: Request) {
  if (env.ARBOR_LOCAL_DEV !== "1") return false;
  const hostname = new URL(request.url).hostname.toLowerCase();
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}

export type StoredTeamConfig = {
  teamName: string;
  architecture: string;
  agents: Array<{ id: string; name: string; role: string; responsibility: string; avatar?: string; color?: string }>;
};

export async function authorizeRun(request: Request, requestedTeamId?: string) {
  if (isLocalDevelopmentRequest(request)) return { local: true as const, teamId: undefined, team: undefined };
  const authorization = request.headers.get("authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) throw new HttpError(401, "Run authorization required");
  const session = await verifyRunToken(authorization.slice(7).trim());
  if (requestedTeamId && requestedTeamId !== session.teamId) throw new HttpError(403, "Run session does not match this team");

  const row = await env.DB.prepare("SELECT team_config, expires_at, revoked_at FROM shared_teams WHERE id = ?")
    .bind(session.teamId)
    .first<{ team_config: string; expires_at: string | null; revoked_at: string | null }>();
  if (!row || row.revoked_at || (row.expires_at && new Date(row.expires_at).getTime() <= Date.now())) {
    throw new HttpError(403, "Share link unavailable");
  }
  let team: StoredTeamConfig;
  try {
    team = JSON.parse(row.team_config) as StoredTeamConfig;
  } catch {
    throw new HttpError(500, "Stored team configuration is invalid");
  }
  if (!Array.isArray(team.agents) || team.agents.length < 2) throw new HttpError(500, "Stored team configuration is invalid");
  return { local: false as const, teamId: session.teamId, team };
}

export async function readJsonLimited<T>(request: Request, maxBytes: number): Promise<T> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > maxBytes) throw new HttpError(413, "Request body is too large");
  if (!request.body) throw new HttpError(400, "Request body is required");
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new HttpError(413, "Request body is too large");
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new HttpError(400, "Invalid JSON body");
  }
}

function requestIdentity(request: Request) {
  return request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}

export async function enforceRateLimit(request: Request, scope: string, limit: number, windowSeconds: number, identity?: string) {
  await consumeQuota(request, scope, limit, windowSeconds, 1, identity);
}

export async function consumeQuota(request: Request, scope: string, limit: number, windowSeconds: number, units: number, identity?: string) {
  const secret = env.RUN_SESSION_SECRET?.trim();
  if (!secret || secret.length < 32) throw new HttpError(503, "Rate limiting is not configured");
  const rawIdentity = identity || requestIdentity(request);
  const key = await sha256(`${secret}:${scope}:${rawIdentity}`);
  const bucket = Math.floor(Date.now() / (windowSeconds * 1000));
  const expiresAt = new Date((bucket + 2) * windowSeconds * 1000).toISOString();
  const row = await env.DB.prepare(
    "INSERT INTO api_rate_limits (key, bucket, count, expires_at) VALUES (?, ?, ?, ?) ON CONFLICT(key, bucket) DO UPDATE SET count = count + excluded.count RETURNING count",
  ).bind(key, bucket, Math.max(1, Math.ceil(units)), expiresAt).first<{ count: number }>();
  if ((row?.count ?? limit + 1) > limit) throw new HttpError(429, "Too many requests; please try again later");
  if (crypto.getRandomValues(new Uint8Array(1))[0] < 4) {
    await env.DB.prepare("DELETE FROM api_rate_limits WHERE expires_at < ?").bind(new Date().toISOString()).run();
  }
}

export function authenticatedUserId(request: Request) {
  const value = request.headers.get("oai-authenticated-user-id")?.trim() || request.headers.get("cf-access-authenticated-user-email")?.trim().toLowerCase();
  return value ? value.slice(0, 240) : undefined;
}

export async function authenticatedUserHash(request: Request) {
  const userId = authenticatedUserId(request);
  const secret = env.RUN_SESSION_SECRET?.trim();
  return userId && secret ? sha256(`${secret}:publisher:${userId}`) : undefined;
}

export function errorResponse(error: unknown, fallback: string) {
  if (error instanceof HttpError) return Response.json({ error: error.message }, { status: error.status, headers: { "cache-control": "no-store" } });
  console.error(fallback, error);
  return Response.json({ error: fallback }, { status: 500, headers: { "cache-control": "no-store" } });
}
