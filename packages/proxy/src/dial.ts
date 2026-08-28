import { Agent as HttpAgent } from "node:http";
import { Agent as HttpsAgent } from "node:https";
import { connect as netConnect, type Socket } from "node:net";
import type { ProxyConfig } from "./config.js";
import { httpConnect } from "./http-connect.js";
import { ProxyError } from "./errors.js";
import type { ProxyKind } from "./endpoint.js";
import { assertNotSelfPivot } from "./self.js";
import { socks5Connect } from "./socks5.js";

/** The subset of a proxy record a dial actually needs. */
export type DialProxy = {
  kind: ProxyKind;
  host: string;
  port: number;
  username: string | undefined;
  config: ProxyConfig;
};

export type DialTarget = {
  host: string;
  port: number;
};

export type ConnectFn = (options: { host: string; port: number }) => Socket;

export type DialThroughProxyOptions = {
  proxy: DialProxy;
  target: DialTarget;
  password?: string;
  connect?: ConnectFn;
};

function openSocket(
  proxy: DialProxy,
  connect: ConnectFn,
  timeoutMs: number,
): Promise<Socket> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const socket = connect({ host: proxy.host, port: proxy.port });

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        socket.destroy();
        reject(new ProxyError("timeout", "proxy-connect"));
      }
    }, timeoutMs);
    timer.unref?.();

    const onError = (): void => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        // The peer address is deliberately absent from the message: it is
        // operator configuration, and an error that carries it ends up in logs.
        reject(new ProxyError("refused", "proxy-connect"));
      }
    };

    socket.once("error", onError);
    socket.once("connect", () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        socket.off("error", onError);
        resolve(socket);
      }
    });
  });
}

/**
 * Open a tunneled socket to `target` through `proxy`.
 *
 * On every failure path the socket is destroyed before the error is thrown: a
 * half-open socket against a hostile or broken proxy is a slow resource leak, and
 * leaving one behind would let a failing proxy exhaust the process over time.
 */
export async function dialThroughProxy(
  options: DialThroughProxyOptions,
): Promise<Socket> {
  const { proxy, target, password } = options;
  const connect = options.connect ?? ((where) => netConnect(where));

  if (proxy.kind !== "socks5" && proxy.kind !== "http") {
    // Checked before any socket is opened, so an unsupported kind cannot even
    // cause a connection attempt.
    throw new ProxyError("invalid_proxy_config", "dial-kind");
  }
  // Same reasoning, one step further: a tunnel back into this process's own listener
  // is refused before a socket exists, so a hostile or mistaken configuration cannot
  // buy even one live connection per attempt.
  assertNotSelfPivot(target);

  const timeoutMs = proxy.config.connectTimeoutMs;
  const socket = await openSocket(proxy, connect, timeoutMs);

  try {
    const handshake =
      proxy.kind === "socks5"
        ? socks5Connect({
            socket,
            target,
            ...(proxy.username === undefined ? {} : { username: proxy.username }),
            ...(password === undefined ? {} : { password }),
            timeoutMs,
          })
        : httpConnect({
            socket,
            target,
            ...(proxy.username === undefined ? {} : { username: proxy.username }),
            ...(password === undefined ? {} : { password }),
            timeoutMs,
          });
    return await handshake;
  } catch (error) {
    socket.destroy();
    throw error instanceof ProxyError
      ? error
      : new ProxyError("protocol_error", "dial-handshake");
  }
}

export type CreateProxyAgentOptions = {
  proxy: DialProxy;
  password?: string;
  connect?: ConnectFn;
  tls?: boolean;
};

/**
 * Build a `node:http`/`node:https` Agent that routes through the proxy.
 *
 * This is the honest boundary of Phase 4: `node:http` and `node:https` accept a
 * custom `createConnection`, so a real request through a real proxy is verifiable.
 * Node's global `fetch` is undici-backed and exposes no stable public way to
 * supply a connector, so `fetch` remains direct-only rather than appearing to be
 * proxied.
 */
export function createProxyAgent(
  options: CreateProxyAgentOptions,
): HttpAgent | HttpsAgent {
  const { proxy, password, connect, tls = false } = options;

  const createConnection = (
    agentOptions: { host?: string | undefined; port?: number | string | undefined },
    callback: (error: Error | null, socket?: Socket) => void,
  ): void => {
    const host = agentOptions.host ?? proxy.config.healthCheckHost;
    const port = Number(agentOptions.port ?? (tls ? 443 : 80));
    dialThroughProxy({
      proxy,
      target: { host, port },
      ...(password === undefined ? {} : { password }),
      ...(connect === undefined ? {} : { connect }),
    }).then(
      (socket) => callback(null, socket),
      (error: unknown) =>
        callback(
          error instanceof Error ? error : new ProxyError("proxy_error", "agent-connect"),
        ),
    );
  };

  const Ctor = tls ? HttpsAgent : HttpAgent;
  const agent = new Ctor({ keepAlive: false });
  // Assigning the hook keeps one code path for both agent classes; the typings
  // do not describe `createConnection` as an instance member.
  (agent as unknown as { createConnection: unknown }).createConnection =
    createConnection;
  return agent;
}
