"""Simulation director: disaster scenarios, survivor vitals, aftershocks, autopilot.

The field agents decide *how* to rescue; this module owns the world they act in:

  reset_scenario    - procedurally generate a city block (roads, buildings, collapsed
                      rubble), trapped + visible survivors, and a rescue team
  sync_from_cloud   - pull the latest Snowflake -> dbt -> Redis Cloud snapshot into the
                      local hot store (the same marts the GitHub Actions injector writes)
  sim_tick          - one world step: every field agent acts, survivor vitals decay,
                      and the occasional aftershock drops new rubble onto live routes
  autopilot         - a background loop that keeps ticking until the mission resolves
"""

import os
import random
import threading
import time
from collections import deque
from typing import Any

from agents.field_agent import (
    INACTIVE_STATUSES,
    LOST_STATUS,
    METRICS_KEY,
    TRAPPED_STATUSES,
    run_field_agents_tick,
)
from memory.redis_iris import (
    GRID_SIZE_X,
    GRID_SIZE_Y,
    clear_simulation,
    get_all_agents,
    log_mission_event,
    redis_client,
    set_agent,
    set_grid_node,
    set_survivor,
)

SIM_KEY = "sim:state"
AGENT_IDS = ("A", "B", "C", "D", "E", "F")

# (starting health, health lost per tick) by condition
VITALS = {
    "minor": (95, 0.35),
    "moderate": (80, 0.6),
    "severe": (62, 0.9),
    "critical": (48, 1.3),
    "stable": (88, 0.7),
    "limited": (66, 1.0),
    "low": (66, 1.0),
}

_tick_lock = threading.Lock()
_autopilot: dict[str, Any] = {"thread": None}


def _cell(x: int, y: int) -> int:
    return y * GRID_SIZE_X + x


def _xy(cell: int) -> tuple[int, int]:
    return cell % GRID_SIZE_X, cell // GRID_SIZE_X


def _neighbors(cell: int) -> list[int]:
    x, y = _xy(cell)
    return [
        _cell(x + dx, y + dy)
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1))
        if 0 <= x + dx < GRID_SIZE_X and 0 <= y + dy < GRID_SIZE_Y
    ]


def _connected(passable: set[int]) -> bool:
    """True when every passable cell can reach every other one."""
    if not passable:
        return True
    start = next(iter(passable))
    seen = {start}
    queue = deque([start])
    while queue:
        for nb in _neighbors(queue.popleft()):
            if nb in passable and nb not in seen:
                seen.add(nb)
                queue.append(nb)
    return len(seen) == len(passable)


def _vitals(condition: str) -> tuple[float, float]:
    return VITALS.get(condition, (80, 0.6))


# --------------------------------------------------------------------------- #
# scenario generation
# --------------------------------------------------------------------------- #
def reset_scenario(
    seed: int | None = None,
    survivors: int = 7,
    agents: int = 4,
    rubble: float = 0.16,
) -> dict[str, Any]:
    stop_autopilot()
    seed = seed if seed is not None else random.randrange(1_000_000)
    rng = random.Random(seed)
    clear_simulation()

    road_rows = {2, 7}
    road_cols = {1, 5, 8}
    roads = {_cell(x, y) for y in range(GRID_SIZE_Y) for x in range(GRID_SIZE_X)
             if y in road_rows or x in road_cols}
    blocks = [c for c in range(GRID_SIZE_X * GRID_SIZE_Y) if c not in roads]
    buildings = {c for c in blocks if rng.random() < 0.75}

    # Collapse buildings into rubble, never disconnecting the street network.
    passable = set(range(GRID_SIZE_X * GRID_SIZE_Y))
    rubble_cells: set[int] = set()
    candidates = list(buildings) + rng.sample(sorted(roads), k=len(roads) // 6)
    rng.shuffle(candidates)
    target = int(rubble * GRID_SIZE_X * GRID_SIZE_Y)
    for cell in candidates:
        if len(rubble_cells) >= target:
            break
        if _connected(passable - {cell}):
            passable.discard(cell)
            rubble_cells.add(cell)

    pipe = redis_client.pipeline()
    for cell in roads - rubble_cells:
        x, y = _xy(cell)
        pipe.hset(f"grid:node:{x}:{y}", mapping={"type": "road", "passable": "true"})
    for cell in buildings - rubble_cells:
        x, y = _xy(cell)
        pipe.hset(f"grid:node:{x}:{y}", mapping={"type": "building", "passable": "true"})
    for cell in rubble_cells:
        x, y = _xy(cell)
        pipe.hset(f"grid:node:{x}:{y}", mapping={
            "type": "rubble", "passable": "false",
            "severity": rng.choice(("moderate", "severe", "critical")),
        })
    pipe.execute()

    # Agents stage from spread-out street cells (farthest-point sampling).
    street = sorted(roads - rubble_cells)
    staged = [rng.choice(street)]
    while len(staged) < min(agents, len(AGENT_IDS)):
        staged.append(max(
            street,
            key=lambda c: min(abs(_xy(c)[0] - _xy(s)[0]) + abs(_xy(c)[1] - _xy(s)[1]) for s in staged),
        ))
    for agent_id, cell in zip(AGENT_IDS, staged):
        x, y = _xy(cell)
        set_agent(agent_id, {
            "x": x, "y": y, "cell": cell, "status": "Staged", "target_survivor_id": "",
            "target_cell": None, "path": [], "thought": "Awaiting orders.", "brain": "rules",
            "rescues": 0, "distance": 0,
        })

    # Trapped survivors sit under rubble that still has an open side to dig from.
    diggable = [c for c in rubble_cells if any(nb in passable for nb in _neighbors(c))]
    rng.shuffle(diggable)
    open_cells = [c for c in sorted(passable) if c not in staged]
    rng.shuffle(open_cells)
    trapped_count = min(len(diggable), (survivors + 1) // 2)
    placed = 0
    for index in range(survivors):
        trapped = index < trapped_count
        cell = diggable.pop() if trapped else open_cells.pop()
        condition = rng.choice(("critical", "limited", "stable") if trapped else ("minor", "moderate", "severe"))
        _place_survivor(f"S-{index + 1:02d}", cell, trapped, condition)
        placed += 1

    redis_client.hset(METRICS_KEY, mapping={
        "tick": 0, "total": placed, "rescued": 0, "lost": 0, "distance": 0, "reroutes": 0,
        "backup_requests": 0, "aftershocks": 0, "decisions_rules": 0, "decisions_llm": 0,
        "started_at": time.time(),
    })
    redis_client.hset(SIM_KEY, mapping={"seed": seed, "source": "procedural", "running": 0})
    log_mission_event("scenario_generated", {
        "seed": seed, "survivors": placed, "agents": len(staged), "rubble_cells": len(rubble_cells),
    })
    return {"seed": seed, "survivors": placed, "agents": len(staged), "rubble_cells": len(rubble_cells)}


def _place_survivor(survivor_id: str, cell: int, trapped: bool, condition: str, **extra: Any) -> None:
    x, y = _xy(cell)
    health, decay = _vitals(condition)
    set_survivor(survivor_id, {
        "id": survivor_id, "x": x, "y": y, "cell": cell,
        "status": "trapped_beneath" if trapped else "injured_visible",
        ("air_supply" if trapped else "injury_severity"): condition,
        "health": health, "decay": decay, "spawned_tick": redis_client.hget(METRICS_KEY, "tick") or 0,
        **extra,
    })
    if trapped:
        set_grid_node(x, y, {"type": "survivor_trapped", "id": survivor_id, "passable": "false"})
    else:
        set_grid_node(x, y, {"type": "survivor_visible", "id": survivor_id, "passable": "true"})


# --------------------------------------------------------------------------- #
# Redis Cloud sync (Snowflake -> dbt marts -> Redis Cloud -> local hot store)
# --------------------------------------------------------------------------- #
def _cloud_client():
    import redis

    host = os.getenv("KENTO_SOURCE_REDIS_HOST")
    if not host:
        raise RuntimeError("KENTO_SOURCE_REDIS_HOST is not configured in .env")
    return redis.Redis(
        host=host,
        port=int(os.getenv("KENTO_SOURCE_REDIS_PORT", "6379")),
        username=os.getenv("KENTO_SOURCE_REDIS_USERNAME") or None,
        password=os.getenv("KENTO_SOURCE_REDIS_PASSWORD") or None,
        decode_responses=True,
        socket_connect_timeout=5,
    )


def sync_from_cloud() -> dict[str, Any]:
    stop_autopilot()
    cloud = _cloud_client()
    grid_keys = list(cloud.scan_iter("grid:node:*"))
    survivor_keys = list(cloud.scan_iter("live:survivor:*"))
    pipe = cloud.pipeline()
    for key in grid_keys + survivor_keys:
        pipe.hgetall(key)
    rows = pipe.execute()
    grid = dict(zip(grid_keys, rows[: len(grid_keys)]))
    survivors = dict(zip(survivor_keys, rows[len(grid_keys):]))
    last_sync = cloud.hgetall("pipeline:last_sync")

    agents = get_all_agents()
    for pattern in ("grid:node:*", "live:survivor:*", "backup:request:*", "mission:log*", METRICS_KEY):
        keys = list(redis_client.scan_iter(match=pattern))
        if keys:
            redis_client.delete(*keys)

    pipe = redis_client.pipeline()
    for key, node in grid.items():
        if node.get("type", "").startswith("survivor_"):
            continue  # survivors are re-placed below with vitals
        pipe.hset(key, mapping=node)
    pipe.execute()

    for key, data in survivors.items():
        trapped = data.get("status") in TRAPPED_STATUSES
        condition = (data.get("air_supply") if trapped else data.get("injury_severity")) or "moderate"
        x, y = int(data["x"]), int(data["y"])
        _place_survivor(
            key.split(":")[-1], _cell(x, y), trapped, condition,
            priority_rank=data.get("priority_rank", ""),
            recommended_initial_response=data.get("recommended_initial_response", ""),
        )

    # Keep the team, but move anyone now standing on fresh rubble to open ground.
    blocked = {_cell(*map(int, k.split(":")[2:4])) for k, n in grid.items() if n.get("passable") == "false"}
    occupied = set()
    for agent in agents:
        cell = int(agent["cell"])
        if cell in blocked or cell in occupied:
            cell = next(c for c in range(GRID_SIZE_X * GRID_SIZE_Y) if c not in blocked and c not in occupied)
        occupied.add(cell)
        x, y = _xy(cell)
        set_agent(agent["id"], {**agent, "x": x, "y": y, "cell": cell, "status": "Staged",
                                "target_survivor_id": "", "target_cell": None, "path": [],
                                "thought": "Synced with the Snowflake snapshot.", "rescues": 0, "distance": 0})

    redis_client.hset(METRICS_KEY, mapping={
        "tick": 0, "total": len(survivors), "rescued": 0, "lost": 0, "distance": 0, "reroutes": 0,
        "backup_requests": 0, "aftershocks": 0, "decisions_rules": 0, "decisions_llm": 0,
        "started_at": time.time(),
    })
    redis_client.hset(SIM_KEY, mapping={
        "source": "redis-cloud", "running": 0, "cloud_last_sync": last_sync.get("last_sync_utc", ""),
    })
    result = {"grid_nodes": len(grid), "survivors": len(survivors), "cloud_last_sync": last_sync.get("last_sync_utc")}
    log_mission_event("cloud_snapshot_synced", result)
    return result


# --------------------------------------------------------------------------- #
# world dynamics
# --------------------------------------------------------------------------- #
def _active_survivors() -> list[dict[str, str]]:
    out = []
    for key in redis_client.scan_iter(match="live:survivor:*"):
        data = redis_client.hgetall(key)
        if data and data.get("status") not in INACTIVE_STATUSES:
            out.append({**data, "id": key.split(":")[-1]})
    return out


def _decay_vitals(tick: int) -> list[str]:
    lost = []
    for survivor in _active_survivors():
        health = float(survivor.get("health") or 100) - float(survivor.get("decay") or 0.6)
        if health > 0:
            redis_client.hset(f"live:survivor:{survivor['id']}", "health", round(health, 1))
            continue
        x, y = int(survivor["x"]), int(survivor["y"])
        redis_client.hset(f"live:survivor:{survivor['id']}", mapping={
            "health": 0, "status": LOST_STATUS, "lost_tick": tick,
        })
        if survivor.get("status") in TRAPPED_STATUSES:
            set_grid_node(x, y, {"type": "rubble", "passable": "false"})
        else:
            set_grid_node(x, y, {"type": "road", "passable": "true"})
        redis_client.hdel(f"grid:node:{x}:{y}", "id")
        redis_client.delete(f"backup:request:{survivor['id']}")
        redis_client.hincrby(METRICS_KEY, "lost", 1)
        log_mission_event("survivor_lost", {"survivor_id": survivor["id"], "tick": tick, "x": x, "y": y})
        lost.append(survivor["id"])
    return lost


def _grid_passable() -> tuple[set[int], dict[int, dict]]:
    coords = [(x, y) for y in range(GRID_SIZE_Y) for x in range(GRID_SIZE_X)]
    pipe = redis_client.pipeline()
    for x, y in coords:
        pipe.hgetall(f"grid:node:{x}:{y}")
    nodes = {_cell(x, y): n for (x, y), n in zip(coords, pipe.execute())}
    passable = {c for c, n in nodes.items() if str(n.get("passable", "true")).lower() != "false"}
    return passable, nodes


def aftershock(rng: random.Random | None = None) -> dict[str, Any]:
    """Drop rubble onto open cells, preferring cells on agents' planned routes so
    the hive has to re-plan, and sometimes bury a new survivor."""
    rng = rng or random.Random()
    passable, nodes = _grid_passable()
    agents = get_all_agents()
    agent_cells = {int(a["cell"]) for a in agents}
    on_routes = [int(c) for a in agents for c in (a.get("path") or [])[1:]]
    free = [c for c in passable if c not in agent_cells and not nodes[c].get("type", "").startswith("survivor")]
    preferred = [c for c in on_routes if c in free]
    pool = list(dict.fromkeys(preferred[:2] + rng.sample(free, k=min(len(free), 6))))

    dropped = []
    for cell in pool:
        if len(dropped) >= rng.randint(1, 3):
            break
        if _connected(passable - {cell}):
            passable.discard(cell)
            x, y = _xy(cell)
            set_grid_node(x, y, {"type": "rubble", "passable": "false", "severity": "aftershock"})
            dropped.append(cell)

    buried = None
    if dropped and rng.random() < 0.55:
        diggable = [c for c in dropped if any(nb in passable for nb in _neighbors(c))]
        if diggable:
            total = int(redis_client.hincrby(METRICS_KEY, "total", 1))
            buried = f"S-{total:02d}"
            _place_survivor(buried, rng.choice(diggable), True, rng.choice(("critical", "limited")))

    redis_client.hincrby(METRICS_KEY, "aftershocks", 1)
    result = {"rubble_cells": dropped, "new_survivor": buried}
    log_mission_event("aftershock", result)
    return result


def sim_tick(aftershocks: bool = False) -> dict[str, Any]:
    with _tick_lock:
        tick = int(redis_client.hincrby(METRICS_KEY, "tick", 1))
        results = run_field_agents_tick()
        lost = _decay_vitals(tick)
        shock = None
        if aftershocks and tick > 4 and random.random() < 0.06:
            shock = aftershock()
        active = len(_active_survivors())
        if active == 0 and not redis_client.hget(SIM_KEY, "completed_tick"):
            redis_client.hset(SIM_KEY, "completed_tick", tick)
            for agent in get_all_agents():
                set_agent(agent["id"], {
                    **agent, "status": "Mission complete", "target_survivor_id": "", "target_cell": None,
                    "path": [], "thought": "All survivors resolved; holding for the next call.",
                })
            log_mission_event("mission_complete", get_metrics())
        return {"tick": tick, "actions": results, "lost": lost, "aftershock": shock, "active": active}


def get_metrics() -> dict[str, Any]:
    raw = redis_client.hgetall(METRICS_KEY)
    metrics: dict[str, Any] = {k: float(v) if "." in v else int(v) for k, v in raw.items() if v != ""}
    total = metrics.get("total", 0)
    metrics["active"] = max(0, total - metrics.get("rescued", 0) - metrics.get("lost", 0))
    metrics["survival_rate"] = metrics.get("rescued", 0) / total if total else 0
    return metrics


# --------------------------------------------------------------------------- #
# autopilot
# --------------------------------------------------------------------------- #
def _autopilot_loop() -> None:
    while redis_client.hget(SIM_KEY, "running") == "1":
        started = time.time()
        try:
            result = sim_tick(aftershocks=redis_client.hget(SIM_KEY, "aftershocks") == "1")
        except Exception as exc:  # keep the API alive; surface the failure in the log
            log_mission_event("autopilot_error", {"error": str(exc)})
            break
        if result["active"] == 0:
            break
        interval = int(redis_client.hget(SIM_KEY, "interval_ms") or 450) / 1000
        time.sleep(max(0.0, interval - (time.time() - started)))
    redis_client.hset(SIM_KEY, "running", 0)


def start_autopilot(interval_ms: int = 450, aftershocks: bool = True) -> dict[str, Any]:
    redis_client.hset(SIM_KEY, mapping={
        "running": 1, "interval_ms": interval_ms, "aftershocks": int(aftershocks),
    })
    thread = _autopilot.get("thread")
    if thread is None or not thread.is_alive():
        thread = threading.Thread(target=_autopilot_loop, daemon=True)
        _autopilot["thread"] = thread
        thread.start()
    return get_sim_state()


def stop_autopilot() -> None:
    redis_client.hset(SIM_KEY, "running", 0)
    thread = _autopilot.get("thread")
    if thread is not None and thread.is_alive() and thread is not threading.current_thread():
        thread.join(timeout=5)


def get_sim_state() -> dict[str, Any]:
    state = redis_client.hgetall(SIM_KEY)
    return {
        "running": state.get("running") == "1",
        "interval_ms": int(state.get("interval_ms") or 450),
        "aftershocks": state.get("aftershocks", "1") == "1",
        "seed": state.get("seed"),
        "source": state.get("source", "procedural"),
        "cloud_last_sync": state.get("cloud_last_sync"),
        "completed_tick": int(state["completed_tick"]) if state.get("completed_tick") else None,
    }


# --------------------------------------------------------------------------- #
# manual edits from the dashboard
# --------------------------------------------------------------------------- #
def edit_cell(x: int, y: int, tool: str) -> dict[str, Any]:
    """tool: 'rubble' toggles debris; 'survivor' drops a survivor (trapped if on rubble)."""
    cell = _cell(x, y)
    with _tick_lock:
        passable, nodes = _grid_passable()
        node = nodes[cell]
        node_type = node.get("type", "")
        if cell in {int(a["cell"]) for a in get_all_agents()}:
            return {"changed": False, "reason": "agent_on_cell"}
        if node_type.startswith("survivor"):
            return {"changed": False, "reason": "survivor_on_cell"}

        if tool == "rubble":
            if node_type == "rubble":
                set_grid_node(x, y, {"type": "road", "passable": "true"})
                redis_client.hdel(f"grid:node:{x}:{y}", "severity")
                log_mission_event("rubble_cleared", {"x": x, "y": y})
                return {"changed": True, "type": "road"}
            if not _connected(passable - {cell}):
                return {"changed": False, "reason": "would_cut_off_the_street_network"}
            set_grid_node(x, y, {"type": "rubble", "passable": "false", "severity": "manual"})
            log_mission_event("rubble_dropped", {"x": x, "y": y})
            return {"changed": True, "type": "rubble"}

        if tool == "survivor":
            trapped = node_type == "rubble"
            if trapped and not any(nb in passable for nb in _neighbors(cell)):
                return {"changed": False, "reason": "no_open_side_to_dig_from"}
            total = int(redis_client.hincrby(METRICS_KEY, "total", 1))
            survivor_id = f"S-{total:02d}"
            _place_survivor(survivor_id, cell, trapped, "critical" if trapped else "severe")
            redis_client.hdel(SIM_KEY, "completed_tick")
            log_mission_event("survivor_reported", {"survivor_id": survivor_id, "x": x, "y": y, "trapped": trapped})
            return {"changed": True, "survivor_id": survivor_id}

    return {"changed": False, "reason": f"unknown tool {tool}"}
