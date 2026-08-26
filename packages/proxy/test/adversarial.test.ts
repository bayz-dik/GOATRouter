import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { createServer, connect, type Server, type Socket } from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  StorageError,
  databasePath,
  openSecretStorage,
  type SecretStorage,
} from "@bayz/storage";
import {
  ProxyError,
  createProxyManager,
  socks5Connect,
  type ProxyManager,
} from "../src/index.js";

/**
 * Adversarial suite for proxy support.
 *
 * These tests attack the stored artifacts and the wire parsers directly: a
 * malicious proxy, an operator id crafted for injection, and an attacker with
 * write access to bayz.db.
 */

const KEY = Buffer.alloc(32, 0x5d).toString("hex");
const PASSWORD = "hunter2-PROXY-ADVERSARIAL-must-never-surface";

function context(): {
  manager: ProxyManager;
  storage: SecretStorage;
  dir: string;
  logs: Array<Record<string, unknown>>;
} {
  const dir = join(mkdtempSync(join(tmpdir(), "bayz-proxy-adv-")), ".bayz");
  const logs: Array<Record<string, unknown>> = [];
  const storage = openSecretStorage({
    dataDir: dir,
    env: { BAYZ_MASTER_KEY: KEY },
  });
  return {
    manager: createProxyManager({ storage, logger: (payload) => logs.push(payload) }),
    storage,
    dir,
    logs,
  };
}

function sourceFiles(): string[] {
  const root = new URL("../src/", import.meta.url);
  const files: string[] = [];
  const walk = (relative: string): void => {
    for (const entry of readdirSync(new URL(relative, root), { withFileTypes: true })) {
      if (entry.isDirectory()) {
        walk(`${relative}${entry.name}/`);
      } else if (entry.name.endsWith(".ts")) {
        files.push(readFileSync(new URL(`${relative}${entry.name}`, root), "utf8"));
      }
    }
  };
  walk("");
  return files;
}

async function withHostileProxy(
  logic: (socket: Socket) => void,
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

function openClientSocket(port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port }, () => resolve(socket));
    socket.on("error", reject);
  });
}

const BASE = { kind: "socks5" as const, host: "127.0.0.1", port: 1080 };

test("no password read path exists anywhere in the package source", () => {
  const sources = sourceFiles();
  assert.ok(sources.length >= 8, "the scan must actually find the sources");
  for (const source of sources) {
    assert.equal(
      /getPassword|revealPassword|exportPassword|getCredential/.test(source),
      false,
      "a password accessor would let plaintext leave the manager",
    );
  }
});

test("the manager surface exposes no password accessor", () => {
  const ctx = context();
  try {
    const keys = Object.keys(ctx.manager);
    for (const forbidden of [
      "getPassword",
      "password",
      "credential",
      "secrets",
      "storage",
      "sql",
    ]) {
      assert.equal(keys.includes(forbidden), false, `${forbidden} must not be public`);
    }
  } finally {
    ctx.manager.close();
  }
});

test("a password lives at exactly one scoped physical name", () => {
  const ctx = context();
  try {
    ctx.manager.createProxy({ id: "victim", ...BASE, username: "bayz" });
    ctx.manager.setPassword("victim", PASSWORD);

    assert.deepEqual(
      ctx.storage.list().map((meta) => meta.name),
      ["proxy:victim:password"],
    );
    const view = ctx.storage.inspect("proxy:victim:password");
    assert.equal(
      Buffer.from(view.ciphertext).includes(Buffer.from(PASSWORD, "utf8")),
      false,
    );
  } finally {
    ctx.manager.close();
  }
});

test("a tampered password fails closed instead of reporting absence", () => {
  const ctx = context();
  try {
    ctx.manager.createProxy({ id: "tampered", ...BASE, username: "bayz" });
    ctx.manager.setPassword("tampered", PASSWORD);
    ctx.storage.corruptForTest("proxy:tampered:password", "ciphertext");

    assert.throws(
      () => ctx.manager.hasPassword("tampered"),
      (error: unknown) =>
        error instanceof StorageError && error.code === "secret_corrupt",
      "a tampered password must never read as false",
    );
    assert.throws(
      () => ctx.manager.getProxy("tampered"),
      (error: unknown) =>
        error instanceof StorageError && error.code === "secret_corrupt",
    );
  } finally {
    ctx.manager.close();
  }
});

test("one proxy's password cannot be reached through another proxy", () => {
  const ctx = context();
  try {
    for (const id of ["alpha", "beta"]) {
      ctx.manager.createProxy({ id, ...BASE, username: "bayz" });
    }
    ctx.manager.setPassword("alpha", PASSWORD);
    assert.equal(ctx.manager.hasPassword("alpha"), true);
    assert.equal(ctx.manager.hasPassword("beta"), false);

    ctx.manager.deleteProxy("beta");
    assert.equal(ctx.manager.hasPassword("alpha"), true);
    assert.deepEqual(
      ctx.storage.list().map((meta) => meta.name),
      ["proxy:alpha:password"],
    );
  } finally {
    ctx.manager.close();
  }
});

test("a provider credential and a proxy password never collide", () => {
  const ctx = context();
  try {
    // Same id in two different scopes must remain two different secrets.
    ctx.manager.createProxy({ id: "shared", ...BASE, username: "bayz" });
    ctx.manager.setPassword("shared", PASSWORD);
    ctx.storage.put("provider:shared:api_key", "sk-provider-value");

    assert.equal(ctx.manager.hasPassword("shared"), true);
    assert.equal(ctx.storage.get("provider:shared:api_key"), "sk-provider-value");
    assert.deepEqual(
      ctx.storage.list().map((meta) => meta.name).sort(),
      ["provider:shared:api_key", "proxy:shared:password"],
    );
  } finally {
    ctx.manager.close();
  }
});

test("plaintext passwords are absent from the database bytes and logs", () => {
  const ctx = context();
  try {
    ctx.manager.createProxy({ id: "ondisk", ...BASE, username: "bayz" });
    ctx.manager.setPassword("ondisk", PASSWORD);
  } finally {
    ctx.manager.close();
  }

  let bytes = Buffer.alloc(0);
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      bytes = Buffer.concat([bytes, readFileSync(`${databasePath(ctx.dir)}${suffix}`)]);
    } catch {
      // Sidecar absent.
    }
  }
  assert.equal(bytes.includes(Buffer.from(PASSWORD, "utf8")), false);
  assert.equal(bytes.includes(Buffer.from(KEY, "utf8")), false);
  assert.equal(
    bytes.includes(Buffer.from(Buffer.from(`bayz:${PASSWORD}`).toString("base64"))),
    false,
    "not even a base64 form may be sitting on disk",
  );
  assert.equal(JSON.stringify(ctx.logs).includes(PASSWORD), false);
});

test("injection-shaped ids are rejected and the schema survives", () => {
  const ctx = context();
  try {
    for (const id of [
      "a'; DROP TABLE proxies; --",
      'a" OR 1=1',
      "proxy:other",
      "../../etc/passwd",
      "a\u0000b",
      "a\nb",
    ]) {
      assert.throws(
        () => ctx.manager.createProxy({ id, ...BASE }),
        (error: unknown) =>
          error instanceof ProxyError && error.code === "invalid_proxy_id",
      );
    }
    ctx.manager.createProxy({ id: "survivor", ...BASE });
    assert.deepEqual(
      ctx.manager.listProxies().map((proxy) => proxy.id),
      ["survivor"],
    );
  } finally {
    ctx.manager.close();
  }
});

test("a config that tries to smuggle a command or header is refused", () => {
  const ctx = context();
  try {
    for (const config of [
      { command: "curl evil.example.com" },
      { headers: { "Proxy-Authorization": "Basic abc" } },
      { password: PASSWORD },
      { healthCheckHost: "https://evil.example.com" },
      { healthCheckHost: "evil.example.com\r\nX: y" },
      { connectTimeoutMs: 1 },
    ]) {
      assert.throws(
        () => ctx.manager.createProxy({ id: "cfg", ...BASE, config }),
        (error: unknown) =>
          error instanceof ProxyError && error.code === "invalid_proxy_config",
      );
    }
    assert.equal(ctx.manager.listProxies().length, 0);
  } finally {
    ctx.manager.close();
  }
});

test("a proxy row rewritten with a hostile config fails closed on read", () => {
  const ctx = context();
  try {
    ctx.manager.createProxy({ id: "rewritten", ...BASE });
    ctx.storage.sql
      .prepare("UPDATE proxies SET config_json = ? WHERE id = ?")
      .run('{"healthCheckHost":"https://evil.example.com"}', "rewritten");

    assert.throws(
      () => ctx.manager.requireProxy("rewritten"),
      (error: unknown) =>
        error instanceof ProxyError && error.code === "invalid_proxy_config",
    );
  } finally {
    ctx.manager.close();
  }
});

test("a proxy claiming a huge bound-address length cannot exhaust the client", async () => {
  await withHostileProxy(
    (socket) => {
      let stage = 0;
      socket.on("data", () => {
        if (stage === 0) {
          socket.write(Buffer.from([0x05, 0x00]));
          stage = 1;
        } else if (stage === 1) {
          // Announce a 255-byte domain, then send nothing and hang up. A client
          // that pre-allocated on the announced length, or that waited forever,
          // would be exploitable here.
          socket.write(Buffer.from([0x05, 0x00, 0x00, 0x03, 0xff]));
          socket.end();
          stage = 2;
        }
      });
    },
    async (port) => {
      const socket = await openClientSocket(port);
      try {
        await assert.rejects(
          socks5Connect({
            socket,
            target: { host: "api.example.com", port: 443 },
            timeoutMs: 1000,
          }),
          (error: unknown) =>
            error instanceof ProxyError && error.code === "protocol_error",
        );
      } finally {
        socket.destroy();
      }
    },
  );
});

test("a proxy flooding garbage is bounded and fails closed", async () => {
  await withHostileProxy(
    (socket) => {
      socket.on("data", () => {
        // Never a valid version byte, forever.
        const flood = setInterval(() => {
          if (socket.writable) {
            socket.write(Buffer.alloc(8192, 0x41));
          }
        }, 5);
        socket.on("close", () => clearInterval(flood));
      });
    },
    async (port) => {
      const socket = await openClientSocket(port);
      try {
        await assert.rejects(
          socks5Connect({
            socket,
            target: { host: "api.example.com", port: 443 },
            timeoutMs: 1000,
          }),
          (error: unknown) =>
            error instanceof ProxyError && error.code === "protocol_error",
        );
      } finally {
        socket.destroy();
      }
    },
  );
});

test("a proxy replying with a zero-length domain is handled without hanging", async () => {
  await withHostileProxy(
    (socket) => {
      let stage = 0;
      socket.on("data", () => {
        if (stage === 0) {
          socket.write(Buffer.from([0x05, 0x00]));
          stage = 1;
        } else if (stage === 1) {
          socket.write(
            Buffer.concat([
              Buffer.from([0x05, 0x00, 0x00, 0x03, 0x00, 0x00, 0x50]),
              Buffer.from("PAYLOAD", "utf8"),
            ]),
          );
          stage = 2;
        }
      });
    },
    async (port) => {
      const socket = await openClientSocket(port);
      try {
        const tunneled = await socks5Connect({
          socket,
          target: { host: "api.example.com", port: 443 },
          timeoutMs: 1000,
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
        assert.equal(received, "PAYLOAD");
      } finally {
        socket.destroy();
      }
    },
  );
});

test("a hostile proxy cannot learn the password when auth is not negotiated", async () => {
  const transcript: Buffer[] = [];
  await withHostileProxy(
    (socket) => {
      socket.on("data", (chunk) => transcript.push(Buffer.from(chunk)));
      let stage = 0;
      socket.on("data", () => {
        if (stage === 0) {
          // Select "no auth" even though the client offered username/password.
          socket.write(Buffer.from([0x05, 0x00]));
          stage = 1;
        } else if (stage === 1) {
          socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          stage = 2;
        }
      });
    },
    async (port) => {
      const socket = await openClientSocket(port);
      try {
        await socks5Connect({
          socket,
          target: { host: "api.example.com", port: 443 },
          username: "bayz",
          password: PASSWORD,
          timeoutMs: 1000,
        });
        const sent = Buffer.concat(transcript);
        assert.equal(
          sent.includes(Buffer.from(PASSWORD, "utf8")),
          false,
          "a proxy that declines auth must never receive the password",
        );
      } finally {
        socket.destroy();
      }
    },
  );
});
