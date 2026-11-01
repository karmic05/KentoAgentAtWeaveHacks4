"""Two eval suites for the hive.

1. Dispatch guardrails: each survivor goes through triage -> route planning ->
   guarded dispatch, and the chosen resource must match the safety table.
   Unknown survivors must escalate instead of dispatching.
2. Field-agent benchmark: run seeded scenarios with aftershocks to completion and
   report survival rate, ticks, and distance. Fails on any deadlock (a scenario
   that doesn't resolve within the tick budget).

    python evals/run_evals.py
"""

import asyncio
import os
import sys
from dataclasses import dataclass
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

os.environ.setdefault("KENTO_REDIS", "memory")  # never touch a shared Redis
os.environ.setdefault("FIELD_AGENT_USE_LLM", "0")  # benchmark the deterministic planner

import weave

from agents.rescue_agent import dispatch_rescue
from agents.route_agent import plan_route
from agents.simulation import get_metrics, reset_scenario, sim_tick
from agents.triage_agent import triage_survivor
from memory.redis_iris import clear_simulation
from memory.seed_disaster_grid import initialize_mock_disaster_grid

if os.getenv("DISABLE_WEAVE", "").lower() not in ("1", "true", "yes"):
    weave.init("kento-agent-hive")

BENCHMARK_SEEDS = (1337, 7, 42, 99, 2024, 5, 314, 808)
TICK_BUDGET = 150


@dataclass(frozen=True)
class EvalCase:
    survivor_id: str
    expected_fragment: str


EVAL_CASES = [
    EvalCase("Survivor-T1", "Heavy Excavator Drone"),
    EvalCase("Survivor-T2", "Heavy Excavator Drone"),
    EvalCase("Survivor-V1", "Medical Aerial Drone"),
    EvalCase("Survivor-V2", "Medical Aerial Drone"),
    EvalCase("Survivor-UNKNOWN", "Escalating Survivor-UNKNOWN"),
]


async def run_case(case: EvalCase) -> bool:
    try:
        triage = await triage_survivor(case.survivor_id)
        route = await plan_route(triage["status"])
        result = await dispatch_rescue(
            survivor_id=triage["survivor_id"],
            x=triage["x"],
            y=triage["y"],
            status=triage["status"],
            resource_type=route["resource_type"],
        )
    except ValueError as exc:
        result = f"Escalating {case.survivor_id}: {exc}"

    passed = case.expected_fragment in result
    print(f"  [{'PASS' if passed else 'FAIL'}] {case.survivor_id}: {result}")
    return passed


def run_benchmark() -> bool:
    ok = True
    print(f"\n{'seed':>6} {'rescued':>9} {'lost':>5} {'ticks':>6} {'distance':>9} {'reroutes':>9} {'shocks':>7}")
    totals = {"rescued": 0, "total": 0}
    for seed in BENCHMARK_SEEDS:
        reset_scenario(seed=seed)
        for _ in range(TICK_BUDGET):
            if sim_tick(aftershocks=True)["active"] == 0:
                break
        m = get_metrics()
        resolved = m["active"] == 0
        ok &= resolved
        totals["rescued"] += m["rescued"]
        totals["total"] += m["total"]
        print(
            f"{seed:>6} {m['rescued']:>4}/{m['total']:<4} {m['lost']:>5} {m['tick']:>6} "
            f"{m['distance']:>9} {m['reroutes']:>9} {m['aftershocks']:>7}"
            + ("" if resolved else "   DEADLOCK")
        )
    rate = totals["rescued"] / totals["total"] if totals["total"] else 0
    print(f"\nOverall survival rate: {rate:.0%} ({totals['rescued']}/{totals['total']})")
    return ok


async def main() -> int:
    print("Dispatch guardrails")
    clear_simulation()
    initialize_mock_disaster_grid()
    results = [await run_case(case) for case in EVAL_CASES]
    print(f"  {sum(results)}/{len(results)} passed")

    print("\nField-agent benchmark")
    benchmark_ok = run_benchmark()
    return 0 if all(results) and benchmark_ok else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
