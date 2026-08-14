import { env } from "cloudflare:workers";

async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function ensureSharedTeamsTable() {
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS shared_teams (id TEXT PRIMARY KEY NOT NULL, team_config TEXT NOT NULL, access_code_hash TEXT NOT NULL, owner_token_hash TEXT, expires_at TEXT, revoked_at TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL)").run();
}

export async function POST(request: Request) {
  try {
    await ensureSharedTeamsTable();
    const payload = (await request.json()) as { teamId?: string; accessCode?: string };
    if (!payload.teamId) return Response.json({ error: "The share link is missing the team ID; please copy the full link again" }, { status: 400 });
    if (!payload.accessCode?.trim()) return Response.json({ error: "Please enter the access code" }, { status: 400 });
    const record = await env.DB.prepare("SELECT team_config, access_code_hash, expires_at, revoked_at FROM shared_teams WHERE id = ?")
      .bind(payload.teamId)
      .first<{ team_config: string; access_code_hash: string; expires_at: string | null; revoked_at: string | null }>();
    if (!record || (await sha256(payload.accessCode.trim().toUpperCase())) !== record.access_code_hash) {
      return Response.json({ error: "The link or access code is incorrect" }, { status: 403 });
    }
    if (record.revoked_at) return Response.json({ error: "This share link has been disabled by its creator" }, { status: 403 });
    if (record.expires_at && new Date(record.expires_at).getTime() <= Date.now()) return Response.json({ error: "This share link has expired" }, { status: 403 });
    return Response.json({ team: JSON.parse(record.team_config) });
  } catch (error) {
    console.error("Unable to verify access code", error);
    return Response.json({ error: "Unable to verify access right now" }, { status: 500 });
  }
}
