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

async function fetchWithTimeout<T>(url: string, options: HttpOptions, readBody: (response: Response) => Promise<T>): Promise<T> {
  options.signal?.throwIfAborted();
  const transport = createOwnedTransport({ proxyUrl: options.proxyUrl });
  const controller = new AbortController();
  const destroyOnAbort = () => { void transport.destroy().catch(() => {}); };
  controller.signal.addEventListener("abort", destroyOnAbort, { once: true });
  const abortFromCaller = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", abortFromCaller, { once: true });
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
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

    if (!response.ok) {
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
