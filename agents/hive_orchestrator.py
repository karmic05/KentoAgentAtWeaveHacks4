from typing import Any

from llama_index.core.workflow import Event, StartEvent, StopEvent, Workflow, step

from agents.coordinator import orchestrate_rescue_operations
from agents.field_agent import INACTIVE_STATUSES, _live_survivors, run_field_agents_tick
from agents.rescue_agent import dispatch_rescue
from agents.route_agent import plan_route
from memory.redis_iris import log_mission_event

# Tactical tick budget the strategic commander oversees per run.
MAX_TACTICAL_TICKS = 80


class CoordinatorEvent(Event):
    summary: dict[str, Any]


class RoutePlanEvent(Event):
    summary: dict[str, Any]


class RescueDispatchEvent(Event):
    summary: dict[str, Any]




def _survivors_by_id(summary: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {survivor["id"]: survivor for survivor in summary.get("active_survivors", [])}


class HiveOrchestrator(Workflow):

    @step
    async def coordinate(self, ev: StartEvent) -> CoordinatorEvent:
        # max_tactical_ticks=0 makes the commander plan and assign only, leaving
        # execution to the dashboard autopilot so the rescue animates live.
        summary = {
            **orchestrate_rescue_operations(),
            "max_tactical_ticks": ev.get("max_tactical_ticks", MAX_TACTICAL_TICKS),
        }
        log_mission_event("coordination_completed", summary)

        return CoordinatorEvent(summary=summary)

    @step
    async def route_planning(self, ev: CoordinatorEvent) -> RoutePlanEvent:
        survivors_by_id = _survivors_by_id(ev.summary)
        route_plans = []
        route_errors = []

        for assignment in ev.summary.get("assignments", []):
            survivor = survivors_by_id.get(assignment["survivor_id"])
            if survivor is None:
                route_errors.append(
                    {
                        "survivor_id": assignment["survivor_id"],
                        "reason": "assigned survivor missing from active survivor list",
                    }
                )
                continue

            try:
                route = await plan_route(survivor["status"])
            except ValueError as exc:
                route_errors.append(
                    {
                        "survivor_id": survivor["id"],
                        "agent_id": assignment["agent_id"],
                        "reason": str(exc),
                    }
                )
                continue

            route_plans.append(
                {
                    **assignment,
                    "survivor": survivor,
                    "resource_type": route["resource_type"],
                    "priority": route["priority"],
                }
            )

        summary = {
            **ev.summary,
            "route_plans": route_plans,
            "route_errors": route_errors,
        }
        log_mission_event("route_planning_completed", summary)

        return RoutePlanEvent(summary=summary)

    @step
    async def dispatch_resource(self, ev: RoutePlanEvent) -> RescueDispatchEvent:
        dispatches = []
        dispatch_errors = []

        for route_plan in ev.summary.get("route_plans", []):
            survivor = route_plan["survivor"]

            try:
                dispatch_result = await dispatch_rescue(
                    survivor_id=survivor["id"],
                    x=survivor["x"],
                    y=survivor["y"],
                    status=survivor["status"],
                    resource_type=route_plan["resource_type"],
                )
            except ValueError as exc:
                dispatch_errors.append(
                    {
                        "survivor_id": survivor["id"],
                        "agent_id": route_plan["agent_id"],
                        "reason": str(exc),
                    }
                )
                continue

            dispatches.append(
                {
                    **route_plan,
                    "dispatch_result": dispatch_result,
                }
            )

        summary = {
            **ev.summary,
            "dispatches": dispatches,
            "dispatch_errors": dispatch_errors,
        }
        log_mission_event("rescue_dispatch_completed", summary)

        return RescueDispatchEvent(summary=summary)

    @step
    async def start_movement(self, ev: RescueDispatchEvent) -> StopEvent:
        # TACTICAL EXECUTION: the strategic commander (coordinate -> route ->
        # dispatch) hands off to the agentic field agents. They observe -> think
        # -> act -> report: rerouting around rubble, rescuing, and calling for
        # backup until every survivor is rescued (or the tactical budget is spent).
        def active() -> int:
            return sum(1 for s in _live_survivors().values() if s.get("status") not in INACTIVE_STATUSES)

        ticks = 0
        for _ in range(ev.summary["max_tactical_ticks"]):
            if active() == 0:
                break
            run_field_agents_tick()
            ticks += 1

        summary = {
            **ev.summary,
            "tactical_ticks": ticks,
            "active_survivors_remaining": active(),
            "complete": active() == 0,
        }
        log_mission_event("movement_tick_completed", summary)

        return StopEvent(result=summary)
