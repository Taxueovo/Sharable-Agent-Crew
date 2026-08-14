import { env } from "cloudflare:workers";
import { authorizeRun, enforceRateLimit, errorResponse, readJsonLimited } from "@/lib/security";

export async function POST(request: Request) {
  try {
    const payload = await readJsonLimited<{ teamId?: string }>(request, 1_024);
    if (!payload.teamId) return Response.json({ error: "Incomplete logging information" }, { status: 400 });
    const access = await authorizeRun(request, payload.teamId);
    if (access.local) return Response.json({ recorded: false }, { status: 200, headers: { "cache-control": "no-store" } });
    await enforceRateLimit(request, "usage", 60, 60, payload.teamId);
    await env.DB.prepare("INSERT INTO team_usage_logs (id, team_id, task) VALUES (?, ?, ?)")
      .bind(crypto.randomUUID().replaceAll("-", ""), payload.teamId, "[redacted]")
      .run();
    return Response.json({ recorded: true }, { status: 201, headers: { "cache-control": "no-store" } });
  } catch (error) {
    return errorResponse(error, "Unable to record team usage right now");
  }
}
