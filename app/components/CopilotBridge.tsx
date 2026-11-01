"use client";

import { useCopilotAction, useCopilotReadable } from "@copilotkit/react-core";
import type { Agent, ApiResponse, Metrics, Survivor } from "../lib/kento";

type Props = {
  agents: Agent[];
  survivors: Survivor[];
  metrics: Metrics;
  run: (path: string, body?: unknown) => Promise<ApiResponse>;
  onSelectAgent: (id: string | null) => void;
};

/**
 * Exposes the hive to the CopilotKit "Rescue Copilot": live state as readables,
 * and the same controls as the dashboard as actions. Mounted only when the
 * Copilot is enabled, so the dashboard never depends on an LLM key.
 */
export function CopilotBridge({ agents, survivors, metrics, run, onSelectAgent }: Props) {
  useCopilotReadable({
    description: "Rescue agents: position, current task, and their latest reasoning",
    value: agents.map((a) => ({
      id: a.id,
      x: a.x,
      y: a.y,
      status: a.status,
      target: a.target_survivor_id || null,
      thought: a.thought,
    })),
  });
  useCopilotReadable({
    description: "Active survivors with health 0-100 (0 = lost) and whether they are trapped",
    value: survivors.map((s) => ({ id: s.id, x: s.x, y: s.y, status: s.status, health: s.data.health })),
  });
  useCopilotReadable({ description: "Mission metrics", value: metrics });

  useCopilotAction({
    name: "startAutopilot",
    description: "Start the autonomous rescue loop so field agents act every tick until all survivors resolve.",
    parameters: [],
    handler: async () => (await run("/sim/autopilot", { running: true })).result,
  });
  useCopilotAction({
    name: "pauseAutopilot",
    description: "Pause the autonomous rescue loop.",
    parameters: [],
    handler: async () => (await run("/sim/autopilot", { running: false })).result,
  });
  useCopilotAction({
    name: "newScenario",
    description: "Generate a new procedural disaster scenario.",
    parameters: [
      { name: "survivors", type: "number", description: "Number of survivors (1-16)", required: false },
      { name: "agents", type: "number", description: "Number of rescue agents (1-6)", required: false },
    ],
    handler: async ({ survivors: count, agents: team }) =>
      (await run("/scenario/reset", { survivors: count ?? 7, agents: team ?? 4 })).result,
  });
  useCopilotAction({
    name: "triggerAftershock",
    description: "Trigger an aftershock that collapses cells on the agents' routes.",
    parameters: [],
    handler: async () => (await run("/sim/aftershock", {})).result,
  });
  useCopilotAction({
    name: "runCommander",
    description: "Run the LlamaIndex strategic commander: triage, route planning and guarded dispatch.",
    parameters: [],
    handler: async () => (await run("/commander/plan", {})).result,
  });
  useCopilotAction({
    name: "highlightAgent",
    description: "Highlight a rescue agent on the map by id (A-F).",
    parameters: [{ name: "agentId", type: "string", description: "Agent id", required: true }],
    handler: ({ agentId }) => onSelectAgent(agentId.trim().toUpperCase()),
  });

  return null;
}
