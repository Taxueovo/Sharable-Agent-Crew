import { env } from "cloudflare:workers";
import { createRunToken, enforceRateLimit, errorResponse, readJsonLimited, secureEqual, sha256 } from "@/lib/security";

export async function POST(request: Request) {
  try {
    const payload = await readJsonLimited<{ teamId?: string; accessCode?: string }>(request, 2_048);
    if (!payload.teamId) return Response.json({ error: "The share link is missing the team ID; please copy the full link again" }, { status: 400 });
    if (!payload.accessCode?.trim()) return Response.json({ error: "Please enter the access code" }, { status: 400 });
    await enforceRateLimit(request, `access:${payload.teamId}`, 8, 60);
    const record = await env.DB.prepare("SELECT team_config, access_code_hash, expires_at, revoked_at FROM shared_teams WHERE id = ?")
      .bind(payload.teamId)
      .first<{ team_config: string; access_code_hash: string; expires_at: string | null; revoked_at: string | null }>();
    const providedHash = await sha256(payload.accessCode.trim().toUpperCase());
    if (!record || !secureEqual(providedHash, record.access_code_hash)) {
      return Response.json({ error: "The link or access code is incorrect" }, { status: 403 });
    }
    if (record.revoked_at) return Response.json({ error: "This share link has been disabled by its creator" }, { status: 403 });
    if (record.expires_at && new Date(record.expires_at).getTime() <= Date.now()) return Response.json({ error: "This share link has expired" }, { status: 403 });
    const runToken = await createRunToken(payload.teamId);
    return Response.json({ team: JSON.parse(record.team_config), runToken }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return errorResponse(error, "Unable to verify access right now");
  }
}
