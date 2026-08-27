import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { StorageError, openDatabase, type SqlDatabase } from "@bayz/storage";
import { createProviderRepository } from "@bayz/providers";
import { createProxyRepository } from "@bayz/proxy";
import { RouterError, createRouteRepository } from "../src/index.js";
import type { RouteRepository } from "../src/repository.js";

function freshRepository(): {
  repo: RouteRepository;
  db: SqlDatabase;
  close(): void;
} {
  const dir = join(mkdtempSync(join(tmpdir(), "bayz-route-repo-")), ".bayz");
  const database = openDatabase({ dataDir: dir });
  const providers = createProviderRepository(database.db);
  const proxies = createProxyRepository(database.db);

  providers.create({
    id: "p1",
    kind: "openai-compatible",
    displayName: "P1",
    baseUrl: "http://127.0.0.1:11434/v1",
    config: { allowLoopback: true },
  });
  providers.create({
    id: "p2",
    kind: "openai-compatible",
    displayName: "P2",
    baseUrl: "http://127.0.0.1:11435/v1",
    config: { allowLoopback: true },
  });
  proxies.create({ id: "x1", kind: "socks5", host: "127.0.0.1", port: 1080 });

  return {
    repo: createRouteRepository(database.db),
    db: database.db,
    close: () => database.close(),
  };
}

const BASE = { model: "gpt-4o", providerId: "p1" };

test("a created route round-trips with defaults", () => {
  const ctx = freshRepository();
  try {
    const created = ctx.repo.create({ id: "r1", ...BASE });
    assert.equal(created.id, "r1");
    assert.equal(created.model, "gpt-4o");
    assert.equal(created.providerId, "p1");
    assert.equal(created.proxyId, undefined);
    assert.equal(created.priority, 100);
    assert.equal(created.enabled, true);
    assert.deepEqual(created.config, { maxAttempts: 2, requestTimeoutMs: 60000 });
    assert.match(created.createdAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(ctx.repo.get("r1"), created);
  } finally {
    ctx.close();
  }
});

test("a wildcard model pattern is accepted and stored verbatim", () => {
  const ctx = freshRepository();
  try {
    const created = ctx.repo.create({ id: "wild", model: "gpt-4*", providerId: "p1" });
    assert.equal(created.model, "gpt-4*");
  } finally {
    ctx.close();
  }
});

test("a hostile model pattern is refused before any row is written", () => {
  const ctx = freshRepository();
  try {
    for (const model of ["*", "gpt*4", "../../etc/passwd", "", "a b", ".*"]) {
      assert.throws(
        () => ctx.repo.create({ id: "bad-model", model, providerId: "p1" }),
        (error: unknown) =>
          error instanceof RouterError && error.code === "invalid_route_config",
        `model must be rejected: ${model}`,
      );
    }
    assert.equal(ctx.repo.list().length, 0);
  } finally {
    ctx.close();
  }
});

test("an invalid route id is refused with the schema intact", () => {
  const ctx = freshRepository();
  try {
    assert.throws(
      () => ctx.repo.create({ id: "Bad'; DROP TABLE routes; --", ...BASE }),
      (error: unknown) =>
        error instanceof RouterError && error.code === "invalid_route_id",
    );
    assert.equal(
      Number(ctx.db.prepare("SELECT COUNT(*) AS n FROM routes").get()?.n),
      0,
    );
  } finally {
    ctx.close();
  }
});

test("a route naming an unknown provider is refused as a validation error", () => {
  const ctx = freshRepository();
  try {
    assert.throws
      (() => ctx.repo.create({ id: "ghost", model: "gpt-4o", providerId: "nope" }),
      (error: unknown) =>
        error instanceof RouterError && error.code === "invalid_route_config",
    );
  } finally {
    ctx.close();
  }
});

test("a route naming an unknown proxy is refused", () => {
  const ctx = freshRepository();
  try {
    assert.throws(
      () => ctx.repo.create({ id: "ghost-proxy", ...BASE, proxyId: "nope" }),
      (error: unknown) =>
        error instanceof RouterError && error.code === "invalid_route_config",
    );
  } finally {
    ctx.close();
  }
});

test("a proxy binding is stored and reported", () => {
  const ctx = freshRepository();
  try {
    const created = ctx.repo.create({ id: "viax", ...BASE, proxyId: "x1" });
    assert.equal(created.proxyId, "x1");
    assert.equal(ctx.repo.require("viax").proxyId, "x1");
  } finally {
    ctx.close();
  }
});

test("the same model cannot be bound twice to one provider", () => {
  const ctx = freshRepository();
  try {
    ctx.repo.create({ id: "first", ...BASE });
    assert.throws(
      () => ctx.repo.create({ id: "second", ...BASE }),
      (error: unknown) =>
        error instanceof RouterError && error.code === "route_already_exists",
    );
    assert.equal(ctx.repo.list().length, 1);
  } finally {
    ctx.close();
  }
});

test("the same model may be bound to different providers", () => {
  const ctx = freshRepository();
  try {
    ctx.repo.create({ id: "on-p1", model: "gpt-4o", providerId: "p1" });
    ctx.repo.create({ id: "on-p2", model: "gpt-4o", providerId: "p2" });
    assert.equal(ctx.repo.list().length, 2);
  } finally {
    ctx.close();
  }
});

test("a duplicate route id is refused", () => {
  const ctx = freshRepository();
  try {
    ctx.repo.create({ id: "dup", ...BASE });
    assert.throws(
      () => ctx.repo.create({ id: "dup", model: "gpt-4o-mini", providerId: "p1" }),
      (error: unknown) =>
        error instanceof RouterError && error.code === "route_already_exists",
    );
  } finally {
    ctx.close();
  }
});

test("priority and config bounds are enforced", () => {
  const ctx = freshRepository();
  try {
    for (const priority of [-1, 1001, 1.5, "100" as unknown as number]) {
      assert.throws(
        () => ctx.repo.create({ id: "bad-prio", ...BASE, priority }),
        (error: unknown) =>
          error instanceof RouterError && error.code === "invalid_route_config",
        `priority must be rejected: ${String(priority)}`,
      );
    }
    for (const config of [
      { maxAttempts: 0 },
      { maxAttempts: 6 },
      { maxAttempts: 1.5 },
      { requestTimeoutMs: 999 },
      { requestTimeoutMs: 600001 },
      { unknown: true },
      { stream: true },
      { headers: { Authorization: "Bearer x" } },
      "not an object",
      [],
      null,
    ]) {
      assert.throws(
        () => ctx.repo.create({ id: "bad-config", ...BASE, config }),
        (error: unknown) =>
          error instanceof RouterError && error.code === "invalid_route_config",
        `config must be rejected: ${JSON.stringify(config)}`,
      );
    }
    assert.equal(ctx.repo.list().length, 0);
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
        error instanceof RouterError && error.code === "route_not_found",
    );
    assert.throws(
      () => ctx.repo.get("Ghost"),
      (error: unknown) =>
        error instanceof RouterError && error.code === "invalid_route_id",
    );
  } finally {
    ctx.close();
  }
});

test("list returns routes ordered by id", () => {
  const ctx = freshRepository();
  try {
    ctx.repo.create({ id: "zeta", model: "m-z", providerId: "p1" });
    ctx.repo.create({ id: "alpha", model: "m-a", providerId: "p1" });
    ctx.repo.create({ id: "mid", model: "m-m", providerId: "p1" });
    assert.deepEqual(
      ctx.repo.list().map((route) => route.id),
      ["alpha", "mid", "zeta"],
    );
  } finally {
    ctx.close();
  }
});

test("update changes only the supplied fields", () => {
  const ctx = freshRepository();
  try {
    const created = ctx.repo.create({ id: "up", ...BASE });
    const updated = ctx.repo.update("up", { priority: 500, enabled: false });
    assert.equal(updated.priority, 500);
    assert.equal(updated.enabled, false);
    assert.equal(updated.model, created.model);
    assert.equal(updated.providerId, created.providerId);
    assert.equal(updated.createdAt, created.createdAt);
    assert.ok(Date.parse(updated.updatedAt) >= Date.parse(created.updatedAt));
  } finally {
    ctx.close();
  }
});

test("a proxy binding can be attached and cleared", () => {
  const ctx = freshRepository();
  try {
    ctx.repo.create({ id: "toggle", ...BASE });
    assert.equal(ctx.repo.update("toggle", { proxyId: "x1" }).proxyId, "x1");
    assert.equal(ctx.repo.update("toggle", { proxyId: null }).proxyId, undefined);
  } finally {
    ctx.close();
  }
});

test("update cannot change the id, the model, or the provider", () => {
  const ctx = freshRepository();
  try {
    ctx.repo.create({ id: "fixed", ...BASE });
    ctx.repo.update("fixed", {
      id: "other",
      model: "claude-3",
      providerId: "p2",
    } as never);
    const stored = ctx.repo.require("fixed");
    assert.equal(stored.model, "gpt-4o");
    assert.equal(stored.providerId, "p1");
    assert.equal(ctx.repo.get("other"), undefined);
  } finally {
    ctx.close();
  }
});

test("a rejected update leaves the stored row untouched", () => {
  const ctx = freshRepository();
  try {
    ctx.repo.create({ id: "atomic", ...BASE, priority: 200 });
    assert.throws(
      () => ctx.repo.update("atomic", { priority: 5000 }),
      (error: unknown) =>
        error instanceof RouterError && error.code === "invalid_route_config",
    );
    assert.equal(ctx.repo.require("atomic").priority, 200);
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
  } finally {
    ctx.close();
  }
});

test("deleting a provider cascades its routes", () => {
  const ctx = freshRepository();
  try {
    ctx.repo.create({ id: "cascade", ...BASE });
    ctx.db.prepare("DELETE FROM providers WHERE id = ?").run("p1");
    assert.equal(ctx.repo.list().length, 0, "no dangling route may survive");
  } finally {
    ctx.close();
  }
});

test("deleting a proxy degrades the route to direct", () => {
  const ctx = freshRepository();
  try {
    ctx.repo.create({ id: "degrade", ...BASE, proxyId: "x1" });
    ctx.db.prepare("DELETE FROM proxies WHERE id = ?").run("x1");
    const stored = ctx.repo.require("degrade");
    assert.equal(stored.proxyId, undefined);
    assert.equal(stored.enabled, true, "the route must remain usable, just direct");
  } finally {
    ctx.close();
  }
});

test("a corrupted config_json surfaces as invalid_route_config", () => {
  const ctx = freshRepository();
  try {
    ctx.repo.create({ id: "corrupt", ...BASE });
    ctx.db
      .prepare("UPDATE routes SET config_json = ? WHERE id = ?")
      .run('{"maxAttempts":99}', "corrupt");
    assert.throws(
      () => ctx.repo.require("corrupt"),
      (error: unknown) =>
        error instanceof RouterError &&
        error.code === "invalid_route_config" &&
        error.stage === "load-config",
    );

    ctx.db
      .prepare("UPDATE routes SET config_json = ? WHERE id = ?")
      .run("not json", "corrupt");
    assert.throws(
      () => ctx.repo.require("corrupt"),
      (error: unknown) =>
        error instanceof RouterError && error.code === "invalid_route_config",
    );
  } finally {
    ctx.close();
  }
});

test("a row rewritten with a hostile model fails closed on read", () => {
  const ctx = freshRepository();
  try {
    ctx.repo.create({ id: "rewritten", ...BASE });
    ctx.db
      .prepare("UPDATE routes SET model = ? WHERE id = ?")
      .run("../../etc/passwd", "rewritten");
    assert.throws(
      () => ctx.repo.require("rewritten"),
      (error: unknown) =>
        error instanceof RouterError && error.code === "invalid_route_config",
    );
  } finally {
    ctx.close();
  }
});

test("stored rows contain no prompt-like or credential-like value", () => {
  const ctx = freshRepository();
  try {
    ctx.repo.create({ id: "clean", ...BASE });
    const row = ctx.db.prepare("SELECT * FROM routes WHERE id = ?").get("clean");
    assert.ok(row !== undefined);
    // Ten columns after 9E added `force_direct`. Pinned as an exact count so a column
    // able to hold a prompt or a credential cannot be added without this failing.
    assert.equal(Object.keys(row).length, 10);
    assert.equal(row.force_direct, 0);
    const serialized = JSON.stringify(row).toLowerCase();
    for (const forbidden of ["bearer", "sk-", "prompt", "message"]) {
      assert.equal(serialized.includes(forbidden), false);
    }
  } finally {
    ctx.close();
  }
});

test("a driver-level failure stays a StorageError, not a RouterError", () => {
  const ctx = freshRepository();
  try {
    ctx.repo.create({ id: "drv", ...BASE });
    ctx.db.exec("DROP TABLE routes");
    assert.throws(
      () => ctx.repo.list(),
      (error: unknown) =>
        error instanceof StorageError && error.code === "storage_unavailable",
    );
  } finally {
    ctx.close();
  }
});
