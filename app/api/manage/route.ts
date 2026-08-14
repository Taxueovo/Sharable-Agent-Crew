import { env } from "cloudflare:workers";
import { corsHeaders, optionsResponse } from "@/lib/cors";

async function sha256(value: string) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Admin token validation. ADMIN_TOKEN is set on Cloudflare with `wrangler secret put ADMIN_TOKEN`
 * (do not write it into a .env file that gets distributed). Admins can list, disable, or delete any
 * published version in the database without being bound by ownerToken — this is the source of the
 * "host/ops" capability to clean up versions shared by others.
 */
async function isAdmin(provided: unknown): Promise<boolean> {
  const expected = env.ADMIN_TOKEN?.trim();
  if (!expected || typeof provided !== "string" || !provided.trim()) return false;
  return await sha256(provided.trim()) === await sha256(expected);
}

export async function OPTIONS() {
  return optionsResponse();
}

export async function POST(request: Request) {
  try {
    await env.DB.prepare("CREATE TABLE IF NOT EXISTS team_usage_logs (id TEXT PRIMARY KEY NOT NULL, team_id TEXT NOT NULL, task TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL)").run();
    await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_team_usage_logs_team_created ON team_usage_logs (team_id, created_at)").run();
    const payload = await request.json() as { teamId?: string; ownerToken?: string; adminToken?: string; action?: "list" | "listAll" | "update" | "delete"; expiresAt?: string | null; revoked?: boolean };
    if (!payload.action) return Response.json({ error: "Incomplete management credentials" }, { status: 400, headers: corsHeaders() });
    const admin = await isAdmin(payload.adminToken);

    // Admin: list every published version in the database (including ones shared by others), with usage counts.
    if (payload.action === "listAll") {
      if (!admin) return Response.json({ error: "Not authorized to manage this share link" }, { status: 403, headers: corsHeaders() });
      const rows = await env.DB.prepare("SELECT id, team_config, expires_at, revoked_at, created_at FROM shared_teams ORDER BY created_at DESC LIMIT 200")
        .all<{ id: string; team_config: string; expires_at: string | null; revoked_at: string | null; created_at: string }>();
      const teams: Array<{ teamId: string; teamName: string; createdAt: string; expiresAt: string | null; revokedAt: string | null; usageCount: number }> = [];
      for (const row of rows.results ?? []) {
        let teamName = "Untitled team";
        try { teamName = (JSON.parse(row.team_config) as { teamName?: string }).teamName ?? teamName; } catch { /* ignore malformed config */ }
        const count = await env.DB.prepare("SELECT COUNT(*) AS c FROM team_usage_logs WHERE team_id = ?").bind(row.id).first<{ c: number }>();
        teams.push({ teamId: row.id, teamName, createdAt: row.created_at, expiresAt: row.expires_at, revokedAt: row.revoked_at, usageCount: count?.c ?? 0 });
      }
      return Response.json({ teams }, { headers: corsHeaders() });
    }

    if (!payload.teamId) return Response.json({ error: "Incomplete management credentials" }, { status: 400, headers: corsHeaders() });
    const team = await env.DB.prepare("SELECT team_config, owner_token_hash, expires_at, revoked_at, created_at FROM shared_teams WHERE id = ?")
      .bind(payload.teamId)
      .first<{ team_config: string; owner_token_hash: string | null; expires_at: string | null; revoked_at: string | null; created_at: string }>();
    if (!team) return Response.json({ error: "This version does not exist or has been deleted" }, { status: 404, headers: corsHeaders() });

    // Authorization: either the version creator (ownerToken) or the global admin (adminToken).
    const owner = Boolean(team.owner_token_hash) && typeof payload.ownerToken === "string" && await sha256(payload.ownerToken) === team.owner_token_hash;
    if (!owner && !admin) return Response.json({ error: "Not authorized to manage this share link" }, { status: 403, headers: corsHeaders() });

    if (payload.action === "delete") {
      await env.DB.prepare("DELETE FROM team_usage_logs WHERE team_id = ?").bind(payload.teamId).run();
      await env.DB.prepare("DELETE FROM shared_teams WHERE id = ?").bind(payload.teamId).run();
      return Response.json({ deleted: true }, { headers: corsHeaders() });
    }

    if (payload.action === "update") {
      const expiresAt = payload.expiresAt && !Number.isNaN(new Date(payload.expiresAt).getTime()) ? new Date(payload.expiresAt).toISOString() : null;
      const revokedAt = payload.revoked ? new Date().toISOString() : null;
      await env.DB.prepare("UPDATE shared_teams SET expires_at = ?, revoked_at = ? WHERE id = ?").bind(expiresAt, revokedAt, payload.teamId).run();
      team.expires_at = expiresAt;
      team.revoked_at = revokedAt;
    }

    const logs = await env.DB.prepare("SELECT id, task, created_at FROM team_usage_logs WHERE team_id = ? ORDER BY created_at DESC LIMIT 100")
      .bind(payload.teamId)
      .all<{ id: string; task: string; created_at: string }>();
    const config = JSON.parse(team.team_config) as { teamName?: string };
    return Response.json({
      team: { teamName: config.teamName ?? "Untitled team", createdAt: team.created_at, expiresAt: team.expires_at, revokedAt: team.revoked_at },
      logs: logs.results,
    }, { headers: corsHeaders() });
  } catch (error) {
    console.error("Unable to manage shared team", error);
    return Response.json({ error: "Unable to load link management info right now" }, { status: 500, headers: corsHeaders() });
  }
}
