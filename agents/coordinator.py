from typing import Any

from agents.movement_simulator import assign_agent_to_survivor
from memory.redis_iris import GRID_SIZE_X, get_all_agents, get_survivor, redis_client


def _xy_to_cell(x: int, y: int) -> int:
    return y * GRID_SIZE_X + x


def _manhattan_distance(agent: dict[str, Any], survivor: dict[str, Any]) -> int:
    return abs(int(agent["x"]) - int(survivor["x"])) + abs(int(agent["y"]) - int(survivor["y"]))


def _get_all_active_survivors() -> list[dict[str, Any]]:
    survivors = []

    for key in redis_client.scan_iter(match="live:survivor:*"):
        survivor_id = key.replace("live:survivor:", "", 1)
        survivor = get_survivor(survivor_id)
        if not survivor or survivor.get("status") in ("rescued", "lost"):
            continue

        x = int(survivor["x"])
        y = int(survivor["y"])
        survivors.append(
            {
                "id": survivor_id,
                "x": x,
                "y": y,
                "cell": _xy_to_cell(x, y),
                "status": survivor.get("status", "unknown"),
                "data": survivor,
            }
        )

    return sorted(survivors, key=lambda survivor: survivor["id"])


def _has_active_assignment(agent: dict[str, Any]) -> bool:
    target_survivor_id = agent.get("target_survivor_id")
    if not target_survivor_id:
        return False

    survivor = get_survivor(str(target_survivor_id))
    return bool(survivor and survivor.get("status") not in ("rescued", "lost"))


def _get_idle_agents() -> list[dict[str, Any]]:
    return [agent for agent in get_all_agents() if not _has_active_assignment(agent)]


def _get_assigned_survivor_ids() -> set[str]:
    assigned_survivor_ids = set()

    for agent in get_all_agents():
        target_survivor_id = agent.get("target_survivor_id")
        if target_survivor_id and _has_active_assignment(agent):
            assigned_survivor_ids.add(str(target_survivor_id))

    return assigned_survivor_ids


def find_nearest_idle_agent(survivor_id: str) -> dict[str, Any] | None:
    survivor = get_survivor(survivor_id)
    if not survivor or survivor.get("status") in ("rescued", "lost"):
        return None

    survivor_state = {
        "id": survivor_id,
        "x": int(survivor["x"]),
        "y": int(survivor["y"]),
    }
    idle_agents = _get_idle_agents()

    if not idle_agents:
        return None

    nearest_agent = min(
        idle_agents,
        key=lambda agent: (_manhattan_distance(agent, survivor_state), agent.get("id", "")),
    )

    return {
        "agent": nearest_agent,
        "distance": _manhattan_distance(nearest_agent, survivor_state),
        "survivor_id": survivor_id,
    }


def assign_best_agent(survivor_id: str) -> dict[str, Any]:
    if survivor_id in _get_assigned_survivor_ids():
        return {
            "assigned": False,
            "survivor_id": survivor_id,
            "reason": "survivor_already_assigned",
        }

    nearest = find_nearest_idle_agent(survivor_id)
    if nearest is None:
        return {
            "assigned": False,
            "survivor_id": survivor_id,
            "reason": "no_idle_agent_available",
        }

    agent = nearest["agent"]
    assigned_agent = assign_agent_to_survivor(str(agent["id"]), survivor_id)

    return {
        "assigned": True,
        "agent_id": assigned_agent["id"],
        "survivor_id": survivor_id,
        "distance": nearest["distance"],
        "agent": assigned_agent,
    }


def orchestrate_rescue_operations() -> dict[str, Any]:
    active_survivors = _get_all_active_survivors()
    assignments = []
    skipped = []

    for survivor in active_survivors:
        result = assign_best_agent(str(survivor["id"]))
        if result["assigned"]:
            assignments.append(result)
        else:
            skipped.append(result)

    return {
        "active_survivors": active_survivors,
        "assignments": assignments,
        "skipped": skipped,
        "idle_agents_remaining": _get_idle_agents(),
    }
