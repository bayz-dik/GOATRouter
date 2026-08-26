import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openSecretStorage, type SecretStorage } from "@bayz/storage";
import { ProxyError, createProxyManager, type ProxyManager } from "../src/index.js";

const KEY = Buffer.alloc(32, 0x33).toString("hex");

type Ctx = {
  manager: ProxyManager;
  storage: SecretStorage;
  logs: Array<Record<string, unknown>>;
};

function context(): Ctx {
  const dir = join(mkdtempSync(join(tmpdir(), "bayz-proxy-mgr-")), ".bayz");
  const logs: Array<Record<string, unknown>> = [];
  const storage = openSecretStorage({
    dataDir: dir,
    env: { BAYZ_MASTER_KEY: KEY },
  });
  return {
    manager: createProxyManager({ storage, logger: (payload) => logs.push(payload) }),
    storage,
    logs,
  };
}

/** A CONNECT proxy that answers 200 once the header block is complete. */
async function withConnectProxy(
  run: (port: number) => Promise<void>,
  status = "200 OK",
): Promise<void> {
  const accepted = new Set<Socket>();
  const server: Server = createServer((socket) => {
    accepted.add(socket);
    socket.on("close", () => accepted.delete(socket));
    socket.on("error", () => {});
    let seen = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      seen = Buffer.concat([seen, Buffer.from(chunk)]);
      if (seen.includes("\r\n\r\n")) {
        socket.write(`HTTP/1.1 ${status}\r\n\r\n`);
        seen = Buffer.alloc(0);
      }
    });
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

const BASE = { kind: "socks5" as const, host: "127.0.0.1", port: 1080 };

test("a proxy can be created, listed, fetched, updated, and deleted", () => {
  const ctx = context();
  try {
    const created = ctx.manager.createProxy({ id: "tor", ...BASE });
    assert.equal(created.id, "tor");
    assert.equal(created.enabled, true);
    assert.equal(created.passwordPresent, false);

    assert.deepEqual(
      ctx.manager.listProxies().map((proxy) => proxy.id),
      ["tor"],
    );
    assert.deepEqual(ctx.manager.getProxy("tor"), created);

    const updated = ctx.manager.updateProxy("tor", { enabled: false });
    assert.equal(updated.enabled, false);

    assert.equal(ctx.manager.deleteProxy("tor"), true);
    assert.equal(ctx.manager.getProxy("tor"), undefined);
    assert.equal(ctx.manager.deleteProxy("tor"), false);
  } finally {
    ctx.manager.close();
  }
});

test("a proxy view reports password presence without exposing the value", () => {
  const ctx = context();
  try {
    ctx.manager.createProxy({ id: "auth", ...BASE, username: "bayz" });
    ctx.manager.setPassword("auth", "hunter2-secret");

    const view = ctx.manager.requireProxy("auth");
    assert.equal(view.passwordPresent, true);
    assert.equal(view.username, "bayz");
    const serialized = JSON.stringify(view);
    assert.equal(serialized.includes("hunter2-secret"), false);
    for (const forbidden of ["password", "secret", "credential"]) {
      assert.equal(Object.keys(view).includes(forbidden), false);
    }
  } finally {
    ctx.manager.close();
  }
});

test("passwords are stored, replaced, queried, and deleted", () => {
  const ctx = context();
  try {
    ctx.manager.createProxy({ id: "p", ...BASE, username: "bayz" });
    assert.equal(ctx.manager.hasPassword("p"), false);
    assert.equal(ctx.manager.deletePassword("p"), false);

    ctx.manager.setPassword("p", "first");
    assert.equal(ctx.manager.hasPassword("p"), true);
    ctx.manager.setPassword("p", "second");
    assert.equal(ctx.manager.hasPassword("p"), true);

    assert.equal(ctx.manager.deletePassword("p"), true);
    assert.equal(ctx.manager.hasPassword("p"), false);
  } finally {
    ctx.manager.close();
  }
});

test("a blank password is refused", () => {
  const ctx = context();
  try {
    ctx.manager.createProxy({ id: "p", ...BASE, username: "bayz" });
    for (const value of ["", "   ", 42 as unknown as string, undefined as unknown as string]) {
      assert.throws(
        () => ctx.manager.setPassword("p", value),
        (error: unknown) =>
          error instanceof ProxyError &&
          (error.code === "password_missing" ||
            error.code === "invalid_proxy_config"),
      );
    }
    assert.equal(ctx.manager.hasPassword("p"), false);
  } finally {
    ctx.manager.close();
  }
});

test("a password on a proxy with no username is refused", () => {
  const ctx = context();
  try {
    ctx.manager.createProxy({ id: "anon", ...BASE });
    assert.throws(
      () => ctx.manager.setPassword("anon", "orphan"),
      (error: unknown) =>
        error instanceof ProxyError && error.code === "invalid_proxy_config",
      "a password without a username could never be sent",
    );
    assert.equal(ctx.manager.hasPassword("anon"), false);
  } finally {
    ctx.manager.close();
  }
});

test("operations on an unknown proxy report proxy_not_found", () => {
  const ctx = context();
  try {
    for (const call of [
      () => ctx.manager.setPassword("ghost", "x"),
      () => ctx.manager.hasPassword("ghost"),
      () => ctx.manager.deletePassword("ghost"),
      () => ctx.manager.requireProxy("ghost"),
      () => ctx.manager.agentFor("ghost"),
    ]) {
      assert.throws(
        call,
        (error: unknown) =>
          error instanceof ProxyError && error.code === "proxy_not_found",
      );
    }
  } finally {
    ctx.manager.close();
  }
});

test("deleting a proxy removes its password too", () => {
  const ctx = context();
  try {
    ctx.manager.createProxy({ id: "doomed", ...BASE, username: "bayz" });
    ctx.manager.setPassword("doomed", "hunter2");
    assert.equal(ctx.storage.list().length, 1);

    ctx.manager.deleteProxy("doomed");
    assert.equal(
      ctx.storage.list().length,
      0,
      "an orphan password would outlive its owner",
    );
  } finally {
    ctx.manager.close();
  }
});

test("checkProxy succeeds through a real CONNECT proxy and reports latency", async () => {
  await withConnectProxy(async (port) => {
    const ctx = context();
    try {
      ctx.manager.createProxy({
        id: "live",
        kind: "http",
        host: "127.0.0.1",
        port,
        config: { connectTimeoutMs: 3000, healthCheckHost: "api.example.com", healthCheckPort: 443 },
      });
      const result = await ctx.manager.checkProxy("live");
      assert.equal(result.ok, true);
      assert.equal(result.kind, "http");
      assert.equal(typeof result.latencyMs, "number");
      assert.ok(result.latencyMs >= 0);
    } finally {
      ctx.manager.close();
    }
  });
});

test("checkProxy surfaces a proxy refusal as a fixed code", async () => {
  await withConnectProxy(async (port) => {
    const ctx = context();
    try {
      ctx.manager.createProxy({
        id: "denied",
        kind: "http",
        host: "127.0.0.1",
        port,
        config: { connectTimeoutMs: 3000, healthCheckHost: "api.example.com", healthCheckPort: 443 },
      });
      await assert.rejects(
        ctx.manager.checkProxy("denied"),
        (error: unknown) =>
          error instanceof ProxyError && error.code === "forbidden",
      );
    } finally {
      ctx.manager.close();
    }
  }, "403 Forbidden");
});

test("a disabled proxy is never dialled", async () => {
  const ctx = context();
  try {
    ctx.manager.createProxy({ id: "off", ...BASE, enabled: false });
    await assert.rejects(
      ctx.manager.checkProxy("off"),
      (error: unknown) =>
        error instanceof ProxyError && error.code === "unsupported_operation",
    );
    assert.throws(
      () => ctx.manager.agentFor("off"),
      (error: unknown) =>
        error instanceof ProxyError && error.code === "unsupported_operation",
    );
  } finally {
    ctx.manager.close();
  }
});

test("a proxy needing auth without a stored password fails before dialling", async () => {
  const ctx = context();
  try {
    ctx.manager.createProxy({ id: "needs-auth", ...BASE, username: "bayz" });
    await assert.rejects(
      ctx.manager.checkProxy("needs-auth"),
      (error: unknown) =>
        error instanceof ProxyError && error.code === "password_missing",
    );
  } finally {
    ctx.manager.close();
  }
});

test("agentFor returns a usable agent for an enabled proxy", () => {
  const ctx = context();
  try {
    ctx.manager.createProxy({ id: "agent", kind: "http", host: "127.0.0.1", port: 8080 });
    const agent = ctx.manager.agentFor("agent");
    assert.equal(typeof agent.destroy, "function");
    agent.destroy();
  } finally {
    ctx.manager.close();
  }
});

test("manager logs carry ids and kinds but never a password", async () => {
  await withConnectProxy(async (port) => {
    const ctx = context();
    try {
      ctx.manager.createProxy({
        id: "logged",
        kind: "http",
        host: "127.0.0.1",
        port,
        username: "bayz",
        config: { connectTimeoutMs: 3000, healthCheckHost: "api.example.com", healthCheckPort: 443 },
      });
      ctx.manager.setPassword("logged", "hunter2-log-sentinel");
      await ctx.manager.checkProxy("logged");
      ctx.manager.updateProxy("logged", { enabled: true });
      ctx.manager.deletePassword("logged");
      ctx.manager.deleteProxy("logged");

      const serialized = JSON.stringify(ctx.logs);
      assert.equal(serialized.includes("hunter2-log-sentinel"), false);
      assert.equal(serialized.includes(KEY), false);
      assert.ok(ctx.logs.some((entry) => entry.event === "proxy_created"));
      assert.ok(ctx.logs.some((entry) => entry.event === "proxy_checked"));
    } finally {
      ctx.manager.close();
    }
  });
});

test("close releases the underlying storage", () => {
  const ctx = context();
  ctx.manager.createProxy({ id: "p", ...BASE });
  ctx.manager.close();
  assert.throws(() => ctx.manager.listProxies());
});
