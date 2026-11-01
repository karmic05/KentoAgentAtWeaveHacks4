"use client";

import { useMemo, useState } from "react";
import {
  type Agent,
  type GridCell,
  type GridNode,
  type Survivor,
  GRID_SIZE,
  agentColor,
  health,
  healthColor,
  isTrapped,
} from "../lib/kento";

export type EditTool = "none" | "rubble" | "survivor";

type Props = {
  cells: GridCell[];
  agents: Agent[];
  survivors: Survivor[];
  backupCells: Set<number>;
  flashes: Flash[];
  selectedAgentId: string | null;
  tool: EditTool;
  moveMs: number;
  onSelectAgent: (id: string | null) => void;
  onCellClick: (x: number, y: number) => void;
};

const pct = (n: number) => `${(n * 100) / GRID_SIZE}%`;
const center = (cell: number) => [(cell % GRID_SIZE) + 0.5, Math.floor(cell / GRID_SIZE) + 0.5];

function isStreet(node: GridNode | undefined): boolean {
  return node?.type === "road" || node?.type === "survivor_visible";
}

function tileClass(index: number, byCell: Map<number, GridCell>): string {
  const node = byCell.get(index)?.node;
  const type = node?.type;
  if (type === "rubble" || type === "survivor_trapped") return "tile-rubble";
  if (type === "building") return "tile-building";
  if (!isStreet(node)) return "tile-ground";
  // Lane markings follow the street: vertical when the road continues up/down.
  const x = index % GRID_SIZE;
  const vertical = isStreet(byCell.get(index - GRID_SIZE)?.node) || isStreet(byCell.get(index + GRID_SIZE)?.node);
  const horizontal = (x > 0 && isStreet(byCell.get(index - 1)?.node)) || (x < GRID_SIZE - 1 && isStreet(byCell.get(index + 1)?.node));
  return vertical && !horizontal ? "tile-road-v" : "tile-road";
}

export type Flash = { key: string; cell: number; tone: "ok" | "danger" };

export function GridMap({
  cells,
  agents,
  survivors,
  backupCells,
  flashes,
  selectedAgentId,
  tool,
  moveMs,
  onSelectAgent,
  onCellClick,
}: Props) {
  const byCell = useMemo(() => new Map(cells.map((c) => [c.cell, c])), [cells]);

  // Animate rubble that appeared since the previous snapshot (aftershocks, edits).
  const rubbleNow = useMemo(
    () => new Set(cells.filter((c) => c.node.type === "rubble").map((c) => c.cell)),
    [cells],
  );
  const [previousRubble, setPreviousRubble] = useState(rubbleNow);
  const [freshRubble, setFreshRubble] = useState<Set<number>>(new Set());
  if (rubbleNow !== previousRubble) {
    setFreshRubble(new Set([...rubbleNow].filter((c) => !previousRubble.has(c))));
    setPreviousRubble(rubbleNow);
  }

  return (
    <div
      className="relative aspect-square w-full select-none overflow-hidden rounded-xl border border-line bg-ground"
      style={{ ["--move-ms" as string]: `${moveMs}ms` }}
    >
      {/* terrain */}
      <div className="absolute inset-0 grid grid-cols-10 grid-rows-10 gap-[2px] p-[2px]">
        {Array.from({ length: GRID_SIZE * GRID_SIZE }, (_, index) => {
          const cell = byCell.get(index);
          const type = cell?.node.type;
          const x = index % GRID_SIZE;
          const y = Math.floor(index / GRID_SIZE);
          return (
            <button
              key={index}
              type="button"
              tabIndex={tool === "none" ? -1 : 0}
              onClick={() => (tool === "none" ? onSelectAgent(null) : onCellClick(x, y))}
              title={`(${x}, ${y}) ${type ?? "open ground"}${cell?.node.severity ? ` · ${cell.node.severity}` : ""}`}
              className={`rounded-[3px] ${tileClass(index, byCell)} ${freshRubble.has(index) ? "tile-rubble-fresh" : ""} ${
                tool === "none" ? "cursor-default" : "cursor-crosshair hover:outline hover:outline-1 hover:outline-accent/70"
              }`}
            />
          );
        })}
      </div>

      {/* coordinates */}
      <div className="pointer-events-none absolute inset-0 font-mono text-[9px] text-faint/70">
        {Array.from({ length: GRID_SIZE }, (_, i) => (
          <span key={`c${i}`} className="absolute top-0.5" style={{ left: `calc(${pct(i)} + 3px)` }}>
            {i}
          </span>
        ))}
      </div>

      {/* planned routes */}
      <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox={`0 0 ${GRID_SIZE} ${GRID_SIZE}`}>
        {agents.map((agent) => {
          const path = agent.path ?? [];
          if (!agent.target_survivor_id || path.length === 0) return null;
          const points = [agent.cell, ...path].map(center).map(([px, py]) => `${px},${py}`).join(" ");
          const dimmed = selectedAgentId != null && selectedAgentId !== agent.id;
          return (
            <polyline
              key={agent.id}
              points={points}
              fill="none"
              stroke={agentColor(agent.id)}
              strokeWidth={0.07}
              strokeLinecap="round"
              strokeLinejoin="round"
              className="route-dash"
              opacity={dimmed ? 0.18 : 0.85}
            />
          );
        })}
      </svg>

      {/* rescue / loss bursts */}
      {flashes.map((flash) => (
        <div
          key={flash.key}
          className="pointer-events-none absolute flex items-center justify-center"
          style={{ left: pct(flash.cell % GRID_SIZE), top: pct(Math.floor(flash.cell / GRID_SIZE)), width: pct(1), height: pct(1) }}
        >
          <span
            className="burst absolute h-[70%] w-[70%] rounded-full border-2"
            style={{ borderColor: `var(--${flash.tone})`, boxShadow: `0 0 16px var(--${flash.tone})` }}
          />
        </div>
      ))}

      {/* backup beacons */}
      {[...backupCells].map((cell) => (
        <div
          key={`b${cell}`}
          className="pointer-events-none absolute flex items-center justify-center"
          style={{ left: pct(cell % GRID_SIZE), top: pct(Math.floor(cell / GRID_SIZE)), width: pct(1), height: pct(1) }}
        >
          <span className="beacon absolute inset-[6%] rounded-md border-2 border-dashed border-warn" />
        </div>
      ))}

      {/* survivors */}
      {survivors.map((survivor) => {
        const value = health(survivor);
        const trapped = isTrapped(survivor.status);
        const tone = trapped ? "var(--danger)" : "var(--warn)";
        return (
          <div
            key={survivor.id}
            className="pointer-events-none absolute flex items-center justify-center"
            style={{ left: pct(survivor.x), top: pct(survivor.y), width: pct(1), height: pct(1) }}
            title={`${survivor.id} · ${trapped ? "trapped" : "visible"} · health ${value.toFixed(0)}`}
          >
            {value < 35 && (
              <span className="pulse-ring absolute h-[60%] w-[60%] rounded-full" style={{ background: tone, opacity: 0.5 }} />
            )}
            <span
              className="relative flex h-[66%] w-[66%] items-center justify-center rounded-full"
              style={{
                background: `conic-gradient(${healthColor(value)} ${value * 3.6}deg, rgba(255,255,255,0.08) 0)`,
              }}
            >
              <span
                className="flex h-[78%] w-[78%] items-center justify-center rounded-full text-[clamp(7px,1.1vw,11px)] font-bold"
                style={{ background: "#0b0f15", color: tone, boxShadow: `0 0 10px ${tone}55` }}
              >
                {trapped ? "T" : "+"}
              </span>
            </span>
          </div>
        );
      })}

      {/* agents */}
      {agents.map((agent) => {
        const color = agentColor(agent.id);
        const selected = agent.id === selectedAgentId;
        return (
          <button
            key={agent.id}
            type="button"
            onClick={() => onSelectAgent(selected ? null : agent.id)}
            className="agent-token absolute z-10 flex items-center justify-center"
            style={{ left: pct(agent.x), top: pct(agent.y), width: pct(1), height: pct(1) }}
            aria-label={`Agent ${agent.id}: ${agent.status}`}
            title={`Agent ${agent.id} · ${agent.status}`}
          >
            <span
              className="flex h-[58%] w-[58%] items-center justify-center rounded-[30%] font-mono text-[clamp(8px,1.2vw,12px)] font-bold text-[#05080c]"
              style={{
                background: color,
                boxShadow: selected ? `0 0 0 2px #fff, 0 0 18px ${color}` : `0 0 12px ${color}88`,
                transform: agent.last_action === "rescue" ? "scale(1.18)" : undefined,
                transition: "transform 200ms, box-shadow 200ms",
              }}
            >
              {agent.id}
            </span>
          </button>
        );
      })}
    </div>
  );
}
