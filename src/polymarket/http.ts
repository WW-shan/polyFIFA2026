import type { Dispatcher } from "undici";
import { createOwnedTransport } from "./owned-transport.js";

export interface HttpOptions {
  timeoutMs?: number;
  proxyUrl?: string;
  headers?: Record<string, string>;
  method?: string;
  body?: string;
  signal?: AbortSignal;
}

export interface HttpResponseText { status: number; statusText: string; headers: Record<string, string>; body: string }
/** Capture public response text before HTTP status / JSON interpretation. */
export async function fetchHttpResponseText(url: string, options: HttpOptions = {}): Promise<HttpResponseText> {
  return fetchWithTimeout(url, options, async response => ({
    status: response.status, statusText: response.statusText,
    headers: Object.fromEntries(response.headers), body: await response.text()
  }), true);
}

/**
 * One-line error text that keeps the cause chain. undici rejects every
 * transport failure as a bare "fetch failed" and puts the reason (ECONNRESET,
 * a refused proxy tunnel, ...) on `cause`; the top message alone is useless.
 * Credentials embedded in proxy URLs are redacted.
 */
export function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const name = error instanceof Error ? error.name : "Error";
  const top = message.trim() || (name && name !== "Error" ? name : "request failed");
  const cause = describeErrorCause(error);
  return redactCredentials(cause === undefined ? top : `${top}: ${cause}`);
}

/** Only the `cause` chain of {@link describeError}, or undefined without one. */
export function describeErrorCause(error: unknown): string | undefined {
  const parts: string[] = [];
  const seen = new Set<unknown>([error]);
  let cause = error instanceof Error ? (error as Error & { cause?: unknown }).cause : undefined;
  for (let depth = 0; cause !== undefined && depth < 4 && !seen.has(cause); depth += 1) {
    seen.add(cause);
    if (cause instanceof Error) {
      const causeMessage = cause.message.trim();
      const code = typeof (cause as NodeJS.ErrnoException).code === "string" ? (cause as NodeJS.ErrnoException).code : undefined;
      if (causeMessage || code) parts.push(`${causeMessage || cause.name}${code ? ` (${code})` : ""}`);
      cause = (cause as Error & { cause?: unknown }).cause;
    } else {
      parts.push(String(cause));
      cause = undefined;
    }
  }
  return parts.length === 0 ? undefined : redactCredentials(parts.join(": "));
}

function redactCredentials(text: string): string {
  return text.replace(/(\b[a-z][a-z\d+.-]*:\/\/)[^\s/]*@/gi, "$1[redacted]@").slice(0, 2000);
}

export async function fetchJson<T = unknown>(url: string, options: HttpOptions = {}): Promise<T> {
  return fetchWithTimeout(url, options, async (response) => (await response.json()) as T);
}

export async function postJson<T = unknown>(url: string, body: string, options: HttpOptions = {}): Promise<T> {
  return fetchJson<T>(url, {
    ...options,
    method: "POST",
    body
  });
}

export async function fetchText(url: string, options: HttpOptions = {}): Promise<string> {
  return fetchWithTimeout(url, options, (response) => response.text());
}

async function fetchWithTimeout<T>(url: string, options: HttpOptions, readBody: (response: Response) => Promise<T>, acceptErrorStatus = false): Promise<T> {
  options.signal?.throwIfAborted();
  const transport = createOwnedTransport({ proxyUrl: options.proxyUrl });
  const controller = new AbortController();
  const destroyOnAbort = () => { void transport.destroy().catch(() => {}); };
  controller.signal.addEventListener("abort", destroyOnAbort, { once: true });
  const abortFromCaller = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", abortFromCaller, { once: true });
  // A bare abort surfaces as "This operation was aborted", which reads like a
  // shutdown. Name the timeout so status and journal errors say what happened.
  const timeoutMs = options.timeoutMs ?? 10_000;
  const timeout = setTimeout(() => controller.abort(new DOMException(`HTTP request timed out after ${timeoutMs}ms`, "TimeoutError")), timeoutMs);
  let response: Response | undefined;
  let failed = false;

  try {
    response = await fetch(url, {
      headers: options.headers,
      method: options.method,
      body: options.body,
      signal: controller.signal,
      dispatcher: transport.dispatcher
    } as RequestInit & { dispatcher: Dispatcher });

    if (!response.ok && !acceptErrorStatus) {
      throw new Error(`HTTP ${response.status} ${response.statusText} for ${url}`);
    }
    const result = await readBody(response);
    controller.signal.throwIfAborted();
    return result;
  } catch (error) {
    failed = true;
    const reason: unknown = controller.signal.aborted ? controller.signal.reason : error;
    // Abort closes a pending fetch/body; cancel also releases unconsumed error responses.
    controller.abort(reason);
    if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
    throw reason;
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abortFromCaller);
    controller.signal.removeEventListener("abort", destroyOnAbort);
    // Successful requests also release their private pool. Preserve the
    // original caller/timeout error if cleanup reports a secondary failure.
    if (failed) await transport.destroy().catch(() => {});
    else await transport.destroy();
  }
}
