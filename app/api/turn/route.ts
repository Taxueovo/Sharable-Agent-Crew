import { errorResponse, HttpError, isLocalDevelopmentRequest, readJsonLimited } from "@/lib/security";
import { executeTurn, sanitizeAttachments, type Agent, type Attachment, type Phase, type Turn } from "@/lib/turn-engine";

// Low-level phase execution is intentionally local-only. Public callers must use
// /api/conversation so the server, rather than an untrusted browser, owns sequencing.
export async function POST(request: Request) {
  try {
    if (!isLocalDevelopmentRequest(request)) throw new HttpError(403, "Direct turn execution is disabled");
    const payload = await readJsonLimited<{ task?: string; agents?: Agent[]; actorId?: string; phase?: Phase; transcript?: Turn[]; attachments?: Attachment[] }>(request, 8_000_000);
    const task = payload.task?.trim().slice(0, 12_000);
    const agents = payload.agents ?? [];
    const actor = agents.find((agent) => agent.id === payload.actorId);
    const phases = new Set<Phase>(["plan", "replan", "work", "review", "respond", "final"]);
    if (!task || !actor || !payload.phase || !phases.has(payload.phase) || agents.length < 2 || agents.length > 12) throw new HttpError(400, "Invalid turn request");
    const result = await executeTurn({ task, agents, actor, phase: payload.phase, transcript: payload.transcript ?? [], attachments: sanitizeAttachments(payload.attachments) });
    return Response.json(result, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return errorResponse(error, "The member failed to speak");
  }
}
