import { env } from "cloudflare:workers";
import { corsHeaders, optionsResponse } from "@/lib/cors";
import { authenticatedUserHash, enforceRateLimit, errorResponse, readJsonLimited, secureEqual, sha256 } from "@/lib/security";

function createAccessCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return `ARB-${Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("")}`;
}

function createOwnerToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function OPTIONS() {
  return optionsResponse();
}

export async function POST(request: Request) {
  try {
    const expectedPublishToken = env.PUBLISH_TOKEN?.trim();
    const providedPublishToken = request.headers.get("x-arbor-publish-token")?.trim() ?? "";
    const ownerUserHash = await authenticatedUserHash(request);
    const tokenAuthorized = Boolean(expectedPublishToken) && secureEqual(providedPublishToken, expectedPublishToken ?? "");
    const identityRequired = env.REQUIRE_AUTHENTICATED_PUBLISHER === "1";
    if ((identityRequired && !ownerUserHash) || (!ownerUserHash && !tokenAuthorized)) {
      return Response.json({ error: "Publishing is not authorized" }, { status: 403, headers: corsHeaders() });
    }
    await enforceRateLimit(request, "publish", 10, 60);
    const payload = await readJsonLimited<{ teamName?: string; architecture?: string; agents?: Array<Record<string, unknown>> }>(request, 64_000);
    if (!payload.teamName?.trim() || payload.teamName.trim().length > 120 || payload.architecture !== "planner" || !Array.isArray(payload.agents) || payload.agents.length < 2 || payload.agents.length > 12) {
      return Response.json({ error: "Incomplete team configuration" }, { status: 400, headers: corsHeaders() });
    }

    const agents = payload.agents.map((agent) => ({
      id: String(agent.id ?? "").trim().slice(0, 80),
      name: String(agent.name ?? "").trim().slice(0, 120),
      role: agent.role === "Planner" ? "Planner" : "Worker",
      responsibility: String(agent.responsibility ?? "").trim().slice(0, 2_000),
      avatar: String(agent.avatar ?? "").slice(0, 8),
      color: String(agent.color ?? "violet").slice(0, 24),
    }));
    const ids = agents.map((agent) => agent.id);
    const hasInvalidAgent = agents.some((agent) => !agent.id || !agent.name || !agent.responsibility);
    const hasDuplicateId = new Set(ids).size !== ids.length;
    const plannerCount = agents.filter((agent) => agent.role === "Planner").length;
    if (hasInvalidAgent || hasDuplicateId || plannerCount !== 1) {
      return Response.json({ error: "Invalid team members" }, { status: 400, headers: corsHeaders() });
    }

    const id = crypto.randomUUID().replaceAll("-", "");
    const accessCode = createAccessCode();
    const ownerToken = createOwnerToken();
    const config = JSON.stringify({ teamName: payload.teamName.trim(), architecture: payload.architecture, agents });
    await env.DB.prepare("INSERT INTO shared_teams (id, team_config, access_code_hash, owner_token_hash, owner_user_hash) VALUES (?, ?, ?, ?, ?)")
      .bind(id, config, await sha256(accessCode), await sha256(ownerToken), ownerUserHash ?? null)
      .run();

    return Response.json({ id, accessCode, ownerToken, sharePath: `/use/${id}`, shareUrl: new URL(`/use/${id}`, request.url).toString() }, { status: 201, headers: corsHeaders() });
  } catch (error) {
    const response = errorResponse(error, "Unable to generate a share link right now");
    for (const [key, value] of Object.entries(corsHeaders())) response.headers.set(key, value);
    return response;
  }
}
