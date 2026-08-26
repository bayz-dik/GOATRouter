import assert from "node:assert/strict";
import { get as httpGet, createServer as createHttpServer } from "node:http";
import { createServer, connect, type Server, type Socket } from "node:net";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { ProxyError, createProxyAgent, dialThroughProxy } from "../src/index.js";

/**
 * The agent test performs a real HTTP request through a real CONNECT proxy to a
 * real origin server, all on loopback. That end-to-end path is the only way to
 * show the dial actually produces a usable socket rather than one that merely
 * looks connected.
 */

type ServerLogic = (socket: Socket) => void;

async function withProxy(
  logic: ServerLogic,
  run: (port: number) => Promise<void>,
): Promise<void> {
  const accepted = new Set<Socket>();
  const server: Server = createServer((socket) => {
    accepted.add(socket);
    socket.on("close", () => accepted.delete(socket));
    socket.on("error", () => {});
    logic(socket);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(port);
  } finally {
    for (const socket of accepted) {
      socket.destroy();
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** A CONNECT proxy that really pipes both directions to the requested origin. */
async function withTunnelingProxy(
  run: (proxyPort: number, originPort: number) => Promise<void>,
): Promise<void> {
  const origin = createHttpServer((request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end(`tunneled:${request.url}`);
  });
  await new Promise<void>((resolve) => origin.listen(0, "127.0.0.1", resolve));
  const originPort = (origin.address() as AddressInfo).port;

  const accepted = new Set<Socket>();
  const proxy = createServer((client) => {
    accepted.add(client);
    client.on("close", () => accepted.delete(client));
    client.on("error", () => {});
    let head = Buffer.alloc(0);
    const onData = (chunk: Buffer): void => {
      head = Buffer.concat([head, Buffer.from(chunk)]);
      const end = head.indexOf("\r\n\r\n");
      if (end === -1) {
        return;
      }
      client.off("data", onData);
      const rest = head.subarray(end + 4);
      const upstream = connect({ host: "127.0.0.1", port: originPort }, () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (rest.length > 0) {
          upstream.write(rest);
        }
        client.pipe(upstream);
        upstream.pipe(client);
      });
      upstream.on("error", () => client.destroy());
      accepted.add(upstream);
    };
    client.on("data", onData);
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const proxyPort = (proxy.address() as AddressInfo).port;

  try {
    await run(proxyPort, originPort);
  } finally {
    for (const socket of accepted) {
      socket.destroy();
    }
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
    await new Promise<void>((resolve) => origin.close(() => resolve()));
  }
}

function expectCode(code: string) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof ProxyError, `expected a ProxyError, got ${String(error)}`);
    assert.equal(error.code, code);
    return true;
  };
}

function socks5Proxy(socket: Socket): void {
  let stage = 0;
  socket.on("data", () => {
    if (stage === 0) {
      socket.write(Buffer.from([0x05, 0x00]));
      stage = 1;
    } else if (stage === 1) {
      socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0x04, 0x38]));
      stage = 2;
    }
  });
}

function connectProxy(socket: Socket): void {
  let seen = Buffer.alloc(0);
  socket.on("data", (chunk) => {
    seen = Buffer.concat([seen, Buffer.from(chunk)]);
    if (seen.includes("\r\n\r\n")) {
      socket.write("HTTP/1.1 200 OK\r\n\r\n");
      seen = Buffer.alloc(0);
    }
  });
}

const TARGET = { host: "api.example.com", port: 443 };

test("a socks5 proxy record dials through the SOCKS5 handshake", async () => {
  await withProxy(socks5Proxy, async (port) => {
    const socket = await dialThroughProxy({
      proxy: {
        kind: "socks5",
        host: "127.0.0.1",
        port,
        username: undefined,
        config: { connectTimeoutMs: 2000, healthCheckHost: "1.1.1.1", healthCheckPort: 443 },
      },
      target: TARGET,
    });
    try {
      assert.equal(socket.destroyed, false);
    } finally {
      socket.destroy();
    }
  });
});

test("an http proxy record dials through CONNECT", async () => {
  await withProxy(connectProxy, async (port) => {
    const socket = await dialThroughProxy({
      proxy: {
        kind: "http",
        host: "127.0.0.1",
        port,
        username: undefined,
        config: { connectTimeoutMs: 2000, healthCheckHost: "1.1.1.1", healthCheckPort: 443 },
      },
      target: TARGET,
    });
    try {
      assert.equal(socket.destroyed, false);
    } finally {
      socket.destroy();
    }
  });
});

test("an unknown proxy kind is refused before any socket is opened", async () => {
  let connectCalls = 0;
  await assert.rejects(
    dialThroughProxy({
      proxy: {
        kind: "socks4" as never,
        host: "127.0.0.1",
        port: 1080,
        username: undefined,
        config: { connectTimeoutMs: 2000, healthCheckHost: "1.1.1.1", healthCheckPort: 443 },
      },
      target: TARGET,
      connect: () => {
        connectCalls += 1;
        throw new Error("must not be called");
      },
    }),
    expectCode("invalid_proxy_config"),
  );
  assert.equal(connectCalls, 0);
});

test("an injected connect function is used instead of a real socket", async () => {
  await withProxy(connectProxy, async (port) => {
    let used = false;
    const socket = await dialThroughProxy({
      proxy: {
        kind: "http",
        host: "example.invalid",
        port: 9,
        username: undefined,
        config: { connectTimeoutMs: 2000, healthCheckHost: "1.1.1.1", healthCheckPort: 443 },
      },
      target: TARGET,
      connect: () => {
        used = true;
        return connect({ host: "127.0.0.1", port });
      },
    });
    try {
      assert.equal(used, true, "the injected dialer must be preferred");
    } finally {
      socket.destroy();
    }
  });
});

test("a refused proxy connection is reported as refused without leaking the peer", async () => {
  // Bind then close to obtain a port nothing listens on.
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const deadPort = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));

  await assert.rejects(
    dialThroughProxy({
      proxy: {
        kind: "http",
        host: "127.0.0.1",
        port: deadPort,
        username: undefined,
        config: { connectTimeoutMs: 2000, healthCheckHost: "1.1.1.1", healthCheckPort: 443 },
      },
      target: TARGET,
    }),
    (error: unknown) => {
      assert.ok(error instanceof ProxyError);
      assert.equal(error.code, "refused");
      assert.equal(error.message.includes(String(deadPort)), false);
      return true;
    },
  );
});

test("a proxy that never answers is bounded and the socket is destroyed", async () => {
  await withProxy(
    () => {
      // Accept and stay silent.
    },
    async (port) => {
      const sockets: Socket[] = [];
      await assert.rejects(
        dialThroughProxy({
          proxy: {
            kind: "http",
            host: "127.0.0.1",
            port,
            username: undefined,
            config: {
              connectTimeoutMs: 200,
              healthCheckHost: "1.1.1.1",
              healthCheckPort: 443,
            },
          },
          target: TARGET,
          connect: () => {
            const socket = connect({ host: "127.0.0.1", port });
            sockets.push(socket);
            return socket;
          },
        }),
        expectCode("timeout"),
      );
      assert.equal(sockets.length, 1);
      assert.equal(
        sockets[0]?.destroyed,
        true,
        "a failed dial must not leak a half-open socket",
      );
    },
  );
});

test("a handshake failure destroys the socket before throwing", async () => {
  await withProxy(
    (socket) => {
      let seen = Buffer.alloc(0);
      socket.on("data", (chunk) => {
        seen = Buffer.concat([seen, Buffer.from(chunk)]);
        if (seen.includes("\r\n\r\n")) {
          socket.write("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n");
          seen = Buffer.alloc(0);
        }
      });
    },
    async (port) => {
      const sockets: Socket[] = [];
      await assert.rejects(
        dialThroughProxy({
          proxy: {
            kind: "http",
            host: "127.0.0.1",
            port,
            username: undefined,
            config: {
              connectTimeoutMs: 2000,
              healthCheckHost: "1.1.1.1",
              healthCheckPort: 443,
            },
          },
          target: TARGET,
          connect: () => {
            const socket = connect({ host: "127.0.0.1", port });
            sockets.push(socket);
            return socket;
          },
        }),
        expectCode("auth_failed"),
      );
      assert.equal(sockets[0]?.destroyed, true);
    },
  );
});

test("a password is required when the proxy record names a username", async () => {
  await withProxy(connectProxy, async (port) => {
    await assert.rejects(
      dialThroughProxy({
        proxy: {
          kind: "http",
          host: "127.0.0.1",
          port,
          username: "bayz",
          config: {
            connectTimeoutMs: 2000,
            healthCheckHost: "1.1.1.1",
            healthCheckPort: 443,
          },
        },
        target: TARGET,
      }),
      expectCode("password_missing"),
    );
  });
});

test("a real HTTP request completes through a real CONNECT proxy agent", async () => {
  await withTunnelingProxy(async (proxyPort, originPort) => {
    const agent = createProxyAgent({
      proxy: {
        kind: "http",
        host: "127.0.0.1",
        port: proxyPort,
        username: undefined,
        config: {
          connectTimeoutMs: 5000,
          healthCheckHost: "1.1.1.1",
          healthCheckPort: 443,
        },
      },
    });

    const body = await new Promise<string>((resolve, reject) => {
      const request = httpGet(
        {
          host: "127.0.0.1",
          port: originPort,
          path: "/through-proxy",
          agent,
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
          response.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        },
      );
      request.on("error", reject);
    });

    assert.equal(body, "tunneled:/through-proxy");
    agent.destroy();
  });
});
