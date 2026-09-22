import { execFile } from "node:child_process";
import { resolve } from "node:path";
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
