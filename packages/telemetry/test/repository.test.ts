import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openDatabase, type SqlDatabase } from "@bayz/storage";
import {
  DEFAULT_ATTEMPT_RETENTION,
  DEFAULT_REQUEST_RETENTION,
  createUsageRepository,
  normalizeUsageEvent,
  type UsageRepository,
} from "../src/index.js";

const PROMPT = "PROMPT-SENTINEL-must-never-be-persisted";
const COMPLETION = "COMPLETION-SENTINEL-must-never-be-persisted";
const CREDENTIAL = "sk-repo-credential-must-never-be-persisted";

function freshRepository(
  options: { requestRetention?: number; attemptRetention?: number } = {},
): { repo: UsageRepository; db: SqlDatabase; close(): void } {
  const dir = join(mkdtempSync(join(tmpdir(), "bayz-usage-repo-")), ".bayz");
  const database = openDatabase({ dataDir: dir });
  return {
    repo: createUsageRepository(database.db, options),
    db: database.db,
    close: () => database.close(),
  };
}

let seq = 0;
function event(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  seq += 1;
  return {
    kind: "request.completed",
    requestId: `req_${seq}`,
    occurredAt: new Date(Date.now() - seq).toISOString(),
    routeId: "r1",
    providerId: "p1",
    proxyId: "x1",
    model: "gpt-4o",
    routingMode: "combo",
    latencyMs: 100 + seq,
    attempts: 1,
    promptTokens: 10,
    completionTokens: 5,
    cachedTokens: 2,
    ...overrides,
  };
}

test("a completed request round-trips as metadata only", () => {
  const ctx = freshRepository();
  try {
    ctx.repo.record(normalizeUsageEvent(event({ requestId: "req_rt" }))!);
    const rows = ctx.repo.recentRequests(10);
    assert.equal(rows.length, 1);
    const row = rows[0]!;
    assert.equal(row.requestId, "req_rt");
    assert.equal(row.model, "gpt-4o");
    assert.equal(row.providerId, "p1");
    assert.equal(row.proxyId, "x1");
    assert.equal(row.routingMode, "combo");
    assert.equal(row.outcome, "ok");
    assert.equal(row.promptTokens, 10);
    assert.equal(row.failureCategory, undefined);
  } finally {
    ctx.close();
  }
});

test("the stored table has no column able to hold content", () => {
  const ctx = freshRepository();
  try {
    for (const table of ["usage_requests", "usage_attempts"]) {
      const columns = ctx.db
        .prepare(`SELECT name FROM pragma_table_info('${table}')`)
        .all()
        .map((row) => String(row.name).toLowerCase());
      assert.ok(columns.length > 0, `${table} must exist`);
      for (const forbidden of [
        "prompt",
        "prompts",
        "completion",
        "content",
        "message",
        "messages",
        "body",
        "request_body",
        "response_body",
        "system_prompt",
        "tool_arguments",
        "authorization",
        "credential",
        "api_key",
        "password",
        "token",
        "secret",
        "cookie",
        "error_body",
        "error_message",
        "detail",
      ]) {
        assert.equal(
          columns.includes(forbidden),
          false,
          `${table} must not have a ${forbidden} column`,
        );
      }
    }
  } finally {
    ctx.close();
  }
});

test("an attempt event is stored separately and names its provider", () => {
  const ctx = freshRepository();
  try {
    ctx.repo.record(
      normalizeUsageEvent(
        event({ kind: "provider.attempted", requestId: "req_att", providerId: "p2" }),
      )!,
    );
    const attempts = ctx.repo.recentAttempts(10);
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0]!.providerId, "p2");
    assert.equal(attempts[0]!.outcome, "ok");
    // An attempt is not a request row.
    assert.equal(ctx.repo.recentRequests(10).length, 0);
  } finally {
    ctx.close();
  }
});

test("a failed request records a normalized category and no upstream text", () => {
  const ctx = freshRepository();
  try {
    ctx.repo.record(
      normalizeUsageEvent(
        event({
          kind: "request.failed",
          requestId: "req_fail",
          failureCategory: `upstream_error ${CREDENTIAL} <html>`,
        }),
      )!,
    );
    const row = ctx.repo.recentRequests(10)[0]!;
    assert.equal(row.outcome, "failed");
    assert.equal(row.failureCategory, "unknown_error");

    const dumped = JSON.stringify(
      ctx.db.prepare("SELECT * FROM usage_requests").all(),
    );
    assert.equal(dumped.includes(CREDENTIAL), false);
    assert.equal(dumped.includes("<html>"), false);
  } finally {
    ctx.close();
  }
});

test("unknown token counts persist as null and read back as unknown", () => {
  const ctx = freshRepository();
  try {
    ctx.repo.record(
      normalizeUsageEvent(
        event({
          requestId: "req_unknown",
          promptTokens: undefined,
          completionTokens: undefined,
          cachedTokens: undefined,
        }),
      )!,
    );
    const row = ctx.repo.recentRequests(10)[0]!;
    assert.equal(row.promptTokens, undefined);
    assert.equal(row.completionTokens, undefined);
    assert.equal(row.cachedTokens, undefined);

    const raw = ctx.db.prepare("SELECT prompt_tokens FROM usage_requests").get();
    assert.equal(raw?.prompt_tokens, null, "unknown must be NULL, never 0");
  } finally {
    ctx.close();
  }
});

test("a genuine zero token count is preserved distinctly from unknown", () => {
  const ctx = freshRepository();
  try {
    ctx.repo.record(
      normalizeUsageEvent(event({ requestId: "req_zero", promptTokens: 0 }))!,
    );
    assert.equal(ctx.repo.recentRequests(10)[0]!.promptTokens, 0);
  } finally {
    ctx.close();
  }
});

test("re-recording the same request id replaces rather than duplicates", () => {
  const ctx = freshRepository();
  try {
    ctx.repo.record(normalizeUsageEvent(event({ requestId: "req_dup", latencyMs: 10 }))!);
    ctx.repo.record(normalizeUsageEvent(event({ requestId: "req_dup", latencyMs: 20 }))!);
    const rows = ctx.repo.recentRequests(10);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.latencyMs, 20);
  } finally {
    ctx.close();
  }
});

test("recent requests are newest first and bounded by the limit", () => {
  const ctx = freshRepository();
  try {
    for (let index = 0; index < 12; index += 1) {
      ctx.repo.record(
        normalizeUsageEvent(
          event({
            requestId: `req_ord_${index}`,
            occurredAt: new Date(Date.now() - (12 - index) * 1000).toISOString(),
          }),
        )!,
      );
    }
    const rows = ctx.repo.recentRequests(5);
    assert.equal(rows.length, 5);
    assert.equal(rows[0]!.requestId, "req_ord_11");
    for (let index = 1; index < rows.length; index += 1) {
      assert.ok(rows[index - 1]!.occurredAt >= rows[index]!.occurredAt);
    }
  } finally {
    ctx.close();
  }
});

test("a hostile limit is clamped rather than trusted", () => {
  const ctx = freshRepository();
  try {
    ctx.repo.record(normalizeUsageEvent(event())!);
    for (const limit of [0, -1, 1.5, Number.NaN, 1_000_000, "50" as unknown as number]) {
      const rows = ctx.repo.recentRequests(limit);
      assert.ok(Array.isArray(rows), `limit must be handled: ${String(limit)}`);
      assert.ok(rows.length <= 200);
    }
  } finally {
    ctx.close();
  }
});

test("retention prunes the oldest usage requests to the configured bound", () => {
  const ctx = freshRepository({ requestRetention: 5 });
  try {
    for (let index = 0; index < 20; index += 1) {
      ctx.repo.record(
        normalizeUsageEvent(
          event({
            requestId: `req_ret_${index}`,
            occurredAt: new Date(Date.now() - (20 - index) * 1000).toISOString(),
          }),
        )!,
      );
    }
    const count = Number(
      ctx.db.prepare("SELECT COUNT(*) AS n FROM usage_requests").get()?.n,
    );
    assert.equal(count, 5, "retention must bound stored rows");

    // The survivors are the newest, not an arbitrary five.
    const ids = ctx.repo.recentRequests(10).map((row) => row.requestId);
    assert.deepEqual(ids, [
      "req_ret_19",
      "req_ret_18",
      "req_ret_17",
      "req_ret_16",
      "req_ret_15",
    ]);
  } finally {
    ctx.close();
  }
});

test("retention prunes attempts independently of requests", () => {
  const ctx = freshRepository({ requestRetention: 100, attemptRetention: 4 });
  try {
    for (let index = 0; index < 15; index += 1) {
      ctx.repo.record(
        normalizeUsageEvent(
          event({
            kind: "provider.attempted",
            requestId: `req_a_${index}`,
            providerId: `p${index % 3}`,
            occurredAt: new Date(Date.now() - (15 - index) * 1000).toISOString(),
          }),
        )!,
      );
    }
    assert.equal(
      Number(ctx.db.prepare("SELECT COUNT(*) AS n FROM usage_attempts").get()?.n),
      4,
    );
  } finally {
    ctx.close();
  }
});

test("retention never touches providers, proxies, routes, or secrets", () => {
  const ctx = freshRepository({ requestRetention: 2, attemptRetention: 2 });
  try {
    // Seed the domain tables retention must never see.
    ctx.db
      .prepare(
        `INSERT INTO providers
           (id, kind, display_name, base_url, enabled, config_json, created_at, updated_at)
         VALUES ('keep-p', 'openai-compatible', 'Keep', 'https://example.com', 1, '{}',
                 '2026-08-26T00:00:00.000Z', '2026-08-26T00:00:00.000Z')`,
      )
      .run();
    ctx.db
      .prepare(
        `INSERT INTO proxies
           (id, kind, host, port, username, enabled, config_json, created_at, updated_at)
         VALUES ('keep-x', 'socks5', '127.0.0.1', 1080, NULL, 1, '{}',
                 '2026-08-26T00:00:00.000Z', '2026-08-26T00:00:00.000Z')`,
      )
      .run();
    ctx.db
      .prepare(
        `INSERT INTO routes
           (id, model, provider_id, proxy_id, priority, enabled, config_json, created_at, updated_at)
         VALUES ('keep-r', 'gpt-4o', 'keep-p', 'keep-x', 100, 1, '{}',
                 '2026-08-26T00:00:00.000Z', '2026-08-26T00:00:00.000Z')`,
      )
      .run();
    const bytes = new Uint8Array([1, 2, 3]);
    ctx.db
      .prepare(
        `INSERT INTO secrets
           (name, version, algorithm, kdf, key_id, wrapped_dek, wrap_iv, wrap_tag,
            ciphertext, iv, tag, created_at, updated_at)
         VALUES ('keep-secret', 1, 'aes-256-gcm', 'none', 'kek_x', ?, ?, ?, ?, ?, ?,
                 '2026-08-26T00:00:00.000Z', '2026-08-26T00:00:00.000Z')`,
      )
      .run(bytes, bytes, bytes, bytes, bytes, bytes);

    // Drive far more usage than retention allows.
    for (let index = 0; index < 30; index += 1) {
      ctx.repo.record(normalizeUsageEvent(event({ requestId: `req_p_${index}` }))!);
      ctx.repo.record(
        normalizeUsageEvent(
          event({ kind: "provider.attempted", requestId: `req_p_${index}`, providerId: "p1" }),
        )!,
      );
    }

    for (const [table, id] of [
      ["providers", "keep-p"],
      ["proxies", "keep-x"],
      ["routes", "keep-r"],
    ] as const) {
      assert.equal(
        Number(
          ctx.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE id = ?`).get(id)?.n,
        ),
        1,
        `${table} must be untouched by usage retention`,
      );
    }
    assert.equal(
      Number(
        ctx.db.prepare("SELECT COUNT(*) AS n FROM secrets WHERE name = ?").get("keep-secret")
          ?.n,
      ),
      1,
      "secrets must be untouched by usage retention",
    );
    assert.equal(
      Number(ctx.db.prepare("SELECT COUNT(*) AS n FROM usage_requests").get()?.n),
      2,
    );
  } finally {
    ctx.close();
  }
});

test("a malformed retention configuration falls back to the documented default", () => {
  for (const bogus of [0, -5, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 10_000_000]) {
    const ctx = freshRepository({ requestRetention: bogus, attemptRetention: bogus });
    try {
      // Retention can never be disabled by a bad value.
      assert.ok(ctx.repo.requestRetention() > 0);
      assert.ok(ctx.repo.requestRetention() <= DEFAULT_REQUEST_RETENTION * 10);
      assert.ok(ctx.repo.attemptRetention() > 0);
      assert.ok(ctx.repo.attemptRetention() <= DEFAULT_ATTEMPT_RETENTION * 10);
    } finally {
      ctx.close();
    }
  }
});

test("the default retention bounds are finite and documented", () => {
  const ctx = freshRepository();
  try {
    assert.equal(ctx.repo.requestRetention(), DEFAULT_REQUEST_RETENTION);
    assert.equal(ctx.repo.attemptRetention(), DEFAULT_ATTEMPT_RETENTION);
    assert.ok(DEFAULT_REQUEST_RETENTION > 0 && Number.isFinite(DEFAULT_REQUEST_RETENTION));
  } finally {
    ctx.close();
  }
});

test("no seeded sentinel reaches the database through the repository", () => {
  const ctx = freshRepository();
  try {
    // Every content-bearing key an upstream might attach, all at once.
    ctx.repo.record(
      normalizeUsageEvent({
        ...event({ requestId: "req_sent" }),
        prompt: PROMPT,
        messages: [{ role: "user", content: PROMPT }],
        completion: COMPLETION,
        body: PROMPT,
        authorization: `Bearer ${CREDENTIAL}`,
        apiKey: CREDENTIAL,
      })!,
    );
    const dumped = JSON.stringify([
      ...ctx.db.prepare("SELECT * FROM usage_requests").all(),
      ...ctx.db.prepare("SELECT * FROM usage_attempts").all(),
    ]);
    for (const sentinel of [PROMPT, COMPLETION, CREDENTIAL]) {
      assert.equal(dumped.includes(sentinel), false, `${sentinel.slice(0, 18)} leaked`);
    }
  } finally {
    ctx.close();
  }
});

test("aggregate counts are computed from stored metadata only", () => {
  const ctx = freshRepository();
  try {
    ctx.repo.record(normalizeUsageEvent(event({ requestId: "req_s1", promptTokens: 10 }))!);
    ctx.repo.record(normalizeUsageEvent(event({ requestId: "req_s2", promptTokens: 20 }))!);
    ctx.repo.record(
      normalizeUsageEvent(
        event({ kind: "request.failed", requestId: "req_s3", failureCategory: "rate_limited" }),
      )!,
    );

    const summary = ctx.repo.summarize(Date.now() - 3600_000);
    assert.equal(summary.totalRequests, 3);
    assert.equal(summary.okRequests, 2);
    assert.equal(summary.failedRequests, 1);
    assert.equal(summary.promptTokens, 40);
    // Cost is not invented: there is no pricing table in Bayz.
    assert.equal(summary.costAvailable, false);
    assert.equal(typeof summary.costReason, "string");
  } finally {
    ctx.close();
  }
});

test("a summary distinguishes zero tokens from unreported tokens", () => {
  const ctx = freshRepository();
  try {
    ctx.repo.record(
      normalizeUsageEvent(
        event({ requestId: "req_none", promptTokens: undefined, completionTokens: undefined }),
      )!,
    );
    const summary = ctx.repo.summarize(Date.now() - 3600_000);
    assert.equal(summary.promptTokens, undefined, "no reports means unknown, not 0");
    assert.equal(summary.tokenReports, 0);

    ctx.repo.record(normalizeUsageEvent(event({ requestId: "req_zero2", promptTokens: 0 }))!);
    const next = ctx.repo.summarize(Date.now() - 3600_000);
    assert.equal(next.promptTokens, 0, "a real zero is a known total");
    assert.equal(next.tokenReports, 1);
  } finally {
    ctx.close();
  }
});

test("provider participation is derived from attempt metadata", () => {
  const ctx = freshRepository();
  try {
    for (const [providerId, kind] of [
      ["p1", "provider.attempted"],
      ["p1", "provider.attempted"],
      ["p2", "provider.failed"],
      ["p3", "provider.attempted"],
    ] as const) {
      ctx.repo.record(
        normalizeUsageEvent(
          event({ kind, providerId, failureCategory: "unreachable" }),
        )!,
      );
    }
    const stats = ctx.repo.providerActivity(Date.now() - 3600_000);
    const byId = new Map(stats.map((entry) => [entry.providerId, entry]));
    assert.equal(byId.get("p1")?.attempts, 2);
    assert.equal(byId.get("p1")?.failures, 0);
    assert.equal(byId.get("p2")?.failures, 1);
    assert.equal(byId.get("p3")?.attempts, 1);
  } finally {
    ctx.close();
  }
});

test("a driver failure surfaces as a storage error, not a silent drop", () => {
  const ctx = freshRepository();
  try {
    ctx.db.exec("DROP TABLE usage_requests");
    assert.throws(
      () => ctx.repo.record(normalizeUsageEvent(event({ requestId: "req_drv" }))!),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        (error as { code: unknown }).code === "storage_unavailable",
    );
  } finally {
    ctx.close();
  }
});
