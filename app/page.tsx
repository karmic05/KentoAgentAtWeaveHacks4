"use client";

import { CopilotSidebar } from "@copilotkit/react-ui";
import { useCallback, useEffect, useMemo, useState } from "react";
import { CopilotBridge } from "./components/CopilotBridge";
import { type EditTool, type Flash, GridMap } from "./components/GridMap";
import { AgentRoster, EventFeed, MetricsStrip, Panel, Pipeline, TriageQueue } from "./components/Panels";
import { BrowserHive } from "./lib/engine";
import { API_BASE_URL, type ApiResponse, type GridState, type Health, api, isActive } from "./lib/kento";

const COPILOT_ENABLED = process.env.NEXT_PUBLIC_COPILOT_ENABLED === "true";
const SPEEDS = [
  { label: "0.5×", ms: 900 },
  { label: "1×", ms: 450 },
  { label: "2×", ms: 220 },
];

type Mode = "probing" | "remote" | "browser";

export default function Home() {
  const [mode, setMode] = useState<Mode>(API_BASE_URL ? "probing" : "browser");
  // Cheap to build (one procedural scenario), so always keep one ready as the fallback.
  const [browserHive] = useState(() => new BrowserHive());
  const [state, setState] = useState<GridState | null>(null);
  const [remoteStatus, setRemoteStatus] = useState<Health | null>(null);
  const [offline, setOffline] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [tool, setTool] = useState<EditTool>("none");
  const [speed, setSpeed] = useState(1);
  const [seed, setSeed] = useState("");

  const running = state?.sim.running ?? false;

  const status = mode === "browser" ? browserHive.health() : remoteStatus;

  // Prefer the full Python stack when it's reachable, else run in the browser.
  useEffect(() => {
    if (mode !== "probing") return;
    api<never>("/health")
      .then((data) => {
        setRemoteStatus(data as unknown as Health);
        setMode("remote");
      })
      .catch(() => setMode("browser"));
  }, [mode]);

  const refresh = useCallback(async () => {
    if (mode === "browser") {
      setState(browserHive.gridState());
      return;
    }
    try {
      const res = await fetch(`${API_BASE_URL}/grid-state`);
      if (!res.ok) throw new Error(`API ${res.status}`);
      setState(await res.json());
      setOffline(null);
    } catch (err) {
      setOffline(err instanceof Error ? err.message : "unreachable");
    }
  }, [mode, browserHive]);

  const run = useCallback(async (path: string, body: unknown = {}): Promise<ApiResponse> => {
    setBusy(path);
    setError(null);
    try {
      const data = mode === "browser" ? browserHive.request(path, body as Record<string, unknown>) : await api(path, body);
      if (data.grid_state) setState(data.grid_state);
      return data;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      throw err;
    } finally {
      setBusy(null);
    }
  }, [mode, browserHive]);

  // Poll fast while the autopilot is moving agents, slowly otherwise.
  useEffect(() => {
    if (mode === "probing") return;
    const first = setTimeout(refresh, 0);
    const timer = setInterval(refresh, running ? (mode === "browser" ? 120 : 350) : 1500);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [refresh, running, mode]);

  useEffect(() => {
    if (mode !== "remote") return;
    api<never>("/health")
      .then((data) => setRemoteStatus(data as unknown as Health))
      .catch(() => setRemoteStatus(null));
  }, [mode, offline, state?.llm.active]);

  const toggleAutopilot = useCallback(() => {
    run("/sim/autopilot", { running: !running, interval_ms: SPEEDS[speed].ms, aftershocks: state?.sim.aftershocks ?? true }).catch(() => {});
  }, [run, running, speed, state?.sim.aftershocks]);

  const step = useCallback(() => {
    run("/sim/step").catch(() => {});
  }, [run]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
      if (event.code === "Space") {
        event.preventDefault();
        toggleAutopilot();
      } else if (event.key === "s" && !running) {
        step();
      } else if (event.key === "Escape") {
        setTool("none");
        setSelectedAgentId(null);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleAutopilot, step, running]);

  const agents = useMemo(() => state?.agents ?? [], [state]);
  const survivors = useMemo(() => (state?.survivors ?? []).filter((s) => isActive(s.status)), [state]);
  const backupCells = useMemo(
    () => new Set((state?.backups ?? []).map((b) => Number(b.cell)).filter((c) => !Number.isNaN(c))),
    [state],
  );
  // Recent rescues/losses become one-shot bursts on the map. The log key is the
  // React key, so each event animates once even though polling repeats it.
  const flashes = useMemo<Flash[]>(() => {
    const newest = Math.max(0, ...(state?.mission_logs ?? []).map((l) => l.timestamp_ns));
    return (state?.mission_logs ?? [])
      .filter((l) => (l.event === "field_agent_rescue" || l.event === "survivor_lost") && newest - l.timestamp_ns < 1.5e9)
      .map((l) => {
        const d = l.data as { x?: number; y?: number };
        return { key: l.key, cell: Number(d.y) * 10 + Number(d.x), tone: l.event === "survivor_lost" ? "danger" : "ok" } as Flash;
      })
      .filter((f) => !Number.isNaN(f.cell));
  }, [state]);
  const metrics = state?.metrics ?? {};
  const complete = state != null && (metrics.total ?? 0) > 0 && (metrics.active ?? 0) === 0;

  const dashboard = (
    <div className="min-h-screen bg-bg text-text">
      <header className="border-b border-line">
        <div className="mx-auto flex max-w-[1500px] flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3 md:px-6">
          <div className="flex items-baseline gap-3">
            <h1 className="font-mono text-lg font-bold tracking-[0.2em]">KENTO</h1>
            <p className="text-sm text-muted">Autonomous disaster-response hive</p>
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-2 text-[11px]">
            <Chip
              ok={!offline}
              label={offline ? "API offline" : mode === "browser" ? "engine · in-browser" : `redis · ${status?.redis ?? "…"}`}
            />
            <Chip
              ok={Boolean(state?.llm.active)}
              label={state?.llm.active ? `brain · ${state.llm.provider ?? "llm"} ${state.llm.model}` : "brain · deterministic"}
              title={state?.llm.reason || (state?.llm.configured ? "" : "Set FIELD_AGENT_USE_LLM=1 and OPENAI_API_KEY to enable LLM-guided agents")}
            />
            <Chip
              ok={state?.sim.source === "redis-cloud"}
              label={state?.sim.source === "redis-cloud" ? "source · Snowflake snapshot" : `source · procedural #${state?.sim.seed ?? "–"}`}
            />
          </div>
        </div>
      </header>

      <main className="mx-auto grid max-w-[1500px] gap-4 px-4 py-4 md:px-6 lg:grid-cols-[minmax(0,1fr)_400px]">
        <div className="min-w-0 space-y-4">
          {mode === "browser" && (
            <div className="rounded-xl border border-accent/30 bg-accent/5 px-4 py-3 text-sm text-muted">
              <span className="font-medium text-accent">Live demo.</span> The hive is running entirely in your
              browser with the deterministic planner. The full stack (Snowflake → dbt → Redis, the LlamaIndex
              commander, the local Ollama LLM advisor, and Weave tracing) runs locally.{" "}
              <a
                className="text-accent underline-offset-2 hover:underline"
                href="https://github.com/karmic05/KentoAgentAtWeaveHacks4/tree/kento-command-center"
              >
                See the code on GitHub
              </a>
              .
            </div>
          )}

          {offline && (
            <div className="rounded-xl border border-warn/40 bg-warn/5 px-4 py-3 text-sm text-warn">
              Can&apos;t reach the hive API ({offline}). Start it with{" "}
              <code className="font-mono text-xs">npm run api</code>.
            </div>
          )}

          <div className="mx-auto w-full max-w-[min(100%,calc(100vh-15rem))] min-w-[280px]">
            <div className="relative">
              <GridMap
                cells={state?.cells ?? []}
                agents={agents}
                survivors={survivors}
                backupCells={backupCells}
                flashes={flashes}
                selectedAgentId={selectedAgentId}
                tool={tool}
                moveMs={Math.min(SPEEDS[speed].ms, 450)}
                onSelectAgent={setSelectedAgentId}
                onCellClick={(x, y) =>
                  run("/grid/edit", { x, y, tool }).then((data) => {
                    const result = data.result as { changed?: boolean; reason?: string } | undefined;
                    if (result && !result.changed) setError(`Can't edit (${x}, ${y}): ${result.reason?.replaceAll("_", " ")}`);
                  }).catch(() => {})
                }
              />
              {complete && !running && (
                <div className="pointer-events-none absolute inset-x-0 top-4 flex justify-center">
                  <div className="pointer-events-auto rounded-xl border border-ok/40 bg-[#07130f]/95 px-5 py-3 text-center shadow-2xl backdrop-blur">
                    <p className="text-sm font-semibold text-ok">Mission complete</p>
                    <p className="tabular mt-0.5 text-xs text-muted">
                      {metrics.rescued}/{metrics.total} rescued · {metrics.lost} lost · {metrics.tick} ticks ·{" "}
                      {metrics.distance} cells travelled
                    </p>
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className="btn btn-primary min-w-28 justify-center" onClick={toggleAutopilot} disabled={complete && !running}>
              {running ? "❚❚ Pause" : "▶ Autopilot"} <span className="kbd !border-[#04121c]/30 !text-[#04121c]/70">space</span>
            </button>
            <button type="button" className="btn" onClick={step} disabled={running || complete}>
              Step <span className="kbd">s</span>
            </button>
            <div className="flex overflow-hidden rounded-lg border border-line-strong">
              {SPEEDS.map((option, index) => (
                <button
                  key={option.label}
                  type="button"
                  onClick={() => {
                    setSpeed(index);
                    if (running) run("/sim/autopilot", { running: true, interval_ms: option.ms, aftershocks: state?.sim.aftershocks ?? true }).catch(() => {});
                  }}
                  className={`px-2.5 py-1.5 font-mono text-xs ${speed === index ? "bg-accent/15 text-accent" : "bg-panel-2 text-muted hover:text-text"}`}
                >
                  {option.label}
                </button>
              ))}
            </div>
            <button
              type="button"
              className={`btn ${state?.sim.aftershocks ? "btn-on" : ""}`}
              onClick={() =>
                run("/sim/autopilot", { running, interval_ms: SPEEDS[speed].ms, aftershocks: !(state?.sim.aftershocks ?? true) }).catch(() => {})
              }
              title="Random aftershocks collapse cells on the agents' planned routes while the autopilot runs"
            >
              Aftershocks {state?.sim.aftershocks ? "on" : "off"}
            </button>
            <button type="button" className="btn" onClick={() => run("/sim/aftershock").catch(() => {})}>
              Trigger aftershock
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => run("/commander/plan").catch(() => {})}
              disabled={busy === "/commander/plan"}
              title="Run the LlamaIndex workflow: coordinate → route planning → guarded dispatch"
            >
              {busy === "/commander/plan" ? "Commander planning…" : "Run commander"}
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-panel px-3 py-2.5">
            <span className="text-[11px] uppercase tracking-wider text-faint">Scenario</span>
            <input
              value={seed}
              onChange={(e) => setSeed(e.target.value.replace(/\D/g, "").slice(0, 7))}
              placeholder="random seed"
              aria-label="Scenario seed"
              className="w-28 rounded-md border border-line-strong bg-panel-2 px-2 py-1.5 font-mono text-xs outline-none focus:border-accent"
            />
            <button
              type="button"
              className="btn"
              onClick={() => run("/scenario/reset", seed ? { seed: Number(seed) } : {}).catch(() => {})}
            >
              New disaster
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => run("/scenario/sync-cloud").catch(() => {})}
              disabled={!status?.cloud_source || busy === "/scenario/sync-cloud"}
              title={status?.cloud_source ? "Load the latest Snowflake → dbt marts from Redis Cloud" : "Set KENTO_SOURCE_REDIS_* in .env"}
            >
              {busy === "/scenario/sync-cloud" ? "Syncing…" : "Sync from Redis Cloud"}
            </button>
            <span className="mx-1 hidden h-5 w-px bg-line-strong sm:block" />
            <span className="text-[11px] uppercase tracking-wider text-faint">Edit map</span>
            {(["rubble", "survivor"] as const).map((option) => (
              <button
                key={option}
                type="button"
                className={`btn ${tool === option ? "btn-on" : ""}`}
                onClick={() => setTool(tool === option ? "none" : option)}
              >
                {option === "rubble" ? "Toggle rubble" : "Drop survivor"}
              </button>
            ))}
          </div>

          {(error || tool !== "none") && (
            <p className={`text-xs ${error ? "text-danger" : "text-muted"}`}>
              {error ??
                (tool === "rubble"
                  ? "Click open ground to drop debris on the agents' routes, or rubble to clear it. Esc to stop."
                  : "Click open ground for a visible survivor, or rubble to bury a trapped one. Esc to stop.")}
            </p>
          )}

          <Panel title="Architecture · live data path">
            <Pipeline health={status} sim={state?.sim ?? null} browser={mode === "browser"} />
          </Panel>
        </div>

        <aside className="min-w-0 space-y-4">
          <Panel title="Mission">
            <MetricsStrip metrics={metrics} />
          </Panel>
          <Panel title="Rescue team" aside={<span className="text-[10px] text-faint">click to trace route</span>}>
            <AgentRoster agents={agents} selectedAgentId={selectedAgentId} onSelect={setSelectedAgentId} />
          </Panel>
          <Panel title="Triage queue" aside={<span className="text-[10px] text-faint">lowest health first</span>}>
            <TriageQueue survivors={survivors} agents={agents} />
          </Panel>
          <Panel title="Mission log">
            <EventFeed logs={state?.mission_logs ?? []} />
          </Panel>
        </aside>
      </main>
    </div>
  );

  if (!COPILOT_ENABLED) return dashboard;

  return (
    <CopilotSidebar
      defaultOpen={false}
      clickOutsideToClose
      labels={{
        title: "Rescue Copilot",
        initial: "Mission command online. Ask me to run the autopilot, trigger an aftershock, or explain what an agent is doing.",
      }}
    >
      <CopilotBridge agents={agents} survivors={survivors} metrics={metrics} run={run} onSelectAgent={setSelectedAgentId} />
      {dashboard}
    </CopilotSidebar>
  );
}

function Chip({ ok, label, title }: { ok: boolean; label: string; title?: string }) {
  return (
    <span
      title={title}
      className="flex items-center gap-1.5 rounded-full border border-line bg-panel px-2.5 py-1 font-mono text-muted"
    >
      <span className={`h-1.5 w-1.5 rounded-full ${ok ? "bg-ok" : "bg-faint"}`} />
      {label}
    </span>
  );
}
