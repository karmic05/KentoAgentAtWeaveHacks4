import random
import re
from typing import Any

from memory.redis_iris import (
    log_mission_event,
    GRID_SIZE_X,
    GRID_SIZE_Y,
    get_all_agents,
    get_grid_node,
    redis_client,
    set_grid_node,
    set_survivor,
)

VISIBLE_SEVERITIES = ("minor", "moderate", "severe")
TRAPPED_AIR_SUPPLIES = ("low", "stable", "critical")


def _xy_to_cell(x: int, y: int) -> int:
    return y * GRID_SIZE_X + x




def _occupied_agent_cells() -> set[int]:
    return {int(agent["cell"]) for agent in get_all_agents()}


def find_clear_grid_cells() -> list[dict[str, int]]:
    occupied_agent_cells = _occupied_agent_cells()
    clear_cells = []

    for y in range(GRID_SIZE_Y):
        for x in range(GRID_SIZE_X):
            cell = _xy_to_cell(x, y)
            node = get_grid_node(x, y)
            node_type = node.get("type")

            if cell in occupied_agent_cells:
                continue
            if node_type in {"rubble", "survivor_visible", "survivor_trapped"}:
                continue

            clear_cells.append({"x": x, "y": y, "cell": cell})

    return clear_cells


def _next_survivor_id(prefix: str) -> str:
    highest_id = 0
    pattern = re.compile(rf"^Survivor-{prefix}(\d+)$")

    for key in redis_client.scan_iter(match=f"live:survivor:Survivor-{prefix}*"):
        survivor_id = key.replace("live:survivor:", "", 1)
        match = pattern.match(survivor_id)
        if match:
            highest_id = max(highest_id, int(match.group(1)))

    return f"Survivor-{prefix}{highest_id + 1}"


def _spawn_visible_survivor(x: int, y: int) -> dict[str, Any]:
    survivor_id = _next_survivor_id("V")
    survivor = {
        "id": survivor_id,
        "x": x,
        "y": y,
        "cell": _xy_to_cell(x, y),
        "status": "injured_visible",
        "injury_severity": random.choice(VISIBLE_SEVERITIES),
    }

    set_grid_node(
        x,
        y,
        {
            "type": "survivor_visible",
            "symbol": "V",
            "id": survivor_id,
            "passable": "true",
        },
    )
    set_survivor(survivor_id, survivor)

    return survivor


def _spawn_trapped_survivor(x: int, y: int) -> dict[str, Any]:
    survivor_id = _next_survivor_id("T")
    survivor = {
        "id": survivor_id,
        "x": x,
        "y": y,
        "cell": _xy_to_cell(x, y),
        "status": "trapped_beneath",
        "air_supply": random.choice(TRAPPED_AIR_SUPPLIES),
    }

    set_grid_node(
        x,
        y,
        {
            "type": "survivor_trapped",
            "symbol": "T",
            "id": survivor_id,
            "passable": "false",
        },
    )
    set_survivor(survivor_id, survivor)

    return survivor


def spawn_random_survivors(count: int) -> dict[str, Any]:
    if count < 1:
        return {
            "requested": count,
            "spawned": [],
            "available_cells_remaining": len(find_clear_grid_cells()),
        }

    spawned = []

    for _ in range(count):
        clear_cells = find_clear_grid_cells()
        if not clear_cells:
            break

        cell = random.choice(clear_cells)
        if random.choice(("visible", "trapped")) == "visible":
            spawned.append(_spawn_visible_survivor(cell["x"], cell["y"]))
        else:
            spawned.append(_spawn_trapped_survivor(cell["x"], cell["y"]))

    result = {
        "requested": count,
        "spawned": spawned,
        "available_cells_remaining": len(find_clear_grid_cells()),
    }
    log_mission_event("random_survivors_spawned", result)

    return result
