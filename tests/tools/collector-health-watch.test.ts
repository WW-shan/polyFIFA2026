import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const run = promisify(execFile);

async function runPython(body: string): Promise<string> {
  const tools = resolve(process.cwd(), "tools");
  const script = `import importlib.util, json, sys, time\nsys.path.insert(0, ${JSON.stringify(tools)})\nspec = importlib.util.spec_from_file_location("collector_health_watch", ${JSON.stringify(resolve(process.cwd(), "tools/collector-health-watch.py"))})\nhealth = importlib.util.module_from_spec(spec)\nsys.modules[spec.name] = health\nspec.loader.exec_module(health)\n${body}\n`;
  return (await run("python3", ["-c", script])).stdout.trim();
}

test("status fallback uses a matching fresh heartbeat over an older full snapshot", async () => {
  const output = await runPython(`
state = {"instanceId": "i", "pid": 1, "updatedAtMs": 1000, "lastRecordAtMs": 900}
heartbeat = {"instanceId": "i", "pid": 1, "updatedAtMs": 2000, "lastRecordAtMs": 1900}
print(json.dumps(health.merge_heartbeat_status(state, heartbeat), sort_keys=True))
print(json.dumps(health.merge_heartbeat_status(state, {"instanceId": "other", "pid": 1, "updatedAtMs": 2000}), sort_keys=True))
`);
  expect(output.split("\n")).toEqual([
    '{"instanceId": "i", "lastRecordAtMs": 1900, "pid": 1, "updatedAtMs": 2000}',
    '{"instanceId": "i", "lastRecordAtMs": 900, "pid": 1, "updatedAtMs": 1000}'
  ]);
});

test("health checks expose stale data and new collector errors", async () => {
  const output = await runPython(`
class Log:
    def __init__(self): self.records = []
    def write(self, level, event, **fields):
        record = {"level": level, "event": event, **fields}
        self.records.append(record)
        return record
log = Log()
watch = health.HealthWatch("/tmp/collector-health-test", 8765, log, 300, 600, 1800, project="/tmp", auto_restart=False)
watch.started = True
now = health.now_ms()
status = {
    "mode": "collecting", "updatedAtMs": now - 1000, "lastRecordAtMs": now - 70000,
    "stateStaleAfterMs": 15000, "desiredTokens": 10, "freeBytes": 30 * 1024 ** 3,
    "games": [], "errors": [{"scope": "discovery:profile", "atMs": now - 1000, "message": "tennis: fetch failed"}],
    "compactStorage": {"lastMaintenanceDeletedMatches": 0},
}
metrics = {"stagingRecords": 100, "matches": 0, "matchKeys": set(), "recordsPerMatch": {}}
watch.check_health(status, metrics, None)
print(json.dumps([record["event"] for record in log.records]))
print(json.dumps([record for record in log.records if record["event"] == "collector_error"]))
`);
  const [events, errors] = output.split("\n");
  expect(JSON.parse(events!)).toEqual(expect.arrayContaining(["collector_error", "data_stale"]));
  expect(JSON.parse(errors!)).toEqual([expect.objectContaining({ scope: "discovery:profile", message: "tennis: fetch failed" })]);
});

test("watchdog remediation invokes the real restart command", async () => {
  const output = await runPython(`
class Log:
    def write(self, *args, **kwargs): return None
class Result:
    returncode = 0
    stdout = "ok"
    stderr = ""
calls = []
def fake_run(args, **kwargs):
    calls.append(args)
    return Result()
health.resolve_npm = lambda: "/fake/npm"
health.subprocess.run = fake_run
watch = health.HealthWatch("/tmp/collector-health-test", 8765, Log(), 300, 600, 1800, project="/tmp", auto_restart=True)
watch.restart_collector("test")
print(json.dumps(calls))
`);
  expect(JSON.parse(output)).toEqual([["/fake/npm", "run", "collect:restart"]]);
});

test("reported-error memory stays bounded to the alert window", async () => {
  const output = await runPython(`
class Log:
    def write(self, level, event, **fields): return {"level": level, "event": event, **fields}
watch = health.HealthWatch("/tmp/collector-health-test", 8765, Log(), 300, 600, 1800, project="/tmp", auto_restart=False)
now = health.now_ms()
watch.seen_status_errors.add(("old-scope", now - 3600_000, "old"))
status = {"mode": "collecting", "updatedAtMs": now - 1000, "lastRecordAtMs": now - 1000,
          "stateStaleAfterMs": 15000, "desiredTokens": 10, "freeBytes": 30 * 1024 ** 3,
          "games": [], "errors": [{"scope": "fresh-scope", "atMs": now - 1000, "message": "new"}],
          "compactStorage": {"lastMaintenanceDeletedMatches": 0}}
metrics = {"stagingRecords": 100, "matches": 0, "matchKeys": set(), "recordsPerMatch": {}}
watch.check_health(status, metrics, None)
print(json.dumps(sorted((scope, message) for scope, _at, message in watch.seen_status_errors)))
`);
  expect(JSON.parse(output)).toEqual([["fresh-scope", "new"]]);
});

test("expected shutdown diagnostics are not reported as collector errors", async () => {
  const output = await runPython(`
class Log:
    def __init__(self): self.records = []
    def write(self, level, event, **fields):
        record = {"level": level, "event": event, **fields}
        self.records.append(record)
        return record
log = Log()
watch = health.HealthWatch("/tmp/collector-health-test", 8765, log, 300, 600, 1800, project="/tmp", auto_restart=False)
watch.started = True
now = health.now_ms()
status = {"mode": "collecting", "updatedAtMs": now - 1000, "lastRecordAtMs": now - 1000,
          "stateStaleAfterMs": 15000, "desiredTokens": 10, "freeBytes": 30 * 1024 ** 3,
          "games": [], "errors": [
              {"scope": "discovery:related", "atMs": now - 1000, "message": "123: Collector stopped"},
              {"scope": "discovery:related", "atMs": now - 1000, "message": "456: fetch failed"}
          ], "compactStorage": {"lastMaintenanceDeletedMatches": 0}}
metrics = {"stagingRecords": 100, "matches": 0, "matchKeys": set(), "recordsPerMatch": {}}
watch.check_health(status, metrics, None)
print(json.dumps([record for record in log.records if record["event"] == "collector_error"]))
`);
  expect(JSON.parse(output)).toEqual([expect.objectContaining({ message: "456: fetch failed" })]);
});

test("runtime bookkeeping is pruned when keys leave the collector snapshot", async () => {
  const output = await runPython(`
watch = health.HealthWatch("/tmp/collector-health-test", 8765, None, 300, 600, 1800, project="/tmp", auto_restart=False)
watch.archives = {"keep-status": "complete", "keep-match": "complete", "old": "complete"}
watch.history = {"keep-status": health.deque([1]), "old": health.deque([2])}
watch.matches_seen = {"keep-match", "old"}
watch.prune_runtime_state({"games": [{"key": "keep-status"}]}, {"matchKeys": {"keep-match"}})
print(json.dumps({
    "archives": sorted(watch.archives),
    "history": sorted(watch.history),
    "matches": sorted(watch.matches_seen),
}, sort_keys=True))
`);
  expect(JSON.parse(output)).toEqual({
    archives: ["keep-match", "keep-status"],
    history: ["keep-status"],
    matches: ["keep-match"],
  });
});

test("first healthy cycle treats an old stopped snapshot as a baseline", async () => {
  const output = await runPython(`
class Log:
    def __init__(self): self.records = []
    def write(self, level, event, **fields):
        record = {"level": level, "event": event, **fields}
        self.records.append(record)
        return record
log = Log()
watch = health.HealthWatch("/tmp/collector-health-test", 8765, log, 300, 600, 1800, project="/tmp", auto_restart=False)
now = health.now_ms()
old = {"mode": "stopped", "updatedAtMs": now - 1000, "lastRecordAtMs": now - 1000,
       "stateStaleAfterMs": 15000, "desiredTokens": 10, "freeBytes": 30 * 1024 ** 3,
       "games": [], "errors": [{"scope": "old-run:books", "atMs": now - 1000, "message": "fetch failed"}],
       "compactStorage": {"lastMaintenanceDeletedMatches": 0}}
metrics = {"stagingRecords": 100, "matches": 0, "matchKeys": set(), "recordsPerMatch": {}}
watch.check_health(old, metrics, None)
print(json.dumps([record["event"] for record in log.records]))
print(len(watch.seen_status_errors))
`);
  const [events, seen] = output.split("\n");
  expect(JSON.parse(events!)).not.toEqual(expect.arrayContaining(["collector_error", "mode_not_collecting"]));
  expect(JSON.parse(seen!)).toBe(1);
});

const recordingLog = `
class Log:
    def __init__(self): self.records = []
    def write(self, level, event, **fields):
        record = {"level": level, "event": event, **fields}
        self.records.append(record)
        return record
clock = [10_000_000_000]
health.now_ms = lambda: clock[0]
def status(mode, state_age_s=1, data_age_s=1, instance="i", **extra):
    now = clock[0]
    return {"mode": mode, "instanceId": instance, "pid": 1, "updatedAtMs": now - state_age_s * 1000,
            "lastRecordAtMs": None if data_age_s is None else now - data_age_s * 1000,
            "stateStaleAfterMs": 15000, "desiredTokens": 10, "freeBytes": 30 * 1024 ** 3,
            "games": [], "errors": [], "compactStorage": {"lastMaintenanceDeletedMatches": 0}, **extra}
metrics = {"stagingRecords": 100, "matches": 0, "matchKeys": set(), "recordsPerMatch": {}}
restarts = []
`;

test("a disk pause is not restarted for missing records", async () => {
  const output = await runPython(`${recordingLog}
watch = health.HealthWatch("/tmp/collector-health-test", 8765, Log(), 300, 600, 1800, project="/tmp", auto_restart=True)
watch.restart_collector = restarts.append
watch.started = True
# paused_disk stops the streams on purpose: fresh state, no records for 10 minutes.
watch.check_health(status("paused_disk", data_age_s=600), metrics, None)
paused = list(restarts)
watch.check_health(status("collecting", data_age_s=600), metrics, None)
print(json.dumps([paused, len(restarts)]))
`);
  expect(JSON.parse(output)).toEqual([[], 1]);
});

test("a collector stuck in starting with a fresh state is restarted after 900 seconds in that mode", async () => {
  const output = await runPython(`${recordingLog}
log = Log()
watch = health.HealthWatch("/tmp/collector-health-test", 8765, log, 300, 600, 1800, project="/tmp", auto_restart=True)
watch.restart_collector = restarts.append
watch.started = True
events = []
for elapsed in (0, 60, 130, 901):
    clock[0] = 10_000_000_000 + elapsed * 1000
    watch.check_health(status("starting", data_age_s=None), metrics, None)
    events.append([len(restarts), sum(1 for record in log.records if record["event"] == "mode_not_collecting")])
# A new process instance starts its own clock instead of inheriting the old one.
clock[0] += 1000
watch.check_health(status("starting", data_age_s=None, instance="j"), metrics, None)
events.append([len(restarts)])
print(json.dumps(events))
`);
  expect(JSON.parse(output)).toEqual([[0, 0], [0, 0], [0, 1], [1, 2], [1]]);
});

test("persistent conditions alert once per episode and then at a bounded rate", async () => {
  const output = await runPython(`${recordingLog}
log = Log()
watch = health.HealthWatch("/tmp/collector-health-test", 8765, log, 300, 600, 1800, project="/tmp", auto_restart=False)
watch.started = True
low = status("paused_disk", freeBytes=10 * 1024 ** 3)
counts = []
def count():
    return {event: sum(1 for record in log.records if record["event"] == event) for event in ("low_disk", "mode_not_collecting")}
for step in range(5):
    clock[0] += 5000
    watch.check_health(status("paused_disk", freeBytes=10 * 1024 ** 3), metrics, None)
counts.append(count())
clock[0] += 301_000
watch.check_health(status("paused_disk", freeBytes=10 * 1024 ** 3), metrics, None)
counts.append(count())
# Clearing the condition re-arms it: the next episode is reported immediately.
clock[0] += 5000
watch.check_health(status("paused_disk"), metrics, None)
clock[0] += 5000
watch.check_health(status("paused_disk", freeBytes=10 * 1024 ** 3), metrics, None)
counts.append(count())
print(json.dumps(counts))
`);
  expect(JSON.parse(output)).toEqual([
    { low_disk: 1, mode_not_collecting: 1 },
    { low_disk: 2, mode_not_collecting: 2 },
    { low_disk: 3, mode_not_collecting: 2 },
  ]);
});

test("archives without new matches alert even when no match finalized since the watcher started", async () => {
  const output = await runPython(`${recordingLog}
log = Log()
watch = health.HealthWatch("/tmp/collector-health-test", 8765, log, 300, 600, 1800, project="/tmp", auto_restart=False)
watch.check_health(status("collecting"), metrics, None)
watch.started = True
clock[0] += 10_000
watch.last_archive_at_ms = clock[0]
clock[0] += 1_900_000
watch.check_health(status("collecting"), metrics, None)
print(json.dumps([record["event"] for record in log.records if record["event"] == "archives_without_new_matches"]))
`);
  expect(JSON.parse(output)).toEqual(["archives_without_new_matches"]);
});

test("an unwritable log never ends the watch loop or blocks a restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "collector-health-log-"));
  try {
    const output = await runPython(`
import os
class Result:
    returncode = 0
    stdout = "ok"
    stderr = ""
calls = []
def fake_run(args, **kwargs):
    calls.append(args)
    return Result()
health.resolve_npm = lambda: "/fake/npm"
health.subprocess.run = fake_run
# A directory at the log path makes every append fail with an OSError, the same
# way a full disk or a removed logs directory does.
log_path = os.path.join(${JSON.stringify(root)}, "logs", "health-watch.log")
log = health.LogFile(log_path)
os.makedirs(log_path)
watch = health.HealthWatch(${JSON.stringify(root)}, 8765, log, 300, 600, 1800, project="/tmp", auto_restart=True)
def unreadable():
    raise ValueError("status unreadable")
watch.api_status = unreadable
class StopLoop(Exception):
    pass
sleeps = []
def fake_sleep(seconds):
    sleeps.append(seconds)
    if len(sleeps) >= 4:
        raise StopLoop()
health.time.sleep = fake_sleep
try:
    watch.run(0)
except StopLoop:
    print(json.dumps({"cycles": len(sleeps), "calls": calls}))
`);
    expect(JSON.parse(output.split("\n").at(-1)!)).toEqual({ cycles: 4, calls: [["/fake/npm", "run", "collect:restart"]] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("routine DB sweeps stay cheap and never scan the payload table", async () => {
  const output = await runPython(`
class Log:
    def write(self, *args, **kwargs): return None
class FakeConnection:
    def __init__(self): self.sqls = []
    def execute(self, sql, params=None):
        self.sqls.append(sql)
        return self
    def fetchone(self): return (0,)
    def __iter__(self): return iter(())
watch = health.HealthWatch("/tmp/collector-health-test", 8765, Log(), 300, 600, 1800, project="/tmp", auto_restart=False)
connection = FakeConnection()
watch.db_metrics(connection, refresh_counts=False)
routine = list(connection.sqls)
connection.sqls.clear()
watch.db_metrics(connection, refresh_counts=True)
refresh = list(connection.sqls)
print(json.dumps({
    "routinePayloads": any("payloads" in sql for sql in routine),
    "routineTailCount": any("COUNT(*) FROM tail_records" in sql for sql in routine),
    "refreshTailCount": sum("COUNT(*) FROM tail_records" in sql for sql in refresh),
}))
`);
  expect(JSON.parse(output)).toEqual({ routinePayloads: false, routineTailCount: false, refreshTailCount: 1 });
});

test("per-match record counts use the indexed game key", async () => {
  const output = await runPython(`
class Log:
    def write(self, *args, **kwargs): return None
class Connection:
    def __init__(self): self.sqls = []
    def execute(self, sql, params=None):
        self.sqls.append((sql, params))
        return self
    def fetchone(self): return (7,)
    def close(self): pass
connection = Connection()
watch = health.HealthWatch("/tmp/collector-health-test", 8765, Log(), 300, 600, 1800, project="/tmp", auto_restart=False)
watch.db = lambda: connection
print(json.dumps({"count": watch.record_count("game:1"), "sql": connection.sqls[0][0], "params": connection.sqls[0][1]}))
`);
  expect(JSON.parse(output)).toMatchObject({ count: 7, params: ["game:1"] });
  expect(JSON.parse(output).sql).toContain("WHERE game_key");
});

test("watchdog remediation hands npm a PATH that can resolve node", async () => {
  const output = await runPython(`
class Log:
    def write(self, *args, **kwargs): return None
class Result:
    returncode = 0
    stdout = "ok"
    stderr = ""
seen = []
def fake_run(args, **kwargs):
    seen.append(kwargs.get("env") or {})
    return Result()
health.resolve_npm = lambda: "/fake/npm"
health.subprocess.run = fake_run
watch = health.HealthWatch("/tmp/collector-health-test", 8765, Log(), 300, 600, 1800, project="/tmp", auto_restart=True)
watch.restart_collector("test")
print(json.dumps(seen[0].get("PATH", "").split(":")[0]))
`);
  expect(JSON.parse(output)).toBe("/fake");
});

test("a restart that exits non-zero is alerted instead of a silent action", async () => {
  const output = await runPython(`
class Log:
    def __init__(self): self.records = []
    def write(self, level, event, **fields):
        record = {"level": level, "event": event, **fields}
        self.records.append(record)
        return record
class Result:
    returncode = 127
    stdout = ""
    stderr = "env: node: No such file or directory"
health.resolve_npm = lambda: "/fake/npm"
health.subprocess.run = lambda *args, **kwargs: Result()
log = Log()
watch = health.HealthWatch("/tmp/collector-health-test", 8765, log, 300, 600, 1800, project="/tmp", auto_restart=True)
watch.restart_collector("test")
print(json.dumps([record for record in log.records if record["event"].startswith("restart")]))
`);
  expect(JSON.parse(output)).toEqual([
    expect.objectContaining({ level: "action", event: "restart_collector" }),
    expect.objectContaining({ level: "alert", event: "restart_collector_failed", code: 127 })
  ]);
});
