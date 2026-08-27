import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createProviderManager } from "@bayz/providers";
import { createProxyManager } from "@bayz/proxy";
import { databasePath, openSecretStorage, type SecretStorage } from "@bayz/storage";
import { RouterError, createRouter, type Router } from "../src/index.js";

/*
 * Every route in this file sets `freeOnly: false`.
 *
 * These tests predate free-only routing and assert proxying, telemetry, failover, and
 * adversarial behaviour — not economics. Their fixture origins serve chat responses
 * without a catalogue, so every model here classifies as undiscovered, and an
 * undiscovered model is not free (spec §25 rule 5). Leaving the schema default of
 * free-only ON would make all of them fail `no_free_route` for a reason none of them is
 * about. Free-only enforcement itself is covered in `free-only.test.ts`.
 */

/**
 * Adversarial suite for the router.
 *
 * Attacks the guarantees that matter most here: prompts are never persisted or
 * logged, no credential can be read out, an upstream cannot inject fields or
 * exhaust memory, and an untrusted model name cannot escape into a URL.
 */

const KEY = Buffer.alloc(32, 0x6f).toString("hex");
const PROMPT = "PROMPT-ADVERSARIAL-SENTINEL-must-never-persist";
const CREDENTIAL = "sk-router-adversarial-credential";

type Ctx = {
  router: Router;
  storage: SecretStorage;
  dir: string;
  logs: Array<Record<string, unknown>>;
};

function context(): Ctx {
  const dir = join(mkdtempSync(join(tmpdir(), "bayz-router-adv-")), ".bayz");
  const logs: Array<Record<string, unknown>> = [];
  const logger = (payload: Record<string, unknown>): void => {
    logs.push(payload);
  };
  const storage = openSecretStorage({ dataDir: dir, env: { BAYZ_MASTER_KEY: KEY } });
  const providers = createProviderManager({ storage, logger });
  const proxies = createProxyManager({ storage, logger });
  return {
    router: createRouter({ storage, providers, proxies, logger }),
    storage,
    dir,
    logs,
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

async function startOrigin(
  handler: (
    request: import("node:http").IncomingMessage,
    response: import("node:http").ServerResponse,
  ) => void,
): Promise<{ port: number; close(): Promise<void>; hits: number }> {
  const state = { hits: 0 };
  const server = createHttpServer((request, response) => {
    request.on("data", () => {});
    request.on("end", () => {
      state.hits += 1;
      handler(request, response);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    port,
    get hits() {
      return state.hits;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

const REQUEST = {
  model: "gpt-4o",
  messages: [{ role: "user" as const, content: PROMPT }],
};

test("no credential getter exists anywhere in the router source", () => {
  const sources = sourceFiles();
  assert.ok(sources.length >= 7, "the scan must actually find the sources");
  for (const source of sources) {
    assert.equal(
      /getCredential|revealCredential|exportCredential/.test(source.text),
      false,
      `${source.name} must not contain a credential accessor`,
    );
  }
});

test("the router never writes message content to the database", () => {
  // An INSERT or UPDATE naming a message/prompt/content column would make the
  // no-persistence guarantee unenforceable, so the source itself is checked.
  for (const source of sourceFiles()) {
    const statements = source.text.match(/(INSERT INTO|UPDATE)\s+\w+[^`]*/gi) ?? [];
    for (const statement of statements) {
      for (const forbidden of ["prompt", "messages", "content", "completion", "body"]) {
        assert.equal(
          statement.toLowerCase().includes(forbidden),
          false,
          `${source.name} must not persist ${forbidden}`,
        );
      }
    }
  }
});

test("the router surface exposes no storage or credential internals", () => {
  const ctx = context();
  try {
    const keys = Object.keys(ctx.router);
    for (const forbidden of ["storage", "sql", "credential", "secrets", "getCredential"]) {
      assert.equal(keys.includes(forbidden), false, `${forbidden} must not be public`);
    }
  } finally {
    ctx.router.close();
  }
});

test("prompt and completion bytes are absent from the database files", async () => {
  const origin = await startOrigin((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        choices: [{ message: { role: "assistant", content: "COMPLETION-ADVERSARIAL" } }],
      }),
    );
  });
  const ctx = context();
  try {
    ctx.router.providers.createProvider({
      id: "p1",
      kind: "openai-compatible",
      displayName: "P1",
      baseUrl: `http://127.0.0.1:${origin.port}/v1`,
      config: { allowLoopback: true },
    });
    ctx.router.providers.setCredential("p1", CREDENTIAL);
    ctx.router.createRoute({ freeOnly: false, id: "r1", model: "gpt-4o", providerId: "p1" });
    const result = await ctx.router.chat(REQUEST);
    assert.equal(result.content, "COMPLETION-ADVERSARIAL");
  } finally {
    ctx.router.close();
    await origin.close();
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
  assert.equal(bytes.includes(Buffer.from(PROMPT, "utf8")), false);
  assert.equal(bytes.includes(Buffer.from("COMPLETION-ADVERSARIAL", "utf8")), false);
  assert.equal(bytes.includes(Buffer.from(CREDENTIAL, "utf8")), false);
  assert.equal(bytes.includes(Buffer.from(KEY, "utf8")), false);
  // The route id is metadata and is expected, proving the scan reads content.
  assert.equal(bytes.includes(Buffer.from("r1", "utf8")), true);
});

test("logs carry no prompt, completion, or credential", async () => {
  const origin = await startOrigin((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({ choices: [{ message: { content: "LOG-COMPLETION" } }] }),
    );
  });
  const ctx = context();
  try {
    ctx.router.providers.createProvider({
      id: "p1",
      kind: "openai-compatible",
      displayName: "P1",
      baseUrl: `http://127.0.0.1:${origin.port}/v1`,
      config: { allowLoopback: true },
    });
    ctx.router.providers.setCredential("p1", CREDENTIAL);
    ctx.router.createRoute({ freeOnly: false, id: "r1", model: "gpt-4o", providerId: "p1" });
    await ctx.router.chat(REQUEST);

    const serialized = JSON.stringify(ctx.logs);
    assert.equal(serialized.includes(PROMPT), false);
    assert.equal(serialized.includes("LOG-COMPLETION"), false);
    assert.equal(serialized.includes(CREDENTIAL), false);
    assert.equal(serialized.includes(KEY), false);
  } finally {
    ctx.router.close();
    await origin.close();
  }
});

test("a model name cannot escape into the request URL", async () => {
  const paths: string[] = [];
  const origin = await startOrigin((request, response) => {
    paths.push(String(request.url));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
  });
  const ctx = context();
  try {
    ctx.router.providers.createProvider({
      id: "p1",
      kind: "openai-compatible",
      displayName: "P1",
      baseUrl: `http://127.0.0.1:${origin.port}/v1`,
      config: { allowLoopback: true },
    });
    ctx.router.createRoute({ freeOnly: false, id: "r1", model: "gpt-4*", providerId: "p1" });

    for (const model of [
      "gpt-4/../../admin",
      "gpt-4o?admin=1",
      "gpt-4o#frag",
      "gpt-4o\r\nX-Injected: 1",
      "gpt-4o/../../../etc/passwd",
    ]) {
      await assert.rejects(
        ctx.router.chat({ ...REQUEST, model }),
        (error: unknown) =>
          error instanceof RouterError &&
          (error.code === "invalid_request" || error.code === "invalid_model"),
        `model must be rejected: ${model}`,
      );
    }
    assert.equal(origin.hits, 0, "no hostile model may reach the upstream");
    assert.equal(paths.length, 0);
  } finally {
    ctx.router.close();
    await origin.close();
  }
});

test("an upstream cannot inject extra fields into the router result", async () => {
  const origin = await startOrigin((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        choices: [
          {
            message: { role: "assistant", content: "hi", injected: "evil" },
            injected: "evil",
          },
        ],
        routeId: "attacker-route",
        providerId: "attacker-provider",
        attempts: 999,
        credential: CREDENTIAL,
        injected: "evil",
      }),
    );
  });
  const ctx = context();
  try {
    ctx.router.providers.createProvider({
      id: "p1",
      kind: "openai-compatible",
      displayName: "P1",
      baseUrl: `http://127.0.0.1:${origin.port}/v1`,
      config: { allowLoopback: true },
    });
    ctx.router.createRoute({ freeOnly: false, id: "r1", model: "gpt-4o", providerId: "p1" });
    const result = await ctx.router.chat(REQUEST);

    // Router-owned fields win; upstream keys are discarded entirely.
    assert.equal(result.routeId, "r1");
    assert.equal(result.providerId, "p1");
    assert.equal(result.attempts, 1);
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes("attacker-route"), false);
    assert.equal(serialized.includes("injected"), false);
    assert.equal(serialized.includes(CREDENTIAL), false);
  } finally {
    ctx.router.close();
    await origin.close();
  }
});

test("a prototype-polluting upstream payload cannot poison Object.prototype", async () => {
  const origin = await startOrigin((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      '{"choices":[{"message":{"content":"hi"}}],"__proto__":{"routerPolluted":true}}',
    );
  });
  const ctx = context();
  try {
    ctx.router.providers.createProvider({
      id: "p1",
      kind: "openai-compatible",
      displayName: "P1",
      baseUrl: `http://127.0.0.1:${origin.port}/v1`,
      config: { allowLoopback: true },
    });
    ctx.router.createRoute({ freeOnly: false, id: "r1", model: "gpt-4o", providerId: "p1" });
    const result = await ctx.router.chat(REQUEST);
    assert.equal(result.content, "hi");
    assert.equal(
      ({} as unknown as Record<string, unknown>).routerPolluted,
      undefined,
    );
  } finally {
    ctx.router.close();
    await origin.close();
  }
});

test("an enormous upstream response is refused rather than buffered", async () => {
  const origin = await startOrigin((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        choices: [{ message: { content: "x".repeat(4 * 1024 * 1024) } }],
      }),
    );
  });
  const ctx = context();
  try {
    ctx.router.providers.createProvider({
      id: "p1",
      kind: "openai-compatible",
      displayName: "P1",
      baseUrl: `http://127.0.0.1:${origin.port}/v1`,
      config: { allowLoopback: true },
    });
    ctx.router.createRoute({ freeOnly: false, id: "r1", model: "gpt-4o", providerId: "p1" });
    await assert.rejects(ctx.router.chat(REQUEST), (error: unknown) => {
      const code = (error as { code?: unknown }).code;
      assert.ok(
        code === "response_too_large" || code === "upstream_error",
        `unexpected code: ${String(code)}`,
      );
      return true;
    });
  } finally {
    ctx.router.close();
    await origin.close();
  }
});

test("a route row rewritten with a hostile model fails closed", async () => {
  const origin = await startOrigin((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
  });
  const ctx = context();
  try {
    ctx.router.providers.createProvider({
      id: "p1",
      kind: "openai-compatible",
      displayName: "P1",
      baseUrl: `http://127.0.0.1:${origin.port}/v1`,
      config: { allowLoopback: true },
    });
    ctx.router.createRoute({ freeOnly: false, id: "r1", model: "gpt-4o", providerId: "p1" });
    ctx.storage.sql
      .prepare("UPDATE routes SET model = ? WHERE id = ?")
      .run("../../etc/passwd", "r1");

    await assert.rejects(
      ctx.router.chat(REQUEST),
      (error: unknown) =>
        error instanceof RouterError && error.code === "invalid_route_config",
    );
    assert.equal(origin.hits, 0);
  } finally {
    ctx.router.close();
    await origin.close();
  }
});

test("a route row rewritten with a hostile config fails closed", async () => {
  const origin = await startOrigin((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
  });
  const ctx = context();
  try {
    ctx.router.providers.createProvider({
      id: "p1",
      kind: "openai-compatible",
      displayName: "P1",
      baseUrl: `http://127.0.0.1:${origin.port}/v1`,
      config: { allowLoopback: true },
    });
    ctx.router.createRoute({ freeOnly: false, id: "r1", model: "gpt-4o", providerId: "p1" });
    ctx.storage.sql
      .prepare("UPDATE routes SET config_json = ? WHERE id = ?")
      .run('{"requestTimeoutMs":1}', "r1");

    await assert.rejects(
      ctx.router.chat(REQUEST),
      (error: unknown) =>
        error instanceof RouterError && error.code === "invalid_route_config",
    );
    assert.equal(origin.hits, 0);
  } finally {
    ctx.router.close();
    await origin.close();
  }
});

test("one provider's credential is never sent to another provider", async () => {
  const seen: Array<string | undefined> = [];
  const first = await startOrigin((request, response) => {
    seen.push(request.headers.authorization);
    response.writeHead(500, { "content-type": "application/json" });
    response.end("{}");
  });
  const second = await startOrigin((request, response) => {
    seen.push(request.headers.authorization);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
  });
  const ctx = context();
  try {
    ctx.router.providers.createProvider({
      id: "with-key",
      kind: "openai-compatible",
      displayName: "With Key",
      baseUrl: `http://127.0.0.1:${first.port}/v1`,
      config: { allowLoopback: true },
    });
    ctx.router.providers.setCredential("with-key", CREDENTIAL);
    ctx.router.providers.createProvider({
      id: "no-key",
      kind: "openai-compatible",
      displayName: "No Key",
      baseUrl: `http://127.0.0.1:${second.port}/v1`,
      config: { allowLoopback: true },
    });
    ctx.router.createRoute({
      freeOnly: false,
      id: "r1",
      model: "gpt-4o",
      providerId: "with-key",
      priority: 900,
    });
    ctx.router.createRoute({
      freeOnly: false,
      id: "r2",
      model: "gpt-4o",
      providerId: "no-key",
      priority: 100,
    });

    const result = await ctx.router.chat(REQUEST);
    assert.equal(result.providerId, "no-key");
    assert.equal(seen[0], `Bearer ${CREDENTIAL}`, "the first provider is authorized");
    assert.equal(
      seen[1],
      undefined,
      "failover must not carry the first provider's credential",
    );
  } finally {
    ctx.router.close();
    await first.close();
    await second.close();
  }
});

test("a tampered credential fails closed instead of sending an unauthenticated request", async () => {
  const seen: Array<string | undefined> = [];
  const origin = await startOrigin((request, response) => {
    seen.push(request.headers.authorization);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
  });
  const ctx = context();
  try {
    ctx.router.providers.createProvider({
      id: "p1",
      kind: "openai-compatible",
      displayName: "P1",
      baseUrl: `http://127.0.0.1:${origin.port}/v1`,
      config: { allowLoopback: true },
    });
    ctx.router.providers.setCredential("p1", CREDENTIAL);
    ctx.router.createRoute({ freeOnly: false, id: "r1", model: "gpt-4o", providerId: "p1" });
    ctx.storage.corruptForTest("provider:p1:api_key", "ciphertext");

    await assert.rejects(ctx.router.chat(REQUEST), (error: unknown) => {
      assert.equal((error as { code?: unknown }).code, "secret_corrupt");
      return true;
    });
    assert.equal(
      origin.hits,
      0,
      "a corrupt credential must not degrade to an unauthenticated request",
    );
  } finally {
    ctx.router.close();
    await origin.close();
  }
});

test("the buffered chat path still refuses a stream flag", async () => {
  const origin = await startOrigin((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
  });
  const ctx = context();
  try {
    ctx.router.providers.createProvider({
      id: "p1",
      kind: "openai-compatible",
      displayName: "P1",
      baseUrl: `http://127.0.0.1:${origin.port}/v1`,
      config: { allowLoopback: true },
    });
    ctx.router.createRoute({ freeOnly: false, id: "r1", model: "gpt-4o", providerId: "p1" });

    await assert.rejects(
      ctx.router.chat({ ...REQUEST, stream: true } as never),
      (error: unknown) =>
        error instanceof RouterError && error.code === "invalid_request",
    );
    assert.equal(origin.hits, 0);
    // Amended in 9B. Streaming now exists as a *separate* entry point, so the
    // assertion worth keeping is that the buffered path cannot be talked into it:
    // `chat()` still refuses `stream`, because a caller wanting events must call
    // `chatStream` and get a real SSE reader rather than a buffered body.
    assert.equal(typeof ctx.router.chatStream, "function");
    await assert.rejects(
      ctx.router.chat({ ...REQUEST, stream: false } as never),
      (error: unknown) =>
        error instanceof RouterError && error.code === "invalid_request",
      "the buffered path accepts no stream flag in either state",
    );
    assert.equal(origin.hits, 0);
  } finally {
    ctx.router.close();
    await origin.close();
  }
});
