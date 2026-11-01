# Kento — Autonomous Disaster-Response Hive

**Live demo: [kentoagent.vercel.app](https://kentoagent.vercel.app)**. The hosted demo runs
the hive entirely in your browser. Clone the repo to run the full stack with Redis, the
LlamaIndex commander, a local LLM via Ollama, and Weave tracing.

A multi-agent search-and-rescue simulation built at **WeaveHacks 4**. After a city block
collapses, a team of rescue agents has to find survivors, route around rubble, and
coordinate two-agent extractions before survivors' vitals run out.

The project combines a real data pipeline with an agent hierarchy:

```
Snowflake (Snowpark generators) ──► dbt (staging → marts) ──► Redis Cloud
                                                                  │  sync
                                                                  ▼
                       Redis hot memory  (grid:node · live:survivor · agent · mission:log)
                                 ▲                         ▲
            LlamaIndex Workflow  │                         │  observe → think → act → report
   coordinate → route → dispatch ┘                         └─ Field agents (LLM-guided + rule fallback)
                 │                                                  │
                 └──────── W&B Weave guardrails & traces ───────────┘
                                         │
                     Next.js command center  +  Rescue Command chat
```

## How the hive works

**Strategic commander** (`agents/hive_orchestrator.py`): a LlamaIndex `Workflow` that
assigns the nearest idle agents, picks a resource type per survivor (heavy excavator for
trapped, medical drone for visible), and validates every dispatch through Weave guardrails
before handing off.

**Tactical field agents** (`agents/field_agent.py`): each agent runs its own
observe → think → act → report loop against live Redis state.

- **Triage by urgency.** Survivors lose health every tick. Target cost is
  `distance + 1.2 × health/10`, so a survivor running out of air outranks a closer, stable one.
- **Obstacle-aware routing.** BFS around rubble, with automatic re-planning when an
  aftershock drops debris on a planned route.
- **Two-agent rescues.** A trapped survivor needs a second agent. The first one to arrive
  posts a `backup:request` to Redis, and idle agents answer backup calls before taking new work.
- **Deadlock-free movement.** Agents meeting head-on try a detour first. Otherwise the
  higher-id agent steps aside.
- **Hybrid brain, no API key.** With `FIELD_AGENT_USE_LLM=1`, a local model on
  [Ollama](https://ollama.com) (default `llama3.2:3b`) acts as an *asynchronous advisor*.
  When an agent picks a target, the LLM reviews the choice in the background and returns a
  schema-constrained `{action, survivor_id}`. It never emits coordinates; deterministic BFS
  turns intent into moves. Valid advice redirects the agent on a later tick. Advice that
  would double-assign a survivor is overruled, and the overrule shows in the agent's
  reasoning. Invalid output, timeouts or an offline model fall back to rules, and a circuit
  breaker keeps a dead endpoint from slowing the simulation. Groq and OpenAI work through
  the same OpenAI-compatible client.
- **Coordination deadlock breaker.** If every agent is pinned beside a trapped survivor
  waiting for backup, the highest-id agent leaves its post to help a teammate dig.

**World simulation** (`agents/simulation.py`):

- Procedural city generation (roads, buildings, collapsed rubble that never disconnects
  the street network).
- Survivor vitals that decay each tick.
- Aftershocks that target cells on agents' routes.
- An autopilot loop.
- A TypeScript port (`app/lib/engine.ts`) that runs the same agents in the browser. The
  dashboard uses it automatically when no API is configured, which is how the Vercel demo works.
- A one-click sync of the real Snowflake → dbt snapshot from Redis Cloud.

## Run it locally

Requirements: Python 3.11+ and Node 20+.

```bash
pip install -r requirements.txt
npm install

npm run api     # hive API on http://localhost:8010  (docs at /docs)
npm run dev     # dashboard on http://localhost:3000
```

On Windows, `scripts/dev.ps1` starts both. For the LLM features, install
[Ollama](https://ollama.com) and run `ollama pull llama3.2:3b`.

No infrastructure is needed. If Redis isn't reachable, the API falls back to an in-process
Redis (`fakeredis`) and generates a scenario on startup.

### Optional configuration (`.env`)

| Variable | Effect |
| --- | --- |
| `REDIS_CLOUD_HOST` / `_PORT` / `_PASSWORD` | Hot-memory Redis. `KENTO_REDIS=memory` forces the in-process store. |
| `KENTO_SOURCE_REDIS_HOST` / `_PORT` / `_USERNAME` / `_PASSWORD` | Redis Cloud fed by the Snowflake → dbt pipeline. Enables **Sync from Redis Cloud**. |
| `FIELD_AGENT_USE_LLM=1` | LLM advisor for field agents. `FIELD_AGENT_LLM_PROVIDER` = `ollama` (default, keyless), `groq` (`GROQ_API_KEY`) or `openai` (`OPENAI_API_KEY`). `FIELD_AGENT_LLM_MODEL` overrides the model. |
| `WANDB_API_KEY` | Turns on Weave tracing for the `kento-agent-hive` project. |
| `GROQ_API_KEY` | Optional. Makes the Rescue Command chat use Groq instead of the keyless Pollinations endpoint (faster). `CHAT_LLM_BASE_URL` / `CHAT_LLM_MODEL` point it at any OpenAI-compatible endpoint, such as a local Ollama. |
| `NEXT_PUBLIC_KENTO_API` | Hive API for the dashboard, e.g. `http://127.0.0.1:8010`. Unset or unreachable means the in-browser engine is used. |

## Rescue Command chat

The chat bar gives orders in plain English, such as "assign B to S-03 and start", "new
scenario with 9 survivors", "what is agent A doing?" or "drop a survivor at (4, 6)".

Common commands are understood instantly in the browser. Anything else goes to an LLM
through a serverless route (`app/api/chat/route.ts`) that needs no API key: it uses the free
[Pollinations](https://pollinations.ai) endpoint, or Groq if `GROQ_API_KEY` is set. The
model answers with tool calls (`assign_agent`, `trigger_aftershock`, `new_scenario` and so
on), which the dashboard executes on the map.

## Dashboard

- **Autopilot** (`space`), **Step** (`s`), and 0.5× / 1× / 2× speed.
- **Aftershocks.** Random or on demand, with cells collapsing onto live routes.
- **Run commander.** Executes the LlamaIndex workflow, then the autopilot animates the handoff.
- **New disaster** (optional seed for reproducible runs) and **Sync from Redis Cloud**.
- **Edit map.** Toggle rubble or drop visible or trapped survivors to test the agents.
- **Live panels.** Mission metrics, each agent's current reasoning, a triage queue sorted
  by health, and a mission log.

## Data pipeline

`data_pipeline/` holds the dbt project. Snowpark Python models generate the raw city
(grid, buildings, roads, rubble, survivors), and SQL staging and mart models
(`mart_city_grid_nodes`, `mart_survivor_targets`, `mart_route_priorities`) shape it. A
scheduled job (`data_pipeline/ci/redis_sync.py`, `live_inject_loop.py`) hydrates Redis Cloud
from the marts.

## Evals

`python evals/run_evals.py` runs two suites:

1. **Dispatch guardrails.** Each survivor goes through triage → route planning → guarded
   dispatch, and the chosen resource must match the safety table in `evals/weave_scorers.py`.
   Unknown survivors must escalate. Current result: 5/5.
2. **Field-agent benchmark.** Eight seeded scenarios run to completion with random
   aftershocks, using the deterministic planner. Any scenario that fails to resolve is
   flagged as a deadlock. A typical run: all 8 resolved, about 95% survival.

When you're logged in to W&B, the API and evals trace every agent decision to the
`kento-agent-hive` Weave project.
