import { ProxyAgent } from "undici";

export interface HttpOptions {
  timeoutMs?: number;
  proxyUrl?: string;
  headers?: Record<string, string>;
}

let cachedProxyUrl: string | undefined;
let cachedDispatcher: ProxyAgent | undefined;

export async function fetchJson<T = unknown>(url: string, options: HttpOptions = {}): Promise<T> {
  const response = await fetchWithTimeout(url, options);
  return (await response.json()) as T;
}

export async function fetchText(url: string, options: HttpOptions = {}): Promise<string> {
  const response = await fetchWithTimeout(url, options);
  return response.text();
}

async function fetchWithTimeout(url: string, options: HttpOptions): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);

  try {
    const response = await fetch(url, {
      headers: options.headers,
      signal: controller.signal,
      dispatcher: dispatcherFor(options.proxyUrl ?? proxyFromEnv())
    } as RequestInit & { dispatcher?: ProxyAgent });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText} for ${url}`);
    }
    return response;
  } finally {
    clearTimeout(timeout);
  }
}

function proxyFromEnv(): string | undefined {
  return process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY ?? process.env.https_proxy ?? process.env.http_proxy;
}

function dispatcherFor(proxyUrl: string | undefined): ProxyAgent | undefined {
  if (!proxyUrl) return undefined;
  if (cachedDispatcher && cachedProxyUrl === proxyUrl) return cachedDispatcher;
  cachedProxyUrl = proxyUrl;
  cachedDispatcher = new ProxyAgent(proxyUrl);
  return cachedDispatcher;
}
