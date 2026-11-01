import json
import time
from typing import Any

from agents.coordinator import orchestrate_rescue_operations
from agents.movement_simulator import move_all_agents
from evals.hive_metrics import calculate_hive_cycle_metrics, log_hive_cycle_evaluation
from memory.redis_iris import GRID_SIZE_X, get_all_agents, get_survivor, log_mission_event, redis_client

HIVE_STATUS_KEY = "hive:status"




def get_active_survivors() -> list[dict[str, Any]]:
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
                "cell": y * GRID_SIZE_X + x,
                "status": survivor.get("status", "unknown"),
                "data": survivor,
            }
        )

    return sorted(survivors, key=lambda survivor: survivor["id"])


def _agent_has_active_assignment(agent: dict[str, Any]) -> bool:
    target_survivor_id = agent.get("target_survivor_id")
    if not target_survivor_id:
        return False

    survivor = get_survivor(str(target_survivor_id))
    return bool(survivor and survivor.get("status") not in ("rescued", "lost"))


def get_idle_agents() -> list[dict[str, Any]]:
    return [agent for agent in get_all_agents() if not _agent_has_active_assignment(agent)]


def _current_tick() -> int:
    status = redis_client.hgetall(HIVE_STATUS_KEY)
    try:
        return int(status.get("tick", 0))
    except (TypeError, ValueError):
        return 0


def _started_at_ns() -> int:
    status = redis_client.hgetall(HIVE_STATUS_KEY)
    if status.get("started_at_ns"):
        return int(status["started_at_ns"])

    started_at_ns = time.time_ns()
    redis_client.hset(HIVE_STATUS_KEY, mapping={"started_at_ns": started_at_ns})
    return started_at_ns


def _set_hive_status(state: str, tick_result: dict[str, Any]) -> dict[str, Any]:
    started_at_ns = _started_at_ns()
    status = {
        "state": state,
        "tick": tick_result["tick"],
        "active_survivors": len(tick_result["active_survivors_after"]),
        "idle_agents": len(tick_result["idle_agents_after"]),
        "complete": len(tick_result["active_survivors_after"]) == 0,
        "started_at_ns": started_at_ns,
        "updated_at_ns": time.time_ns(),
        "last_evaluation": tick_result["evaluation"],
        "last_result": tick_result,
    }
    redis_client.hset(
        HIVE_STATUS_KEY,
        mapping={
            "state": status["state"],
            "tick": status["tick"],
            "active_survivors": status["active_survivors"],
            "idle_agents": status["idle_agents"],
            "complete": json.dumps(status["complete"]),
            "started_at_ns": status["started_at_ns"],
            "updated_at_ns": status["updated_at_ns"],
            "last_evaluation": json.dumps(status["last_evaluation"], default=str),
            "last_result": json.dumps(status["last_result"], default=str),
        },
    )

    return status


def get_hive_status() -> dict[str, Any]:
    status = redis_client.hgetall(HIVE_STATUS_KEY)
    if not status:
        active_survivors = get_active_survivors()
        idle_agents = get_idle_agents()
        return {
            "state": "idle",
            "tick": 0,
            "active_survivors": len(active_survivors),
            "idle_agents": len(idle_agents),
            "complete": len(active_survivors) == 0,
            "started_at_ns": None,
            "updated_at_ns": None,
            "last_evaluation": None,
            "last_result": None,
        }

    return {
        "state": status.get("state", "idle"),
        "tick": int(status.get("tick", 0)),
        "active_survivors": int(status.get("active_survivors", 0)),
        "idle_agents": int(status.get("idle_agents", 0)),
        "complete": json.loads(status.get("complete", "false")),
        "started_at_ns": int(status["started_at_ns"]) if status.get("started_at_ns") else None,
        "updated_at_ns": int(status["updated_at_ns"]) if status.get("updated_at_ns") else None,
        "last_evaluation": json.loads(status["last_evaluation"]) if status.get("last_evaluation") else None,
        "last_result": json.loads(status["last_result"]) if status.get("last_result") else None,
    }


def run_autonomous_tick() -> dict[str, Any]:
    cycle_started_at_ns = time.time_ns()
    started_at_ns = _started_at_ns()
    agents_before = get_all_agents()
    active_survivors_before = get_active_survivors()
    idle_agents_before = get_idle_agents()

    coordination = orchestrate_rescue_operations() if active_survivors_before else {
        "active_survivors": [],
        "assignments": [],
        "skipped": [],
        "idle_agents_remaining": idle_agents_before,
    }
    moved_agents = move_all_agents()
    agents_after = get_all_agents()
    active_survivors_after = get_active_survivors()
    idle_agents_after = get_idle_agents()
    cycle_finished_at_ns = time.time_ns()
    tick = _current_tick() + 1

    cycle = {
        "active_survivors_before": active_survivors_before,
        "idle_agents_before": idle_agents_before,
        "agents_before": agents_before,
        "coordination": coordination,
        "moved_agents": moved_agents,
        "agents_after": agents_after,
        "active_survivors_after": active_survivors_after,
        "idle_agents_after": idle_agents_after,
    }
    metrics = calculate_hive_cycle_metrics(
        started_at_ns=started_at_ns,
        cycle_started_at_ns=cycle_started_at_ns,
        cycle_finished_at_ns=cycle_finished_at_ns,
        active_survivors_before=active_survivors_before,
        active_survivors_after=active_survivors_after,
        idle_agents_before=idle_agents_before,
        agents_before=agents_before,
        agents_after=agents_after,
        coordination=coordination,
    )
    evaluation = log_hive_cycle_evaluation(tick=tick, metrics=metrics, cycle=cycle)

    result = {
        "tick": tick,
        "active_survivors_before": active_survivors_before,
        "idle_agents_before": idle_agents_before,
        "coordination": coordination,
        "moved_agents": moved_agents,
        "active_survivors_after": active_survivors_after,
        "idle_agents_after": idle_agents_after,
        "metrics": metrics,
        "evaluation": evaluation,
        "complete": len(active_survivors_after) == 0,
    }
    status = _set_hive_status("complete" if result["complete"] else "running", result)
    log_mission_event("autonomous_hive_tick_completed", result)
    log_mission_event("autonomous_hive_cycle_evaluated", evaluation)

    return {
        "status": status,
        "result": result,
    }


def run_autonomous_hive_until_complete(max_ticks: int = 100, tick_sleep_seconds: float = 0) -> dict[str, Any]:
    tick_results = []
    started_at_ns = time.time_ns()
    redis_client.hset(HIVE_STATUS_KEY, mapping={"started_at_ns": started_at_ns, "state": "running"})
    log_mission_event("autonomous_hive_started", {"max_ticks": max_ticks, "started_at_ns": started_at_ns})

    while len(get_active_survivors()) > 0 and len(tick_results) < max_ticks:
        tick_result = run_autonomous_tick()
        tick_results.append(tick_result)

        if tick_sleep_seconds > 0 and not tick_result["result"]["complete"]:
            time.sleep(tick_sleep_seconds)

    final_status = get_hive_status()
    if len(get_active_survivors()) > 0:
        redis_client.hset(HIVE_STATUS_KEY, mapping={"state": "paused_max_ticks"})
        final_status = get_hive_status()
        log_mission_event("autonomous_hive_paused_max_ticks", final_status)
    else:
        log_mission_event("autonomous_hive_completed", final_status)

    return {
        "status": final_status,
        "ticks": tick_results,
    }
