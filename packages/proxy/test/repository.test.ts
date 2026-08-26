import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { StorageError, openDatabase, type SqlDatabase } from "@bayz/storage";
import { ProxyError, createProxyRepository } from "../src/index.js";
import type { ProxyRepository } from "../src/repository.js";

function freshRepository(): {
  repo: ProxyRepository;
  db: SqlDatabase;
  close(): void;
} {
  const dir = join(mkdtempSync(join(tmpdir(), "bayz-proxy-repo-")), ".bayz");
  const database = openDatabase({ dataDir: dir });
  return {
    repo: createProxyRepository(database.db),
    db: database.db,
    close: () => database.close(),
  };
}

const BASE = {
  kind: "socks5" as const,
  host: "127.0.0.1",
  port: 1080,
};

test("a created proxy round-trips with normalized fields and defaults", () => {
  const ctx = freshRepository();
  try {
    const created = ctx.repo.create({ id: "tor", ...BASE });
    assert.equal(created.id, "tor");
    assert.equal(created.kind, "socks5");
    assert.equal(created.host, "127.0.0.1");
    assert.equal(created.port, 1080);
    assert.equal(created.username, undefined);
    assert.equal(created.enabled, true);
    assert.deepEqual(created.config, {
      connectTimeoutMs: 10000,
      healthCheckHost: "1.1.1.1",
      healthCheckPort: 443,
    });
    assert.match(created.createdAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(created.updatedAt, created.createdAt);
    assert.deepEqual(ctx.repo.get("tor"), created);
  } finally {
    ctx.close();
  }
});

test("the host is lowercased on the way in", () => {
  const ctx = freshRepository();
  try {
    const created = ctx.repo.create({
      id: "norm",
      ...BASE,
      host: "Proxy.EXAMPLE.com",
    });
    assert.equal(created.host, "proxy.example.com");
  } finally {
    ctx.close();
  }
});

test("a username is optional and stored in cleartext", () => {
  const ctx = freshRepository();
  try {
    const created = ctx.repo.create({ id: "auth", ...BASE, username: "bayz" });
    assert.equal(created.username, "bayz");
    const row = ctx.db.prepare("SELECT username FROM proxies WHERE id = ?").get("auth");
    assert.equal(row?.username, "bayz");
  } finally {
    ctx.close();
  }
});

test("an unusable username is rejected", () => {
  const ctx = freshRepository();
  try {
    for (const username of [
      "",
      "   ",
      "u".repeat(256),
      "user\r\nX",
      "user\u0000",
      42 as unknown as string,
    ]) {
      assert.throws
        (() => ctx.repo.create({ id: "bad-user", ...BASE, username }),
        (error: unknown) =>
          error instanceof ProxyError && error.code === "invalid_proxy_config",
        `username must be rejected: ${String(username)}`,
      );
    }
    assert.equal(ctx.repo.list().length, 0);
  } finally {
    ctx.close();
  }
});

test("an invalid id is rejected before any row is written", () => {
  const ctx = freshRepository();
  try {
    assert.throws(
      () => ctx.repo.create({ id: "bad'; DROP TABLE proxies; --", ...BASE }),
      (error: unknown) =>
        error instanceof ProxyError && error.code === "invalid_proxy_id",
    );
    assert.equal(ctx.repo.list().length, 0);
    assert.equal(
      Number(ctx.db.prepare("SELECT COUNT(*) AS n FROM proxies").get()?.n),
      0,
    );
  } finally {
    ctx.close();
  }
});

test("a URL in the host field is refused", () => {
  const ctx = freshRepository();
  try {
    for (const host of [
      "socks5://127.0.0.1",
      "http://proxy.example.com",
      "user@proxy.example.com",
      "proxy.example.com:1080",
    ]) {
      assert.throws(
        () => ctx.repo.create({ id: "url-host", ...BASE, host }),
        (error: unknown) =>
          error instanceof ProxyError && error.code === "invalid_proxy_config",
      );
    }
  } finally {
    ctx.close();
  }
});

test("a duplicate id is reported as proxy_already_exists", () => {
  const ctx = freshRepository();
  try {
    ctx.repo.create({ id: "dup", ...BASE });
    assert.throws(
      () => ctx.repo.create({ id: "dup", ...BASE }),
      (error: unknown) =>
        error instanceof ProxyError && error.code === "proxy_already_exists",
    );
    assert.equal(ctx.repo.list().length, 1);
  } finally {
    ctx.close();
  }
});

test("an unknown kind is rejected", () => {
  const ctx = freshRepository();
  try {
    assert.throws(
      () => ctx.repo.create({ id: "socks4", ...BASE, kind: "socks4" as never }),
      (error: unknown) =>
        error instanceof ProxyError && error.code === "invalid_proxy_config",
    );
  } finally {
    ctx.close();
  }
});

test("get and require disagree only on how absence is reported", () => {
  const ctx = freshRepository();
  try {
    assert.equal(ctx.repo.get("ghost"), undefined);
    assert.throws(
      () => ctx.repo.require("ghost"),
      (error: unknown) =>
        error instanceof ProxyError && error.code === "proxy_not_found",
    );
    assert.throws(
      () => ctx.repo.get("Ghost"),
      (error: unknown) =>
        error instanceof ProxyError && error.code === "invalid_proxy_id",
    );
  } finally {
    ctx.close();
  }
});

test("list returns proxies ordered by id", () => {
  const ctx = freshRepository();
  try {
    for (const id of ["zeta", "alpha", "mid"]) {
      ctx.repo.create({ id, ...BASE });
    }
    assert.deepEqual(
      ctx.repo.list().map((proxy) => proxy.id),
      ["alpha", "mid", "zeta"],
    );
  } finally {
    ctx.close();
  }
});

test("update changes only the supplied fields and advances updated_at", () => {
  const ctx = freshRepository();
  try {
    const created = ctx.repo.create({ id: "up", ...BASE, username: "old" });
    const updated = ctx.repo.update("up", {
      port: 9050,
      enabled: false,
      config: { connectTimeoutMs: 2000 },
    });

    assert.equal(updated.port, 9050);
    assert.equal(updated.enabled, false);
    assert.equal(updated.host, created.host, "untouched fields survive");
    assert.equal(updated.username, "old");
    assert.equal(updated.kind, created.kind);
    assert.equal(updated.createdAt, created.createdAt);
    assert.deepEqual(updated.config, {
      connectTimeoutMs: 2000,
      healthCheckHost: "1.1.1.1",
      healthCheckPort: 443,
    });
    assert.ok(Date.parse(updated.updatedAt) >= Date.parse(created.updatedAt));
    assert.deepEqual(ctx.repo.get("up"), updated);
  } finally {
    ctx.close();
  }
});

test("a username can be cleared with null", () => {
  const ctx = freshRepository();
  try {
    ctx.repo.create({ id: "clear", ...BASE, username: "bayz" });
    const updated = ctx.repo.update("clear", { username: null });
    assert.equal(updated.username, undefined);
    assert.equal(ctx.repo.require("clear").username, undefined);
  } finally {
    ctx.close();
  }
});

test("a rejected update leaves the stored row untouched", () => {
  const ctx = freshRepository();
  try {
    ctx.repo.create({ id: "atomic", ...BASE });
    assert.throws(
      () => ctx.repo.update("atomic", { host: "socks5://evil.example.com" }),
      (error: unknown) =>
        error instanceof ProxyError && error.code === "invalid_proxy_config",
    );
    assert.equal(ctx.repo.require("atomic").host, "127.0.0.1");
  } finally {
    ctx.close();
  }
});

test("update cannot change the id or the kind", () => {
  const ctx = freshRepository();
  try {
    ctx.repo.create({ id: "fixed", ...BASE });
    ctx.repo.update("fixed", { id: "other", kind: "http" } as never);
    assert.equal(ctx.repo.require("fixed").kind, "socks5");
    assert.equal(ctx.repo.get("other"), undefined);
  } finally {
    ctx.close();
  }
});

test("update on a missing proxy reports proxy_not_found", () => {
  const ctx = freshRepository();
  try {
    assert.throws(
      () => ctx.repo.update("ghost", { enabled: false }),
      (error: unknown) =>
        error instanceof ProxyError && error.code === "proxy_not_found",
    );
  } finally {
    ctx.close();
  }
});

test("delete reports whether a row was removed", () => {
  const ctx = freshRepository();
  try {
    ctx.repo.create({ id: "gone", ...BASE });
    assert.equal(ctx.repo.delete("gone"), true);
    assert.equal(ctx.repo.delete("gone"), false);
    assert.equal(ctx.repo.get("gone"), undefined);
  } finally {
    ctx.close();
  }
});

test("a corrupted config_json surfaces as invalid_proxy_config", () => {
  const ctx = freshRepository();
  try {
    ctx.repo.create({ id: "corrupt", ...BASE });
    ctx.db
      .prepare("UPDATE proxies SET config_json = ? WHERE id = ?")
      .run('{"connectTimeoutMs":1}', "corrupt");
    assert.throws(
      () => ctx.repo.require("corrupt"),
      (error: unknown) =>
        error instanceof ProxyError &&
        error.code === "invalid_proxy_config" &&
        error.stage === "load-config",
    );

    ctx.db
      .prepare("UPDATE proxies SET config_json = ? WHERE id = ?")
      .run("not json", "corrupt");
    assert.throws(
      () => ctx.repo.require("corrupt"),
      (error: unknown) =>
        error instanceof ProxyError && error.code === "invalid_proxy_config",
    );
  } finally {
    ctx.close();
  }
});

test("stored rows contain no password-like value", () => {
  const ctx = freshRepository();
  try {
    ctx.repo.create({ id: "clean", ...BASE, username: "bayz" });
    const row = ctx.db.prepare("SELECT * FROM proxies WHERE id = ?").get("clean");
    assert.ok(row !== undefined);
    assert.equal(Object.keys(row).length, 9);
    const serialized = JSON.stringify(row).toLowerCase();
    assert.equal(serialized.includes("password"), false);
    assert.equal(serialized.includes("basic "), false);
  } finally {
    ctx.close();
  }
});

test("a driver-level failure stays a StorageError, not a ProxyError", () => {
  const ctx = freshRepository();
  try {
    ctx.repo.create({ id: "drv", ...BASE });
    ctx.db.exec("DROP TABLE proxies");
    assert.throws(
      () => ctx.repo.list(),
      (error: unknown) =>
        error instanceof StorageError && error.code === "storage_unavailable",
    );
  } finally {
    ctx.close();
  }
});
