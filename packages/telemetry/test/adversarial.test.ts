import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { databasePath, openDatabase, type SqlDatabase } from "@bayz/storage";
import {
  createUsageRepository,
  normalizeUsageEvent,
  usageRowFields,
  type UsageRepository,
} from "../src/index.js";

/**
 * Adversarial suite for the telemetry boundary and its persistence.
 *
 * These tests attack the guarantee directly: they try to get content, credentials,
 * and arbitrary text into a stored row, and they attack the bounds that keep
 * storage finite.
 */

const PROMPT = "PROMPT_CONTENT_SENTINEL_adv";
const COMPLETION = "COMPLETION_CONTENT_SENTINEL_adv";
const PROVIDER_CREDENTIAL = "PROVIDER_CREDENTIAL_SENTINEL_adv";
const PROXY_CREDENTIAL = "PROXY_CREDENTIAL_SENTINEL_adv";
const AUTHORIZATION = "BAYZ_AUTHORIZATION_SENTINEL_adv";
const UPSTREAM_ERROR = "UPSTREAM_ERROR_BODY_SENTINEL_adv";

const ALL_SENTINELS = [
  PROMPT,
  COMPLETION,
  PROVIDER_CREDENTIAL,
  PROXY_CREDENTIAL,
  AUTHORIZATION,
  UPSTREAM_ERROR,
];

function freshRepository(): {
  repo: UsageRepository;
  db: SqlDatabase;
  dir: string;
  close(): void;
} {
  const dir = join(mkdtempSync(join(tmpdir(), "bayz-telemetry-adv-")), ".bayz");
  const database = openDatabase({ dataDir: dir });
  return {
    repo: createUsageRepository(database.db),
    db: database.db,
    dir,
    close: () => database.close(),
  };
}

function sourceFiles(): Array<{ name: string; text: string }> {
  const root = new URL("../src/", import.meta.url);
  const files: Array<{ name: string; text: string }> = [];
  const walk = (relative: string): void => {
    for (const entry of readdirSync(new URL(relative, root), { withFileTypes: true })) {
      if (entry.isDirectory()) {
        walk(`${relative}${entry.name}/`);
      } else if (entry.name.endsWith(".ts")) {
        files.push({
          name: `${relative}${entry.name}`,
          text: readFileSync(new URL(`${relative}${entry.name}`, root), "utf8"),
        });
      }
    }
  };
  walk("");
  return files;
}

/** Strip comments so a rule tests code, not the prose explaining the rule. */
function codeOnly(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}

test("no SQL in the telemetry package names a content-bearing column", () => {
  const sources = sourceFiles();
  assert.ok(sources.length >= 3, "the scan must find the sources");
  for (const source of sources) {
    const statements = codeOnly(source.text).match(/(INSERT INTO|UPDATE)[\s\S]{0,600}/gi) ?? [];
    for (const statement of statements) {
      /*
       * Whole-word column names only. `completion_tokens` and `prompt_tokens` are
       * counts, not content, so a substring match on "completion" or "prompt"
       * would flag the very fields that make the metadata-only design useful.
       * What must never appear is a column that could hold the text itself.
       */
      const lowered = statement.toLowerCase();
      for (const forbidden of [
        "prompt_text",
        "prompt_content",
        "completion_text",
        "completion_content",
        "content",
        "message_text",
        "messages",
        "request_body",
        "response_body",
        "raw_body",
        "system_prompt",
        "tool_arguments",
        "authorization",
        "credential",
        "api_key",
        "password",
        "cookie",
        "secret",
        "error_body",
        "error_message",
      ]) {
        assert.equal(
          new RegExp(`\\b${forbidden}\\b`).test(lowered),
          false,
          `${source.name} must not persist ${forbidden}`,
        );
      }
    }
  }
});

test("the telemetry package exposes no credential accessor", () => {
  for (const source of sourceFiles()) {
    assert.equal(
      /getCredential|getPassword|revealCredential|revealPassword|apiToken/.test(
        codeOnly(source.text),
      ),
      false,
      `${source.name} must not touch credential material`,
    );
  }
});

test("an event carrying thirty hostile keys yields a clean row", () => {
  const hostile: Record<string, unknown> = {
    kind: "request.completed",
    requestId: "req_hostile",
    occurredAt: new Date().toISOString(),
    model: "gpt-4o",
    routingMode: "combo",
    latencyMs: 10,
    attempts: 1,
  };
  // Every plausible name an upstream object might carry.
  const contentKeys = [
    "prompt",
    "prompts",
    "messages",
    "message",
    "content",
    "completion",
    "completions",
    "choices",
    "body",
    "requestBody",
    "responseBody",
    "rawBody",
    "systemPrompt",
    "system",
    "tools",
    "toolArguments",
    "functionCall",
    "authorization",
    "Authorization",
    "apiKey",
    "api_key",
    "credential",
    "credentials",
    "password",
    "token",
    "accessToken",
    "cookie",
    "secret",
    "upstreamError",
    "stack",
  ];
  for (const key of contentKeys) {
    hostile[key] = `${PROMPT}/${COMPLETION}/${PROVIDER_CREDENTIAL}`;
  }

  const row = normalizeUsageEvent(hostile)!;
  assert.deepEqual(Object.keys(row).sort(), [...usageRowFields()].sort());
  const serialized = JSON.stringify(row);
  for (const sentinel of ALL_SENTINELS) {
    assert.equal(serialized.includes(sentinel), false, `${sentinel} survived`);
  }
});

test("a hostile event cannot reach the database through the repository", () => {
  const ctx = freshRepository();
  try {
    const hostile = {
      kind: "request.completed",
      requestId: "req_db_hostile",
      occurredAt: new Date().toISOString(),
      model: "gpt-4o",
      routingMode: "combo",
      latencyMs: 10,
      attempts: 1,
      prompt: PROMPT,
      completion: COMPLETION,
      authorization: `Bearer ${AUTHORIZATION}`,
      credential: PROVIDER_CREDENTIAL,
      proxyPassword: PROXY_CREDENTIAL,
      upstreamError: UPSTREAM_ERROR,
    };
    ctx.repo.record(normalizeUsageEvent(hostile)!);

    // Dump every column of every usage table and scan the bytes.
    const dumped = JSON.stringify([
      ...ctx.db.prepare("SELECT * FROM usage_requests").all(),
      ...ctx.db.prepare("SELECT * FROM usage_attempts").all(),
    ]);
    for (const sentinel of ALL_SENTINELS) {
      assert.equal(dumped.includes(sentinel), false, `${sentinel} reached storage`);
    }
  } finally {
    ctx.close();
  }
});

test("no sentinel reaches the database file, WAL, or SHM", () => {
  const ctx = freshRepository();
  try {
    for (let index = 0; index < 40; index += 1) {
      ctx.repo.record(
        normalizeUsageEvent({
          kind: index % 3 === 0 ? "request.failed" : "request.completed",
          requestId: `req_bytes_${index}`,
          occurredAt: new Date().toISOString(),
          providerId: "p1",
          routeId: "r1",
          model: "gpt-4o",
          routingMode: "combo",
          latencyMs: 10 + index,
          attempts: 1,
          failureCategory: `${UPSTREAM_ERROR} rate_limited`,
          prompt: PROMPT,
          completion: COMPLETION,
          authorization: AUTHORIZATION,
        })!,
      );
    }
  } finally {
    ctx.close();
  }

  let bytes = Buffer.alloc(0);
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      bytes = Buffer.concat([bytes, readFileSync(`${databasePath(ctx.dir)}${suffix}`)]);
    } catch {
      // Sidecar absent.
    }
  }
  assert.ok(bytes.byteLength > 0, "the scan must read real bytes");
  for (const sentinel of ALL_SENTINELS) {
    assert.equal(
      bytes.includes(Buffer.from(sentinel, "utf8")),
      false,
      `${sentinel} found on disk`,
    );
  }
  // Metadata is present, proving the scan reads real content.
  assert.equal(bytes.includes(Buffer.from("req_bytes_39", "utf8")), true);
});

test("prototype pollution through a parsed event cannot poison anything", () => {
  const ctx = freshRepository();
  try {
    const raw = JSON.parse(
      `{"kind":"request.completed","requestId":"req_proto","occurredAt":"${new Date().toISOString()}","model":"gpt-4o","routingMode":"direct","latencyMs":1,"attempts":1,"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted2":true}}}`,
    ) as Record<string, unknown>;
    const row = normalizeUsageEvent(raw);
    assert.ok(row !== undefined);
    ctx.repo.record(row);

    assert.equal(({} as Record<string, unknown>).polluted, undefined);
    assert.equal(({} as Record<string, unknown>).polluted2, undefined);
    assert.equal((row as unknown as Record<string, unknown>).polluted, undefined);
  } finally {
    ctx.close();
  }
});

test("hostile identifier shapes are refused or degraded, never stored", () => {
  const ctx = freshRepository();
  try {
    const shapes = [
      "a".repeat(500),
      `${PROMPT} ${COMPLETION}`,
      "<script>alert(1)</script>",
      "'; DROP TABLE usage_requests; --",
      "../../etc/passwd",
      "a\u0000b",
      "a\r\nb",
      "\u202eevil",
    ];
    for (const shape of shapes) {
      // requestId is required: an invalid one drops the event entirely.
      assert.equal(
        normalizeUsageEvent({
          kind: "request.completed",
          requestId: shape,
          occurredAt: new Date().toISOString(),
          model: "gpt-4o",
          routingMode: "direct",
          latencyMs: 1,
          attempts: 1,
        }),
        undefined,
        `requestId must be refused: ${shape.slice(0, 24)}`,
      );

      // Optional ids degrade to absent.
      const row = normalizeUsageEvent({
        kind: "request.completed",
        requestId: "req_ok",
        occurredAt: new Date().toISOString(),
        routeId: shape,
        providerId: shape,
        proxyId: shape,
        model: "gpt-4o",
        routingMode: "direct",
        latencyMs: 1,
        attempts: 1,
      })!;
      assert.equal(row.routeId, undefined);
      assert.equal(row.providerId, undefined);
      assert.equal(row.proxyId, undefined);
      ctx.repo.record(row);
    }

    const dumped = JSON.stringify(ctx.db.prepare("SELECT * FROM usage_requests").all());
    for (const sentinel of ALL_SENTINELS) {
      assert.equal(dumped.includes(sentinel), false);
    }
    assert.equal(dumped.includes("DROP TABLE"), false);
    assert.equal(dumped.includes("<script>"), false);
  } finally {
    ctx.close();
  }
});

test("a SQL-injection-shaped model name is refused before any statement runs", () => {
  const ctx = freshRepository();
  try {
    assert.equal(
      normalizeUsageEvent({
        kind: "request.completed",
        requestId: "req_sqli",
        occurredAt: new Date().toISOString(),
        model: "gpt-4o'; DROP TABLE usage_requests; --",
        routingMode: "direct",
        latencyMs: 1,
        attempts: 1,
      }),
      undefined,
    );
    // The table is still there and usable.
    ctx.repo.record(
      normalizeUsageEvent({
        kind: "request.completed",
        requestId: "req_after",
        occurredAt: new Date().toISOString(),
        model: "gpt-4o",
        routingMode: "direct",
        latencyMs: 1,
        attempts: 1,
      })!,
    );
    assert.equal(ctx.repo.recentRequests(10).length, 1);
  } finally {
    ctx.close();
  }
});

test("timestamp abuse cannot pin a row above retention forever", () => {
  const dir = join(mkdtempSync(join(tmpdir(), "bayz-telemetry-ts-")), ".bayz");
  const database = openDatabase({ dataDir: dir });
  const repo = createUsageRepository(database.db, { requestRetention: 3 });
  try {
    // A far-future timestamp would otherwise sort above every real row.
    repo.record(
      normalizeUsageEvent({
        kind: "request.completed",
        requestId: "req_future",
        occurredAt: new Date(Date.now() + 400 * 24 * 3600_000).toISOString(),
        model: "gpt-4o",
        routingMode: "direct",
        latencyMs: 1,
        attempts: 1,
      })!,
    );
    for (let index = 0; index < 6; index += 1) {
      repo.record(
        normalizeUsageEvent({
          kind: "request.completed",
          requestId: `req_now_${index}`,
          occurredAt: new Date(Date.now() + index).toISOString(),
          model: "gpt-4o",
          routingMode: "direct",
          latencyMs: 1,
          attempts: 1,
        })!,
      );
    }

    const stored = repo.recentRequests(10).map((row) => row.requestId);
    assert.equal(stored.length, 3);
    // Its timestamp was replaced with now, so it aged out like anything else.
    assert.equal(stored.includes("req_future"), false);
  } finally {
    database.close();
  }
});

test("event flooding stays bounded by retention", () => {
  const dir = join(mkdtempSync(join(tmpdir(), "bayz-telemetry-flood-")), ".bayz");
  const database = openDatabase({ dataDir: dir });
  const repo = createUsageRepository(database.db, {
    requestRetention: 10,
    attemptRetention: 10,
  });
  try {
    for (let index = 0; index < 500 ; index += 1) {
      repo.record(
        normalizeUsageEvent({
          kind: "request.completed",
          requestId: `req_flood_${index}`,
          occurredAt: new Date(Date.now() - (500 - index)).toISOString(),
          model: "gpt-4o",
          routingMode: "direct",
          latencyMs: 1,
          attempts: 1,
        })!,
      );
      repo.record(
        normalizeUsageEvent({
          kind: "provider.attempted",
          requestId: `req_flood_${index}`,
          occurredAt: new Date(Date.now() - (500 - index)).toISOString(),
          providerId: "p1",
          model: "gpt-4o",
          routingMode: "direct",
          latencyMs: 1,
          attempts: 1,
        })!,
      );
    }
    assert.equal(
      Number(database.db.prepare("SELECT COUNT(*) AS n FROM usage_requests").get()?.n),
      10,
    );
    assert.equal(
      Number(database.db.prepare("SELECT COUNT(*) AS n FROM usage_attempts").get()?.n),
      10,
    );
  } finally {
    database.close();
  }
});

test("retention cannot be disabled through a hostile configuration", () => {
  for (const bogus of [
    0,
    -1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER,
    1.5,
    "unlimited" as unknown as number,
    null as unknown as number,
  ]) {
    const dir = join(mkdtempSync(join(tmpdir(), "bayz-telemetry-cfg-")), ".bayz");
    const database = openDatabase({ dataDir: dir });
    const repo = createUsageRepository(database.db, {
      requestRetention: bogus,
      attemptRetention: bogus,
    });
    try {
      assert.ok(
        Number.isInteger(repo.requestRetention()) && repo.requestRetention() > 0,
        `retention must stay finite for ${String(bogus)}`,
      );
      assert.ok(repo.requestRetention() <= 1_000_000);
    } finally {
      database.close();
    }
  }
});

test("a purge deletes usage only, never domain data", () => {
  const ctx = freshRepository();
  try {
    ctx.db
      .prepare(
        `INSERT INTO providers
           (id, kind, display_name, base_url, enabled, config_json, created_at, updated_at)
         VALUES ('survivor', 'openai-compatible', 'Survivor', 'https://example.com', 1, '{}',
                 '2026-08-26T00:00:00.000Z', '2026-08-26T00:00:00.000Z')`,
      )
      .run();
    const bytes = new Uint8Array([9, 9, 9]);
    ctx.db
      .prepare(
        `INSERT INTO secrets
           (name, version, algorithm, kdf, key_id, wrapped_dek, wrap_iv, wrap_tag,
            ciphertext, iv, tag, created_at, updated_at)
         VALUES ('survivor-secret', 1, 'aes-256-gcm', 'none', 'kek_x', ?, ?, ?, ?, ?, ?,
                 '2026-08-26T00:00:00.000Z', '2026-08-26T00:00:00.000Z')`,
      )
      .run(bytes, bytes, bytes, bytes, bytes, bytes);

    ctx.repo.record(
      normalizeUsageEvent({
        kind: "request.completed",
        requestId: "req_purge",
        occurredAt: new Date().toISOString(),
        model: "gpt-4o",
        routingMode: "direct",
        latencyMs: 1,
        attempts: 1,
      })!,
    );

    ctx.repo.purge();
    ctx.repo.purge();

    assert.equal(ctx.repo.recentRequests(10).length, 0);
    assert.equal(
      Number(ctx.db.prepare("SELECT COUNT(*) AS n FROM providers").get()?.n),
      1,
      "a purge must never touch providers",
    );
    assert.equal(
      Number(ctx.db.prepare("SELECT COUNT(*) AS n FROM secrets").get()?.n),
      1,
      "a purge must never touch secrets",
    );
  } finally {
    ctx.close();
  }
});

test("malformed numeric fields cannot create an unbounded or negative row", () => {
  const ctx = freshRepository();
  try {
    for (const value of [
      -1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      1e30,
      "10" as unknown as number,
    ]) {
      assert.equal(
        normalizeUsageEvent({
          kind: "request.completed",
          requestId: "req_num",
          occurredAt: new Date().toISOString(),
          model: "gpt-4o",
          routingMode: "direct",
          latencyMs: value,
          attempts: 1,
        }),
        undefined,
        `latency must be refused: ${String(value)}`,
      );
    }
    assert.equal(ctx.repo.recentRequests(10).length, 0);
  } finally {
    ctx.close();
  }
});

test("token counts cannot be negative or absurd in a stored row", () => {
  const ctx = freshRepository();
  try {
    ctx.repo.record(
      normalizeUsageEvent({
        kind: "request.completed",
        requestId: "req_tok",
        occurredAt: new Date().toISOString(),
        model: "gpt-4o",
        routingMode: "direct",
        latencyMs: 1,
        attempts: 1,
        promptTokens: -50,
        completionTokens: 1e18,
        cachedTokens: Number.NaN,
      })!,
    );
    const row = ctx.repo.recentRequests(1)[0]!;
    // All three degrade to unknown rather than storing a bogus fact.
    assert.equal(row.promptTokens, undefined);
    assert.equal(row.completionTokens, undefined);
    assert.equal(row.cachedTokens, undefined);
  } finally {
    ctx.close();
  }
});

test("cardinality cannot explode through distinct provider ids", () => {
  const dir = join(mkdtempSync(join(tmpdir(), "bayz-telemetry-card-")), ".bayz");
  const database = openDatabase({ dataDir: dir });
  const repo = createUsageRepository(database.db, { attemptRetention: 25 });
  try {
    for (let index = 0; index < 300; index += 1) {
      repo.record(
        normalizeUsageEvent({
          kind: "provider.attempted",
          requestId: `req_card_${index}`,
          occurredAt: new Date(Date.now() - (300 - index)).toISOString(),
          providerId: `provider-${index}`,
          model: "gpt-4o",
          routingMode: "combo",
          latencyMs: 1,
          attempts: 1,
        })!,
      );
    }
    assert.equal(
      Number(database.db.prepare("SELECT COUNT(*) AS n FROM usage_attempts").get()?.n),
      25,
      "distinct ids do not bypass retention",
    );
  } finally {
    database.close();
  }
});
