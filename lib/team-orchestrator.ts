import type { TaskAttachment } from "@/lib/task-attachments";

export type RunStage = "planning" | "working" | "discussing" | "summarizing";
export type TeamTurn = { agentId: string; text: string; type: "user" | "handoff" | "result" };
export type AgentActivity = { agentId: string; label: string; state: "thinking" | "done" };
export type TeamAgent = { id: string; name: string; role: string; responsibility: string };
export type RunOptions = { initialTranscript?: TeamTurn[]; takeInterventions?: () => TeamTurn[]; continued?: boolean; attachments?: TaskAttachment[]; visionEnabled?: boolean; authorization?: { teamId: string; token: string } };

type StreamEvent =
  | { type: "stage"; stage: RunStage }
  | { type: "activity"; agentId: string; label: string; state: "thinking" | "done" }
  | { type: "turn"; turn: TeamTurn }
  | { type: "error"; error: string };

export async function runTeamConversation(task: string, agents: TeamAgent[], onStage: (stage: RunStage) => void, onTurn: (turn: TeamTurn) => void, onActivity: (activity: AgentActivity) => void, options: RunOptions = {}) {
  const transcript = [...(options.initialTranscript ?? [])].slice(-40);
  const response = await fetch("/api/conversation", {
    method: "POST",
    headers: { "content-type": "application/json", ...(options.authorization ? { authorization: `Bearer ${options.authorization.token}` } : {}) },
    body: JSON.stringify({
      teamId: options.authorization?.teamId,
      task,
      agents,
      continued: options.continued,
      transcript,
      attachments: (options.attachments ?? []).map((attachment) => ({ ...attachment, dataUrl: options.visionEnabled && attachment.kind === "image" ? attachment.dataUrl : undefined })),
    }),
  });
  if (!response.ok || !response.body) {
    const body = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? "Unable to start the team run");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const output = [...transcript];
  const consume = (line: string) => {
    if (!line.trim()) return;
    const event = JSON.parse(line) as StreamEvent;
    if (event.type === "stage") onStage(event.stage);
    else if (event.type === "activity") onActivity({ agentId: event.agentId, label: event.label, state: event.state });
    else if (event.type === "turn") { output.push(event.turn); onTurn(event.turn); }
    else if (event.type === "error") throw new Error(event.error);
  };
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) consume(line);
    if (done) break;
  }
  consume(buffer);
  return output;
}
