// Empty (e.g. on Vercel) means the hive runs in the browser via BrowserHive.
export const API_BASE_URL = process.env.NEXT_PUBLIC_KENTO_API ?? "";
export const GRID_SIZE = 10;

export type GridNode = {
  type?: string;
  passable?: string;
  id?: string;
  severity?: string;
  building_id?: string;
  road_id?: string;
};

export type GridCell = { x: number; y: number; cell: number; node: GridNode };

export type Agent = {
  id: string;
  x: number;
  y: number;
  cell: number;
  status: string;
  target_survivor_id?: string;
  target_cell?: number | null;
  path?: number[];
  thought?: string;
  brain?: string;
  last_action?: string;
  rescues?: string;
  distance?: string;
};

export type Survivor = {
  id: string;
  x: number;
  y: number;
  cell: number;
  status: string;
  data: Record<string, string>;
};

export type MissionLog = { key: string; event: string; timestamp_ns: number; data: unknown };

export type Metrics = {
  tick?: number;
  total?: number;
  rescued?: number;
  lost?: number;
  active?: number;
  distance?: number;
  reroutes?: number;
  backup_requests?: number;
  aftershocks?: number;
  decisions_rules?: number;
  decisions_llm?: number;
  survival_rate?: number;
};

export type SimState = {
  running: boolean;
  interval_ms: number;
  aftershocks: boolean;
  seed: string | null;
  source: string;
  cloud_last_sync: string | null;
  completed_tick: number | null;
};

export type LlmStatus = { configured: boolean; active: boolean; model: string; reason: string; provider?: string };

export type GridState = {
  cells: GridCell[];
  survivors: Survivor[];
  agents: Agent[];
  mission_logs: MissionLog[];
  metrics: Metrics;
  sim: SimState;
  llm: LlmStatus;
  backups: Record<string, string>[];
};

export type Health = {
  ok: boolean;
  redis: string;
  llm: LlmStatus;
  weave: boolean;
  cloud_source: boolean;
};

export type ApiResponse<T = unknown> = { result?: T; grid_state?: GridState };

export async function api<T = unknown>(path: string, body?: unknown): Promise<ApiResponse<T>> {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new Error(detail?.detail ?? `Request failed (${res.status})`);
  }
  return res.json();
}

export const AGENT_COLORS: Record<string, string> = {
  A: "#38bdf8",
  B: "#a78bfa",
  C: "#34d399",
  D: "#f472b6",
  E: "#a3e635",
  F: "#818cf8",
};

export function agentColor(id: string): string {
  return AGENT_COLORS[id] ?? "#e2e8f0";
}

export function isTrapped(status: string): boolean {
  return status === "trapped" || status === "trapped_beneath";
}

export function isActive(status: string): boolean {
  return status !== "rescued" && status !== "lost";
}

export function health(survivor: Survivor): number {
  return Math.max(0, Math.min(100, Number(survivor.data.health ?? 100)));
}

export function healthColor(value: number): string {
  if (value > 60) return "var(--ok)";
  if (value > 30) return "var(--warn)";
  return "var(--danger)";
}

type LogData = Record<string, unknown>;

export function describeLog(entry: MissionLog): { tone: string; text: string } {
  const d = (entry.data && typeof entry.data === "object" ? entry.data : {}) as LogData;
  const agent = d.agent_id ? `Agent ${d.agent_id}` : "";
  const survivor = String(d.survivor_id ?? "");
  switch (entry.event) {
    case "scenario_generated":
      return { tone: "info", text: `New disaster scenario: seed ${d.seed}, ${d.survivors} survivors, ${d.rubble_cells} collapsed cells` };
    case "cloud_snapshot_synced":
      return { tone: "info", text: `Pulled Snowflake → dbt snapshot from Redis Cloud (${d.survivors} survivors, ${d.grid_nodes} grid nodes)` };
    case "field_agent_self_assign":
      return { tone: "agent", text: `${agent} triaged ${survivor} as top priority` };
    case "field_agent_respond_backup":
      return { tone: "agent", text: `${agent} answering backup call at ${survivor}` };
    case "field_agent_rescue": {
      const helpers = Array.isArray(d.with_backup) ? ` with ${d.with_backup.join(", ")}` : "";
      return { tone: "ok", text: `${agent} rescued ${survivor}${helpers}` };
    }
    case "field_agent_request_backup":
      return { tone: "warn", text: `${agent} requests backup: ${survivor} is trapped` };
    case "field_agent_reroute":
      return { tone: "agent", text: `${agent} re-planned around debris toward ${survivor}` };
    case "field_agent_blocked":
      return { tone: "warn", text: `${agent} has no route to ${survivor}` };
    case "field_agent_drop_target":
      return { tone: "muted", text: `${agent} stood down from ${survivor}` };
    case "survivor_lost":
      return { tone: "danger", text: `${survivor} lost: vitals reached zero` };
    case "aftershock": {
      const cells = Array.isArray(d.rubble_cells) ? d.rubble_cells.length : 0;
      return { tone: "danger", text: `Aftershock: ${cells} cell${cells === 1 ? "" : "s"} collapsed${d.new_survivor ? `, ${d.new_survivor} buried` : ""}` };
    }
    case "mission_complete":
      return { tone: "ok", text: `Mission complete: ${d.rescued}/${d.total} rescued in ${d.tick} ticks` };
    case "coordination_completed":
      return { tone: "info", text: `Commander: assigned ${Array.isArray(d.assignments) ? d.assignments.length : 0} agents by proximity` };
    case "route_planning_completed":
      return { tone: "info", text: `Commander: route plans and resource types selected` };
    case "rescue_dispatch_completed":
      return { tone: "info", text: `Commander: dispatch validated by Weave guardrails` };
    case "movement_tick_completed":
      return { tone: "info", text: `Commander handed execution to the field agents` };
    case "llm_circuit_open":
      return { tone: "warn", text: `LLM brain offline (${d.status}); field agents fell back to the deterministic planner` };
    case "rubble_dropped":
      return { tone: "muted", text: `Debris reported at (${d.x}, ${d.y})` };
    case "rubble_cleared":
      return { tone: "muted", text: `Debris cleared at (${d.x}, ${d.y})` };
    case "survivor_reported":
      return { tone: "warn", text: `New ${d.trapped ? "trapped" : "visible"} survivor ${survivor} reported at (${d.x}, ${d.y})` };
    case "manual_assignment":
      return { tone: "agent", text: `Command: Agent ${d.agent_id} ordered to ${d.survivor_id}` };
    case "autopilot_error":
      return { tone: "danger", text: `Autopilot stopped: ${d.error}` };
    default:
      return { tone: "muted", text: entry.event.replaceAll("_", " ") };
  }
}
