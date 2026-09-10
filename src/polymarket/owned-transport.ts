import { connect as connectTcp, isIP } from "node:net";
import type { Duplex } from "node:stream";
import { connect as connectTls } from "node:tls";
import { Agent, EnvHttpProxyAgent, Pool, ProxyAgent, type Dispatcher, type buildConnector } from "undici";

export interface OwnedTransportOptions {
  proxyUrl?: string | undefined;
  connectTimeoutMs?: number;
}

export interface OwnedTransport {
  dispatcher: Dispatcher;
  /** Destroy and await every owned socket, including unfinished handshakes. */
  destroy(): Promise<void>;
}

/** Only HTTP/HTTPS proxy URLs are supported, including environment settings. */
export function validateProxyConfiguration(proxyUrl?: string): void {
  proxyConfiguration(proxyUrl);
}

function proxyConfiguration(proxyUrl: string | undefined) {
  const environment = {
    httpProxy: process.env.http_proxy ?? process.env.HTTP_PROXY ?? "",
    httpsProxy: process.env.https_proxy ?? process.env.HTTPS_PROXY ?? "",
    noProxy: process.env.no_proxy ?? process.env.NO_PROXY ?? ""
  };
  for (const value of proxyUrl === undefined ? [environment.httpProxy, environment.httpsProxy] : [proxyUrl]) {
    if (!value) continue;
    let protocol: string;
    try {
      protocol = new URL(value).protocol;
    } catch {
      throw new Error("INVALID_PROXY_URL: expected an HTTP or HTTPS proxy URL");
    }
    if (protocol !== "http:" && protocol !== "https:") {
      throw new Error(`UNSUPPORTED_PROXY_PROTOCOL: ${protocol} proxy URLs are unsupported; use http: or https:`);
    }
  }
  return environment;
}

export function createOwnedTransport(options: OwnedTransportOptions = {}): OwnedTransport {
  // Validate before constructing an agent: some proxy protocols create their
  // own connectors and would bypass socket ownership and cancellation.
  const environment = proxyConfiguration(options.proxyUrl);
  const transports = new Map<Duplex, Promise<void>>();
  let destroying = false;
  let destroyed: Promise<void> | undefined;
  const track = (transport: Duplex): void => {
    if (transports.has(transport) || transport.closed) return;
    const closed = new Promise<void>((resolve) => transport.once("close", resolve));
    transports.set(transport, closed);
    void closed.then(() => transports.delete(transport));
    if (destroying) transport.destroy();
  };
  const connectTimeout = options.connectTimeoutMs ?? 10_000;
  const connect = ownedConnector(track, connectTimeout);
  const agentOptions = {
    connectTimeout, allowH2: false, connect,
    // Own the proxy connection before CONNECT detaches it from its pool,
    // including tunnels awaiting the destination's TLS handshake.
    clientFactory: (origin: URL, settings: object) => new Pool(origin, { ...settings, connect })
  };
  const owner = options.proxyUrl === undefined
    ? new EnvHttpProxyAgent({ ...agentOptions, ...environment })
    : options.proxyUrl ? new ProxyAgent({ ...agentOptions, uri: options.proxyUrl }) : new Agent(agentOptions);
  // WebSocket upgrades are no longer owned by Undici's HTTP pool. Retain them
  // through the supported dispatch hook as well as tracking connecting sockets.
  const dispatcher = owner.compose((dispatch) => (request, handler) => {
    const onUpgrade = handler.onRequestUpgrade;
    return dispatch(request, {
      ...handler,
      onRequestUpgrade(controller, statusCode, headers, transport) {
        track(transport);
        return onUpgrade?.call(this, controller, statusCode, headers, transport);
      }
    });
  });
  return {
    dispatcher,
    destroy() {
      if (destroyed) return destroyed;
      destroying = true;
      destroyed = (async () => {
        for (const transport of transports.keys()) transport.destroy();
        try {
          await owner.destroy();
        } finally {
          while (transports.size > 0) await Promise.all([...transports.values()]);
        }
      })();
      return destroyed;
    }
  };
}

function ownedConnector(track: (transport: Duplex) => void, timeoutMs: number): buildConnector.connector {
  return (options, callback) => {
    const secure = options.protocol === "https:";
    const address = {
      host: options.hostname,
      port: Number(options.port || (secure ? 443 : 80)),
      ...(options.localAddress ? { localAddress: options.localAddress } : {})
    };
    const servername = options.servername || options.hostname;
    // Own the socket before DNS/TCP/TLS completes; a connector callback alone
    // misses sockets stuck in the TLS handshake. Certificate checks stay on.
    const transport = secure
      ? connectTls({
        ...address,
        ...(options.httpSocket ? { socket: options.httpSocket } : {}),
        servername: isIP(servername) ? "" : servername,
        ALPNProtocols: ["http/1.1"]
      })
      : connectTcp(address);
    let settled = false;
    const timeout = setTimeout(() => transport.destroy(new Error("TRANSPORT_CONNECT_TIMEOUT")), timeoutMs);
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) callback(error, null);
      else callback(null, transport);
    };
    transport.once(secure ? "secureConnect" : "connect", () => finish());
    transport.once("error", (error) => finish(error));
    transport.once("close", () => finish(new Error("TRANSPORT_CONNECT_CLOSED")));
    transport.setNoDelay(true);
    transport.setKeepAlive(true, 60_000);
    track(transport);
  };
}
