import assert from "node:assert/strict";
import { createServer, connect, type Server, type Socket } from "node:net";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { ProxyError, socks5Connect } from "../src/index.js";

/**
 * These tests drive the real client against hand-written SOCKS5 servers on
 * loopback. Mocking the socket would only prove the code agrees with itself; the
 * wire format has to be exercised byte-for-byte.
 */

type ServerLogic = (socket: Socket, transcript: Buffer[]) => void;

async function withProxy(
  logic: ServerLogic,
  run: (port: number, transcript: Buffer[]) => Promise<void>,
): Promise<void> {
  const transcript: Buffer[] = [];
  // `net.Server` has no `closeAllConnections`, so accepted sockets are tracked
  // and destroyed explicitly; otherwise `close()` waits forever on a peer the
  // test already abandoned.
  const accepted = new Set<Socket>();
  const server: Server = createServer((socket) => {
    accepted.add(socket);
    socket.on("close", () => accepted.delete(socket));
    socket.on("error", () => {
      // A client that hangs up mid-handshake is the point of several tests.
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

/** Collect every byte the client sends, so credential handling is inspectable. */
function record(socket: Socket, transcript: Buffer[]): void {
  socket.on("data", (chunk) => transcript.push(Buffer.from(chunk)));
}

function successReply(): Buffer {
  return Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0x04, 0x38]);
}

function expectCode(code: string) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof ProxyError, `expected a ProxyError, got ${String(error)}`);
    assert.equal(error.code, code);
    return true;
  };
}

test("a no-auth handshake succeeds and greets with method 00 only", async () => {
  await withProxy(
    (socket, transcript) => {
      record(socket, transcript);
      let stage = 0;
      socket.on("data", () => {
        if (stage === 0) {
          socket.write(Buffer.from([0x05, 0x00]));
          stage = 1;
        } else if (stage === 1) {
          socket.write(successReply());
          stage = 2;
        }
      });
    },
    async (port, transcript) => {
      const socket = await openSocket(port);
      try {
        await socks5Connect({
          socket,
          target: { host: "api.example.com", port: 443 },
          timeoutMs: 2000,
        });
        const greeting = transcript[0];
        assert.ok(greeting !== undefined);
        assert.deepEqual([...greeting.subarray(0, 3)], [0x05, 0x01, 0x00]);
      } finally {
        socket.destroy();
      }
    },
  );
});

test("a username/password handshake succeeds and follows RFC 1929", async () => {
  await withProxy(
    (socket, transcript) => {
      record(socket, transcript);
      let stage = 0;
      socket.on("data", () => {
        if (stage === 0) {
          socket.write(Buffer.from([0x05, 0x02]));
          stage = 1;
        } else if (stage === 1) {
          socket.write(Buffer.from([0x01, 0x00]));
          stage = 2;
        } else if (stage === 2) {
          socket.write(successReply());
          stage = 3;
        }
      });
    },
    async (port, transcript) => {
      const socket = await openSocket(port);
      try {
        await socks5Connect({
          socket,
          target: { host: "api.example.com", port: 443 },
          username: "bayz",
          password: "hunter2-secret",
          timeoutMs: 2000,
        });

        const greeting = transcript[0];
        assert.ok(greeting !== undefined);
        assert.equal(greeting[1], 0x02, "two methods offered");
        assert.deepEqual([...greeting.subarray(2, 4)], [0x00, 0x02]);

        const auth = transcript[1];
        assert.ok(auth !== undefined);
        assert.equal(auth[0], 0x01, "sub-negotiation version");
        assert.equal(auth[1], 4, "username length");
        assert.equal(auth.subarray(2, 6).toString("utf8"), "bayz");
        assert.equal(auth[6], 14, "password length");
        assert.equal(auth.subarray(7, 21).toString("utf8"), "hunter2-secret");
      } finally {
        socket.destroy();
      }
    },
  );
});

test("the password never appears outside the single RFC 1929 field", async () => {
  await withProxy(
    (socket, transcript) => {
      record(socket, transcript);
      let stage = 0;
      socket.on("data", () => {
        if (stage === 0) {
          socket.write(Buffer.from([0x05, 0x02]));
          stage = 1;
        } else if (stage === 1) {
          socket.write(Buffer.from([0x01, 0x00]));
          stage = 2;
        } else if (stage === 2) {
          socket.write(successReply());
          stage = 3;
        }
      });
    },
    async (port, transcript) => {
      const socket = await openSocket(port);
      try {
        await socks5Connect({
          socket,
          target: { host: "api.example.com", port: 443 },
          username: "bayz",
          password: "hunter2-secret",
          timeoutMs: 2000,
        });
        const needle = Buffer.from("hunter2-secret", "utf8");
        const occurrences = transcript.filter((chunk) => chunk.includes(needle));
        assert.equal(occurrences.length, 1, "the password is sent exactly once");
        const connectRequest = transcript[2];
        assert.ok(connectRequest !== undefined);
        assert.equal(connectRequest.includes(needle), false);
      } finally {
        socket.destroy();
      }
    },
  );
});

test("a proxy that offers no acceptable method fails as auth_failed", async () => {
  await withProxy(
    (socket) => {
      socket.on("data", () => socket.write(Buffer.from([0x05, 0xff])));
    },
    async (port) => {
      const socket = await openSocket(port);
      try {
        await assert.rejects(
          socks5Connect({
            socket,
            target: { host: "api.example.com", port: 443 },
            timeoutMs: 2000,
          }),
          expectCode("auth_failed"),
        );
      } finally {
        socket.destroy();
      }
    },
  );
});

test("a proxy selecting a method that was never offered is a protocol error", async () => {
  await withProxy(
    (socket) => {
      // 0x02 was not offered because no username is configured.
      socket.on("data", () => socket.write(Buffer.from([0x05, 0x02])));
    },
    async (port) => {
      const socket = await openSocket(port);
      try {
        await assert.rejects(
          socks5Connect({
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

test("a rejected username/password is auth_failed", async () => {
  await withProxy(
    (socket) => {
      let stage = 0;
      socket.on("data", () => {
        if (stage === 0) {
          socket.write(Buffer.from([0x05, 0x02]));
          stage = 1;
        } else {
          socket.write(Buffer.from([0x01, 0x01]));
        }
      });
    },
    async (port) => {
      const socket = await openSocket(port);
      try {
        await assert.rejects(
          socks5Connect({
            socket,
            target: { host: "api.example.com", port: 443 },
            username: "bayz",
            password: "wrong",
            timeoutMs: 2000,
          }),
          expectCode("auth_failed"),
        );
      } finally {
        socket.destroy();
      }
    },
  );
});

test("username auth without a password is refused before any bytes are sent", async () => {
  await withProxy(
    (socket, transcript) => record(socket, transcript),
    async (port, transcript) => {
      const socket = await openSocket(port);
      try {
        await assert.rejects(
          socks5Connect({
            socket,
            target: { host: "api.example.com", port: 443 },
            username: "bayz",
            timeoutMs: 2000,
          }),
          expectCode("password_missing"),
        );
        assert.equal(transcript.length, 0, "no greeting may be sent");
      } finally {
        socket.destroy();
      }
    },
  );
});

test("every CONNECT reply code maps to a fixed error code", async () => {
  const mapping: Array<[number, string]> = [
    [0x01, "proxy_error"],
    [0x02, "forbidden"],
    [0x03, "unreachable"],
    [0x04, "unreachable"],
    [0x05, "refused"],
    [0x06, "timeout"],
    [0x07, "unsupported_operation"],
    [0x08, "unsupported_operation"],
    [0x42, "protocol_error"],
  ];

  for (const [reply, code] of mapping) {
    await withProxy(
      (socket) => {
        let stage = 0;
        socket.on("data", () => {
          if (stage === 0) {
            socket.write(Buffer.from([0x05, 0x00]));
            stage = 1;
          } else {
            socket.write(
              Buffer.from([0x05, reply, 0x00, 0x01, 0, 0, 0, 0, 0, 0]),
            );
          }
        });
      },
      async (port) => {
        const socket = await openSocket(port);
        try {
          await assert.rejects(
            socks5Connect({
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

test("a wrong protocol version in either reply is a protocol error", async () => {
  await withProxy(
    (socket) => {
      socket.on("data", () => socket.write(Buffer.from([0x04, 0x00])));
    },
    async (port) => {
      const socket = await openSocket(port);
      try {
        await assert.rejects(
          socks5Connect({
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

test("a truncated reply followed by FIN is a protocol error, not a hang", async () => {
  await withProxy(
    (socket) => {
      let stage = 0;
      socket.on("data", () => {
        if (stage === 0) {
          socket.write(Buffer.from([0x05, 0x00]));
          stage = 1;
        } else {
          socket.write(Buffer.from([0x05, 0x00, 0x00]));
          socket.end();
        }
      });
    },
    async (port) => {
      const socket = await openSocket(port);
      try {
        await assert.rejects(
          socks5Connect({
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

test("an immediate FIN before any reply is a protocol error", async () => {
  await withProxy(
    (socket) => {
      socket.on("data", () => socket.end());
    },
    async (port) => {
      const socket = await openSocket(port);
      try {
        await assert.rejects(
          socks5Connect({
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

test("a proxy that never answers is bounded by the timeout", async () => {
  await withProxy(
    () => {
      // Accept and stay silent.
    },
    async (port) => {
      const socket = await openSocket(port);
      const started = Date.now();
      try {
        await assert.rejects(
          socks5Connect({
            socket,
            target: { host: "api.example.com", port: 443 },
            timeoutMs: 200,
          }),
          expectCode("timeout"),
        );
        assert.ok(Date.now() - started < 5000, "the timeout must bound the wait");
      } finally {
        socket.destroy();
      }
    },
  );
});

test("target address types are encoded per RFC 1928", async () => {
  const cases: Array<[string, number[]]> = [
    ["127.0.0.1", [0x01, 127, 0, 0, 1]],
    ["api.example.com", [0x03, 15]],
    ["[::1]", [0x04, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]],
  ];

  for (const [host, expectedPrefix] of cases) {
    await withProxy(
      (socket, transcript) => {
        record(socket, transcript);
        let stage = 0;
        socket.on("data", () => {
          if (stage === 0) {
            socket.write(Buffer.from([0x05, 0x00]));
            stage = 1;
          } else if (stage === 1) {
            socket.write(successReply());
            stage = 2;
          }
        });
      },
      async (port, transcript) => {
        const socket = await openSocket(port);
        try {
          await socks5Connect({
            socket,
            target: { host, port: 443 },
            timeoutMs: 2000,
          });
          const request = transcript[1];
          assert.ok(request !== undefined);
          assert.deepEqual([...request.subarray(0, 3)], [0x05, 0x01, 0x00]);
          assert.deepEqual(
            [...request.subarray(3, 3 + expectedPrefix.length)],
            expectedPrefix,
            `address encoding for ${host}`,
          );
          assert.deepEqual(
            [...request.subarray(request.length - 2)],
            [0x01, 0xbb],
            "port is big-endian",
          );
        } finally {
          socket.destroy();
        }
      },
    );
  }
});

test("an over-long target hostname is refused before any bytes are sent", async () => {
  await withProxy(
    (socket, transcript) => record(socket, transcript),
    async (port, transcript) => {
      const socket = await openSocket(port);
      try {
        // 254 characters: past the DNS limit, and therefore also past the
        // single-byte length prefix the SOCKS5 domain field uses.
        const host = `${"a".repeat(61)}.${"b".repeat(61)}.${"c".repeat(61)}.${"d".repeat(61)}.example`;
        assert.ok(host.length > 253);
        await assert.rejects(
          socks5Connect({
            socket,
            target: { host, port: 443 },
            timeoutMs: 2000,
          }),
          expectCode("invalid_proxy_config"),
        );
        assert.equal(transcript.length, 0);
      } finally {
        socket.destroy();
      }
    },
  );
});

test("a target host that is really a URL is refused before any bytes are sent", async () => {
  await withProxy(
    (socket, transcript) => record(socket, transcript),
    async (port, transcript) => {
      const socket = await openSocket(port);
      try {
        for (const host of [
          "https://api.example.com",
          "api.example.com/v1",
          "api.example.com\r\nX: y",
        ]) {
          await assert.rejects(
            socks5Connect({ socket, target: { host, port: 443 }, timeoutMs: 2000 }),
            expectCode("invalid_proxy_config"),
          );
        }
        assert.equal(transcript.length, 0, "no greeting may reach a hostile target");
      } finally {
        socket.destroy();
      }
    },
  );
});

test("bound-address forms in the reply are consumed without eating payload", async () => {
  const replies: Buffer[] = [
    Buffer.from([0x05, 0x00, 0x00, 0x01, 1, 2, 3, 4, 0x00, 0x50]),
    Buffer.concat([
      Buffer.from([0x05, 0x00, 0x00, 0x03, 0x03]),
      Buffer.from("a.b", "utf8"),
      Buffer.from([0x00, 0x50]),
    ]),
    Buffer.concat([
      Buffer.from([0x05, 0x00, 0x00, 0x04]),
      Buffer.alloc(16, 0x11),
      Buffer.from([0x00, 0x50]),
    ]),
  ];

  for (const reply of replies) {
    await withProxy(
      (socket) => {
        let stage = 0;
        socket.on("data", () => {
          if (stage === 0) {
            socket.write(Buffer.from([0x05, 0x00]));
            stage = 1;
          } else if (stage === 1) {
            // The payload is appended to the reply in one write, which is exactly
            // the case a naive "read whatever arrived" implementation gets wrong.
            socket.write(Buffer.concat([reply, Buffer.from("PAYLOAD", "utf8")]));
            stage = 2;
          }
        });
      },
      async (port) => {
        const socket = await openSocket(port);
        try {
          const tunneled = await socks5Connect({
            socket,
            target: { host: "api.example.com", port: 443 },
            timeoutMs: 2000,
          });
          const received = await new Promise<string>((resolve) => {
            const chunks: Buffer[] = [];
            tunneled.on("data", (chunk) => {
              chunks.push(Buffer.from(chunk));
              const text = Buffer.concat(chunks).toString("utf8");
              if (text.includes("PAYLOAD")) {
                resolve(text);
              }
            });
          });
          assert.equal(received, "PAYLOAD", "no handshake byte may leak into the stream");
        } finally {
          socket.destroy();
        }
      },
    );
  }
});

test("payload written after the handshake reaches the proxy byte-exact", async () => {
  await withProxy(
    (socket, transcript) => {
      record(socket, transcript);
      let stage = 0;
      socket.on("data", () => {
        if (stage === 0) {
          socket.write(Buffer.from([0x05, 0x00]));
          stage = 1;
        } else if (stage === 1) {
          socket.write(successReply());
          stage = 2;
        }
      });
    },
    async (port, transcript) => {
      const socket = await openSocket(port);
      try {
        const tunneled = await socks5Connect({
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
