"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AttachmentPicker, useVisionCapability } from "@/app/attachment-picker";
import { AgentActivityPanel, RunProgress, TeamMap } from "@/app/workspace-components";
import { runTeamConversation, type AgentActivity, type RunStage, type TeamTurn } from "@/lib/team-orchestrator";
import type { TaskAttachment } from "@/lib/task-attachments";

type Architecture = "planner";
type Agent = { id: string; name: string; role: string; avatar: string; color: string; responsibility: string; tools: string[]; status?: string };
type Message = { id: number; agentId: string; time: string; text: string; type?: "handoff" | "result" | "user" };
type EvolutionSuggestion = { agentId: string; reason: string; proposedResponsibility: string };
type ManagedLink = { teamId: string; teamName: string; url: string; accessCode: string; ownerToken: string; createdAt: string };
type ManagementData = { team: { teamName: string; createdAt: string; expiresAt: string | null; revokedAt: string | null }; logs: Array<{ id: string; task: string; created_at: string }> };
type AdminTeam = { teamId: string; teamName: string; createdAt: string; expiresAt: string | null; revokedAt: string | null; usageCount: number };

// The leader console runs on the local machine (network-drive delivery, http://localhost:3000).
// Share links must be public (<internal-endpoint>/use/<id>), so create/manage operations are
// written to the deployed Cloudflare worker; but direct cross-origin browser access to workers.dev
// is blocked on the corporate network (fetch error), so publish/manage requests go through the
// local Node relay /share-api (see the shareApiProxyPlugin in vite.config.ts), which forwards them
// to the worker via the .env proxy. PUBLIC_BASE_URL is only used to compose the public share link for display.

const architectureOptions: { id: Architecture; label: string; hint: string; flow: string; icon: string }[] = [
  { id: "planner", label: "Planner–Worker", hint: "One Planner breaks down and synthesizes the task; any number of Workers complete subtasks according to the responsibilities you write.", flow: "Planner → Workers → Planner", icon: "✦" },
];

const workerColors = ["mint", "orange", "blue", "pink"];
function createWorker(index: number): Agent { return { id: `worker-${index}`, name: `Worker ${index}`, role: "Worker", avatar: `W${index}`, color: workerColors[(index - 1) % workerColors.length], responsibility: "Describe what this Worker should complete, what results it delivers, and how it reports back to the Planner.", tools: ["Task execution", "Deliver results"], status: "On standby" }; }
function agentsFor() { return [{ id: "planner", name: "Planner", role: "Planner", avatar: "P", color: "violet", responsibility: "Understand the goal, break down the task, assign subtasks to Workers, and integrate the final result.", tools: ["Task breakdown", "Synthesis"], status: "Coordinating" }, createWorker(1), createWorker(2)]; }

export default function Home() {
  const [screen, setScreen] = useState<"builder" | "workspace">("builder");
  const [step, setStep] = useState(1);
  const [architecture, setArchitecture] = useState<Architecture>("planner");
  const [userName, setUserName] = useState("Team creator");
  const [teamName, setTeamName] = useState("My new agent team");
  const [agents, setAgents] = useState<Agent[]>(() => agentsFor());
  const [selectedId, setSelectedId] = useState("planner");
  const [task, setTask] = useState("Prepare a market-entry proposal for the new product \"Morning Dew\"");
  const [attachments, setAttachments] = useState<TaskAttachment[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [conversationInput, setConversationInput] = useState("");
  const [evolving, setEvolving] = useState(false);
  const [evolutionSummary, setEvolutionSummary] = useState("");
  const [evolutionSuggestions, setEvolutionSuggestions] = useState<EvolutionSuggestion[]>([]);
  const [running, setRunning] = useState(false);
  const [runStage, setRunStage] = useState<RunStage>("planning");
  const [runError, setRunError] = useState("");
  const [agentActivity, setAgentActivity] = useState<Record<string, AgentActivity>>({});
  const runLock = useRef(false);
  const messagesRef = useRef<Message[]>([]);
  const interventionQueue = useRef<TeamTurn[]>([]);
  const evolutionRequest = useRef(0);
  const [published, setPublished] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [shareInfo, setShareInfo] = useState<ManagedLink | null>(null);
  const [managedLinks, setManagedLinks] = useState<ManagedLink[]>([]);
  const [managerOpen, setManagerOpen] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const visionEnabled = useVisionCapability();

  const selected = agents.find((agent) => agent.id === selectedId) ?? agents[0];
  const agentMap = useMemo(() => Object.fromEntries(agents.map((agent) => [agent.id, agent])), [agents]);
  const activeActivity = Object.values(agentActivity).find((activity) => activity.state === "thinking");
  const activeAgentName = agents.find((agent) => agent.id === activeActivity?.agentId)?.name;

  useEffect(() => {
    const savedUserName = window.localStorage.getItem("arbor-user-name");
    if (savedUserName?.trim()) setUserName(savedUserName);
    try {
      const links = JSON.parse(window.sessionStorage.getItem("arbor-managed-links") ?? "[]") as ManagedLink[];
      if (Array.isArray(links)) { setManagedLinks(links); setShareInfo(links[0] ?? null); }
    } catch { window.sessionStorage.removeItem("arbor-managed-links"); }
    const saved = window.localStorage.getItem("arbor-team");
    if (!saved) return;
    try {
      const parsed = JSON.parse(saved) as { templateVersion?: number; userName?: string; teamName: string; architecture: Architecture; agents: Agent[]; published: boolean };
      if (parsed.templateVersion === 2 && parsed.agents?.length) { setTeamName(parsed.teamName); if (parsed.userName?.trim() && !savedUserName) setUserName(parsed.userName); setArchitecture("planner"); setAgents(parsed.agents); setSelectedId(parsed.agents[0].id); setPublished(parsed.published); setScreen("workspace"); }
    } catch { window.localStorage.removeItem("arbor-team"); }
  }, []);

  function chooseArchitecture(next: Architecture) {
    setArchitecture(next); const nextAgents = agentsFor(); setAgents(nextAgents); setSelectedId(nextAgents[0].id);
  }
  function updateAgent(id: string, field: "name" | "responsibility", value: string) { setAgents((current) => current.map((agent) => agent.id === id ? { ...agent, [field]: value } : agent)); }
  function updateUserName(value: string) { setUserName(value); window.localStorage.setItem("arbor-user-name", value); }
  function addWorker() { const worker = createWorker(agents.filter((agent) => agent.role === "Worker").length + 1); worker.id = `worker-${Date.now()}`; setAgents((current) => [...current, worker]); setSelectedId(worker.id); }
  function removeWorker(id: string) { if (id === "planner" || agents.filter((agent) => agent.role === "Worker").length <= 1) return; const next = agents.filter((agent) => agent.id !== id); setAgents(next); setSelectedId(next[0].id); }
  function createTeam() { const safeName = teamName.trim() || "Untitled team"; const safeUserName = userName.trim() || "Team creator"; setTeamName(safeName); setUserName(safeUserName); window.localStorage.setItem("arbor-user-name", safeUserName); window.localStorage.setItem("arbor-team", JSON.stringify({ templateVersion: 2, userName: safeUserName, teamName: safeName, architecture, agents, published })); setScreen("workspace"); setStep(1); }
  function saveTeam() { window.localStorage.setItem("arbor-team", JSON.stringify({ templateVersion: 2, userName, teamName, architecture, agents, published })); }
  function resetTeam() { const freshAgents = agentsFor(); window.localStorage.removeItem("arbor-team"); setArchitecture("planner"); setAgents(freshAgents); setSelectedId(freshAgents[0].id); setScreen("builder"); setStep(1); setPublished(false); messagesRef.current = []; setMessages([]); setAttachments([]); setEvolutionSuggestions([]); setEvolutionSummary(""); }
  function appendTurn(turn: TeamTurn) {
    const message: Message = { ...turn, id: messagesRef.current.length + 1, time: "Just now" };
    messagesRef.current = [...messagesRef.current, message];
    setMessages(messagesRef.current);
  }
  function currentTranscript() { return messagesRef.current.map(({ agentId, text, type }) => ({ agentId, text, type: type ?? "handoff" } satisfies TeamTurn)); }
  async function generateEvolution(runTask: string, transcript: TeamTurn[]) {
    const requestId = ++evolutionRequest.current;
    setEvolving(true); setEvolutionSummary(""); setEvolutionSuggestions([]);
    try {
      const response = await fetch("/api/evolve", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ task: runTask, agents, transcript }) });
      const body = await response.json() as { summary?: string; suggestions?: EvolutionSuggestion[]; error?: string };
      if (!response.ok) throw new Error(body.error ?? "Review failed");
      if (requestId === evolutionRequest.current) { setEvolutionSummary(body.summary ?? "Review completed for this round"); setEvolutionSuggestions(body.suggestions ?? []); }
    } catch { if (requestId === evolutionRequest.current) { setEvolutionSummary("No usable evolution suggestions were generated this round."); setEvolutionSuggestions([]); } } finally { if (requestId === evolutionRequest.current) setEvolving(false); }
  }
  async function executeRun(runTask: string, continued = false, priorityTurns: TeamTurn[] = []) {
    if (runLock.current) return;
    runLock.current = true;
    const current = continued ? currentTranscript() : [];
    const initialTranscript = priorityTurns.length
      ? [...current.filter((turn) => !priorityTurns.some((queued) => queued.agentId === turn.agentId && queued.text === turn.text)), ...priorityTurns]
      : current;
    if (!continued) { messagesRef.current = []; setMessages([]); setEvolutionSuggestions([]); setEvolutionSummary(""); }
    setRunning(true); setRunStage("planning"); setRunError(""); setAgentActivity({});
    try {
      const transcript = await runTeamConversation(
        runTask,
        agents,
        setRunStage,
        appendTurn,
        (activity) => setAgentActivity((current) => ({ ...current, [activity.agentId]: activity })),
        { initialTranscript, continued, attachments, visionEnabled },
      );
      void generateEvolution(runTask, transcript);
    } catch (error) { setRunError(error instanceof Error ? error.message : "Team run failed"); } finally {
      runLock.current = false; setRunning(false);
      const queued = interventionQueue.current.splice(0);
      if (queued.length) queueMicrotask(() => void executeRun(queued.map((turn) => turn.text).join("\n"), true, queued));
    }
  }
  function buildRun() {
    const runTask = task.trim() || (attachments.length ? "Please analyze the attachments, extract the key points, and provide actionable conclusions." : "");
    if (runTask) void executeRun(runTask);
  }
  function sendConversationMessage() {
    const text = conversationInput.trim();
    if (!text) return;
    const turn: TeamTurn = { agentId: "user", text, type: "user" };
    appendTurn(turn); setConversationInput("");
    if (running) interventionQueue.current.push(turn);
    else void executeRun(text, true);
  }
  function applyEvolution(suggestion: EvolutionSuggestion) {
    setAgents((current) => {
      const next = current.map((agent) => agent.id === suggestion.agentId ? { ...agent, responsibility: suggestion.proposedResponsibility } : agent);
      window.localStorage.setItem("arbor-team", JSON.stringify({ templateVersion: 2, userName, teamName, architecture, agents: next, published }));
      return next;
    });
    setEvolutionSuggestions((current) => { const next = current.filter((item) => item.agentId !== suggestion.agentId); if (next.length === 0) setEvolutionSummary(""); return next; });
  }
  async function publishTeam() {
    setPublishing(true);
    try {
      // Same-origin POST to the local relay /share-api, forwarded by the shareApiProxyPlugin
      // in vite.config.ts to the deployed worker via the .env proxy; we do not call workers.dev
      // cross-origin directly (the corporate network blocks it). The worker's request.json()
      // ignores content-type.
      const response = await fetch("/share-api/api/teams", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ teamName, architecture, agents }) });
      const body = await response.json() as { id?: string; shareUrl?: string; accessCode?: string; ownerToken?: string; error?: string };
      if (!response.ok || !body.id || !body.shareUrl || !body.accessCode || !body.ownerToken) throw new Error(body.error ?? "Unable to generate a share link");
      const link: ManagedLink = { teamId: body.id, teamName, url: body.shareUrl, accessCode: body.accessCode, ownerToken: body.ownerToken, createdAt: new Date().toISOString() };
      setShareInfo(link);
      setManagedLinks((current) => { const next = [link, ...current]; window.sessionStorage.setItem("arbor-managed-links", JSON.stringify(next)); return next; });
      setPublished(true); window.localStorage.setItem("arbor-team", JSON.stringify({ templateVersion: 2, userName, teamName, architecture, agents, published: true })); setShareOpen(true);
    } catch (error) { window.alert(error instanceof Error ? error.message : "Unable to generate a share link"); } finally { setPublishing(false); }
  }
  function removeManagedLink(teamId: string) {
    setManagedLinks((current) => {
      const next = current.filter((link) => link.teamId !== teamId);
      window.sessionStorage.setItem("arbor-managed-links", JSON.stringify(next));
      setShareInfo(next[0] ?? null);
      setPublished(next.length > 0);
      window.localStorage.setItem("arbor-team", JSON.stringify({ templateVersion: 2, userName, teamName, architecture, agents, published: next.length > 0 }));
      return next;
    });
  }

  if (screen === "builder") return <Builder step={step} setStep={setStep} architecture={architecture} chooseArchitecture={chooseArchitecture} userName={userName} updateUserName={updateUserName} teamName={teamName} setTeamName={setTeamName} agents={agents} selectedId={selectedId} setSelectedId={setSelectedId} updateAgent={updateAgent} addWorker={addWorker} removeWorker={removeWorker} createTeam={createTeam} />;

  return <main className="app-shell workspace-shell">
    <aside className="team-sidebar" id="team">
      <div className="sidebar-brand-row"><div className="brand dark"><span className="brand-mark">A</span><span>SharableAgentCrew</span></div><span className="draft-badge">{published ? "Published" : "Draft"}</span></div>
      <label className="owner-name-field"><span>Workspace name</span><div><span className="profile-avatar">{userName.trim().slice(0, 1) || "Me"}</span><input aria-label="Custom user name" value={userName} onChange={(event) => updateUserName(event.target.value)} onBlur={saveTeam} /></div></label>
      <section className="sidebar-panel architecture-panel"><div className="sidebar-panel-title"><div><span className="section-kicker">TEAM ARCHITECTURE</span><h2>Team architecture</h2></div><button className="mini-action" onClick={addWorker}>+ Worker</button></div><TeamMap agents={agents} selectedId={selectedId} setSelectedId={setSelectedId} architecture={architecture} /></section>
      <section className="sidebar-panel member-panel"><div className="sidebar-panel-title"><div><span className="section-kicker">AGENT PROFILE</span><h2>Agent profile</h2></div>{selected.role === "Worker" && <button className="text-danger" onClick={() => removeWorker(selected.id)}>Remove</button>}</div><div className="sidebar-member-tabs">{agents.map((agent) => <button key={agent.id} className={selectedId === agent.id ? "selected" : ""} onClick={() => setSelectedId(agent.id)}><span className={`agent-avatar ${agent.color}`}>{agent.avatar}</span><span><strong>{agent.name}</strong><small>{agent.role}</small></span></button>)}</div><div className="sidebar-agent-editor"><label>Member name<input value={selected.name} onChange={(event) => updateAgent(selected.id, "name", event.target.value)} onBlur={saveTeam} /></label><div className="sidebar-role"><span>Role template</span><strong>{selected.role}</strong></div><label>Responsibility and working style<textarea value={selected.responsibility} onChange={(event) => updateAgent(selected.id, "responsibility", event.target.value)} onBlur={saveTeam} rows={4} /></label></div></section>
      <div className="sidebar-utility"><button onClick={() => { saveTeam(); setScreen("builder"); setStep(2); }}>Edit full team</button><button onClick={resetTeam}>+ New team</button></div>
    </aside>
    <section className="content priority-content">
      <header className="topbar"><div><div className="breadcrumb">{userName.trim() || "My"} workspace <span>/</span> {teamName}</div><div className="title-row"><h1>{teamName}</h1><span className="live-dot" /><span className="published-state">{published ? "Live version available" : "Not published yet"}</span></div></div><div className="top-actions"><button className="ghost-button" onClick={() => setManagerOpen(true)}>Share & access</button><button className={`publish-button ${published ? "published" : ""}`} onClick={publishTeam} disabled={publishing}>{publishing ? "Publishing…" : published ? "Publish new version" : "Publish team"}</button></div></header>
      <section className="run-section run-primary" id="runs"><div className="run-heading"><div><span className="section-kicker">TASK DISPATCH</span><h2>Dispatch a task</h2><p>Add corrections while running; they are queued as the next server-controlled follow-up.</p></div><span className={`run-status ${running ? "running" : ""}`}>{running ? `● ${activeAgentName ?? "Team"}${activeActivity ? ` · ${activeActivity.label}` : " collaborating"}` : "○ Awaiting task"}</span></div><div className="task-bar"><div className="task-input-wrap"><span>⌁</span><input aria-label="Task content" value={task} onChange={(event) => setTask(event.target.value)} placeholder="Give the team a task…" /></div><button className="run-button" disabled={running || (!task.trim() && attachments.length === 0)} onClick={buildRun}>{running ? `${activeAgentName ?? "Team"} ${activeActivity?.label ?? "starting"}…` : "Run team  →"}</button></div><AttachmentPicker attachments={attachments} setAttachments={setAttachments} disabled={running} visionEnabled={visionEnabled} />{running && <AgentActivityPanel agents={agents} activity={agentActivity} />}<div className="conversation" aria-live="polite">{running && <RunProgress stage={runStage} />}{runError && <div className="run-error"><strong>Run failed</strong><span>{runError}</span></div>}{messages.length === 0 && !running && !runError && <div className="empty-conversation"><span>◇</span><strong>The team is ready</strong><p>Enter a real task; each member's message will appear here as soon as it is said.</p></div>}{messages.map((message) => { const agent = agentMap[message.agentId]; if (message.type === "user") return <article className="message user-message" key={message.id}><div className="agent-avatar user-avatar">Me</div><div className="message-body"><div className="message-meta"><strong>You</strong><span>Additional request</span><time>{message.time}</time></div><p>{message.text}</p><em>↑ User request · highest priority</em></div></article>; return <article className={`message ${message.type ?? ""}`} key={message.id}><div className={`agent-avatar ${agent?.color ?? "violet"}`}>{agent?.avatar ?? "?"}</div><div className="message-body"><div className="message-meta"><strong>{agent?.name}</strong><span>{agent?.role}</span><time>{message.time}</time></div><p>{message.text}</p>{message.type === "handoff" && <em>↗ Handed off to the next member</em>}{message.type === "result" && <em className="result-mark">✓ Team conclusion formed</em>}</div></article>; })}</div>{(running || messages.length > 0) && <div className={`conversation-control ${running ? "interrupting" : "continuing"}`}><div><strong>{running ? "Queue a correction" : "Continue this conversation"}</strong><small>{running ? "Your correction will start automatically as a server-controlled follow-up after this run." : "The team will continue with the full context above."}</small></div><div className="conversation-control-input"><input aria-label="Add a request to the team" value={conversationInput} onChange={(event) => setConversationInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); sendConversationMessage(); } }} placeholder={running ? "Queue a correction or additional constraint…" : "Follow up or ask for revised results…"} /><button onClick={sendConversationMessage} disabled={!conversationInput.trim()}>{running ? "Queue" : "Continue"}</button></div></div>}{(evolving || evolutionSummary || evolutionSuggestions.length > 0) && <EvolutionPanel agents={agents} evolving={evolving} summary={evolutionSummary} suggestions={evolutionSuggestions} apply={applyEvolution} dismiss={() => { evolutionRequest.current += 1; setEvolving(false); setEvolutionSummary(""); setEvolutionSuggestions([]); }} />}</section>
      <section className="workspace-overview"><div><span className="section-kicker">CURRENT TEAM</span><strong>{architectureOptions.find((item) => item.id === architecture)?.flow}</strong><small>{agents.length} members · full conversation visible</small></div><div className="workflow-legend"><span><i className="legend-plan" />Planner plans</span><b>→</b><span><i className="legend-work" />Workers collaborate</span><b>→</b><span><i className="legend-result" />Planner delivers</span></div><button onClick={() => setManagerOpen(true)}>{managedLinks.length} published versions · manage access</button></section>
    </section>
    {shareOpen && <ShareModal shareInfo={shareInfo} close={() => setShareOpen(false)} openManagement={() => { setShareOpen(false); setManagerOpen(true); }} />}{managerOpen && <ManagementModal links={managedLinks} close={() => setManagerOpen(false)} onDelete={removeManagedLink} />}
  </main>;
}

function Builder({ step, setStep, architecture, chooseArchitecture, userName, updateUserName, teamName, setTeamName, agents, selectedId, setSelectedId, updateAgent, addWorker, removeWorker, createTeam }: { step: number; setStep: (value: number) => void; architecture: Architecture; chooseArchitecture: (value: Architecture) => void; userName: string; updateUserName: (value: string) => void; teamName: string; setTeamName: (value: string) => void; agents: Agent[]; selectedId: string; setSelectedId: (value: string) => void; updateAgent: (id: string, field: "name" | "responsibility", value: string) => void; addWorker: () => void; removeWorker: (id: string) => void; createTeam: () => void }) {
  const selected = agents.find((agent) => agent.id === selectedId) ?? agents[0];
  return <main className="builder-shell"><header className="builder-header"><div className="brand dark"><span className="brand-mark">A</span><span>SharableAgentCrew</span></div><div className="builder-progress"><span className={step >= 1 ? "now" : ""}>1. Choose architecture</span><i /><span className={step >= 2 ? "now" : ""}>2. Define members</span><i /><span className={step >= 3 ? "now" : ""}>3. Finalize the team</span></div><span className="builder-help">Team setup wizard</span></header><section className="builder-content">{step === 1 && <><span className="section-kicker">CREATE YOUR TEAM</span><h1>Start your team from Planner–Worker.</h1><p className="builder-lead">Teams use only two role templates: Planner handles breakdown, coordination, and delivery; Worker executes the responsibilities you write for it. You can add any number of Workers.</p><div className="identity-fields"><label>Your name<input value={userName} onChange={(event) => updateUserName(event.target.value)} placeholder="e.g., Alex Chen" /></label><label>Team name<input value={teamName} onChange={(event) => setTeamName(event.target.value)} placeholder="e.g., New product market research team" /></label></div><div className="architecture-grid single-template">{architectureOptions.map((option) => <button key={option.id} className={`architecture-card ${architecture === option.id ? "chosen" : ""}`} onClick={() => chooseArchitecture(option.id)}><span className="architecture-icon">{option.icon}</span><strong>{option.label}</strong><p>{option.hint}</p><em>{option.flow}</em>{architecture === option.id && <b>✓</b>}</button>)}</div><div className="builder-footer"><span>Fixed role templates only; each member's name, responsibility, and working style are defined by you</span><button className="next-button" onClick={() => setStep(2)}>Configure members  →</button></div></>}{step === 2 && <><span className="section-kicker">DEFINE THE TEAM</span><h1>Name your members and describe how they work.</h1><p className="builder-lead">No preset "researcher" or "analyst" roles. You can name any Worker to fit your business and write a dedicated responsibility for it.</p><div className="builder-members"><div className="member-list">{agents.map((agent, index) => <button key={agent.id} className={`builder-member ${selectedId === agent.id ? "selected" : ""}`} onClick={() => setSelectedId(agent.id)}><span className="member-index">{String(index + 1).padStart(2, "0")}</span><div className={`agent-avatar ${agent.color}`}>{agent.avatar}</div><div><strong>{agent.name}</strong><span>{agent.role}</span></div><i>›</i></button>)}<button className="add-member-large" onClick={addWorker}>+ Add Worker</button></div><div className="builder-editor"><span className="section-kicker">EDIT MEMBER</span><div className="editor-person"><div className={`agent-avatar large ${selected.color}`}>{selected.avatar}</div><div><h3>{selected.name}</h3><p>{selected.role}</p></div>{selected.role === "Worker" && <button className="text-danger" onClick={() => removeWorker(selected.id)}>Remove Worker</button>}</div><label>Member name<input value={selected.name} onChange={(event) => updateAgent(selected.id, "name", event.target.value)} /></label><div className="fixed-field"><span>Role</span><strong>{selected.role}</strong><small>Role templates use only Planner / Worker</small></div><label>Responsibility and working style<textarea rows={5} value={selected.responsibility} onChange={(event) => updateAgent(selected.id, "responsibility", event.target.value)} /></label><div className="definition-tip"><strong>Suggested when writing responsibilities:</strong><span>What the input is, what needs to be done, what the deliverable is, and who receives the result.</span></div></div></div><div className="builder-footer"><button className="back-button" onClick={() => setStep(1)}>← Back to architecture</button><button className="next-button" onClick={() => setStep(3)}>Review the team  →</button></div></>}{step === 3 && <><span className="section-kicker">READY TO RUN</span><h1>Your team is ready to collaborate.</h1><p className="builder-lead">After publishing, you can authorize others to use it. They can enter tasks and view the conversation, but members, responsibilities, flows, and tools stay read-only.</p><div className="ready-card"><div className="ready-title"><div><span className="section-kicker">TEAM BLUEPRINT</span><h2>{teamName || "Untitled team"}</h2><p>{architectureOptions.find((item) => item.id === architecture)?.label} · {architectureOptions.find((item) => item.id === architecture)?.flow}</p></div><span className="ready-count">{agents.length} members</span></div><div className="ready-members">{agents.map((agent, index) => <div key={agent.id}><div className={`agent-avatar ${agent.color}`}>{agent.avatar}</div><span>{agent.name}</span>{index < agents.length - 1 && <i>→</i>}</div>)}</div><div className="permission-preview"><span>◉</span><p><strong>Publishing permissions:</strong> owners can edit and update versions; invited users can only run the team and view the collaboration process and results of their own tasks.</p></div></div><div className="builder-footer"><button className="back-button" onClick={() => setStep(2)}>← Edit members</button><button className="create-button" onClick={createTeam}>Create and enter team  →</button></div></>}</section></main>;
}

function EvolutionPanel({ agents, evolving, summary, suggestions, apply, dismiss }: { agents: Agent[]; evolving: boolean; summary: string; suggestions: EvolutionSuggestion[]; apply: (suggestion: EvolutionSuggestion) => void; dismiss: () => void }) { return <section className="evolution-panel"><header><div><span className="section-kicker">CONTROLLED EVOLUTION</span><h3>Team self-evolution</h3></div>{!evolving && <button onClick={dismiss}>Not now</button>}</header>{evolving ? <div className="evolution-loading"><span className="progress-spinner" /><div><strong>Reviewing this round of collaboration</strong><small>Suggestions are based only on observed performance; agents are never modified automatically.</small></div></div> : <><p className="evolution-summary">{summary}</p>{suggestions.length === 0 ? <div className="evolution-empty">There is not enough evidence to change agent responsibilities right now; the team keeps its current configuration.</div> : <div className="evolution-list">{suggestions.map((suggestion) => { const agent = agents.find((item) => item.id === suggestion.agentId); return <article key={suggestion.agentId}><div className={`agent-avatar ${agent?.color ?? "violet"}`}>{agent?.avatar ?? "?"}</div><div><strong>{agent?.name ?? "Member"}</strong><p>{suggestion.reason}</p><details><summary>View improved responsibility</summary><span>{suggestion.proposedResponsibility}</span></details></div><button onClick={() => apply(suggestion)}>Apply</button></article>; })}</div>}<small className="evolution-note">Applying updates only the current draft; to give shared users the new capabilities, republish the team.</small></>}</section>; }
function ShareModal({ shareInfo, close, openManagement }: { shareInfo: ManagedLink | null; close: () => void; openManagement: () => void }) { const copy = (text: string) => navigator.clipboard?.writeText(text); return <div className="modal-backdrop" role="presentation" onMouseDown={close}><section className="share-modal" role="dialog" aria-modal="true" aria-labelledby="share-title" onMouseDown={(event) => event.stopPropagation()}><button className="close" onClick={close} aria-label="Close">×</button><span className="section-kicker">VERSION PUBLISHED</span><h2 id="share-title">Team version published</h2><p>This version's members, responsibilities, and architecture are locked. The other party needs no registration; with the access code they can only run it, not modify the team.</p>{shareInfo && <div className="share-result"><label>Link for this version<div><input readOnly value={shareInfo.url} /><button onClick={() => copy(shareInfo.url)}>Copy</button></div></label><label>Access code<div><input readOnly value={shareInfo.accessCode} /><button onClick={() => copy(shareInfo.accessCode)}>Copy</button></div></label><small>If you change agents later, click "Publish new version"; the original version will not be overwritten.</small></div>}<div className="modal-actions"><button className="modal-secondary" onClick={close}>Done</button><button className="modal-publish" onClick={openManagement}>Manage sharing & access</button></div></section></div>; }

function ManagementModal({ links, close, onDelete }: { links: ManagedLink[]; close: () => void; onDelete: (teamId: string) => void }) {
  const [selectedId, setSelectedId] = useState(links[0]?.teamId ?? "");
  const [data, setData] = useState<ManagementData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [expiryDays, setExpiryDays] = useState("30");
  // Admin mode: the token is validated by the Cloudflare worker's env.ADMIN_TOKEN
  // (`wrangler secret put ADMIN_TOKEN`). Admins can view and delete every version in the
  // database (including ones shared by others) — the source of the "host" cleanup power.
  const [adminInput, setAdminInput] = useState("");
  const [adminToken, setAdminToken] = useState(() => window.sessionStorage.getItem("arbor-admin-token") ?? "");
  const [adminTeams, setAdminTeams] = useState<AdminTeam[]>([]);
  const [adminMode, setAdminMode] = useState(false);
  const [adminBusy, setAdminBusy] = useState(false);
  const [adminError, setAdminError] = useState("");

  const isAdminView = adminMode && adminTeams.length > 0;
  const selectedOwn = links.find((link) => link.teamId === selectedId);
  const selectedTeamName = (isAdminView ? adminTeams.find((team) => team.teamId === selectedId)?.teamName : selectedOwn?.teamName) ?? "";
  const visibleTeams = isAdminView
    ? adminTeams.map((team) => ({ teamId: team.teamId, teamName: team.teamName, sub: `Version ${new Date(team.createdAt).toLocaleString("en-US")} · ${team.usageCount} questions` }))
    : links.map((link) => ({ teamId: link.teamId, teamName: link.teamName, sub: `Version ${new Date(link.createdAt).toLocaleString("en-US")}` }));

  const manageCall = useCallback(async (action: "list" | "update" | "delete", update?: { expiresAt: string | null; revoked: boolean }) => {
    const payload = isAdminView
      ? { teamId: selectedId, adminToken, action, ...update }
      : { teamId: selectedId, ownerToken: selectedOwn?.ownerToken ?? "", action, ...update };
    const response = await fetch("/share-api/api/manage", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    return await response.json() as ManagementData & { deleted?: boolean; error?: string };
  }, [isAdminView, selectedId, adminToken, selectedOwn]);

  async function loadAdminList(token: string): Promise<AdminTeam[]> {
    const response = await fetch("/share-api/api/manage", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ adminToken: token, action: "listAll" }) });
    const body = await response.json() as { teams?: AdminTeam[]; error?: string };
    if (!response.ok || !Array.isArray(body.teams)) throw new Error(body.error ?? "Incorrect admin token");
    return body.teams;
  }

  const loadDetail = useCallback(async () => {
    if (!selectedId) return;
    setLoading(true); setError("");
    try {
      const body = await manageCall("list");
      if (!body.team) throw new Error(body.error ?? "Unable to read run logs");
      setData(body);
    } catch (error) { setError(error instanceof Error ? error.message : "Unable to read run logs"); } finally { setLoading(false); }
  }, [selectedId, manageCall]);

  useEffect(() => { setData(null); if (selectedId) void loadDetail(); }, [selectedId, loadDetail]);

  async function enterAdmin() {
    const token = adminInput.trim();
    if (!token) return;
    setAdminBusy(true); setAdminError("");
    try {
      const teams = await loadAdminList(token);
      window.sessionStorage.setItem("arbor-admin-token", token);
      setAdminToken(token); setAdminTeams(teams); setAdminMode(true);
      setSelectedId(teams[0]?.teamId ?? ""); setData(null); setError("");
    } catch (error) { setAdminError(error instanceof Error ? error.message : "Unable to enter admin mode"); } finally { setAdminBusy(false); }
  }

  async function refreshAdmin() {
    if (!adminToken) return;
    setAdminBusy(true); setAdminError("");
    try {
      const teams = await loadAdminList(adminToken);
      setAdminTeams(teams); setAdminMode(true);
    } catch (error) { setAdminError(error instanceof Error ? error.message : "Unable to refresh the version list"); } finally { setAdminBusy(false); }
  }

  function exitAdmin() { setAdminMode(false); setAdminTeams([]); setSelectedId(links[0]?.teamId ?? ""); setData(null); setError(""); }
  function clearAdmin() { window.sessionStorage.removeItem("arbor-admin-token"); setAdminToken(""); setAdminInput(""); exitAdmin(); }

  function applyExpiry() {
    if (!data) return;
    const expiresAt = expiryDays === "never" ? null : new Date(Date.now() + Number(expiryDays) * 86400000).toISOString();
    void manageCall("update", { expiresAt, revoked: Boolean(data.team.revokedAt) }).then((body) => { if (body.team) setData(body); }).catch((error) => setError(error instanceof Error ? error.message : "Update failed"));
  }
  function toggleRevoked() { if (data) void manageCall("update", { expiresAt: data.team.expiresAt, revoked: !data.team.revokedAt }).then((body) => { if (body.team) setData(body); }).catch((error) => setError(error instanceof Error ? error.message : "Update failed")); }
  async function deleteVersion() {
    if (!selectedId || !window.confirm(`Permanently delete "${selectedTeamName}"? The access link and its question logs will be deleted and cannot be restored.`)) return;
    const wasAdmin = isAdminView;
    setLoading(true); setError("");
    try {
      const body = await manageCall("delete");
      if (!body.deleted) throw new Error(body.error ?? "Unable to delete this version");
      if (!wasAdmin) onDelete(selectedId);
      if (wasAdmin) setAdminTeams((current) => current.filter((team) => team.teamId !== selectedId));
      const nextId = (wasAdmin ? adminTeams.filter((team) => team.teamId !== selectedId).map((team) => team.teamId) : links.filter((link) => link.teamId !== selectedId).map((link) => link.teamId))[0] ?? "";
      setSelectedId(nextId); setData(null);
    } catch (error) { setError(error instanceof Error ? error.message : "Unable to delete this version"); } finally { setLoading(false); }
  }

  const copy = (text: string) => navigator.clipboard?.writeText(text);
  const hasAny = isAdminView ? adminTeams.length > 0 : links.length > 0;
  return <div className="modal-backdrop" role="presentation" onMouseDown={close}><section className="manage-modal" role="dialog" aria-modal="true" aria-labelledby="manage-title" onMouseDown={(event) => event.stopPropagation()}><button className="close" onClick={close} aria-label="Close">×</button><header><span className="section-kicker">ACCESS CONTROL</span><h2 id="manage-title">Share & access</h2><p>Manage published versions here: copy access details, set expiration, disable or permanently delete versions, and review users' question logs. Admin mode can manage versions shared by anyone.</p><div className="manage-admin-bar">{adminMode ? <><span className="manage-admin-status">Admin mode · all {adminTeams.length} versions</span><button className="mini-action" onClick={() => void refreshAdmin()} disabled={adminBusy}>Refresh</button><button className="mini-action" onClick={exitAdmin}>Exit admin mode</button><button className="text-danger" onClick={clearAdmin}>Clear token</button></> : <><input aria-label="Admin token" value={adminInput} onChange={(event) => setAdminInput(event.target.value)} placeholder="Admin token" /><button className="mini-action" onClick={() => void enterAdmin()} disabled={!adminInput.trim() || adminBusy}>{adminBusy ? "Verifying…" : "Enter admin mode"}</button></>}{adminError && <span className="manage-admin-error">{adminError}</span>}</div></header>{hasAny ? <div className="manage-layout"><aside>{visibleTeams.map((team) => <button key={team.teamId} className={selectedId === team.teamId ? "selected" : ""} onClick={() => setSelectedId(team.teamId)}><strong>{team.teamName}</strong><span>{team.sub}</span></button>)}</aside><main>{!isAdminView && selectedOwn && <div className="managed-access"><label>Access link<div><input readOnly value={selectedOwn.url} /><button onClick={() => copy(selectedOwn.url)}>Copy</button></div></label><label>Access code<div><input readOnly value={selectedOwn.accessCode} /><button onClick={() => copy(selectedOwn.accessCode)}>Copy</button></div></label></div>}{loading && !data ? <div className="manage-loading">Loading access info and logs…</div> : error ? <div className="run-error"><strong>Operation failed</strong><span>{error}</span></div> : data && <><div className="manage-summary"><div><span>Access status</span><strong className={data.team.revokedAt ? "danger" : "ok"}>{data.team.revokedAt ? "Disabled" : data.team.expiresAt && new Date(data.team.expiresAt) <= new Date() ? "Expired" : "Active"}</strong></div><div><span>Validity</span><strong>{data.team.expiresAt ? new Date(data.team.expiresAt).toLocaleString("en-US") : "Permanent"}</strong></div><div><span>Questions asked</span><strong>{data.logs.length}</strong></div></div><div className="manage-actions"><label>Validity period<select value={expiryDays} onChange={(event) => setExpiryDays(event.target.value)}><option value="7">7 days</option><option value="30">30 days</option><option value="90">90 days</option><option value="never">Permanent</option></select></label><button onClick={applyExpiry} disabled={loading}>Apply</button><button className={data.team.revokedAt ? "restore" : "revoke"} onClick={toggleRevoked} disabled={loading}>{data.team.revokedAt ? "Restore access" : "Disable access"}</button><button className="delete-version" onClick={() => void deleteVersion()} disabled={loading}>Delete version permanently</button></div><div className="usage-list"><div className="usage-list-title"><strong>Questions asked by users</strong><button onClick={() => void loadDetail()} disabled={loading}>Refresh</button></div>{data.logs.length === 0 ? <p>No usage records yet.</p> : data.logs.map((log) => <article key={log.id}><time>{new Date(`${log.created_at}Z`).toLocaleString("en-US")}</time><p>{log.task}</p></article>)}</div></>}</main></div> : <div className="manage-empty"><strong>{isAdminView ? "No published versions in the database yet" : "No published team versions yet"}</strong><span>{isAdminView ? "Teams shared by other users will appear here." : "Close this window and click \"Publish team\" in the top-right corner to create the first fixed version."}</span></div>}</section></div>;
}
