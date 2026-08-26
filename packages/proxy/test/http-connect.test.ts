import assert from "node:assert/strict";
import { createServer, connect, type Server, type Socket } from "node:net";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { ProxyError, httpConnect } from "../src/index.js";

/**
 * Driven against hand-written CONNECT proxies on loopback: the status-line and
 * header parsing has to be proven against real bytes, including a proxy that
 * coalesces its response with the tunneled payload.
 */

type ServerLogic = (socket: Socket, transcript: Buffer[]) => void;

async function withProxy(
  logic: ServerLogic,
  run: (port: number, transcript: Buffer[]) => Promise<void>,
): Promise<void> {
  const transcript: Buffer[] = [];
  const accepted = new Set<Socket>();
  const server: Server = createServer((socket) => {
    accepted.add(socket);
    socket.on("close", () => accepted.delete(socket));
    socket.on("error", () => {
      // Abandoned handshakes are the point of several tests.
    });
    logic(socket, transcript);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(port, transcript);
  } finally {
    for (const socket of accepted) {
      socket.destroy();
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function openSocket(port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port }, () => resolve(socket));
    socket.on("error", reject);
  });
}

function record(socket: Socket, transcript: Buffer[]): void {
  socket.on("data", (chunk) => transcript.push(Buffer.from(chunk)));
}

/** Reply once the request header block is complete. */
function replyWhenReady(socket: Socket, reply: Buffer | string): void {
  let seen = Buffer.alloc(0);
  socket.on("data", (chunk) => {
    seen = Buffer.concat([seen, Buffer.from(chunk)]);
    if (seen.includes("\r\n\r\n")) {
      socket.write(reply);
      seen = Buffer.alloc(0);
    }
  });
}

function expectCode(code: string) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof ProxyError, `expected a ProxyError, got ${String(error)}`);
    assert.equal(error.code, code);
    return true;
  };
}

test("a 200 response completes the tunnel and the request line is well formed", async () => {
  await withProxy(
    (socket, transcript) => {
      record(socket, transcript);
      replyWhenReady(socket, "HTTP/1.1 200 Connection Established\r\n\r\n");
    },
    async (port, transcript) => {
      const socket = await openSocket(port);
      try {
        await httpConnect({
          socket,
          target: { host: "api.example.com", port: 443 },
          timeoutMs: 2000,
        });
        const request = Buffer.concat(transcript).toString("utf8");
        assert.match(request, /^CONNECT api\.example\.com:443 HTTP\/1\.1\r\n/);
        assert.match(request, /\r\nhost: api\.example\.com:443\r\n/i);
        assert.match(request, /\r\n\r\n$/);
        assert.equal(/proxy-authorization/i.test(request), false);
      } finally {
        socket.destroy();
      }
    },
  );
});

test("any 2xx status is accepted", async () => {
  for (const status of [200, 201, 204]) {
    await withProxy(
      (socket) => replyWhenReady(socket, `HTTP/1.1 ${status} OK\r\n\r\n`),
      async (port) => {
        const socket = await openSocket(port);
        try {
          await httpConnect({
            socket,
            target: { host: "api.example.com", port: 443 },
            timeoutMs: 2000,
          });
        } finally {
          socket.destroy();
        }
      },
    );
  }
});

test("credentials are sent as correctly encoded Basic proxy auth", async () => {
  await withProxy(
    (socket, transcript) => {
      record(socket, transcript);
      replyWhenReady(socket, "HTTP/1.1 200 OK\r\n\r\n");
    },
    async (port, transcript) => {
      const socket = await openSocket(port);
      try {
        await httpConnect({
          socket,
          target: { host: "api.example.com", port: 443 },
          username: "bayz",
          password: "hunter2-secret",
          timeoutMs: 2000,
        });
        const request = Buffer.concat(transcript).toString("utf8");
        const expected = Buffer.from("bayz:hunter2-secret", "utf8").toString("base64");
        assert.match(
          request,
          new RegExp(`\\r\\nproxy-authorization: Basic ${expected}\\r\\n`, "i"),
        );
        // Base64 is encoding, not encryption; the plaintext must still not appear.
        assert.equal(request.includes("hunter2-secret"), false);
      } finally {
        socket.destroy();
      }
    },
  );
});

test("a username without a password is refused before any bytes are sent", async () => {
  await withProxy(
    (socket, transcript) => record(socket, transcript),
    async (port, transcript) => {
      const socket = await openSocket(port);
      try {
        await assert.rejects(
          httpConnect({
            socket,
            target: { host: "api.example.com", port: 443 },
            username: "bayz",
            timeoutMs: 2000,
          }),
          expectCode("password_missing"),
        );
        assert.equal(transcript.length, 0);
      } finally {
        socket.destroy();
      }
    },
  );
});

test("proxy status codes map to fixed error codes", async () => {
  const mapping: Array<[number, string]> = [
    [407, "auth_failed"],
    [401, "auth_failed"],
    [403, "forbidden"],
    [502, "unreachable"],
    [504, "unreachable"],
    [400, "proxy_error"],
    [500, "proxy_error"],
    [301, "proxy_error"],
  ];

  for (const [status, code] of mapping) {
    await withProxy(
      (socket) =>
        replyWhenReady(
          socket,
          `HTTP/1.1 ${status} Nope\r\ncontent-length: 0\r\n\r\n`,
        ),
      async (port) => {
        const socket = await openSocket(port);
        try {
          await assert.rejects(
            httpConnect({
              socket,
              target: { host: "api.example.com", port: 443 },
              timeoutMs: 2000,
            }),
            expectCode(code),
          );
        } finally {
          socket.destroy();
        }
      },
    );
  }
});

test("an error response body never reaches the raised error", async () => {
  await withProxy(
    (socket) =>
      replyWhenReady(
        socket,
        "HTTP/1.1 407 Proxy Authentication Required\r\n" +
          "proxy-authenticate: Basic realm=\"secret-realm\"\r\n\r\n" +
          "credential hunter2-secret was rejected",
      ),
    async (port) => {
      const socket = await openSocket(port);
      try {
        await assert.rejects(
          httpConnect({
            socket,
            target: { host: "api.example.com", port: 443 },
            timeoutMs: 2000,
          }),
          (error: unknown) => {
            assert.ok(error instanceof ProxyError);
            assert.equal(error.code, "auth_failed");
            assert.equal(error.message.includes("hunter2-secret"), false);
            assert.equal(error.message.includes("secret-realm"), false);
            return true;
          },
        );
      } finally {
        socket.destroy();
      }
    },
  );
});

test("a malformed status line is a protocol error", async () => {
  for (const reply of [
    "NOT-HTTP 200 OK\r\n\r\n",
    "HTTP/1.1\r\n\r\n",
    "HTTP/1.1 abc OK\r\n\r\n",
    "\r\n\r\n",
    "HTTP/1.1 20 OK\r\n\r\n",
  ]) {
    await withProxy(
      (socket) => replyWhenReady(socket, reply),
      async (port) => {
        const socket = await openSocket(port);
        try {
          await assert.rejects(
            httpConnect({
              socket,
              target: { host: "api.example.com", port: 443 },
              timeoutMs: 2000,
            }),
            expectCode("protocol_error"),
            `reply must be rejected: ${JSON.stringify(reply)}`,
          );
        } finally {
          socket.destroy();
        }
      },
    );
  }
});

test("a header block that never terminates is refused at the byte cap", async () => {
  await withProxy(
    (socket) => {
      replyWhenReady(socket, "HTTP/1.1 200 OK\r\n");
      // Then flood headers without ever sending the blank line.
      const flood = setInterval(() => {
        if (socket.writable) {
          socket.write(`x-pad: ${"A".repeat(4000)}\r\n`);
        }
      }, 5);
      socket.on("close", () => clearInterval(flood));
    },
    async (port) => {
      const socket = await openSocket(port);
      try {
        await assert.rejects(
          httpConnect({
            socket,
            target: { host: "api.example.com", port: 443 },
            timeoutMs: 5000,
          }),
          expectCode("protocol_error"),
        );
      } finally {
        socket.destroy();
      }
    },
  );
});

test("an immediate FIN before any reply is a protocol error", async () => {
  await withProxy(
    (socket) => {
      socket.on("data", () => socket.end());
    },
    async (port) => {
      const socket = await openSocket(port);
      try {
        await assert.rejects(
          httpConnect({
            socket,
            target: { host: "api.example.com", port: 443 },
            timeoutMs: 2000,
          }),
          expectCode("protocol_error"),
        );
      } finally {
        socket.destroy();
      }
    },
  );
});

test("a silent proxy is bounded by the timeout", async () => {
  await withProxy(
    () => {
      // Accept and stay silent.
    },
    async (port) => {
      const socket = await openSocket(port);
      const started = Date.now();
      try {
        await assert.rejects(
          httpConnect({
            socket,
            target: { host: "api.example.com", port: 443 },
            timeoutMs: 200,
          }),
          expectCode("timeout"),
        );
        assert.ok(Date.now() - started < 5000);
      } finally {
        socket.destroy();
      }
    },
  );
});

test("a CRLF-bearing target host cannot reach the request line", async () => {
  await withProxy(
    (socket, transcript) => record(socket, transcript),
    async (port, transcript) => {
      const socket = await openSocket(port);
      try {
        for (const host of [
          "api.example.com\r\nX-Injected: 1",
          "api.example\r\n.com",
          "api.example.com\nX: y",
          "https://api.example.com",
          "api.example.com:443",
        ]) {
          await assert.rejects(
            httpConnect({ socket, target: { host, port: 443 }, timeoutMs: 2000 }),
            expectCode("invalid_proxy_config"),
          );
        }
        assert.equal(transcript.length, 0, "nothing may be written for a bad target");
      } finally {
        socket.destroy();
      }
    },
  );
});

test("surrounding whitespace is trimmed rather than treated as injection", async () => {
  await withProxy(
    (socket, transcript) => {
      record(socket, transcript);
      replyWhenReady(socket, "HTTP/1.1 200 OK\r\n\r\n");
    },
    async (port, transcript) => {
      const socket = await openSocket(port);
      try {
        // A trailing newline is stripped by trimming, which yields a clean host —
        // the danger is embedded CRLF, which the case above covers.
        await httpConnect({
          socket,
          target: { host: "api.example.com\r\n", port: 443 },
          timeoutMs: 2000,
        });
        const request = Buffer.concat(transcript).toString("utf8");
        assert.match(request, /^CONNECT api\.example\.com:443 HTTP\/1\.1\r\nhost: /);
        assert.equal(request.split("\r\n\r\n").length, 2, "exactly one header block");
      } finally {
        socket.destroy();
      }
    },
  );
});

test("payload coalesced with the response is delivered intact", async () => {
  await withProxy(
    (socket) =>
      replyWhenReady(
        socket,
        "HTTP/1.1 200 Connection Established\r\n\r\nPAYLOAD-AFTER-HEADERS",
      ),
    async (port) => {
      const socket = await openSocket(port);
      try {
        const tunneled = await httpConnect({
          socket,
          target: { host: "api.example.com", port: 443 },
          timeoutMs: 2000,
        });
        const received = await new Promise<string>((resolve) => {
          const chunks: Buffer[] = [];
          tunneled.on("data", (chunk) => {
            chunks.push(Buffer.from(chunk));
            const text = Buffer.concat(chunks).toString("utf8");
            if (text.includes("PAYLOAD-AFTER-HEADERS")) {
              resolve(text);
            }
          });
        });
        assert.equal(
          received,
          "PAYLOAD-AFTER-HEADERS",
          "no header byte may leak into the tunneled stream",
        );
      } finally {
        socket.destroy();
      }
    },
  );
});

test("payload written after the handshake reaches the proxy byte-exact", async () => {
  await withProxy(
    (socket, transcript) => {
      let seen = Buffer.alloc(0);
      socket.on("data", (chunk) => {
        const buffer = Buffer.from(chunk);
        seen = Buffer.concat([seen, buffer]);
        if (seen.includes("\r\n\r\n")) {
          socket.write("HTTP/1.1 200 OK\r\n\r\n");
          seen = Buffer.alloc(0);
        } else {
          transcript.push(buffer);
        }
      });
    },
    async (port, transcript) => {
      const socket = await openSocket(port);
      try {
        const tunneled = await httpConnect({
          socket,
          target: { host: "api.example.com", port: 443 },
          timeoutMs: 2000,
        });
        tunneled.write(Buffer.from([0x00, 0xff, 0x10, 0x05]));
        await new Promise((resolve) => setTimeout(resolve, 120));
        const last = transcript[transcript.length - 1];
        assert.ok(last !== undefined);
        assert.deepEqual([...last], [0x00, 0xff, 0x10, 0x05]);
      } finally {
        socket.destroy();
      }
    },
  );
});

test("an IPv6 target is bracketed in the request line", async () => {
  await withProxy(
    (socket, transcript) => {
      record(socket, transcript);
      replyWhenReady(socket, "HTTP/1.1 200 OK\r\n\r\n");
    },
    async (port, transcript) => {
      const socket = await openSocket(port);
      try {
        await httpConnect({
          socket,
          target: { host: "[::1]", port: 8443 },
          timeoutMs: 2000,
        });
        const request = Buffer.concat(transcript).toString("utf8");
        assert.match(request, /^CONNECT \[::1\]:8443 HTTP\/1\.1\r\n/);
      } finally {
        socket.destroy();
      }
    },
  );
});
