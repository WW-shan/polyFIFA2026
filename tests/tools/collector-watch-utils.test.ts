import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";

const run = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function runPython(script: string, env: NodeJS.ProcessEnv = {}) {
  return run("python3", ["-c", script], { env: { ...process.env, ...env } });
}

function utilityScript(body: string): string {
  const tools = resolve(process.cwd(), "tools");
  return `import sys\nsys.path.insert(0, ${JSON.stringify(tools)})\nimport collector_watch_utils as utils\n${body}\n`;
}

test("watchdogs prefer an explicit npm path and then POLY_NPM", async () => {
  const root = await mkdtemp(join(tmpdir(), "collector-watch-utils-"));
  roots.push(root);
  const explicitNpm = join(root, "explicit-npm");
  const fakeNpm = join(root, "npm");
  await writeFile(explicitNpm, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await writeFile(fakeNpm, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const { stdout } = await runPython(utilityScript(`
print(utils.choose_npm(${JSON.stringify(explicitNpm)}, (${JSON.stringify(fakeNpm)},)))
print(utils.choose_npm(None, (${JSON.stringify(fakeNpm)},)))
`), { PATH: "/usr/bin:/bin", POLY_NPM: fakeNpm });
  expect(stdout.trim().split("\n")).toEqual([explicitNpm, fakeNpm]);
});

test("watchdogs find npm on PATH before known absolute fallbacks", async () => {
  const root = await mkdtemp(join(tmpdir(), "collector-watch-utils-"));
  roots.push(root);
  const bin = join(root, "bin");
  const pathNpm = join(bin, "npm");
  const fallbackNpm = join(root, "fallback-npm");
  await writeFile(fallbackNpm, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await mkdir(bin);
  await writeFile(pathNpm, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const { stdout } = await runPython(utilityScript(`
print(utils.choose_npm(None, (${JSON.stringify(fallbackNpm)},)))
`), { PATH: `${bin}:/usr/bin:/bin`, POLY_NPM: "" });
  expect(stdout.trim()).toBe(pathNpm);
});

test("watchdogs use an absolute fallback when launchd PATH has no npm", async () => {
  const root = await mkdtemp(join(tmpdir(), "collector-watch-utils-"));
  roots.push(root);
  const fallbackNpm = join(root, "fallback-npm");
  await writeFile(fallbackNpm, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const { stdout } = await runPython(utilityScript(`
print(utils.resolve_npm(candidates=(${JSON.stringify(fallbackNpm)},)))
`), { PATH: "/usr/bin:/bin", POLY_NPM: "" });
  expect(stdout.trim()).toBe(fallbackNpm);
});

test("watchdogs report when no npm executable can be found", async () => {
  const script = utilityScript(`
try:
    utils.resolve_npm(candidates=())
except FileNotFoundError as error:
    print(type(error).__name__, str(error))
`);
  const { stdout } = await runPython(script, { PATH: "/usr/bin:/bin", POLY_NPM: "" });
  expect(stdout.trim()).toContain("FileNotFoundError");
  expect(stdout.trim()).toContain("npm executable not found");
});
