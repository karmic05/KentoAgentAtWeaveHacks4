import { type GridState, isActive } from "./kento";

/** A dashboard operation the chat can perform (mirrors the AI's tool calls). */
export type ChatAction =
  | { name: "assign_agent"; args: { agent_id: string; survivor_id: string } }
  | { name: "start_autopilot"; args: Record<string, never> }
  | { name: "pause_autopilot"; args: Record<string, never> }
  | { name: "step"; args: Record<string, never> }
  | { name: "trigger_aftershock"; args: Record<string, never> }
  | { name: "new_scenario"; args: { survivors?: number; agents?: number; seed?: number } }
  | { name: "run_commander"; args: Record<string, never> }
  | { name: "highlight_agent"; args: { agent_id: string } }
  | { name: "drop_survivor"; args: { x: number; y: number } }
  | { name: "toggle_rubble"; args: { x: number; y: number } };

export type Parsed = { actions: ChatAction[]; reply?: string };

export const HELP = [
  "assign B to S-03",
  "start / pause",
  "trigger an aftershock",
  "new scenario with 9 survivors and 5 agents",
  "run the commander",
  "what is agent A doing?",
  "status",
  "drop a survivor at (4, 6)",
];

const none = {} as Record<string, never>;

/** Normalise "s3", "S-3", "survivor 3" and "Survivor-003" to an id that exists on the map. */
function resolveSurvivor(raw: string, state: GridState | null): string | null {
  const ids = (state?.survivors ?? []).map((s) => s.id);
  const exact = ids.find((id) => id.toLowerCase() === raw.toLowerCase());
  if (exact) return exact;
  const n = Number(raw.match(/\d+/)?.[0]);
  if (!Number.isFinite(n)) return null;
  return ids.find((id) => Number(id.match(/\d+/)?.[0]) === n) ?? null;
}

function parseClause(text: string, state: GridState | null): Parsed | null {
  const t = text.trim().toLowerCase();
  if (!t) return { actions: [] };

  const survivorMatch = t.match(/\b(s-?\d{1,3}|survivor[- ]?\d{1,3})\b/);
  const agentMatch = t.match(/\bagent\s+([a-f])\b/) ?? text.match(/\b([A-F])\b/);
  if (survivorMatch && agentMatch && /\b(assign|send|dispatch|move|have|order|get|go|rescue|help|to)\b/.test(t)) {
    const survivor = resolveSurvivor(survivorMatch[1], state);
    if (!survivor) return { actions: [], reply: `I can't find ${survivorMatch[1].toUpperCase()} on the map.` };
    return { actions: [{ name: "assign_agent", args: { agent_id: agentMatch[1].toUpperCase(), survivor_id: survivor } }] };
  }

  const at = t.match(/\(?\s*(\d)\s*,\s*(\d)\s*\)?/);
  if (at && /\b(survivor|victim|person)\b/.test(t) && /\b(drop|add|place|spawn|put|report)\b/.test(t)) {
    return { actions: [{ name: "drop_survivor", args: { x: Number(at[1]), y: Number(at[2]) } }] };
  }
  if (at && /\b(rubble|debris|block|collapse|clear)\b/.test(t)) {
    return { actions: [{ name: "toggle_rubble", args: { x: Number(at[1]), y: Number(at[2]) } }] };
  }

  if (/\b(after-?shock|quake|earthquake|tremor)\b/.test(t)) return { actions: [{ name: "trigger_aftershock", args: none }] };
  if (/\b(commander|auto-?assign|dispatch (all|everyone)|plan)\b/.test(t)) return { actions: [{ name: "run_commander", args: none }] };
  if (/\b(new|reset|generate|another|fresh)\b.*\b(scenario|disaster|map|city|mission)\b|^reset$/.test(t)) {
    const num = (re: RegExp) => {
      const m = t.match(re);
      return m ? Number(m[1]) : undefined;
    };
    return {
      actions: [{
        name: "new_scenario",
        args: { survivors: num(/(\d+)\s*(survivors?|victims?|people)/), agents: num(/(\d+)\s*(agents?|rescuers?|robots?)/), seed: num(/seed\s*(\d+)/) },
      }],
    };
  }
  if (/\b(pause|stop|halt|freeze|hold)\b/.test(t)) return { actions: [{ name: "pause_autopilot", args: none }] };
  if (/^(step|tick|advance|next)\b/.test(t)) return { actions: [{ name: "step", args: none }] };
  if (/\b(start|resume|play|begin|go|run)\b/.test(t) && !/\bagent\b/.test(t)) return { actions: [{ name: "start_autopilot", args: none }] };

  const agentQuestion = t.match(/\bagent\s+([a-f])\b/);
  if (agentQuestion && /\b(doing|status|where|what|how|why|thinking)\b/.test(t)) {
    const agent = state?.agents.find((a) => a.id === agentQuestion[1].toUpperCase());
    if (!agent) return { actions: [], reply: `There is no agent ${agentQuestion[1].toUpperCase()}.` };
    return {
      actions: [{ name: "highlight_agent", args: { agent_id: agent.id } }],
      reply: `Agent ${agent.id} is at (${agent.x}, ${agent.y}): ${agent.status}. ${agent.thought ?? ""}`.trim(),
    };
  }
  if (agentQuestion && /\b(highlight|show|track|focus|select|find)\b/.test(t)) {
    return { actions: [{ name: "highlight_agent", args: { agent_id: agentQuestion[1].toUpperCase() } }] };
  }

  if (/\b(status|progress|report|summary|how many|how('s| is) it going|sitrep)\b/.test(t)) return { actions: [], reply: statusReport(state) };
  if (/^(help|commands|\?|what can you do)/.test(t)) return { actions: [], reply: `Try: ${HELP.join(" · ")}` };
  return null;
}

export function statusReport(state: GridState | null): string {
  if (!state) return "The hive isn't loaded yet.";
  const m = state.metrics;
  const active = state.survivors.filter((s) => isActive(s.status));
  const urgent = [...active].sort((a, b) => Number(a.data.health) - Number(b.data.health))[0];
  return (
    `Tick ${m.tick ?? 0}: ${m.rescued ?? 0}/${m.total ?? 0} rescued, ${m.lost ?? 0} lost, ${active.length} still out there.` +
    (urgent ? ` Most urgent: ${urgent.id} at health ${Math.round(Number(urgent.data.health))}.` : "") +
    ` Autopilot is ${state.sim.running ? "running" : "paused"}.`
  );
}

/**
 * Instant, offline understanding of common commands. Compound requests
 * ("assign B to S-03 and start") are split into clauses; if any clause isn't
 * understood the whole message goes to the AI instead.
 */
export function parseCommand(message: string, state: GridState | null): Parsed | null {
  // A comma followed by a digit belongs to coordinates like "(4, 6)", not a new clause.
  const pieces = message.split(/\s*(?:,(?!\s*\d)|;|\band then\b|\bthen\b|\band\b)\s*/i).filter(Boolean);
  // A piece that can't stand alone ("5 agents" in "9 survivors and 5 agents")
  // is merged back into the clause before it.
  const clauses: { text: string; parsed: Parsed }[] = [];
  for (const piece of pieces) {
    const parsed = parseClause(piece, state);
    if (parsed && parsed.actions.length + (parsed.reply ? 1 : 0) > 0) {
      clauses.push({ text: piece, parsed });
      continue;
    }
    const previous = clauses.pop();
    if (!previous) return null;
    const text = `${previous.text} and ${piece}`;
    const merged = parseClause(text, state);
    if (!merged) return null;
    clauses.push({ text, parsed: merged });
  }
  return {
    actions: clauses.flatMap((c) => c.parsed.actions),
    reply: clauses.map((c) => c.parsed.reply).filter(Boolean).join(" ") || undefined,
  };
}
