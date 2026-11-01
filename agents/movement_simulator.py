from typing import Any

from memory.redis_iris import (
    GRID_SIZE_X,
    get_agent,
    get_all_agents,
    get_survivor,
    log_mission_event,
    redis_client,
    set_agent,
    set_grid_node,
    set_survivor,
)


def _cell_to_xy(cell: int) -> tuple[int, int]:
    return cell % GRID_SIZE_X, cell // GRID_SIZE_X


def _xy_to_cell(x: int, y: int) -> int:
    return y * GRID_SIZE_X + x


def generate_manhattan_path(start_cell: int, target_cell: int) -> list[int]:
    path = []
    start_x, start_y = _cell_to_xy(start_cell)
    target_x, target_y = _cell_to_xy(target_cell)

    x, y = start_x, start_y
    while x != target_x:
        x += 1 if x < target_x else -1
        path.append(_xy_to_cell(x, y))

    while y != target_y:
        y += 1 if y < target_y else -1
        path.append(_xy_to_cell(x, y))

    return path


def _require_agent(agent_id: str) -> dict[str, Any]:
    agent = get_agent(agent_id)
    if not agent:
        raise ValueError(f"Agent {agent_id} missing from Redis.")

    return agent


def _require_survivor(survivor_id: str) -> dict[str, str]:
    survivor = get_survivor(survivor_id)
    if not survivor:
        raise ValueError(f"Survivor {survivor_id} missing from Redis.")

    return survivor


def _log_rescue_event(agent_id: str, survivor_id: str, cell: int, x: int, y: int) -> None:
    log_mission_event(
        "survivor_rescued",
        {"agent_id": agent_id, "survivor_id": survivor_id, "cell": cell, "x": x, "y": y},
    )


def _rescue_survivor(agent_id: str, survivor_id: str) -> None:
    survivor = _require_survivor(survivor_id)
    survivor_x = int(survivor["x"])
    survivor_y = int(survivor["y"])
    survivor_cell = _xy_to_cell(survivor_x, survivor_y)

    set_survivor(survivor_id, {**survivor, "status": "rescued"})
    set_grid_node(survivor_x, survivor_y, {"type": "clear", "passable": "true"})
    redis_client.hdel(f"grid:node:{survivor_x}:{survivor_y}", "id")
    _log_rescue_event(agent_id, survivor_id, survivor_cell, survivor_x, survivor_y)


def assign_agent_to_survivor(agent_id: str, survivor_id: str) -> dict[str, Any]:
    agent = _require_agent(agent_id)
    survivor = _require_survivor(survivor_id)

    target_x = int(survivor["x"])
    target_y = int(survivor["y"])
    target_cell = _xy_to_cell(target_x, target_y)
    path = generate_manhattan_path(int(agent["cell"]), target_cell)

    updated_agent = {
        **agent,
        "target_survivor_id": survivor_id,
        "target_cell": target_cell,
        "path": path,
        "status": f"Moving to {survivor_id}",
    }
    set_agent(agent_id, updated_agent)

    if not path:
        _rescue_survivor(agent_id, survivor_id)
        set_agent(agent_id, {**updated_agent, "status": f"Arrived at {survivor_id}"})

    return get_agent(agent_id)


def move_agent_one_tick(agent_id: str) -> dict[str, Any]:
    agent = _require_agent(agent_id)
    path = list(agent.get("path", []))

    if not path:
        return agent

    next_cell = int(path.pop(0))
    next_x, next_y = _cell_to_xy(next_cell)
    target_survivor_id = agent.get("target_survivor_id", "")
    status = agent.get("status", "idle")

    if not path and target_survivor_id:
        status = f"Arrived at {target_survivor_id}"
        _rescue_survivor(agent_id, target_survivor_id)

    updated_agent = {
        **agent,
        "x": next_x,
        "y": next_y,
        "cell": next_cell,
        "path": path,
        "status": status,
    }
    set_agent(agent_id, updated_agent)

    return get_agent(agent_id)


def move_all_agents() -> list[dict[str, Any]]:
    moved_agents = []

    for agent in get_all_agents():
        moved_agents.append(move_agent_one_tick(agent["id"]))

    return moved_agents
