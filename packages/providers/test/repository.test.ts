import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { StorageError, openDatabase, type SqlDatabase } from "@bayz/storage";
import { ProviderError, createProviderRepository } from "../src/index.js";
import type { ProviderRepository } from "../src/repository.js";

function freshRepository(): { repo: ProviderRepository; db: SqlDatabase; close(): void } {
  const dir = join(mkdtempSync(join(tmpdir(), "bayz-provider-repo-")), ".bayz");
  const database = openDatabase({ dataDir: dir });
  return {
    repo: createProviderRepository(database.db),
    db: database.db,
    close: () => database.close(),
  };
}

const BASE = {
  kind: "openai-compatible" as const,
  displayName: "Local Llama",
  baseUrl: "http://127.0.0.1:11434/v1",
};

test("a created provider round-trips with normalized fields and defaults", () => {
  const ctx = freshRepository();
  try {
    const created = ctx.repo.create({ id: "local", ...BASE });
    assert.equal(created.id, "local");
    assert.equal(created.kind, "openai-compatible");
    assert.equal(created.displayName, "Local Llama");
    assert.equal(created.baseUrl, "http://127.0.0.1:11434/v1");
    assert.equal(created.enabled, true);
    assert.deepEqual(created.config, {
      timeoutMs: 30000,
      discoveryPath: "/v1/models",
      modelLimit: 100,
    });
    assert.match(created.createdAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(created.updatedAt, created.createdAt);
    assert.deepEqual(ctx.repo.get("local"), created);
  } finally {
    ctx.close();
  }
});

test("the base url is normalized on the way in", () => {
  const ctx = freshRepository();
  try {
    const created = ctx.repo.create({
      id: "norm",
      ...BASE,
      baseUrl: "HTTPS://API.Example.COM/v1/?key=leak#frag",
    });
    assert.equal(created.baseUrl, "https://api.example.com/v1");
  } finally {
    ctx.close();
  }
});

test("openrouter falls back to its documented base url", () => {
  const ctx = freshRepository();
  try {
    const created = ctx.repo.create({
      id: "or",
      kind: "openrouter",
      displayName: "OpenRouter",
    });
    assert.equal(created.baseUrl, "https://openrouter.ai/api");
  } finally {
    ctx.close();
  }
});

test("kinds without a default base url must be given one", () => {
  const ctx = freshRepository();
  try {
    for (const kind of ["openai-compatible", "gemini", "codex-oauth"] as const) {
      assert.throws(
        () => ctx.repo.create({ id: `k-${kind}`, kind, displayName: "X" }),
        (error: unknown) =>
          error instanceof ProviderError &&
          error.code === "invalid_provider_config",
      );
    }
  } finally {
    ctx.close();
  }
});

test("gemini providers default to the v1beta discovery path", () => {
  const ctx = freshRepository();
  try {
    const created = ctx.repo.create({
      id: "gem",
      kind: "gemini",
      displayName: "Gemini",
      baseUrl: "https://generativelanguage.googleapis.com",
    });
    assert.equal(created.config.discoveryPath, "/v1beta/models");
  } finally {
    ctx.close();
  }
});

test("an invalid id is rejected before any row is written", () => {
  const ctx = freshRepository();
  try {
    assert.throws(
      () => ctx.repo.create({ id: "Bad Id; DROP TABLE providers", ...BASE }),
      (error: unknown) =>
        error instanceof ProviderError && error.code === "invalid_provider_id",
    );
    assert.equal(ctx.repo.list().length, 0);
    // The table must still exist and be usable after a hostile id.
    assert.equal(
      Number(ctx.db.prepare("SELECT COUNT(*) AS n FROM providers").get()?.n),
      0,
    );
  } finally {
    ctx.close();
  }
});

test("a duplicate id is reported as provider_already_exists", () => {
  const ctx = freshRepository();
  try {
    ctx.repo.create({ id: "dup", ...BASE });
    assert.throws(
      () => ctx.repo.create({ id: "dup", ...BASE }),
      (error: unknown) =>
        error instanceof ProviderError &&
        error.code === "provider_already_exists",
    );
    assert.equal(ctx.repo.list().length, 1);
  } finally {
    ctx.close();
  }
});

test("an empty or oversized display name is rejected", () => {
  const ctx = freshRepository();
  try {
    for (const displayName of ["", "   ", "n".repeat(129), 42 as unknown as string]) {
      assert.throws(
        () => ctx.repo.create({ id: "dn", ...BASE, displayName }),
        (error: unknown) =>
          error instanceof ProviderError &&
          error.code === "invalid_provider_config",
      );
    }
    assert.equal(ctx.repo.list().length, 0);
  } finally {
    ctx.close();
  }
});

test("an unknown kind is rejected", () => {
  const ctx = freshRepository();
  try {
    assert.throws(
      () =>
        ctx.repo.create({
          id: "unknown-kind",
          kind: "anthropic" as never,
          displayName: "X",
          baseUrl: "https://example.com",
        }),
      (error: unknown) =>
        error instanceof ProviderError &&
        error.code === "invalid_provider_config",
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
        error instanceof ProviderError && error.code === "provider_not_found",
    );
    // An invalid id is a validation failure, not a lookup miss.
    assert.throws(
      () => ctx.repo.get("Ghost"),
      (error: unknown) =>
        error instanceof ProviderError && error.code === "invalid_provider_id",
    );
  } finally {
    ctx.close();
  }
});

test("list returns providers ordered by id", () => {
  const ctx = freshRepository();
  try {
    for (const id of ["zeta", "alpha", "mid"]) {
      ctx.repo.create({ id, ...BASE });
    }
    assert.deepEqual(
      ctx.repo.list().map((provider) => provider.id),
      ["alpha", "mid", "zeta"],
    );
  } finally {
    ctx.close();
  }
});

test("update changes only the supplied fields and advances updated_at", () => {
  const ctx = freshRepository();
  try {
    const created = ctx.repo.create({ id: "up", ...BASE });
    const updated = ctx.repo.update("up", {
      displayName: "Renamed",
      enabled: false,
      config: { timeoutMs: 5000 },
    });

    assert.equal(updated.displayName, "Renamed");
    assert.equal(updated.enabled, false);
    assert.equal(updated.baseUrl, created.baseUrl, "untouched fields survive");
    assert.equal(updated.kind, created.kind);
    assert.equal(updated.createdAt, created.createdAt);
    assert.deepEqual(updated.config, {
      timeoutMs: 5000,
      discoveryPath: "/v1/models",
      modelLimit: 100,
    });
    assert.ok(
      Date.parse(updated.updatedAt) >= Date.parse(created.updatedAt),
      "updated_at must not go backwards",
    );
    assert.deepEqual(ctx.repo.get("up"), updated);
  } finally {
    ctx.close();
  }
});

test("update normalizes a new base url and rejects a bad one atomically", () => {
  const ctx = freshRepository();
  try {
    ctx.repo.create({ id: "upn", ...BASE });
    assert.equal(
      ctx.repo.update("upn", { baseUrl: "https://API.Example.com/v2/" }).baseUrl,
      "https://api.example.com/v2",
    );
    assert.throws(
      () => ctx.repo.update("upn", { baseUrl: "ftp://example.com" }),
      (error: unknown) =>
        error instanceof ProviderError &&
        error.code === "invalid_provider_config",
    );
    assert.equal(
      ctx.repo.require("upn").baseUrl,
      "https://api.example.com/v2",
      "a rejected update must leave the stored row untouched",
    );
  } finally {
    ctx.close();
  }
});

test("update cannot change the id or the kind", () => {
  const ctx = freshRepository();
  try {
    ctx.repo.create({ id: "fixed", ...BASE });
    ctx.repo.update("fixed", {
      id: "other",
      kind: "gemini",
    } as never);
    const stored = ctx.repo.require("fixed");
    assert.equal(stored.kind, "openai-compatible");
    assert.equal(ctx.repo.get("other"), undefined);
  } finally {
    ctx.close();
  }
});

test("update on a missing provider reports provider_not_found", () => {
  const ctx = freshRepository();
  try {
    assert.throws(
      () => ctx.repo.update("ghost", { enabled: false }),
      (error: unknown) =>
        error instanceof ProviderError && error.code === "provider_not_found",
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

test("a corrupted config_json surfaces as invalid_provider_config", () => {
  const ctx = freshRepository();
  try {
    ctx.repo.create({ id: "corrupt", ...BASE });
    ctx.db
      .prepare("UPDATE providers SET config_json = ? WHERE id = ?")
      .run('{"timeoutMs":1}', "corrupt");
    assert.throws(
      () => ctx.repo.require("corrupt"),
      (error: unknown) =>
        error instanceof ProviderError &&
        error.code === "invalid_provider_config" &&
        error.stage === "load-config",
    );

    ctx.db
      .prepare("UPDATE providers SET config_json = ? WHERE id = ?")
      .run("not json at all", "corrupt");
    assert.throws(
      () => ctx.repo.require("corrupt"),
      (error: unknown) =>
        error instanceof ProviderError &&
        error.code === "invalid_provider_config",
    );
  } finally {
    ctx.close();
  }
});

test("a tampered enabled value never decodes to true by accident", () => {
  const ctx = freshRepository();
  try {
    ctx.repo.create({ id: "flag", ...BASE, enabled: false });
    assert.equal(ctx.repo.require("flag").enabled, false);
    ctx.db.prepare("UPDATE providers SET enabled = 1 WHERE id = ?").run("flag");
    assert.equal(ctx.repo.require("flag").enabled, true);
  } finally {
    ctx.close();
  }
});

test("stored rows contain no credential-like value", () => {
  const ctx = freshRepository();
  try {
    ctx.repo.create({ id: "clean", ...BASE });
    const row = ctx.db.prepare("SELECT * FROM providers WHERE id = ?").get("clean");
    assert.ok(row !== undefined);
    const serialized = JSON.stringify(row);
    assert.equal(serialized.toLowerCase().includes("bearer"), false);
    assert.equal(serialized.includes("sk-"), false);
    assert.equal(Object.keys(row).length, 8);
  } finally {
    ctx.close();
  }
});

test("a driver-level failure stays a StorageError, not a ProviderError", () => {
  const ctx = freshRepository();
  try {
    ctx.repo.create({ id: "drv", ...BASE });
    ctx.db.exec("DROP TABLE providers");
    assert.throws(
      () => ctx.repo.list(),
      (error: unknown) =>
        error instanceof StorageError && error.code === "storage_unavailable",
    );
  } finally {
    ctx.close();
  }
});
