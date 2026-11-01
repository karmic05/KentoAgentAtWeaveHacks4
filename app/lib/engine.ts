/**
 * In-browser hive engine: a TypeScript port of agents/field_agent.py and
 * agents/simulation.py, so the dashboard runs with no backend (e.g. on Vercel).
 *
 * It speaks the same request/response shapes as the FastAPI server, so the UI
 * switches between the two with a single `request(path, body)` call. The
 * Python stack remains the source of truth and adds Redis, the LlamaIndex
 * commander, the Ollama/LLM advisor and Weave tracing.
 */
import type { Agent, ApiResponse, GridNode, GridState, Health, MissionLog, Survivor } from "./kento";

const W = 10;
const H = 10;
const N = W * H;
const AGENT_IDS = ["A", "B", "C", "D", "E", "F"];
const TRAPPED = new Set(["trapped", "trapped_beneath"]);
const INACTIVE = new Set(["rescued", "lost"]);
const URGENCY_WEIGHT = 1.2;
const LOG_MAX = 300;
const SIGNIFICANT = new Set(["self_assign", "respond_backup", "rescue", "request_backup", "reroute", "blocked", "drop_target"]);

// (starting health, health lost per tick) by condition
const VITALS: Record<string, [number, number]> = {
  minor: [95, 0.35],
  moderate: [80, 0.6],
  severe: [62, 0.9],
  critical: [48, 1.3],
  stable: [88, 0.7],
  limited: [66, 1.0],
  low: [66, 1.0],
};

type SurvivorRec = {
  id: string;
  x: number;
  y: number;
  cell: number;
  status: string;
  health: number;
  decay: number;
  condition: string;
};

type AgentRec = {
  id: string;
  x: number;
  y: number;
  cell: number;
  status: string;
  target_survivor_id: string;
  target_cell: number | null;
  path: number[];
  thought: string;
  brain: string;
  last_action: string;
  rescues: number;
  distance: number;
};

type Backup = { survivor_id: string; cell: number; requested_by: string; reason: string; status: string };
type Decision = { action: string; [key: string]: unknown };

const xy = (cell: number): [number, number] => [cell % W, Math.floor(cell / W)];
const toCell = (x: number, y: number) => y * W + x;
const manhattan = (a: number, b: number) => {
  const [ax, ay] = xy(a);
  const [bx, by] = xy(b);
  return Math.abs(ax - bx) + Math.abs(ay - by);
};

function neighbors(cell: number): number[] {
  const [x, y] = xy(cell);
  const out: number[] = [];
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const nx = x + dx;
    const ny = y + dy;
    if (nx >= 0 && nx < W && ny >= 0 && ny < H) out.push(toCell(nx, ny));
  }
  return out;
}

function connected(passable: Set<number>): boolean {
  if (passable.size === 0) return true;
  const start = passable.values().next().value as number;
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length) {
    for (const nb of neighbors(queue.shift()!)) {
      if (passable.has(nb) && !seen.has(nb)) {
        seen.add(nb);
        queue.push(nb);
      }
    }
  }
  return seen.size === passable.size;
}

/** Seeded PRNG (mulberry32) so a seed always produces the same city. */
function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    pick: <T,>(items: readonly T[]): T => items[Math.floor(next() * items.length)],
    shuffle: <T,>(items: T[]): T[] => {
      for (let i = items.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [items[i], items[j]] = [items[j], items[i]];
      }
      return items;
    },
  };
}

export class BrowserHive {
  private grid = new Map<number, GridNode>();
  private survivors = new Map<string, SurvivorRec>();
  private agents = new Map<string, AgentRec>();
  private backups = new Map<string, Backup>();
  private logs: MissionLog[] = [];
  private metrics: Record<string, number> = {};
  private sim = { running: false, interval_ms: 450, aftershocks: true, seed: "", completed_tick: null as number | null };
  private timer: ReturnType<typeof setTimeout> | null = null;
  private logSeq = 0;

  constructor(seed = 1337) {
    this.resetScenario(seed);
  }

  // ------------------------------------------------------------------ api --
  request(path: string, body: Record<string, unknown> = {}): ApiResponse {
    let result: unknown;
    switch (path) {
      case "/scenario/reset":
        result = this.resetScenario(
          typeof body.seed === "number" ? body.seed : undefined,
          Number(body.survivors ?? 7),
          Number(body.agents ?? 4),
        );
        break;
      case "/sim/step":
        result = this.tick(false);
        break;
      case "/sim/autopilot":
        if (body.running) this.startAutopilot(Number(body.interval_ms ?? 450), body.aftershocks !== false);
        else this.stopAutopilot();
        this.sim.aftershocks = body.aftershocks !== false;
        result = { ...this.sim };
        break;
      case "/sim/aftershock":
        result = this.aftershock();
        break;
      case "/grid/edit":
        result = this.editCell(Number(body.x), Number(body.y), String(body.tool));
        break;
      case "/commander/plan":
        result = this.commanderPlan();
        break;
      case "/scenario/sync-cloud":
        throw new Error("Redis Cloud sync needs the local Python API (see README)");
      default:
        throw new Error(`Unknown route ${path}`);
    }
    return { result, grid_state: this.gridState() };
  }

  health(): Health {
    return {
      ok: true,
      redis: "in-browser",
      llm: { configured: false, active: false, model: "", reason: "The hosted demo runs the deterministic planner" },
      weave: false,
      cloud_source: false,
    };
  }

  gridState(): GridState {
    const total = this.metrics.total ?? 0;
    const rescued = this.metrics.rescued ?? 0;
    const lost = this.metrics.lost ?? 0;
    return {
      cells: Array.from({ length: N }, (_, cell) => {
        const [x, y] = xy(cell);
        return { x, y, cell, node: { ...(this.grid.get(cell) ?? {}) } };
      }),
      survivors: [...this.survivors.values()].map((s): Survivor => ({
        id: s.id,
        x: s.x,
        y: s.y,
        cell: s.cell,
        status: s.status,
        data: {
          health: String(s.health),
          [TRAPPED.has(s.status) || s.status === "lost" ? "air_supply" : "injury_severity"]: s.condition,
        },
      })),
      agents: [...this.agents.values()].map((a): Agent => ({
        ...a,
        path: [...a.path],
        rescues: String(a.rescues),
        distance: String(a.distance),
      })),
      mission_logs: this.logs.slice(-60),
      metrics: { ...this.metrics, active: Math.max(0, total - rescued - lost), survival_rate: total ? rescued / total : 0 },
      sim: { ...this.sim, source: "procedural", cloud_last_sync: null },
      llm: this.health().llm,
      backups: [...this.backups.values()].map((b) => ({ ...b, cell: String(b.cell) })),
    };
  }

  // ------------------------------------------------------------- scenario --
  resetScenario(seed?: number, survivorCount = 7, agentCount = 4) {
    this.stopAutopilot();
    const s = seed ?? Math.floor(Math.random() * 1_000_000);
    const r = rng(s);
    this.grid.clear();
    this.survivors.clear();
    this.agents.clear();
    this.backups.clear();
    this.logs = [];

    const roads = new Set<number>();
    for (let cell = 0; cell < N; cell++) {
      const [x, y] = xy(cell);
      if (y === 2 || y === 7 || x === 1 || x === 5 || x === 8) roads.add(cell);
    }
    const buildings = new Set<number>();
    for (let cell = 0; cell < N; cell++) if (!roads.has(cell) && r.next() < 0.75) buildings.add(cell);

    const passable = new Set(Array.from({ length: N }, (_, i) => i));
    const rubble = new Set<number>();
    const roadSample = r.shuffle([...roads]).slice(0, Math.floor(roads.size / 6));
    const candidates = r.shuffle([...buildings, ...roadSample]);
    const target = Math.floor(0.16 * N);
    for (const cell of candidates) {
      if (rubble.size >= target) break;
      passable.delete(cell);
      if (connected(passable)) rubble.add(cell);
      else passable.add(cell);
    }

    for (const cell of roads) if (!rubble.has(cell)) this.grid.set(cell, { type: "road", passable: "true" });
    for (const cell of buildings) if (!rubble.has(cell)) this.grid.set(cell, { type: "building", passable: "true" });
    for (const cell of rubble) {
      this.grid.set(cell, { type: "rubble", passable: "false", severity: r.pick(["moderate", "severe", "critical"]) });
    }

    // Agents stage from spread-out street cells (farthest-point sampling).
    const street = [...roads].filter((c) => !rubble.has(c)).sort((a, b) => a - b);
    const staged = [r.pick(street)];
    while (staged.length < Math.min(agentCount, AGENT_IDS.length)) {
      staged.push(street.reduce((best, c) =>
        Math.min(...staged.map((s2) => manhattan(c, s2))) > Math.min(...staged.map((s2) => manhattan(best, s2))) ? c : best,
      ));
    }
    staged.forEach((cell, i) => {
      const [x, y] = xy(cell);
      this.agents.set(AGENT_IDS[i], {
        id: AGENT_IDS[i], x, y, cell, status: "Staged", target_survivor_id: "", target_cell: null, path: [],
        thought: "Awaiting orders.", brain: "rules", last_action: "", rescues: 0, distance: 0,
      });
    });

    const diggable = r.shuffle([...rubble].filter((c) => neighbors(c).some((nb) => passable.has(nb))));
    const open = r.shuffle([...passable].filter((c) => !staged.includes(c)));
    const trappedCount = Math.min(diggable.length, Math.floor((survivorCount + 1) / 2));
    let placed = 0;
    for (let i = 0; i < survivorCount; i++) {
      const trapped = i < trappedCount;
      const cell = trapped ? diggable.pop() : open.pop();
      if (cell === undefined) break;
      const condition = r.pick(trapped ? ["critical", "limited", "stable"] : ["minor", "moderate", "severe"]);
      this.placeSurvivor(`S-${String(i + 1).padStart(2, "0")}`, cell, trapped, condition);
      placed++;
    }

    this.metrics = {
      tick: 0, total: placed, rescued: 0, lost: 0, distance: 0, reroutes: 0,
      backup_requests: 0, aftershocks: 0, decisions_rules: 0, decisions_llm: 0,
    };
    this.sim = { ...this.sim, running: false, seed: String(s), completed_tick: null };
    const result = { seed: s, survivors: placed, agents: staged.length, rubble_cells: rubble.size };
    this.log("scenario_generated", result);
    return result;
  }

  private placeSurvivor(id: string, cell: number, trapped: boolean, condition: string) {
    const [x, y] = xy(cell);
    const [health, decay] = VITALS[condition] ?? [80, 0.6];
    this.survivors.set(id, { id, x, y, cell, status: trapped ? "trapped_beneath" : "injured_visible", health, decay, condition });
    this.grid.set(cell, trapped
      ? { type: "survivor_trapped", id, passable: "false" }
      : { type: "survivor_visible", id, passable: "true" });
  }

  // ----------------------------------------------------------- simulation --
  tick(aftershocks: boolean) {
    const tick = ++this.metrics.tick;
    for (const id of [...this.agents.keys()].sort()) this.stepAgent(id);
    const lost = this.decayVitals(tick);
    let shock = null;
    if (aftershocks && tick > 4 && Math.random() < 0.06) shock = this.aftershock();
    const active = this.activeSurvivors().length;
    if (active === 0 && this.sim.completed_tick == null) {
      this.sim.completed_tick = tick;
      for (const agent of this.agents.values()) {
        Object.assign(agent, {
          status: "Mission complete", target_survivor_id: "", target_cell: null, path: [],
          thought: "All survivors resolved; holding for the next call.",
        });
      }
      this.log("mission_complete", { ...this.metrics });
    }
    return { tick, lost, aftershock: shock, active };
  }

  private startAutopilot(intervalMs: number, aftershocks: boolean) {
    this.sim.interval_ms = Math.max(120, Math.min(intervalMs, 3000));
    this.sim.aftershocks = aftershocks;
    if (this.sim.running) return;
    this.sim.running = true;
    const loop = () => {
      if (!this.sim.running) return;
      const { active } = this.tick(this.sim.aftershocks);
      if (active === 0) {
        this.sim.running = false;
        return;
      }
      this.timer = setTimeout(loop, this.sim.interval_ms);
    };
    loop();
  }

  private stopAutopilot() {
    this.sim.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private activeSurvivors() {
    return [...this.survivors.values()].filter((s) => !INACTIVE.has(s.status));
  }

  private decayVitals(tick: number) {
    const lost: string[] = [];
    for (const s of this.activeSurvivors()) {
      s.health = Math.round((s.health - s.decay) * 10) / 10;
      if (s.health > 0) continue;
      s.health = 0;
      s.status = "lost";
      this.grid.set(s.cell, TRAPPED.has(this.survivorKind(s)) ? { type: "rubble", passable: "false" } : { type: "road", passable: "true" });
      this.backups.delete(s.id);
      this.metrics.lost++;
      this.log("survivor_lost", { survivor_id: s.id, tick, x: s.x, y: s.y });
      lost.push(s.id);
    }
    return lost;
  }

  private survivorKind(s: SurvivorRec) {
    return this.grid.get(s.cell)?.type === "survivor_trapped" ? "trapped" : "visible";
  }

  private passableSet() {
    const set = new Set<number>();
    for (let c = 0; c < N; c++) if (this.isPassable(c)) set.add(c);
    return set;
  }

  private isPassable(cell: number) {
    return String(this.grid.get(cell)?.passable ?? "true").toLowerCase() !== "false";
  }

  aftershock() {
    const passable = this.passableSet();
    const agentCells = new Set([...this.agents.values()].map((a) => a.cell));
    const free = [...passable].filter((c) => !agentCells.has(c) && !String(this.grid.get(c)?.type ?? "").startsWith("survivor"));
    const onRoutes = [...this.agents.values()].flatMap((a) => a.path.slice(1)).filter((c) => free.includes(c));
    const sample = [...free].sort(() => Math.random() - 0.5).slice(0, 6);
    const pool = [...new Set([...onRoutes.slice(0, 2), ...sample])];
    const want = 1 + Math.floor(Math.random() * 3);
    const dropped: number[] = [];
    for (const cell of pool) {
      if (dropped.length >= want) break;
      passable.delete(cell);
      if (connected(passable)) {
        this.grid.set(cell, { type: "rubble", passable: "false", severity: "aftershock" });
        dropped.push(cell);
      } else {
        passable.add(cell);
      }
    }
    let buried: string | null = null;
    if (dropped.length && Math.random() < 0.55) {
      const diggable = dropped.filter((c) => neighbors(c).some((nb) => passable.has(nb)));
      if (diggable.length) {
        buried = `S-${String(++this.metrics.total).padStart(2, "0")}`;
        this.placeSurvivor(buried, diggable[Math.floor(Math.random() * diggable.length)], true, Math.random() < 0.5 ? "critical" : "limited");
        this.sim.completed_tick = null;
      }
    }
    this.metrics.aftershocks++;
    const result = { rubble_cells: dropped, new_survivor: buried };
    this.log("aftershock", result);
    return result;
  }

  editCell(x: number, y: number, tool: string) {
    const cell = toCell(x, y);
    const node = this.grid.get(cell) ?? {};
    const type = node.type ?? "";
    if ([...this.agents.values()].some((a) => a.cell === cell)) return { changed: false, reason: "agent_on_cell" };
    if (type.startsWith("survivor")) return { changed: false, reason: "survivor_on_cell" };
    const passable = this.passableSet();
    if (tool === "rubble") {
      if (type === "rubble") {
        this.grid.set(cell, { type: "road", passable: "true" });
        this.log("rubble_cleared", { x, y });
        return { changed: true, type: "road" };
      }
      passable.delete(cell);
      if (!connected(passable)) return { changed: false, reason: "would_cut_off_the_street_network" };
      this.grid.set(cell, { type: "rubble", passable: "false", severity: "manual" });
      this.log("rubble_dropped", { x, y });
      return { changed: true, type: "rubble" };
    }
    if (tool === "survivor") {
      const trapped = type === "rubble";
      if (trapped && !neighbors(cell).some((nb) => passable.has(nb))) return { changed: false, reason: "no_open_side_to_dig_from" };
      const id = `S-${String(++this.metrics.total).padStart(2, "0")}`;
      this.placeSurvivor(id, cell, trapped, trapped ? "critical" : "severe");
      this.sim.completed_tick = null;
      this.log("survivor_reported", { survivor_id: id, x, y, trapped });
      return { changed: true, survivor_id: id };
    }
    return { changed: false, reason: `unknown tool ${tool}` };
  }

  /** Strategic commander (browser version): nearest-idle assignment, resource selection and guarded dispatch. */
  commanderPlan() {
    const idle = () => [...this.agents.values()].filter((a) => {
      const t = this.survivors.get(a.target_survivor_id);
      return !t || INACTIVE.has(t.status);
    });
    const taken = new Set([...this.agents.values()].map((a) => a.target_survivor_id).filter(Boolean));
    const assignments: { agent_id: string; survivor_id: string; distance: number }[] = [];
    const dispatches: string[] = [];
    for (const s of this.activeSurvivors().sort((a, b) => a.id.localeCompare(b.id))) {
      if (taken.has(s.id)) continue;
      const pool = idle();
      if (!pool.length) break;
      const agent = pool.reduce((best, a) => (manhattan(a.cell, s.cell) < manhattan(best.cell, s.cell) ? a : best));
      Object.assign(agent, { target_survivor_id: s.id, target_cell: s.cell, path: [], status: `Dispatched to ${s.id}` });
      taken.add(s.id);
      assignments.push({ agent_id: agent.id, survivor_id: s.id, distance: manhattan(agent.cell, s.cell) });
      dispatches.push(TRAPPED.has(s.status)
        ? `🚨 Dispatching Heavy Excavator Drone to coordinate Grid (${s.x}, ${s.y}) for buried target ${s.id}.`
        : `🚁 Dispatching Medical Aerial Drone to coordinate Grid (${s.x}, ${s.y}) for visible target ${s.id}.`);
    }
    this.log("coordination_completed", { assignments });
    this.log("route_planning_completed", {});
    this.log("rescue_dispatch_completed", { dispatches });
    this.log("movement_tick_completed", {});
    return { assignments: assignments.length, dispatches, errors: [] };
  }

  // --------------------------------------------------------- field agents --
  private stepAgent(id: string) {
    const agent = this.agents.get(id)!;
    const decision = this.think(agent);
    const result: Decision = { ...this.act(agent, decision), agent_id: id };
    agent.thought = describe(result, this.survivors);
    agent.brain = "rules";
    agent.last_action = result.action;
    this.metrics.decisions_rules++;
    if (SIGNIFICANT.has(result.action)) {
      const rest: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(result)) if (!["action", "path", "next"].includes(k)) rest[k] = v;
      this.log(`field_agent_${result.action}`, rest);
    }
  }

  private others(self: string) {
    return [...this.agents.values()].filter((a) => a.id !== self);
  }

  private think(agent: AgentRec): Decision {
    const occupied = new Set(this.others(agent.id).map((a) => a.cell));
    if (occupied.has(agent.cell)) {
      const free = neighbors(agent.cell).filter((n) => this.isPassable(n) && !occupied.has(n));
      if (free.length) return { action: "decollide", next: free[0] };
    }
    const tid = agent.target_survivor_id;
    const target = tid ? this.survivors.get(tid) : undefined;
    if (tid && (!target || INACTIVE.has(target.status))) return { action: "drop_target", survivor_id: tid };
    if (!target) {
      const backup = this.openBackup(agent.id);
      if (backup) return { action: "self_assign", survivor_id: backup.id, as_backup: true };
      const taken = new Set(this.others(agent.id).map((a) => a.target_survivor_id).filter(Boolean));
      const free = this.activeSurvivors().filter((s) => !taken.has(s.id));
      if (!free.length) return { action: "idle" };
      const cost = (s: SurvivorRec) => manhattan(agent.cell, s.cell) + (URGENCY_WEIGHT * s.health) / 10;
      const best = free.reduce((a, b) => (cost(b) < cost(a) ? b : a));
      return { action: "self_assign", survivor_id: best.id, as_backup: false };
    }
    return this.decideForTarget(agent, target);
  }

  private openBackup(self: string): SurvivorRec | null {
    for (const [sid, req] of this.backups) {
      const s = this.survivors.get(sid);
      if (!s || INACTIVE.has(s.status) || req.status !== "open") {
        this.backups.delete(sid);
        continue;
      }
      if (this.others(self).filter((a) => a.target_survivor_id === sid).length < 2) return s;
    }
    return null;
  }

  private bfs(start: number, goal: number, blocked = new Set<number>()): number[] {
    if (start === goal) return [];
    const prev = new Map<number, number | null>([[start, null]]);
    const queue = [start];
    while (queue.length) {
      const cur = queue.shift()!;
      for (const nb of neighbors(cur)) {
        if (prev.has(nb) || blocked.has(nb)) continue;
        if (nb !== goal && !this.isPassable(nb)) continue;
        prev.set(nb, cur);
        if (nb === goal) {
          const path: number[] = [];
          let node: number = nb;
          while (node !== start) {
            path.push(node);
            node = prev.get(node)!;
          }
          return path.reverse();
        }
        queue.push(nb);
      }
    }
    return [];
  }

  private decideForTarget(agent: AgentRec, target: SurvivorRec): Decision {
    const trapped = TRAPPED.has(target.status);
    const tid = target.id;
    let goal: number | null = target.cell;
    if (trapped) {
      const options = neighbors(target.cell).filter((n) => this.isPassable(n));
      goal = options.length ? options.reduce((a, b) => (manhattan(b, agent.cell) < manhattan(a, agent.cell) ? b : a)) : null;
    }
    if (goal === null) return { action: "request_backup", survivor_id: tid, reason: "survivor_unreachable" };

    const reached = trapped ? manhattan(agent.cell, target.cell) === 1 : agent.cell === goal;
    if (reached) {
      if (!trapped) return { action: "rescue", survivor_id: tid };
      const responders = this.others(agent.id).filter((a) => a.target_survivor_id === tid).map((a) => a.id);
      const adjacent = this.others(agent.id).filter((a) => manhattan(a.cell, target.cell) === 1).map((a) => a.id);
      const helpers = responders.length ? responders : adjacent;
      if (helpers.length) return { action: "rescue", survivor_id: tid, with_backup: helpers };
      // Coordination deadlock: everyone pinned waiting for backup. The highest-id
      // waiter leaves its post to join the most urgent teammate.
      const waiting = this.others(agent.id).filter((a) => a.last_action === "request_backup");
      if (waiting.length && waiting.length === this.agents.size - 1 && waiting.every((a) => agent.id > a.id)) {
        const targets = waiting
          .map((a) => this.survivors.get(a.target_survivor_id))
          .filter((t): t is SurvivorRec => Boolean(t) && !INACTIVE.has(t!.status));
        if (targets.length) {
          const join = targets.reduce((a, b) => (b.health < a.health ? b : a));
          return { action: "self_assign", survivor_id: join.id, as_backup: true, abandoned: tid };
        }
      }
      return { action: "request_backup", survivor_id: tid, reason: "trapped_needs_backup" };
    }

    const others = new Set(this.others(agent.id).map((a) => a.cell));
    let path = agent.path;
    let action = "move";
    const valid = path.length > 0 && path[path.length - 1] === goal && neighbors(agent.cell).includes(path[0]) && this.isPassable(path[0]);
    if (!valid) {
      path = this.bfs(agent.cell, goal);
      if (!path.length) return { action: "blocked", survivor_id: tid, goal };
      action = "reroute";
    }

    // Head-on collisions: detour around teammates, else the higher id yields.
    if (others.has(path[0])) {
      const walls = new Set(others);
      walls.delete(goal);
      const detour = this.bfs(agent.cell, goal, walls);
      if (detour.length && detour.length <= path.length + 4) return { action: "reroute", survivor_id: tid, path: detour, goal };
      const blocker = this.others(agent.id).find((a) => a.cell === path[0]);
      if (blocker && agent.id > blocker.id) {
        const aside = neighbors(agent.cell).filter((n) => !others.has(n) && n !== path[0] && this.isPassable(n));
        if (aside.length) return { action: "sidestep", survivor_id: tid, next: aside[0] };
      }
      return { action: "wait", survivor_id: tid };
    }
    return { action, survivor_id: tid, path, goal };
  }

  private moveTo(agent: AgentRec, cell: number) {
    [agent.x, agent.y] = xy(cell);
    agent.cell = cell;
    agent.distance++;
    this.metrics.distance++;
  }

  private act(agent: AgentRec, d: Decision): Decision {
    const sid = String(d.survivor_id ?? "");
    const s = this.survivors.get(sid);
    switch (d.action) {
      case "idle":
        agent.status = "idle";
        return d;
      case "drop_target":
        Object.assign(agent, { target_survivor_id: "", target_cell: null, path: [], status: "idle" });
        return d;
      case "self_assign":
        Object.assign(agent, {
          target_survivor_id: sid, target_cell: s!.cell, path: [],
          status: (d.as_backup ? "Backup for " : "Engaging ") + sid,
        });
        return d.as_backup ? { ...d, action: "respond_backup" } : d;
      case "rescue": {
        s!.status = "rescued";
        this.grid.set(s!.cell, this.grid.get(s!.cell)?.type === "survivor_trapped"
          ? { type: "clear", passable: "true" }
          : { type: "road", passable: "true" });
        this.backups.delete(sid);
        this.metrics.rescued++;
        agent.rescues++;
        Object.assign(agent, { target_survivor_id: "", target_cell: null, path: [], status: `Rescued ${sid}` });
        return { ...d, x: s!.x, y: s!.y };
      }
      case "request_backup":
        if (!this.backups.has(sid)) this.metrics.backup_requests++;
        this.backups.set(sid, { survivor_id: sid, cell: s!.cell, requested_by: agent.id, reason: String(d.reason), status: "open" });
        agent.status = `Awaiting backup for ${sid}`;
        return d;
      case "blocked":
        if (s && !this.backups.has(sid)) {
          this.metrics.backup_requests++;
          this.backups.set(sid, { survivor_id: sid, cell: s.cell, requested_by: agent.id, reason: "path_blocked", status: "open" });
        }
        Object.assign(agent, { path: [], status: `Blocked from ${sid}` });
        return d;
      case "decollide":
      case "sidestep":
        this.moveTo(agent, d.next as number);
        Object.assign(agent, { path: [], status: d.action === "sidestep" ? "Yielding to teammate" : "Repositioning" });
        return d;
      case "wait":
        agent.status = "Holding (path occupied)";
        return d;
      case "move":
      case "reroute": {
        const path = d.path as number[];
        this.moveTo(agent, path[0]);
        Object.assign(agent, {
          path: path.slice(1), target_survivor_id: sid, target_cell: s!.cell,
          status: (d.action === "reroute" ? "Rerouting to " : "Moving to ") + sid,
        });
        if (d.action === "reroute") this.metrics.reroutes++;
        return { ...d, to_cell: path[0], path_remaining: path.length - 1 };
      }
      default:
        return d;
    }
  }

  private log(event: string, data: unknown) {
    // ns timestamps exceed Number's integer precision, so the key uses a sequence.
    this.logs.push({ key: `log:${this.logSeq++}`, event, timestamp_ns: Date.now() * 1e6, data });
    if (this.logs.length > LOG_MAX) this.logs.splice(0, this.logs.length - LOG_MAX);
  }
}

function describe(result: Decision, survivors: Map<string, { health: number }>): string {
  const sid = String(result.survivor_id ?? "");
  const s = survivors.get(sid);
  const vitals = s ? ` (health ${Math.round(s.health)})` : "";
  switch (result.action) {
    case "self_assign": return `Highest triage priority is ${sid}${vitals}; taking it.`;
    case "respond_backup":
      return result.abandoned
        ? `Whole team was pinned waiting; leaving ${result.abandoned} to help dig out ${sid}.`
        : `${sid} is trapped and a teammate called for help; responding.`;
    case "move": return `En route to ${sid}${vitals}, ${result.path_remaining ?? 0} steps left.`;
    case "reroute": return `Path to ${sid} is blocked or stale; re-planning around rubble.`;
    case "rescue": {
      const helpers = result.with_backup as string[] | undefined;
      return `Extracted ${sid}${helpers?.length ? ` with ${helpers.join(", ")}` : ""}.`;
    }
    case "request_backup": return `${sid} is trapped under debris; holding and calling for a second agent.`;
    case "wait": return "Next cell is occupied by a teammate; yielding one tick.";
    case "blocked": return `No passable route to ${sid}; flagged for backup.`;
    case "decollide": return "Sharing a cell with a teammate; stepping aside.";
    case "sidestep": return "Head-on with a teammate in a corridor; stepping aside to let them pass.";
    case "drop_target": return `${sid} is no longer active; standing down.`;
    default: return "No active survivors; holding position.";
  }
}
