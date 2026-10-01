import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";

const run = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function runLiveWatch(root: string, body: string): Promise<string> {
  const tools = resolve(process.cwd(), "tools");
  const script = `import importlib.util, json, os, sqlite3, sys
sys.path.insert(0, ${JSON.stringify(tools)})
spec = importlib.util.spec_from_file_location("collector_live_watch", ${JSON.stringify(resolve(process.cwd(), "tools/collector-live-watch.py"))})
live = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = live
spec.loader.exec_module(live)
root = ${JSON.stringify(root)}
db = sqlite3.connect(os.path.join(root, "tail.sqlite"))
db.executescript("CREATE TABLE matches(game_key); CREATE TABLE tail_records(game_key); CREATE TABLE staging_records(game_key);")
db.commit()
db.close()
class Result:
    returncode = 0
    stdout = "ok"
    stderr = ""
calls = []
def fake_run(args, **kwargs):
    calls.append(args)
    return Result()
live.resolve_npm = lambda: "/fake/npm"
live.subprocess.run = fake_run
watch = live.LiveWatch("/tmp", root, 1, 5, 60, 45, 240, os.path.join(root, "logs", "live-watch.log"), True)
${body}
`;
  return (await run("python3", ["-c", script])).stdout.trim().split("\n").at(-1)!;
}

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "collector-live-watch-"));
  roots.push(root);
  return root;
}

test("an intentional collect:stop is never undone by the live watch", async () => {
  const root = await tempRoot();
  await writeFile(join(root, ".collector-stopped"), "{}\n");
  const output = await runLiveWatch(root, `
now = live.now_ms()
watch.api = lambda: {"mode": "stopped", "updatedAtMs": now - 600_000, "receivedRecords": 10, "games": []}
watch.last_records_at -= 600
watch.cycle()
watch.api = lambda: None
watch.cycle()
print(json.dumps(calls))
`);
  expect(JSON.parse(output)).toEqual([]);
});

test("a hung but loaded collector is restarted in place, not re-started as a no-op", async () => {
  const root = await tempRoot();
  const output = await runLiveWatch(root, `
now = live.now_ms()
watch.api = lambda: {"mode": "collecting", "updatedAtMs": now, "receivedRecords": 10, "games": []}
watch.cycle()
watch.last_records_at -= 600
watch.cycle()
print(json.dumps(calls))
`);
  expect(JSON.parse(output)).toEqual([["/fake/npm", "run", "collect:restart"]]);
});

test("a restart hands npm a PATH that can resolve node", async () => {
  const root = await tempRoot();
  const output = await runLiveWatch(root, `
now = live.now_ms()
seen = []
class Result:
    returncode = 0
    stdout = "ok"
    stderr = ""
def capture(args, **kwargs):
    seen.append({"args": args, "env": kwargs.get("env")})
    return Result()
live.subprocess.run = capture
watch.api = lambda: {"mode": "collecting", "updatedAtMs": now, "receivedRecords": 10, "games": []}
watch.cycle()
watch.last_records_at -= 600
watch.cycle()
print(json.dumps(seen))
`);
  const seen = JSON.parse(output) as Array<{ args: string[]; env?: Record<string, string> }>;
  expect(seen).toHaveLength(1);
  expect(seen[0]?.env?.PATH?.split(":")[0]).toBe("/fake");
});

test("a restart that exits non-zero is alerted instead of a silent action", async () => {
  const root = await tempRoot();
  const output = await runLiveWatch(root, `
os.makedirs(os.path.join(root, "logs"), exist_ok=True)
now = live.now_ms()
class Result:
    returncode = 127
    stdout = ""
    stderr = "env: node: No such file or directory"
live.subprocess.run = lambda args, **kwargs: Result()
watch.api = lambda: {"mode": "collecting", "updatedAtMs": now, "receivedRecords": 10, "games": []}
watch.cycle()
watch.last_records_at -= 600
watch.cycle()
print(json.dumps([json.loads(line) for line in open(watch.log_path)]))
`);
  const lines = JSON.parse(output) as Array<{ level: string; event: string; code?: number }>;
  const failure = lines.find(line => line.event === "restart_collector_failed");
  expect(failure).toBeTruthy();
  expect(failure?.level).toBe("alert");
  expect(failure?.code).toBe(127);
});
