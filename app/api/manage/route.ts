import { env } from "cloudflare:workers";
import { corsHeaders, optionsResponse } from "@/lib/cors";
import { authenticatedUserHash, enforceRateLimit, errorResponse, readJsonLimited, secureEqual, sha256 } from "@/lib/security";

/**
 * Admin token validation. ADMIN_TOKEN is set on Cloudflare with `wrangler secret put ADMIN_TOKEN`
 * (do not write it into a .env file that gets distributed). Admins can list, disable, or delete any
 * published version in the database without being bound by ownerToken — this is the source of the
 * "host/ops" capability to clean up versions shared by others.
 */
async function isAdmin(provided: unknown): Promise<boolean> {
  const expected = env.ADMIN_TOKEN?.trim();
  if (!expected || typeof provided !== "string" || !provided.trim()) return false;
  return secureEqual(provided.trim(), expected);
}

export async function OPTIONS() {
  return optionsResponse();
}

export async function POST(request: Request) {
  try {
    await enforceRateLimit(request, "manage", 30, 60);
    const payload = await readJsonLimited<{ teamId?: string; ownerToken?: string; adminToken?: string; action?: "list" | "listAll" | "update" | "delete"; expiresAt?: string | null; revoked?: boolean }>(request, 8_192);
    if (!payload.action) return Response.json({ error: "Incomplete management credentials" }, { status: 400, headers: corsHeaders() });
    const admin = await isAdmin(payload.adminToken);

    // Admin: list every published version in the database (including ones shared by others), with usage counts.
    if (payload.action === "listAll") {
      if (!admin) return Response.json({ error: "Not authorized to manage this share link" }, { status: 403, headers: corsHeaders() });
      const rows = await env.DB.prepare("SELECT s.id, s.team_config, s.expires_at, s.revoked_at, s.created_at, COUNT(l.id) AS usage_count FROM shared_teams s LEFT JOIN team_usage_logs l ON l.team_id = s.id GROUP BY s.id ORDER BY s.created_at DESC LIMIT 200")
        .all<{ id: string; team_config: string; expires_at: string | null; revoked_at: string | null; created_at: string; usage_count: number }>();
      const teams: Array<{ teamId: string; teamName: string; createdAt: string; expiresAt: string | null; revokedAt: string | null; usageCount: number }> = [];
      for (const row of rows.results ?? []) {
        let teamName = "Untitled team";
        try { teamName = (JSON.parse(row.team_config) as { teamName?: string }).teamName ?? teamName; } catch { /* ignore malformed config */ }
        teams.push({ teamId: row.id, teamName, createdAt: row.created_at, expiresAt: row.expires_at, revokedAt: row.revoked_at, usageCount: Number(row.usage_count) || 0 });
      }
      return Response.json({ teams }, { headers: corsHeaders() });
    }

    if (!payload.teamId) return Response.json({ error: "Incomplete management credentials" }, { status: 400, headers: corsHeaders() });
    const team = await env.DB.prepare("SELECT team_config, owner_token_hash, owner_user_hash, expires_at, revoked_at, created_at FROM shared_teams WHERE id = ?")
      .bind(payload.teamId)
      .first<{ team_config: string; owner_token_hash: string | null; owner_user_hash: string | null; expires_at: string | null; revoked_at: string | null; created_at: string }>();
    if (!team) return Response.json({ error: "This version does not exist or has been deleted" }, { status: 404, headers: corsHeaders() });

    // Authorization: either the version creator (ownerToken) or the global admin (adminToken).
    const callerUserHash = await authenticatedUserHash(request);
    const identityOwner = Boolean(team.owner_user_hash && callerUserHash && secureEqual(callerUserHash, team.owner_user_hash));
    const tokenOwner = Boolean(team.owner_token_hash) && typeof payload.ownerToken === "string" && secureEqual(await sha256(payload.ownerToken), team.owner_token_hash ?? "");
    const owner = identityOwner || tokenOwner;
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
      logs: (logs.results ?? []).map((log) => ({ ...log, task: "Task content is not retained for privacy." })),
    }, { headers: corsHeaders() });
  } catch (error) {
    const response = errorResponse(error, "Unable to load link management info right now");
    for (const [key, value] of Object.entries(corsHeaders())) response.headers.set(key, value);
    return response;
  }
}
