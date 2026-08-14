import type { TaskAttachment } from "@/lib/task-attachments";

export type RunStage = "planning" | "working" | "discussing" | "summarizing";

export type TeamTurn = { agentId: string; text: string; type: "user" | "handoff" | "result" };

export type AgentActivity = { agentId: string; label: string; state: "thinking" | "done" };

export type TeamAgent = { id: string; name: string; role: string; responsibility: string };

export type RunOptions = {
  initialTranscript?: TeamTurn[];
  takeInterventions?: () => TeamTurn[];
  continued?: boolean;
  attachments?: TaskAttachment[];
  visionEnabled?: boolean;
};

type TurnPhase = "plan" | "replan" | "work" | "review" | "respond" | "final";

type TurnResult = { text: string; needsFollowUp: boolean; targetAgentIds: string[] };

async function requestTurn(task: string, agents: TeamAgent[], actorId: string, phase: TurnPhase, transcript: TeamTurn[], attachments: TaskAttachment[] = [], visionEnabled = false): Promise<TurnResult> {
  const response = await fetch("/api/turn", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      task,
      agents,
      actorId,
      phase,
      transcript,
      attachments: attachments.map((attachment) => ({ ...attachment, dataUrl: visionEnabled && attachment.kind === "image" ? attachment.dataUrl : undefined })),
    }),
  });
  const body = (await response.json()) as { text?: string; error?: string; needsFollowUp?: boolean; targetAgentIds?: string[] };
  if (!response.ok || !body.text) throw new Error(body.error ?? "Agent failed to speak");
  return { text: body.text, needsFollowUp: body.needsFollowUp === true, targetAgentIds: body.targetAgentIds ?? [] };
}

export async function runTeamConversation(
  task: string,
  agents: TeamAgent[],
  onStage: (stage: RunStage) => void,
  onTurn: (turn: TeamTurn) => void,
  onActivity: (activity: AgentActivity) => void,
  options: RunOptions = {},
) {
  const planner = agents.find((agent) => agent.role === "Planner") ?? agents[0];
  const workers = agents.filter((agent) => agent.id !== planner?.id);
  if (!planner || workers.length === 0) throw new Error("A team needs one Planner and at least one Worker");

  const transcript = [...(options.initialTranscript ?? [])].slice(-40);

  async function speak(agentId: string, phase: TurnPhase, type: TeamTurn["type"] = "handoff"): Promise<TurnResult> {
    const labels: Record<TurnPhase, [string, string]> = {
      plan: ["Planning", "Planning complete"],
      replan: ["Adjusting to your feedback", "Adjustment complete"],
      work: ["Working", "First delivery complete"],
      review: ["Reviewing", "Review complete"],
      respond: ["Responding", "Response complete"],
      final: ["Summarizing", "Final answer ready"],
    };
    onActivity({ agentId, label: labels[phase][0], state: "thinking" });
    const result = await requestTurn(task, agents, agentId, phase, transcript, options.attachments, options.visionEnabled);
    const turn: TeamTurn = { agentId, text: result.text, type };
    transcript.push(turn);
    onTurn(turn);
    onActivity({ agentId, label: labels[phase][1], state: "done" });
    return result;
  }

  async function handleInterventions() {
    const interventions = (options.takeInterventions?.() ?? []).filter((turn) => turn.text.trim());
    if (interventions.length === 0) return false;
    transcript.push(...interventions);
    onStage("planning");
    await speak(planner.id, "replan");
    return true;
  }

  onStage("planning");
  await speak(planner.id, options.continued ? "replan" : "plan");
  await handleInterventions();
  onStage("working");
  let replanned = false;
  for (const worker of workers) {
    await speak(worker.id, options.continued ? "respond" : "work");
    if (await handleInterventions()) replanned = true;
    onStage("working");
  }
  if (replanned) for (const worker of workers) await speak(worker.id, "respond");
  onStage("discussing");
  const review = await speak(planner.id, "review");
  if (review.needsFollowUp) {
    const targets = workers.filter((worker) => review.targetAgentIds.includes(worker.id));
    for (const target of targets) await speak(target.id, "respond");
  }
  if (await handleInterventions()) {
    onStage("working");
    for (const worker of workers) await speak(worker.id, "respond");
  }
  onStage("summarizing");
  await speak(planner.id, "final", "result");
  if (await handleInterventions()) {
    onStage("working");
    for (const worker of workers) await speak(worker.id, "respond");
    onStage("summarizing");
    await speak(planner.id, "final", "result");
  }
  return transcript;
}
