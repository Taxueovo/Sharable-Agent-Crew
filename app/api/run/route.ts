import { requestLLM } from "@/lib/llm";

type Agent = { id: string; name: string; role: string; responsibility: string };
type AgentMessage = { agentId: string; text: string; type: "handoff" | "result" };

async function askModel(instructions: string, input: string, maxOutputTokens: number) {
  const text = await requestLLM({ instructions, input, maxOutputTokens });
  if (!text) throw new Error("The model returned no usable content");
  return text;
}

export async function POST(request: Request) {
  const payload = (await request.json()) as { task?: string; agents?: Agent[] };
  const task = payload.task?.trim();
  const agents = payload.agents ?? [];
  const planner = agents.find((agent) => agent.role === "Planner") ?? agents[0];
  const workers = agents.filter((agent) => agent.id !== planner?.id);
  if (!task || !planner || workers.length === 0) return Response.json({ error: "Task, Planner, and at least one Worker are all required" }, { status: 400 });

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: object) => controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      try {
        send({ event: "stage", stage: "planning" });
        const plan = await askModel(
          `You are the Planner of the team. Responsibility: ${planner.responsibility}\n\nBreak the task down into distinct subtasks for each Worker. Output only the breakdown itself: keep it short, concrete, and verifiable. Do not restate the user's question, confirm receipt, introduce yourself, exchange pleasantries, explain your thinking, use handoff clichés, or add unnecessary next-step suggestions. For coding tasks, name the deliverable file or acceptance criteria. Write in English, usually within 300 characters.`,
          `Task: ${task}\n\nMembers:\n${workers.map((worker) => `- ${worker.name}: ${worker.responsibility}`).join("\n")}`,
          500,
        );
        send({ event: "message", message: { agentId: planner.id, text: plan, type: "handoff" } satisfies AgentMessage });

        send({ event: "stage", stage: "working" });
        const workerResults = await Promise.all(workers.map(async (worker) => {
          const result: AgentMessage = {
            agentId: worker.id,
            type: "handoff",
            text: await askModel(
              `You are Worker "${worker.name}". Responsibility: ${worker.responsibility}\n\nComplete the work assigned to you directly; deliver only substantive content that the user and Planner can reuse. Do not restate the task, confirm receipt, introduce yourself, describe "what I will do", show a chain of thought, use pleasantries, handoff clichés, or repeat conclusions. For coding tasks, provide runnable code with the necessary notes; for analysis tasks, provide concrete conclusions, evidence, and action items. Be concise by default and elaborate only when the task truly requires it. Write in English.`,
              `Task: ${task}\n\nPlanner breakdown:\n${plan}`,
              900,
            ),
          };
          send({ event: "message", message: result });
          return result;
        }));

        send({ event: "stage", stage: "summarizing" });
        const final = await askModel(
          `You are the final answer editor. Answer the user's task directly from the team's deliverables. Keep only useful conclusions, finished output, code, key evidence, and necessary actions; deduplicate and resolve conflicts. Do not restate the question, mention the Planner/Worker or the collaboration process, use pleasantries, self-evaluate, declare completion, show a chain of thought, or add unnecessary summaries. Answer naturally, clearly, and concisely, like a high-quality GPT response. Coding tasks must include code that can be copied and run directly. Write in English.`,
          `Task: ${task}\n\nInitial breakdown:\n${plan}\n\nDeliverables:\n${workerResults.map((result) => `\n[${agents.find((agent) => agent.id === result.agentId)?.name}]\n${result.text}`).join("\n")}`,
          1200,
        );
        send({ event: "message", message: { agentId: planner.id, text: final, type: "result" } satisfies AgentMessage });
        send({ event: "done" });
      } catch (error) {
        const message = error instanceof Error ? error.message : "An unknown error occurred while running the team";
        send({ event: "error", error: message === "LLM_NOT_CONFIGURED" ? "LLM is not configured. Set OPENAI_API_KEY on the server and try running the team again." : message });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-cache" } });
}
