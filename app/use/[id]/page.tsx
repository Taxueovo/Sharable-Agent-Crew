"use client";

import { use, useMemo, useRef, useState } from "react";
import { AttachmentPicker, useVisionCapability } from "@/app/attachment-picker";
import { runTeamConversation, type AgentActivity, type RunStage, type TeamTurn } from "@/lib/team-orchestrator";
import { attachmentSummary, type TaskAttachment } from "@/lib/task-attachments";

type Agent = { id: string; name: string; role: string; avatar: string; color: string; responsibility: string };
type Team = { teamName: string; architecture: string; agents: Agent[] };
type Message = { agent: Agent | null; text: string; result?: boolean; user?: boolean; type: TeamTurn["type"] };

export default function SharedTeamPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: teamId } = use(params);
  const [accessCode, setAccessCode] = useState("");
  const [team, setTeam] = useState<Team | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [task, setTask] = useState("");
  const [attachments, setAttachments] = useState<TaskAttachment[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [conversationInput, setConversationInput] = useState("");
  const [running, setRunning] = useState(false);
  const [runStage, setRunStage] = useState<RunStage>("planning");
  const [runError, setRunError] = useState("");
  const [agentActivity, setAgentActivity] = useState<Record<string, AgentActivity>>({});
  const runLock = useRef(false);
  const messagesRef = useRef<Message[]>([]);
  const interventionQueue = useRef<TeamTurn[]>([]);
  const flowLabel = useMemo(() => ({ planner: "Planner–Worker", supervisor: "Supervisor", "round-robin": "Round Robin" }[team?.architecture ?? ""] ?? "Fixed team template"), [team?.architecture]);
  const activeActivity = Object.values(agentActivity).find((activity) => activity.state === "thinking");
  const activeAgentName = team?.agents.find((agent) => agent.id === activeActivity?.agentId)?.name;
  const visionEnabled = useVisionCapability();

  async function unlock() {
    setLoading(true); setError("");
    try {
      const response = await fetch("/api/access", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ teamId, accessCode }) });
      const body = await response.json() as { team?: Team; error?: string };
      if (!response.ok || !body.team) { setError(body.error ?? "Unable to open the team"); return; }
      setTeam(body.team);
    } catch { setError("Network connection failed; please try again later"); } finally { setLoading(false); }
  }

  function appendTurn(turn: TeamTurn) {
    if (!team) return;
    const message: Message = { agent: turn.agentId === "user" ? null : team.agents.find((agent) => agent.id === turn.agentId) ?? team.agents[0], text: turn.text, result: turn.type === "result", user: turn.type === "user", type: turn.type };
    messagesRef.current = [...messagesRef.current, message]; setMessages(messagesRef.current);
  }
  function currentTranscript() { return messagesRef.current.map((message) => ({ agentId: message.user ? "user" : message.agent?.id ?? "user", text: message.text, type: message.type } satisfies TeamTurn)); }
  function takeInterventions() { const pending = interventionQueue.current; interventionQueue.current = []; return pending; }
  async function runTeam(runTask = task, continued = false) {
    const effectiveTask = runTask.trim() || (attachments.length ? "Please analyze the attachments, extract the key points, and provide actionable conclusions." : "");
    if (!team || !effectiveTask || runLock.current) return;
    runLock.current = true;
    const initialTranscript = continued ? currentTranscript() : [];
    if (!continued) { messagesRef.current = []; setMessages([]); }
    setRunError(""); setAgentActivity({}); setRunStage("planning"); setRunning(true);
    try {
      const fileNames = attachmentSummary(attachments);
      const loggedTask = fileNames ? `${effectiveTask}\nAttachments: ${fileNames}` : effectiveTask;
      const logResponse = await fetch("/api/usage", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ teamId, accessCode, task: loggedTask }) });
      if (!logResponse.ok) {
        const logBody = await logResponse.json().catch(() => null) as { error?: string } | null;
        throw new Error(logBody?.error ?? "This share link is currently unavailable");
      }
      await runTeamConversation(
        effectiveTask,
        team.agents,
        setRunStage,
        appendTurn,
        (activity) => setAgentActivity((current) => ({ ...current, [activity.agentId]: activity })),
        { initialTranscript, takeInterventions, continued, attachments, visionEnabled },
      );
    } catch (error) { setRunError(error instanceof Error ? error.message : "Team run failed"); } finally { runLock.current = false; setRunning(false); }
  }
  function sendConversationMessage() {
    const text = conversationInput.trim();
    if (!text) return;
    const turn: TeamTurn = { agentId: "user", text, type: "user" };
    appendTurn(turn); setConversationInput("");
    if (running) {
      interventionQueue.current.push(turn);
      void fetch("/api/usage", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ teamId, accessCode, task: `Mid-discussion addition: ${text}` }) });
    } else void runTeam(text, true);
  }

  if (!team) return <main className="access-shell"><section className="access-card"><div className="brand dark"><span className="brand-mark">A</span><span>SharableAgentCrew</span></div><span className="section-kicker">SHARED AGENT TEAM</span><h1>Enter the access code to start using the team.</h1><p>No registration needed. After verification, you can dispatch tasks, view member conversations, and get results, but you cannot modify the team configuration.</p><label>Access code<input autoFocus value={accessCode} onChange={(event) => setAccessCode(event.target.value.toUpperCase())} onKeyDown={(event) => event.key === "Enter" && unlock()} placeholder="e.g., ARB-9K2M7PXA" /></label>{error && <div className="access-error">{error}</div>}<button className="access-button" disabled={!accessCode || loading} onClick={unlock}>{loading ? "Verifying…" : "Enter team  →"}</button><small>Authorized by the team creator · no Codex or ChatGPT account required</small></section></main>;

  return <main className="guest-shell"><header className="guest-header"><div className="brand dark"><span className="brand-mark">A</span><span>SharableAgentCrew</span></div><div><span className="guest-badge">Authorized · run only</span><strong>{team.teamName}</strong></div></header><section className="guest-content"><span className="section-kicker">{flowLabel}</span><h1>Dispatch a task to this team.</h1><p className="guest-lead">The collaboration is visible to you. You can correct direction during the discussion or keep asking after a conclusion; the team definition stays locked.</p><div className="guest-team">{team.agents.map((agent, index) => <div className="guest-member" key={agent.id}><div className={`agent-avatar large ${agent.color}`}>{agent.avatar}</div><strong>{agent.name}</strong><span>{agent.role}</span>{index < team.agents.length - 1 && <i>→</i>}</div>)}</div><section className="guest-run"><div className="task-bar"><div className="task-input-wrap"><span>⌁</span><input value={task} onChange={(event) => setTask(event.target.value)} placeholder="Enter the task you want the team to complete…" /></div><button className="run-button" disabled={(!task.trim() && attachments.length === 0) || running} onClick={() => void runTeam()}>{running ? `${activeAgentName ?? "Team"} ${activeActivity?.label ?? "starting"}…` : "Run team →"}</button></div><AttachmentPicker attachments={attachments} setAttachments={setAttachments} disabled={running} visionEnabled={visionEnabled} />{running && <SharedActivityPanel agents={team.agents} activity={agentActivity} />}<div className="guest-conversation">{running && <SharedRunProgress stage={runStage} />}{runError && <div className="run-error"><strong>Run failed</strong><span>{runError}</span></div>}{messages.length === 0 && !running && !runError && <div className="empty-conversation"><span>◇</span><strong>The team awaits your task</strong><p>After it runs, you will see explicit collaboration messages from every member.</p></div>}{messages.map((message, index) => message.user ? <article className="message user-message" key={index}><div className="agent-avatar user-avatar">Me</div><div className="message-body"><div className="message-meta"><strong>You</strong><span>{running ? "Interjection" : "Follow-up"}</span></div><p>{message.text}</p><em>↑ User request · highest priority</em></div></article> : <article className="message" key={index}><div className={`agent-avatar ${message.agent?.color ?? "violet"}`}>{message.agent?.avatar ?? "?"}</div><div className="message-body"><div className="message-meta"><strong>{message.agent?.name}</strong><span>{message.agent?.role}</span></div><p>{message.text}</p><em className={message.result ? "result-mark" : ""}>{message.result ? "✓ Team conclusion formed" : "↗ Handed off to a team member"}</em></div></article>)}</div>{(running || messages.length > 0) && <div className={`conversation-control ${running ? "interrupting" : "continuing"}`}><div><strong>{running ? "Interject into the team discussion" : "Continue this conversation"}</strong><small>{running ? "After the current member finishes, the Planner will re-adjust according to your request." : "The team will keep the context above and continue answering."}</small></div><div className="conversation-control-input"><input value={conversationInput} onChange={(event) => setConversationInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); sendConversationMessage(); } }} placeholder={running ? "Correct direction, add conditions, or revise requirements…" : "Follow up or ask for revised results…"} /><button onClick={sendConversationMessage} disabled={!conversationInput.trim()}>{running ? "Interject" : "Continue"}</button></div></div>}</section></section></main>;
}

function SharedActivityPanel({ agents, activity }: { agents: Agent[]; activity: Record<string, AgentActivity> }) { return <div className="agent-activity" role="status" aria-live="assertive"><div className="activity-title"><span className="activity-pulse" /><strong>Team started</strong><small>Status updates in real time</small></div><div className="activity-members">{agents.map((agent) => { const current = activity[agent.id]; return <div key={agent.id} className={current?.state ?? "waiting"}><span className={`agent-avatar ${agent.color}`}>{agent.avatar}</span><div><strong>{agent.name}</strong><small>{current?.label ?? "Waiting to speak"}</small></div>{current?.state === "thinking" ? <i className="mini-spinner" /> : current?.state === "done" ? <i>✓</i> : <i>·</i>}</div>; })}</div></div>; }
function SharedRunProgress({ stage }: { stage: RunStage }) { const steps: Array<{ id: RunStage; label: string }> = [{ id: "planning", label: "Planner breakdown" }, { id: "working", label: "Workers first round" }, { id: "discussing", label: "Team discussion" }, { id: "summarizing", label: "Planner summary" }]; const active = steps.findIndex((step) => step.id === stage); return <div className="run-progress"><div className="progress-copy"><span className="progress-spinner" /><div><strong>{steps[active].label} in progress</strong><small>Each member's message appears as soon as it is said; please do not click repeatedly</small></div></div><div className="progress-steps">{steps.map((step, index) => <span key={step.id} className={index < active ? "done" : index === active ? "active" : ""}>{index < active ? "✓" : index + 1} {step.label}</span>)}</div></div>; }
