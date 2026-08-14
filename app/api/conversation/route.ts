import { env } from "cloudflare:workers";
import { audit, requestId, withRequestId } from "@/lib/observability";
import { authorizeRun, consumeQuota, enforceRateLimit, errorResponse, HttpError, readJsonLimited } from "@/lib/security";
import { executeTurn, phaseTokenBudget, sanitizeAttachments, type Agent, type Attachment, type Phase, type Turn } from "@/lib/turn-engine";

type Event = { type: "stage"; stage: string } | { type: "activity"; agentId: string; label: string; state: string } | { type: "turn"; turn: Turn } | { type: "error"; error: string };
const labels: Record<Phase, [string, string]> = { plan: ["Planning", "Planning complete"], replan: ["Adjusting", "Adjustment complete"], work: ["Working", "Delivery complete"], review: ["Reviewing", "Review complete"], respond: ["Responding", "Response complete"], final: ["Summarizing", "Final answer ready"] };
const positiveInt = (value: string | undefined, fallback: number) => { const parsed = Number(value); return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback; };

export async function POST(request: Request) {
  const id = requestId(request);
  const startedAt = Date.now();
  try {
    const payload = await readJsonLimited<{ teamId?: string; task?: string; agents?: Agent[]; continued?: boolean; transcript?: Turn[]; attachments?: Attachment[] }>(request, 8_000_000);
    const access = await authorizeRun(request, payload.teamId);
    const task = payload.task?.trim().slice(0, 12_000);
    const agents = (access.local ? payload.agents : access.team?.agents) ?? [];
    if (!task || agents.length < 2 || agents.length > 12) throw new HttpError(400, "A task and 2 to 12 valid team members are required");
    const planner = agents.find((agent) => agent.role === "Planner") ?? agents[0];
    const workers = agents.filter((agent) => agent.id !== planner.id);
    if (!access.local && access.teamId) {
      await enforceRateLimit(request, "conversation-minute", 5, 60, access.teamId);
      await consumeQuota(request, "conversation-month", positiveInt(env.MAX_TEAM_RUNS_PER_MONTH, 1_000), 31 * 86_400, 1, access.teamId);
    }
    const transcript: Turn[] = (payload.transcript ?? []).slice(-40).map((turn) => ({ agentId: String(turn.agentId).slice(0, 80), text: String(turn.text).slice(0, 12_000), type: turn.type }));
    const attachments = sanitizeAttachments(payload.attachments);
    const encoder = new TextEncoder();
    let turns = 0;
    const stream = new ReadableStream({
      async start(controller) {
        const send = (event: Event) => controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        const speak = async (actor: Agent, phase: Phase, type: Turn["type"] = "handoff") => {
          if (!access.local && access.teamId) await consumeQuota(request, "output-tokens-day", positiveInt(env.MAX_TEAM_OUTPUT_TOKENS_PER_DAY, 200_000), 86_400, phaseTokenBudget[phase], access.teamId);
          send({ type: "activity", agentId: actor.id, label: labels[phase][0], state: "thinking" });
          const result = await executeTurn({ task, agents, actor, phase, transcript, attachments });
          const turn: Turn = { agentId: actor.id, text: result.text, type };
          transcript.push(turn); turns += 1;
          send({ type: "turn", turn });
          send({ type: "activity", agentId: actor.id, label: labels[phase][1], state: "done" });
          return result;
        };
        try {
          send({ type: "stage", stage: "planning" });
          await speak(planner, payload.continued ? "replan" : "plan");
          send({ type: "stage", stage: "working" });
          for (const worker of workers) await speak(worker, payload.continued ? "respond" : "work");
          send({ type: "stage", stage: "discussing" });
          const review = await speak(planner, "review");
          for (const worker of workers.filter((item) => review.targetAgentIds.includes(item.id))) await speak(worker, "respond");
          send({ type: "stage", stage: "summarizing" });
          await speak(planner, "final", "result");
          audit({ requestId: id, route: "/api/conversation", outcome: "ok", startedAt, teamId: access.teamId, turns });
        } catch (error) {
          const message = error instanceof HttpError ? error.message : error instanceof Error && error.message === "MODEL_CIRCUIT_OPEN" ? "The model service is temporarily unavailable; retry in one minute" : "The team run failed";
          send({ type: "error", error: message });
          audit({ requestId: id, route: "/api/conversation", outcome: "error", startedAt, teamId: access.teamId, turns, code: error instanceof Error ? error.name : "unknown" });
        } finally { controller.close(); }
      },
    });
    return withRequestId(new Response(stream, { headers: { "content-type": "application/x-ndjson; charset=utf-8" } }), id);
  } catch (error) {
    audit({ requestId: id, route: "/api/conversation", outcome: "rejected", startedAt, code: error instanceof Error ? error.name : "unknown" });
    return withRequestId(errorResponse(error, "Unable to start the team run"), id);
  }
}
