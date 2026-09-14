import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { JournalCompressionReport } from "./journal-compression.js";
export interface JournalCompressionTask { roots: string[]; activeRunDirectory?: string; maxSegments: number; timeoutMs: number }
export async function runJournalCompression(task: JournalCompressionTask, signal?: AbortSignal): Promise<JournalCompressionReport> {
  signal?.throwIfAborted();
  if (!task.roots.length || task.roots.some(root => !root.trim()) || !Number.isSafeInteger(task.maxSegments) || task.maxSegments < 1
    || !Number.isSafeInteger(task.timeoutMs) || task.timeoutMs < 1 || task.timeoutMs > 2_147_483_647) throw new Error("COMPRESSION_TASK_INVALID");
  const args = ["--import", "tsx", fileURLToPath(new URL("./storage-cli.ts", import.meta.url)), "compact", "--replace-verified", "--quiet",
    ...task.roots.flatMap(root => ["--root", root]), "--max-segments", String(task.maxSegments),
    ...(task.activeRunDirectory ? ["--active-run", task.activeRunDirectory] : [])];
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", bytes = 0, failure: Error | undefined, closed = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = (reason: Error): void => {
      if (closed) return;
      failure ??= reason; child.kill("SIGTERM");
      killTimer ??= setTimeout(() => { if (!closed) child.kill("SIGKILL"); }, 2000);
    };
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (data: string) => {
      bytes += Buffer.byteLength(data);
      if (bytes > 2 * 1024 * 1024) { stop(new Error("COMPRESSION_OUTPUT_LIMIT")); return; }
      stdout += data;
    });
    child.stderr.on("data", (data: string) => { stderr = (stderr + data).slice(-32_768); });
    const abort = (): void => stop(signal?.reason instanceof Error ? signal.reason : new Error("COMPRESSION_ABORTED"));
    const timer = setTimeout(() => stop(new Error("COMPRESSION_TIMEOUT")), task.timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const cleanup = (): void => {
      closed = true; clearTimeout(timer); if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener("abort", abort);
    };
    child.once("error", error => { cleanup(); reject(error); });
    child.once("close", (code, exitSignal) => {
      cleanup();
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`COMPRESSION_CHILD_FAILED (${code ?? exitSignal}): ${stderr.slice(-4000)}`));
      else resolve(stdout);
    });
  });
  signal?.throwIfAborted();
  let report: JournalCompressionReport & { type?: string };
  try { report = JSON.parse(output) as typeof report; }
  catch (error) { throw new Error("COMPRESSION_RESULT_INVALID: invalid JSON", { cause: error }); }
  if (report?.type !== "compression-summary" || !Array.isArray(report.skipped)
    || [report.compressedSegments, report.replacedAliases, report.originalBytes, report.compressedBytes, report.logicalBytesSaved]
      .some(value => !Number.isSafeInteger(value) || value < 0)) throw new Error("COMPRESSION_RESULT_INVALID");
  return report;
}
