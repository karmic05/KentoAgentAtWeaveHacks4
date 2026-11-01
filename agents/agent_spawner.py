"""Seed rescue agents into Redis so they appear on the grid.

The movement/coordination/hive code all operate on existing agents
(get_all_agents), but nothing created them. This module places agents on clear,
passable cells and registers them as agent:* hashes that the /grid-state API
returns and the dashboard renders.
"""

from typing import Any

from agents.survivor_spawner import find_clear_grid_cells
from memory.redis_iris import get_agent, get_all_agents, log_mission_event, set_agent

DEFAULT_AGENT_IDS = ("A", "B", "C")




def _existing_agent_ids() -> set[str]:
    return {str(agent["id"]) for agent in get_all_agents()}


def spawn_agents(agent_ids: list[str] | None = None) -> dict[str, Any]:
    """Create the given agents (default A, B, C) on spread-out clear cells.

    Agents already present in Redis are skipped (idempotent). Each agent starts
    idle with no target.
    """
    ids = [str(a).strip() for a in (agent_ids or DEFAULT_AGENT_IDS) if str(a).strip()]
    existing = _existing_agent_ids()
    spawned = []

    for agent_id in ids:
        if agent_id in existing:
            continue

        clear_cells = find_clear_grid_cells()
        if not clear_cells:
            break

        # Spread agents across the available clear cells rather than clustering.
        index = (len(spawned) * len(clear_cells)) // max(1, len(ids))
        cell = clear_cells[index % len(clear_cells)]

        set_agent(
            agent_id,
            {
                "x": cell["x"],
                "y": cell["y"],
                "cell": cell["cell"],
                "status": "idle",
                "target_survivor_id": "",
                "target_cell": None,
                "path": [],
            },
        )
        existing.add(agent_id)
        spawned.append(get_agent(agent_id))

    result = {"spawned": spawned, "agents": get_all_agents()}
    if spawned:
        log_mission_event("rescue_agents_spawned", {"agent_ids": [a["id"] for a in spawned]})

    return result


def ensure_default_agents() -> dict[str, Any]:
    """Seed the default A/B/C agents only if no agents exist yet."""
    if get_all_agents():
        return {"spawned": [], "agents": get_all_agents()}
    return spawn_agents()
