import type { CSSProperties } from "react";
import type { AgentActivity, RunStage } from "@/lib/team-orchestrator";

type Agent = { id: string; name: string; role: string; avatar: string; color: string };

export function TeamMap({ agents, selectedId, setSelectedId }: { agents: Agent[]; selectedId: string; setSelectedId: (id: string) => void; architecture: "planner" }) {
  const workers = agents.slice(1);
  return <div className="team-map architecture-planner"><div className="map-label">Planner → Workers → Planner</div><div className="planner-node"><AgentCard agent={agents[0]} selected={selectedId === agents[0]?.id} onSelect={setSelectedId} lead /></div><div className="worker-branches" style={{ "--worker-count": Math.max(workers.length, 1) } as CSSProperties}>{workers.map((agent) => <div className="worker-node" key={agent.id}><AgentCard agent={agent} selected={selectedId === agent.id} onSelect={setSelectedId} /></div>)}</div></div>;
}

function AgentCard({ agent, selected, onSelect, lead = false }: { agent: Agent; selected: boolean; onSelect: (id: string) => void; lead?: boolean }) {
  return <button className={`agent-card ${selected ? "selected" : ""} ${lead ? "lead" : ""}`} onClick={() => onSelect(agent.id)}><div className={`agent-avatar ${agent.color}`}>{agent.avatar}</div><div className="agent-card-copy"><strong>{agent.name}</strong><span>{agent.role}</span></div><i className="node-status" /></button>;
}

export function AgentActivityPanel({ agents, activity }: { agents: Agent[]; activity: Record<string, AgentActivity> }) {
  return <div className="agent-activity" role="status" aria-live="assertive"><div className="activity-title"><span className="activity-pulse" /><strong>Team started</strong><small>Status updates in real time</small></div><div className="activity-members">{agents.map((agent) => { const current = activity[agent.id]; return <div key={agent.id} className={current?.state ?? "waiting"}><span className={`agent-avatar ${agent.color}`}>{agent.avatar}</span><div><strong>{agent.name}</strong><small>{current?.label ?? "Waiting to speak"}</small></div>{current?.state === "thinking" ? <i className="mini-spinner" /> : current?.state === "done" ? <i>✓</i> : <i>·</i>}</div>; })}</div></div>;
}

export function RunProgress({ stage }: { stage: RunStage }) {
  const steps: Array<{ id: RunStage; label: string }> = [{ id: "planning", label: "Planner breakdown" }, { id: "working", label: "Workers first round" }, { id: "discussing", label: "Team discussion" }, { id: "summarizing", label: "Planner summary" }];
  const active = Math.max(0, steps.findIndex((step) => step.id === stage));
  return <div className="run-progress"><div className="progress-copy"><span className="progress-spinner" /><div><strong>{steps[active].label} in progress</strong><small>Each member's message appears as soon as it is said; please do not click repeatedly</small></div></div><div className="progress-steps">{steps.map((step, index) => <span key={step.id} className={index < active ? "done" : index === active ? "active" : ""}>{index < active ? "✓" : index + 1} {step.label}</span>)}</div></div>;
}
