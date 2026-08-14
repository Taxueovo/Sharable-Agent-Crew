import { env } from "cloudflare:workers";

async function sha256(value: string) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function ensureUsageTable() {
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS team_usage_logs (id TEXT PRIMARY KEY NOT NULL, team_id TEXT NOT NULL, task TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL)").run();
  await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_team_usage_logs_team_created ON team_usage_logs (team_id, created_at)").run();
}

export async function POST(request: Request) {
  try {
    await ensureUsageTable();
    const payload = await request.json() as { teamId?: string; accessCode?: string; task?: string };
    const task = payload.task?.trim();
    if (!payload.teamId || !payload.accessCode?.trim() || !task) return Response.json({ error: "Incomplete logging information" }, { status: 400 });
    const team = await env.DB.prepare("SELECT access_code_hash, expires_at, revoked_at FROM shared_teams WHERE id = ?")
      .bind(payload.teamId)
      .first<{ access_code_hash: string; expires_at: string | null; revoked_at: string | null }>();
    if (!team || await sha256(payload.accessCode.trim().toUpperCase()) !== team.access_code_hash) return Response.json({ error: "Not authorized to log this team's tasks" }, { status: 403 });
    if (team.revoked_at || (team.expires_at && new Date(team.expires_at).getTime() <= Date.now())) return Response.json({ error: "Share link unavailable" }, { status: 403 });
    await env.DB.prepare("INSERT INTO team_usage_logs (id, team_id, task) VALUES (?, ?, ?)")
      .bind(crypto.randomUUID().replaceAll("-", ""), payload.teamId, task.slice(0, 4000))
      .run();
    return Response.json({ recorded: true }, { status: 201 });
  } catch (error) {
    console.error("Unable to record team usage", error);
    return Response.json({ error: "Unable to record the task right now" }, { status: 500 });
  }
}
