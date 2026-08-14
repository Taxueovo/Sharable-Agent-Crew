import { env } from "cloudflare:workers";
import { corsHeaders, optionsResponse } from "@/lib/cors";

async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function createAccessCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return `ARB-${Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("")}`;
}

function createOwnerToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function ensureSharedTeamsTable() {
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS shared_teams (id TEXT PRIMARY KEY NOT NULL, team_config TEXT NOT NULL, access_code_hash TEXT NOT NULL, owner_token_hash TEXT, expires_at TEXT, revoked_at TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL)").run();
}

export async function OPTIONS() {
  return optionsResponse();
}

export async function POST(request: Request) {
  try {
    await ensureSharedTeamsTable();
    const payload = (await request.json()) as { teamName?: string; architecture?: string; agents?: unknown[] };
    if (!payload.teamName?.trim() || !payload.architecture || !Array.isArray(payload.agents) || payload.agents.length === 0) {
      return Response.json({ error: "Incomplete team configuration" }, { status: 400, headers: corsHeaders() });
    }

    const id = crypto.randomUUID().replaceAll("-", "");
    const accessCode = createAccessCode();
    const ownerToken = createOwnerToken();
    const config = JSON.stringify({ teamName: payload.teamName.trim(), architecture: payload.architecture, agents: payload.agents });
    await env.DB.prepare("INSERT INTO shared_teams (id, team_config, access_code_hash, owner_token_hash) VALUES (?, ?, ?, ?)")
      .bind(id, config, await sha256(accessCode), await sha256(ownerToken))
      .run();

    return Response.json({ id, accessCode, ownerToken, sharePath: `/use/${id}` }, { status: 201, headers: corsHeaders() });
  } catch (error) {
    console.error("Unable to create share link", error);
    return Response.json({ error: "Unable to generate a share link right now" }, { status: 500, headers: corsHeaders() });
  }
}
