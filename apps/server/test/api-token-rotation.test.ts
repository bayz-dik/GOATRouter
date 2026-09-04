import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { createBayzRuntime, type BayzRuntime } from "../src/runtime.js";
import { openSecretStorage } from "@bayz/storage";
import { API_TOKEN_SECRET_NAME } from "../src/api-token.js";

const KEY = Buffer.alloc(32, 0x7c).toString("hex");
const TOKEN = "api-token-rotation-token-0123456789";
const URL = "/api/security/rotate-api-token";
const HEX64 = /^[0-9a-f]{64}$/;

type Harness = {
  app: FastifyInstance;
  runtime: BayzRuntime;
  dataDir: string;
};

/**
 * Build a runtime + app exactly as the real server does: the loopback-local
 * admin seam is ON, so a same-uid loopback operator with no token can rotate a
 * lost token. `loopbackLocalAdmin: true` mirrors `apps/server/src/index.ts`.
 */
function harness(): Harness {
  const dataDir = join(mkdtempSync(join(tmpdir(), "bayz-api-token-rot-")), ".bayz");
  const runtime = createBayzRuntime(
    { host: "127.0.0.1", port: 20156, dataDir, dashboardRoot: "/nonexistent" },
    { env: { BAYZ_MASTER_KEY: KEY, BAYZ_API_TOKEN: TOKEN }, notify: () => {} },
  );
  const app = buildApp({
    logger: false,
    apiToken: TOKEN,
    runtime,
    loopbackLocalAdmin: true,
    rateLimit: { max: 100000, authMax: 100000 },
  });
  return { app, runtime, dataDir };
}

test("a loopback caller with no token can rotate a lost API token", async (t) => {
  const { app, runtime } = harness();
  t.after(async () => {
    runtime.close();
    await app.close();
  });

  // Same-device, Origin-less (a bare local `bayz` / curl): the seam that breaks
  // the lost-token deadlock. No Authorization header at all.
  const response = await app.inject({
    method: "POST",
    url: URL,
    remoteAddress: "127.0.0.1",
    headers: { "content-type": "application/json" },
    payload: {},
  });

  assert.equal(response.statusCode, 200, response.body);
  const body = response.json() as { token: string; tokenShownOnce: boolean };
  assert.match(body.token, HEX64, "a rotated token must be a fresh 64-hex credential");
  assert.equal(body.tokenShownOnce, true);
  assert.notEqual(body.token, TOKEN, "rotation returned the previous token");
});

test("the old token stops working immediately and the new one works", async (t) => {
  const { app, runtime } = harness();
  t.after(async () => {
    runtime.close();
    await app.close();
  });

  const rotated = (
    await app.inject({
      method: "POST",
      url: URL,
      remoteAddress: "127.0.0.1",
      headers: { "content-type": "application/json" },
      payload: {},
    })
  ).json() as { token: string };
  const fresh = rotated.token;

  const oldDenied = await app.inject({
    method: "GET",
    url: "/api/status",
    remoteAddress: "127.0.0.1",
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(oldDenied.statusCode, 401, "the superseded token must be refused immediately");

  const freshAllowed = await app.inject({
    method: "GET",
    url: "/api/status",
    remoteAddress: "127.0.0.1",
    headers: { authorization: `Bearer ${fresh}` },
  });
  assert.equal(freshAllowed.statusCode, 200);
});

test("a remote caller without a token cannot rotate", async (t) => {
  const { app, runtime } = harness();
  t.after(async () => {
    runtime.close();
    await app.close();
  });

  // Off-machine, no token. The bypass is loopback-only, so this must not be
  // treated as a local operator: remote callers need the credential as before.
  const response = await app.inject({
    method: "POST",
    url: URL,
    remoteAddress: "192.168.1.50",
    headers: { "content-type": "application/json" },
    payload: {},
  });
  assert.equal(response.statusCode, 401);
});

test("a remote caller with a valid admin token is refused (admin stays loopback-only)", async (t) => {
  const { app, runtime } = harness();
  t.after(async () => {
    runtime.close();
    await app.close();
  });

  // Rotation is an `admin` operation, and `admin` is refused over the wire even
  // with a genuinely valid token (requireScope keys off the peer address).
  const response = await app.inject({
    method: "POST",
    url: URL,
    remoteAddress: "192.168.1.50",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    payload: {},
  });
  assert.equal(response.statusCode, 403);
  const body = response.json() as { error: { code: string; message: string } };
  assert.equal(body.error.code, "forbidden");
  assert.match(body.error.message, /loopback/i);
});

test("a loopback browser request (with an Origin) cannot rotate without a token", async (t) => {
  const { app, runtime } = harness();
  t.after(async () => {
    runtime.close();
    await app.close();
  });

  // The no-Origin condition is the CSRF gate: a cross-origin request always
  // sends an Origin, so a drive-by website on the same machine cannot rotate the
  // token via the seam. Origin-less loopback is the seam; this is not it.
  const response = await app.inject({
    method: "POST",
    url: URL,
    remoteAddress: "127.0.0.1",
    headers: {
      origin: "https://evil.example.com",
      "content-type": "application/json",
    },
    payload: {},
  });
  assert.equal(response.statusCode, 403);
});

test("the replacement token is persisted and opens a fresh runtime", async (t) => {
  const { app, runtime, dataDir } = harness();

  const rotated = (
    await app.inject({
      method: "POST",
      url: URL,
      remoteAddress: "127.0.0.1",
      headers: { "content-type": "application/json" },
      payload: {},
    })
  ).json() as { token: string };
  const fresh = rotated.token;

  // A rotation from an environment source must still persist the replacement, so
  // a later boot that drops the env var keeps working. Prove it by reopening the
  // store without BAYZ_API_TOKEN and resolving what a fresh boot would use.
  runtime.close();
  await app.close();

  const storage = openSecretStorage({ dataDir, env: { BAYZ_MASTER_KEY: KEY } });
  try {
    assert.equal(
      storage.find(API_TOKEN_SECRET_NAME),
      fresh,
      "the rotated token was not persisted into the store",
    );
  } finally {
    storage.close();
  }
});

