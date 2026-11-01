import json
import os
import time
from collections.abc import Mapping
from pathlib import Path
from typing import Any
from dotenv import load_dotenv

import redis

PROJECT_ROOT = Path(__file__).resolve().parents[1]
load_dotenv(PROJECT_ROOT / ".env")

REDIS_HOST = os.getenv("REDIS_CLOUD_HOST", "localhost")
REDIS_PORT = int(os.getenv("REDIS_CLOUD_PORT", 6379))
REDIS_PASSWORD = os.getenv("REDIS_CLOUD_PASSWORD", "")

# KENTO_REDIS=auto (default): use the configured Redis if it answers a PING,
# otherwise fall back to an in-process fakeredis so the hive runs with zero infra.
# KENTO_REDIS=memory forces the in-process store; KENTO_REDIS=remote forbids it.
REDIS_MODE = os.getenv("KENTO_REDIS", "auto").lower()

GRID_SIZE_X = 10
GRID_SIZE_Y = 10

MISSION_LOG_MAX = 300


def _connect() -> tuple[redis.Redis, str]:
    if REDIS_MODE != "memory":
        client = redis.Redis(
            host=REDIS_HOST,
            port=REDIS_PORT,
            password=REDIS_PASSWORD,
            decode_responses=True,
            socket_connect_timeout=2,
        )
        try:
            client.ping()
            return client, f"redis://{REDIS_HOST}:{REDIS_PORT}"
        except redis.RedisError as exc:
            if REDIS_MODE == "remote":
                raise
            print(f"[redis_iris] {REDIS_HOST}:{REDIS_PORT} unreachable ({exc}); using in-memory Redis")

    import fakeredis

    return fakeredis.FakeRedis(decode_responses=True), "in-memory"


redis_client, REDIS_BACKEND = _connect()


def log_mission_event(event: str, data: Mapping[str, Any]) -> None:
    """Append to the mission log, pruning the oldest entries past MISSION_LOG_MAX."""
    timestamp_ns = time.time_ns()
    key = f"mission:log:{timestamp_ns}"
    redis_client.hset(
        key,
        mapping={"event": event, "timestamp_ns": timestamp_ns, "data": json.dumps(data, default=str)},
    )
    redis_client.zadd("mission:log:index", {key: timestamp_ns})
    overflow = redis_client.zcard("mission:log:index") - MISSION_LOG_MAX
    if overflow > 0:
        stale = redis_client.zrange("mission:log:index", 0, overflow - 1)
        redis_client.delete(*stale)
        redis_client.zrem("mission:log:index", *stale)


def get_recent_mission_logs(limit: int = 60) -> list[dict[str, Any]]:
    keys = redis_client.zrange("mission:log:index", -limit, -1)
    if not keys:
        return []
    pipe = redis_client.pipeline()
    for key in keys:
        pipe.hgetall(key)
    logs = []
    for key, raw in zip(keys, pipe.execute()):
        if not raw:
            continue
        try:
            data = json.loads(raw.get("data", "null"))
        except json.JSONDecodeError:
            data = raw.get("data")
        logs.append({
            "key": key,
            "event": raw.get("event", "unknown"),
            "timestamp_ns": int(raw.get("timestamp_ns", 0)),
            "data": data,
        })
    return logs


def _survivor_key(survivor_id: str) -> str:
    return f"live:survivor:{survivor_id}"


def _agent_key(agent_id: str) -> str:
    return f"agent:{agent_id}"


def _grid_node_key(x: int, y: int) -> str:
    return f"grid:node:{x}:{y}"


def get_survivor(survivor_id: str) -> dict[str, str]:
    return redis_client.hgetall(_survivor_key(survivor_id))


def set_survivor(survivor_id: str, data: Mapping[str, Any]) -> None:
    if data:
        redis_client.hset(_survivor_key(survivor_id), mapping=data)


def _encode_agent_data(data: Mapping[str, Any]) -> dict[str, Any]:
    encoded = dict(data)

    if "path" in encoded and not isinstance(encoded["path"], str):
        encoded["path"] = json.dumps(encoded["path"])

    for key, value in encoded.items():
        if value is None:
            encoded[key] = ""

    return encoded


def _decode_agent_data(data: dict[str, str]) -> dict[str, Any]:
    if not data:
        return {}

    decoded: dict[str, Any] = dict(data)

    for key in ("x", "y", "cell"):
        if decoded.get(key) not in (None, ""):
            decoded[key] = int(decoded[key])

    if decoded.get("target_cell") in (None, ""):
        decoded["target_cell"] = None
    else:
        decoded["target_cell"] = int(decoded["target_cell"])

    path = decoded.get("path")
    if isinstance(path, str):
        decoded["path"] = json.loads(path) if path else []

    return decoded


def get_agent(agent_id: str) -> dict[str, Any]:
    return _decode_agent_data(redis_client.hgetall(_agent_key(agent_id)))


def set_agent(agent_id: str, data: Mapping[str, Any]) -> None:
    if data:
        redis_client.hset(_agent_key(agent_id), mapping=_encode_agent_data({"id": agent_id, **data}))


def get_all_agents() -> list[dict[str, Any]]:
    agents = []

    for key in redis_client.scan_iter(match="agent:*"):
        agent_id = key.replace("agent:", "", 1)
        agent = get_agent(agent_id)
        if agent:
            agents.append(agent)

    return sorted(agents, key=lambda agent: agent.get("id", ""))


def get_grid_node(x: int, y: int) -> dict[str, str]:
    return redis_client.hgetall(_grid_node_key(x, y))


def set_grid_node(x: int, y: int, data: Mapping[str, Any]) -> None:
    if data:
        redis_client.hset(_grid_node_key(x, y), mapping=data)


def render_grid() -> list[list[str]]:
    matrix = [["." for _ in range(GRID_SIZE_X)] for _ in range(GRID_SIZE_Y)]

    for y in range(GRID_SIZE_Y):
        for x in range(GRID_SIZE_X):
            node = get_grid_node(x, y)
            if node:
                node_type = node.get("type")
                if node_type == "rubble":
                    matrix[y][x] = "█"
                elif node_type == "survivor_visible":
                    matrix[y][x] = "V"
                elif node_type == "survivor_trapped":
                    matrix[y][x] = "T"

    return matrix


def clear_simulation() -> int:
    keys_to_delete = []
    for pattern in (
        "grid:node:*", "live:survivor:*", "agent:*", "mission:log:*", "hive:*",
        "backup:request:*", "sim:*",
    ):
        keys_to_delete.extend(redis_client.scan_iter(match=pattern))

    if not keys_to_delete:
        return 0

    return redis_client.delete(*keys_to_delete)
