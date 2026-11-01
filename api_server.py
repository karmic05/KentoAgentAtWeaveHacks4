import os
import threading
import time
from pathlib import Path

import weave
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from agents.autonomous_hive import (
    get_hive_status,
    run_autonomous_hive_until_complete,
    run_autonomous_tick,
)
from agents.agent_spawner import ensure_default_agents, spawn_agents
from agents.coordinator import assign_best_agent
from agents.field_agent import llm_status, run_field_agents_tick, warm_up_llm
from agents.hive_orchestrator import HiveOrchestrator
from agents.movement_simulator import assign_agent_to_survivor
from agents.simulation import (
    aftershock,
    edit_cell,
    get_metrics,
    get_sim_state,
    reset_scenario,
    sim_tick,
    start_autopilot,
    stop_autopilot,
    sync_from_cloud,
)
from agents.survivor_spawner import spawn_random_survivors
from memory.redis_iris import (
    GRID_SIZE_X,
    GRID_SIZE_Y,
    REDIS_BACKEND,
    get_all_agents,
    get_recent_mission_logs,
    get_survivor,
    log_mission_event,
    redis_client,
)

def _wandb_logged_in() -> bool:
    if os.getenv("WANDB_API_KEY"):
        return True
    for name in (".netrc", "_netrc"):
        netrc = Path.home() / name
        if netrc.exists() and "api.wandb.ai" in netrc.read_text(errors="ignore"):
            return True
    return False


# Weave tracing needs a W&B login; without one weave.init would block on an
# interactive prompt, so only initialise when credentials are present.
WEAVE_ENABLED = _wandb_logged_in() and os.getenv("DISABLE_WEAVE", "").lower() not in ("1", "true", "yes")
if WEAVE_ENABLED:
    weave.init("kento-agent-hive")

app = FastAPI()


class HiveDispatchRequest(BaseModel):
    survivor_id: str


class AssignAgentRequest(BaseModel):
    agent_id: str
    survivor_id: str


class AssignNearestAgentRequest(BaseModel):
    survivor_id: str


class AutonomousHiveRunRequest(BaseModel):
    max_ticks: int = 100
    tick_sleep_seconds: float = 0


class SpawnSurvivorsRequest(BaseModel):
    count: int


class SpawnAgentsRequest(BaseModel):
    agent_ids: list[str] | None = None


class SimulationModeRequest(BaseModel):
    paused: bool


class FieldAgentsRunRequest(BaseModel):
    max_ticks: int = 60


class ScenarioRequest(BaseModel):
    seed: int | None = None
    survivors: int = 7
    agents: int = 4
    rubble: float = 0.16


class AutopilotRequest(BaseModel):
    running: bool
    interval_ms: int = 450
    aftershocks: bool = True


class CellEditRequest(BaseModel):
    x: int
    y: int
    tool: str


SIM_PAUSED_KEY = "sim:paused"

# Background field-agent run state. With LLM thinking enabled each tick costs an
# OpenAI round-trip (~4s for 3 agents), so a full rescue is tens of seconds. We run
# it off-request in a daemon thread and let the dashboard's 2s /grid-state polling
# animate the rescue, instead of blocking the HTTP request for the whole run.
_field_run = {"running": False, "ticks": 0, "complete": False, "started_at": 0.0}
_field_run_lock = threading.Lock()


def _field_agents_run_worker(max_ticks: int) -> None:
    redis_client.set(SIM_PAUSED_KEY, "1")
    ticks = 0
    try:
        for _ in range(max_ticks):
            run_field_agents_tick()
            ticks += 1
            _field_run["ticks"] = ticks
            if _active_survivor_count() == 0:
                break
    finally:
        complete = _active_survivor_count() == 0
        _field_run["complete"] = complete
        _field_run["running"] = False
        redis_client.set(SIM_PAUSED_KEY, "0")
        log_mission_event(
            "api_field_agents_run_completed",
            {"ticks_run": ticks, "complete": complete,
             "active_survivors_remaining": _active_survivor_count()},
        )


def _active_survivor_count() -> int:
    return sum(1 for s in _get_survivors_from_redis() if s.get("status") != "rescued")


app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"http://(localhost|127\.0\.0\.1)(:\d+)?",
    allow_methods=["*"],
    allow_headers=["*"],
)




def _parse_int(value: str | int | None, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _get_survivors_from_redis():
    survivors = []

    for key in redis_client.scan_iter("live:survivor:*"):
        survivor_id = key.replace("live:survivor:", "", 1)
        data = get_survivor(survivor_id)
        x = _parse_int(data.get("x"))
        y = _parse_int(data.get("y"))
        survivors.append({
            "id": survivor_id,
            "x": x,
            "y": y,
            "cell": y * GRID_SIZE_X + x,
            "status": data.get("status", "unknown"),
            "data": data,
        })

    return sorted(survivors, key=lambda survivor: survivor["id"])


@app.get("/grid-state")
def grid_state():
    cells = []

    # Batch all grid-node reads into a single Redis pipeline round-trip.
    # (100 individual hgetall calls over Redis Cloud took ~13s; this is ~1.)
    coords = [(x, y) for y in range(GRID_SIZE_Y) for x in range(GRID_SIZE_X)]
    pipe = redis_client.pipeline()
    for x, y in coords:
        pipe.hgetall(f"grid:node:{x}:{y}")
    nodes = pipe.execute()

    for (x, y), node in zip(coords, nodes):
        symbol = "."

        if node:
            node_type = node.get("type")
            if node_type == "rubble":
                symbol = "█"
            elif node_type == "survivor_visible":
                symbol = "V"
            elif node_type == "survivor_trapped":
                symbol = "T"

        cells.append({
            "x": x,
            "y": y,
            "cell": y * GRID_SIZE_X + x,
            "symbol": symbol,
            "node": node,
        })

    return {
        "width": GRID_SIZE_X,
        "height": GRID_SIZE_Y,
        "cells": cells,
        "survivors": _get_survivors_from_redis(),
        "agents": get_all_agents(),
        "mission_logs": get_recent_mission_logs(),
        "hive_status": get_hive_status(),
        "metrics": get_metrics(),
        "sim": get_sim_state(),
        "llm": llm_status(),
        "backups": [
            redis_client.hgetall(key) for key in redis_client.scan_iter("backup:request:*")
        ],
    }


@app.get("/health")
def health():
    return {
        "ok": True,
        "redis": REDIS_BACKEND,
        "llm": llm_status(),
        "weave": WEAVE_ENABLED,
        "cloud_source": bool(os.getenv("KENTO_SOURCE_REDIS_HOST")),
    }


@app.post("/scenario/reset")
def scenario_reset(request: ScenarioRequest):
    result = reset_scenario(
        seed=request.seed,
        survivors=max(1, min(request.survivors, 16)),
        agents=max(1, min(request.agents, 6)),
        rubble=max(0.0, min(request.rubble, 0.3)),
    )
    return {"result": result, "grid_state": grid_state()}


@app.post("/scenario/sync-cloud")
def scenario_sync_cloud():
    try:
        result = sync_from_cloud()
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Redis Cloud sync failed: {exc}") from exc
    return {"result": result, "grid_state": grid_state()}


@app.post("/sim/step")
def sim_step():
    result = sim_tick()
    return {"result": {k: v for k, v in result.items() if k != "actions"}, "grid_state": grid_state()}


@app.post("/sim/autopilot")
def sim_autopilot(request: AutopilotRequest):
    if request.running:
        start_autopilot(max(120, min(request.interval_ms, 3000)), request.aftershocks)
    else:
        stop_autopilot()
    return {"result": get_sim_state(), "grid_state": grid_state()}


@app.post("/sim/aftershock")
def sim_aftershock():
    return {"result": aftershock(), "grid_state": grid_state()}


@app.post("/grid/edit")
def grid_edit(request: CellEditRequest):
    if not (0 <= request.x < GRID_SIZE_X and 0 <= request.y < GRID_SIZE_Y):
        raise HTTPException(status_code=400, detail="cell outside grid")
    return {"result": edit_cell(request.x, request.y, request.tool), "grid_state": grid_state()}


@app.post("/commander/plan")
async def commander_plan():
    """Run the LlamaIndex strategic commander (coordinate -> route -> dispatch)
    without its tactical loop, so the autopilot animates the handoff."""
    workflow = HiveOrchestrator(timeout=60)
    result = await workflow.run(max_tactical_ticks=0)
    return {
        "result": {
            "assignments": len(result.get("assignments", [])),
            "dispatches": [d.get("dispatch_result") for d in result.get("dispatches", [])],
            "errors": result.get("dispatch_errors", []) + result.get("route_errors", []),
        },
        "grid_state": grid_state(),
    }


@app.post("/orchestrate")
async def orchestrate():
    # Pause the inject loop so the orchestrator's tactical field-agent execution
    # isn't overwritten by re-injected Snowflake survivors; resume afterwards.
    redis_client.set(SIM_PAUSED_KEY, "1")
    try:
        workflow = HiveOrchestrator(timeout=180)
        result = await workflow.run()
    finally:
        redis_client.set(SIM_PAUSED_KEY, "0")
    log_mission_event("api_orchestrate_completed", {"result": result})

    return {
        "result": result,
        "grid_state": grid_state(),
    }


@app.post("/assign-agent-to-survivor")
def assign_agent(request: AssignAgentRequest):
    agent_id = request.agent_id.strip()
    survivor_id = request.survivor_id.strip()

    if not agent_id:
        raise HTTPException(status_code=400, detail="agent_id is required")
    if not survivor_id:
        raise HTTPException(status_code=400, detail="survivor_id is required")

    try:
        agent = assign_agent_to_survivor(agent_id, survivor_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    log_mission_event(
        "api_agent_assigned",
        {
            "agent_id": agent_id,
            "survivor_id": survivor_id,
            "agent": agent,
        },
    )

    return {
        "agent": agent,
        "grid_state": grid_state(),
    }


@app.post("/spawn-survivors")
def spawn_survivors(request: SpawnSurvivorsRequest):
    if request.count < 1:
        raise HTTPException(status_code=400, detail="count must be at least 1")

    result = spawn_random_survivors(request.count)
    log_mission_event("api_random_survivors_spawned", result)

    return {
        "result": result,
        "grid_state": grid_state(),
    }


@app.post("/spawn-agents")
def spawn_agents_endpoint(request: SpawnAgentsRequest):
    result = spawn_agents(request.agent_ids)
    log_mission_event("api_rescue_agents_spawned", {"count": len(result["spawned"])})

    return {
        "result": result,
        "grid_state": grid_state(),
    }


@app.post("/simulation/mode")
def simulation_mode(request: SimulationModeRequest):
    # Pauses/resumes the external live_inject_loop (which honours this Redis flag),
    # so field agents can own the survivor/grid keys without being overwritten.
    redis_client.set(SIM_PAUSED_KEY, "1" if request.paused else "0")
    log_mission_event("api_simulation_mode", {"paused": request.paused})
    return {"paused": request.paused, "grid_state": grid_state()}


@app.post("/field-agents/tick")
def field_agents_tick():
    # One tactical observe-think-act-report cycle for every field agent.
    results = run_field_agents_tick()
    return {"results": results, "grid_state": grid_state()}


@app.post("/field-agents/run")
def field_agents_run(request: FieldAgentsRunRequest):
    if request.max_ticks < 1:
        raise HTTPException(status_code=400, detail="max_ticks must be at least 1")

    # Kick off the rescue in a background thread and return immediately. The loop
    # pauses the inject loop (so rescues aren't overwritten), runs the field agents
    # to completion (or max_ticks), then resumes the loop. The dashboard polls
    # /grid-state every 2s, so the rescue animates live without the button hanging.
    with _field_run_lock:
        if _field_run["running"]:
            return {
                "result": {"status": "already_running", "ticks_run": _field_run["ticks"]},
                "grid_state": grid_state(),
            }
        _field_run.update(running=True, ticks=0, complete=False, started_at=time.time())
        threading.Thread(
            target=_field_agents_run_worker, args=(request.max_ticks,), daemon=True
        ).start()

    log_mission_event("api_field_agents_run_started", {"max_ticks": request.max_ticks})
    return {
        "result": {"status": "started", "max_ticks": request.max_ticks},
        "grid_state": grid_state(),
    }


@app.get("/field-agents/status")
def field_agents_status():
    return {
        "running": _field_run["running"],
        "ticks_run": _field_run["ticks"],
        "complete": _field_run["complete"],
        "active_survivors_remaining": _active_survivor_count(),
    }


@app.post("/assign-nearest-agent")
def assign_nearest_agent(request: AssignNearestAgentRequest):
    survivor_id = request.survivor_id.strip()

    if not survivor_id:
        raise HTTPException(status_code=400, detail="survivor_id is required")

    result = assign_best_agent(survivor_id)
    log_mission_event("api_nearest_agent_assignment_completed", result)

    return {
        "result": result,
        "grid_state": grid_state(),
    }


@app.post("/tick-all-agents")
def tick_all_agents():
    tick = run_autonomous_tick()
    log_mission_event("api_autonomous_simulation_tick_completed", tick)

    return {
        "tick": tick,
        "grid_state": grid_state(),
    }


@app.post("/autonomous-hive/tick")
def autonomous_hive_tick():
    tick = run_autonomous_tick()

    return {
        "tick": tick,
        "grid_state": grid_state(),
    }


@app.post("/autonomous-hive/run")
def autonomous_hive_run(request: AutonomousHiveRunRequest):
    if request.max_ticks < 1:
        raise HTTPException(status_code=400, detail="max_ticks must be at least 1")
    if request.tick_sleep_seconds < 0:
        raise HTTPException(status_code=400, detail="tick_sleep_seconds cannot be negative")

    result = run_autonomous_hive_until_complete(
        max_ticks=request.max_ticks,
        tick_sleep_seconds=request.tick_sleep_seconds,
    )

    return {
        "result": result,
        "grid_state": grid_state(),
    }


@app.get("/autonomous-hive/status")
def autonomous_hive_status():
    return {
        "status": get_hive_status(),
        "grid_state": grid_state(),
    }


@app.post("/mission-status")
def mission_status():
    current_grid_state = grid_state()
    status = {
        "agents": len(current_grid_state["agents"]),
        "survivors": len(current_grid_state["survivors"]),
        "cells": len(current_grid_state["cells"]),
        "mission_logs": len(current_grid_state["mission_logs"]),
        "hive_status": current_grid_state["hive_status"],
    }
    log_mission_event("api_mission_status_requested", status)

    return {
        "status": status,
        "grid_state": grid_state(),
    }


@app.post("/run-hive-dispatch")
async def run_hive_dispatch(request: HiveDispatchRequest):
    survivor_id = request.survivor_id.strip()
    if not survivor_id:
        raise HTTPException(status_code=400, detail="survivor_id is required")

    redis_client.set(SIM_PAUSED_KEY, "1")
    try:
        workflow = HiveOrchestrator(timeout=180)
        result = await workflow.run()
    finally:
        redis_client.set(SIM_PAUSED_KEY, "0")

    return {
        "survivor_id": survivor_id,
        "result": result,
        "grid_state": grid_state(),
    }


# A fresh in-memory store starts empty, so generate a scenario to land on.
# Against a real Redis, keep whatever the pipeline injected and just make sure
# the default rescue agents exist.
try:
    if REDIS_BACKEND == "in-memory":
        reset_scenario(seed=int(os.getenv("KENTO_SEED", "1337")))
    else:
        ensure_default_agents()
except Exception as exc:  # don't block API startup if Redis is briefly unavailable
    print(f"[api_server] startup seeding skipped: {exc}")

warm_up_llm()