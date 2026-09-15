import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TailSummary } from "./tail-types.js";

export interface TailExportTask {
  snapshotDirectory: string; outputDirectory: string; eventSlugs: string[]; gameKey: string; timeoutMs: number;
  finishFactsFile?: string;
}
export interface TailArchiveResult { outputDirectory: string; priceReadyTokens: number; strictReadyTokens: number }

/** A separate process keeps book reconstruction off the receiving event loop. */
export async function runTailExport(task: TailExportTask, signal?: AbortSignal): Promise<TailArchiveResult> {
  signal?.throwIfAborted();
  if (!Number.isSafeInteger(task.timeoutMs) || task.timeoutMs < 1 || !task.eventSlugs.length) throw new Error("TAIL_EXPORT_TASK_INVALID");
  const args = ["--import", "tsx", fileURLToPath(new URL("./tail-cli.ts", import.meta.url)), "export",
    "--run-dir", task.snapshotDirectory, "--output-dir", task.outputDirectory, "--event-slugs", task.eventSlugs.join(","),
    "--clock-policy", "flag-backsteps", "--window-seconds", "301", "--compress-raw-events",
    ...(task.finishFactsFile ? ["--finish-facts", task.finishFactsFile] : [])];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "", failure: Error | undefined, closed = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const capture = (data: Buffer): void => { output = (output + data.toString("utf8")).slice(-32_768); };
    child.stdout.on("data", capture); child.stderr.on("data", capture);
    const stop = (reason: Error): void => {
      if (closed) return;
      failure ??= reason;
      child.kill("SIGTERM");
      killTimer ??= setTimeout(() => { if (!closed) child.kill("SIGKILL"); }, 2000);
    };
    const onAbort = (): void => stop(signal?.reason instanceof Error ? signal.reason : new Error("TAIL_EXPORT_ABORTED"));
    const timer = setTimeout(() => stop(new Error("TAIL_EXPORT_TIMEOUT")), task.timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    const cleanup = (): void => {
      closed = true; clearTimeout(timer); if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener("abort", onAbort);
    };
    child.once("error", error => { cleanup(); reject(error); });
    child.once("close", (code, exitSignal) => {
      cleanup();
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`TAIL_EXPORT_CHILD_FAILED (${code ?? exitSignal}): ${output.slice(-4000)}`));
      else resolve();
    });
  });
  signal?.throwIfAborted();
  const manifest = JSON.parse(await readFile(join(task.outputDirectory, "manifest.json"), "utf8")) as { status?: string };
  const summary = JSON.parse(await readFile(join(task.outputDirectory, "quality.json"), "utf8")) as TailSummary;
  if (manifest.status !== "complete" || !Array.isArray(summary.tokens) || !summary.windows.some(window => window.key === task.gameKey)) throw new Error("TAIL_EXPORT_RESULT_INVALID");
  const tokens = summary.tokens.filter(token => token.windowKey === task.gameKey);
  return { outputDirectory: task.outputDirectory,
    priceReadyTokens: tokens.filter(token => token.observedWindowComplete && token.snapshotAuditPassed && token.validSeconds > 0).length,
    strictReadyTokens: tokens.filter(token => token.readyForReplay).length };
}
