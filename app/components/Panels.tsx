"use client";

import type { ReactNode } from "react";
import {
  type Agent,
  type Health,
  type Metrics,
  type MissionLog,
  type SimState,
  type Survivor,
  agentColor,
  describeLog,
  health,
  healthColor,
  isTrapped,
} from "../lib/kento";

export function Panel({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-2xl border border-line bg-panel">
      <header className="flex items-center justify-between px-4 pt-3.5">
        <h2 className="label">{title}</h2>
        {aside && <span className="text-[11px] text-faint">{aside}</span>}
      </header>
      <div className="px-4 pb-4 pt-3">{children}</div>
    </section>
  );
}

export function MetricsStrip({ metrics }: { metrics: Metrics }) {
  const total = metrics.total ?? 0;
  const rescued = metrics.rescued ?? 0;
  const lost = metrics.lost ?? 0;
  const active = metrics.active ?? 0;
  const items = [
    { label: "Rescued", value: rescued, tone: "text-ok" },
    { label: "Active", value: active, tone: "text-warn" },
    { label: "Lost", value: lost, tone: lost ? "text-danger" : "text-text" },
    { label: "Tick", value: metrics.tick ?? 0, tone: "text-text" },
  ];
  return (
    <div>
      <div className="grid grid-cols-4 divide-x divide-line">
        {items.map((item, index) => (
          <div key={item.label} className={index === 0 ? "pr-3" : "px-3"}>
            <p className={`tabular text-[26px] font-semibold leading-none tracking-tight ${item.tone}`}>{item.value}</p>
            <p className="mt-1.5 text-[11px] text-faint">{item.label}</p>
          </div>
        ))}
      </div>
      <div className="mt-4 flex h-1 overflow-hidden rounded-full bg-white/[0.06]" aria-label="Mission progress">
        <div className="bg-ok transition-[width] duration-500 ease-out" style={{ width: `${total ? (rescued / total) * 100 : 0}%` }} />
        <div className="bg-danger transition-[width] duration-500 ease-out" style={{ width: `${total ? (lost / total) * 100 : 0}%` }} />
      </div>
      <dl className="tabular mt-4 grid grid-cols-4 gap-2 text-[11px]">
        <Stat label="distance" value={metrics.distance ?? 0} />
        <Stat label="reroutes" value={metrics.reroutes ?? 0} />
        <Stat label="backups" value={metrics.backup_requests ?? 0} />
        <Stat label="aftershocks" value={metrics.aftershocks ?? 0} />
      </dl>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dd className="font-mono text-[13px] text-text">{value}</dd>
      <dt className="text-faint">{label}</dt>
    </div>
  );
}

export function AgentRoster({
  agents,
  selectedAgentId,
  onSelect,
}: {
  agents: Agent[];
  selectedAgentId: string | null;
  onSelect: (id: string | null) => void;
}) {
  return (
    <ul className="-mx-2 divide-y divide-line">
      {agents.map((agent) => {
        const color = agentColor(agent.id);
        const selected = agent.id === selectedAgentId;
        return (
          <li key={agent.id}>
            <button
              type="button"
              onClick={() => onSelect(selected ? null : agent.id)}
              className={`w-full rounded-lg px-2 py-2.5 text-left transition-colors duration-150 ${
                selected ? "bg-white/[0.05]" : "hover:bg-white/[0.03]"
              }`}
            >
              <div className="flex items-center gap-2.5">
                <span
                  className="flex h-5 w-5 shrink-0 items-center justify-center rounded-[5px] font-mono text-[11px] font-bold text-[#0b0b0a]"
                  style={{ background: color }}
                >
                  {agent.id}
                </span>
                <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{agent.status}</span>
                <span
                  className={`font-mono text-[10px] ${agent.brain === "llm" ? "text-accent" : "text-faint"}`}
                  title={agent.brain === "llm" ? "Decided by the LLM, validated by guardrails" : "Decided by the deterministic planner"}
                >
                  {agent.brain === "llm" ? "llm" : "rules"}
                </span>
              </div>
              {agent.thought && <p className="mt-1 pl-[30px] text-xs leading-relaxed text-muted">{agent.thought}</p>}
              <p className="tabular mt-1 pl-[30px] font-mono text-[10px] text-faint">
                ({agent.x},{agent.y}) · {agent.rescues ?? 0} rescued · {agent.distance ?? 0} cells moved
              </p>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

export function TriageQueue({ survivors, agents }: { survivors: Survivor[]; agents: Agent[] }) {
  const sorted = [...survivors].sort((a, b) => health(a) - health(b));
  if (sorted.length === 0) {
    return <p className="text-sm text-faint">No active survivors. Generate a scenario or drop one on the map.</p>;
  }
  return (
    <ul className="space-y-3">
      {sorted.map((survivor) => {
        const value = health(survivor);
        const trapped = isTrapped(survivor.status);
        const responders = agents.filter((a) => a.target_survivor_id === survivor.id);
        return (
          <li key={survivor.id}>
            <div className="flex items-center justify-between gap-2 text-sm">
              <span className="flex items-center gap-2">
                <span className={`font-mono text-xs font-semibold ${trapped ? "text-danger" : "text-warn"}`}>
                  {survivor.id}
                </span>
                <span className="text-xs text-muted">
                  {trapped ? `trapped · air ${survivor.data.air_supply || "?"}` : `visible · ${survivor.data.injury_severity || "injured"}`}
                </span>
              </span>
              <span className="flex gap-1">
                {responders.map((a) => (
                  <span
                    key={a.id}
                    className="flex h-4 w-4 items-center justify-center rounded font-mono text-[9px] font-bold text-[#0b0b0a]"
                    style={{ background: agentColor(a.id) }}
                  >
                    {a.id}
                  </span>
                ))}
              </span>
            </div>
            <div className="mt-1.5 flex items-center gap-2">
              <div className="h-1 flex-1 overflow-hidden rounded-full bg-white/[0.06]">
                <div
                  className="h-full rounded-full transition-[width] duration-500 ease-out"
                  style={{ width: `${value}%`, background: healthColor(value) }}
                />
              </div>
              <span className="tabular w-7 text-right font-mono text-[10px] text-muted">{value.toFixed(0)}</span>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

const TONE: Record<string, string> = {
  ok: "bg-ok",
  warn: "bg-warn",
  danger: "bg-danger",
  agent: "bg-accent",
  info: "bg-[#b4a2f5]",
  muted: "bg-faint",
};

export function EventFeed({ logs }: { logs: MissionLog[] }) {
  const recent = [...logs].reverse().slice(0, 40);
  return (
    <ol className="scroll-thin max-h-72 space-y-2 overflow-y-auto pr-1">
      {recent.length === 0 && <li className="text-sm text-faint">Waiting for mission events…</li>}
      {recent.map((entry) => {
        const { tone, text } = describeLog(entry);
        const time = new Date(entry.timestamp_ns / 1e6).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        });
        return (
          <li key={entry.key} className="feed-enter flex items-start gap-2 text-xs leading-relaxed">
            <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${TONE[tone] ?? TONE.muted}`} />
            <span className="flex-1 text-muted">{text}</span>
            <span className="tabular shrink-0 font-mono text-[10px] text-faint">{time}</span>
          </li>
        );
      })}
    </ol>
  );
}

export function Pipeline({ health: status, sim, browser }: { health: Health | null; sim: SimState | null; browser: boolean }) {
  const cloud = sim?.source === "redis-cloud";
  const local = browser ? "local stack" : null;
  const stages = [
    {
      name: "Snowflake",
      detail: "Snowpark generators",
      live: cloud,
      note: local ?? (cloud && sim?.cloud_last_sync ? `snapshot ${sim.cloud_last_sync.slice(0, 10)}` : "batch source"),
    },
    { name: "dbt", detail: "staging → marts", live: cloud, note: local ?? "3 marts" },
    {
      name: "Redis Cloud",
      detail: "matured layer",
      live: Boolean(status?.cloud_source),
      note: local ?? (status?.cloud_source ? "connected" : "not configured"),
    },
    {
      name: "Redis hot memory",
      detail: "grid · survivors · agents",
      live: Boolean(status),
      note: browser ? "in-browser engine" : status?.redis ?? "offline",
    },
    {
      name: "LlamaIndex",
      detail: "strategic commander",
      live: Boolean(status) && !browser,
      note: browser ? "browser port of the plan" : "triage → route → dispatch",
    },
    {
      name: "Field agents",
      detail: "observe · think · act",
      live: Boolean(status),
      note: status?.llm.active ? `${status.llm.provider ?? "LLM"} · ${status.llm.model}` : "deterministic planner",
    },
    {
      name: "W&B Weave",
      detail: "guardrails + traces",
      live: Boolean(status?.weave),
      note: local ?? (status?.weave ? "tracing" : "guardrails only"),
    },
  ];
  return (
    <ol className="grid grid-cols-2 gap-x-4 gap-y-4 sm:grid-cols-4 xl:grid-cols-7">
      {stages.map((stage, index) => (
        <li key={stage.name} className="border-l border-line pl-3">
          <p className="font-mono text-[9px] text-faint">{String(index + 1).padStart(2, "0")}</p>
          <p className="mt-1 flex items-center gap-1.5 text-xs font-medium">
            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${stage.live ? "bg-ok" : "bg-faint"}`} />
            {stage.name}
          </p>
          <p className="text-[10px] text-faint">{stage.detail}</p>
          <p className="truncate font-mono text-[9px] text-muted" title={stage.note}>{stage.note}</p>
        </li>
      ))}
    </ol>
  );
}
