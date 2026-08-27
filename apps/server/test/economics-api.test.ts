import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ClientScope } from "@bayz/identity";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { createBayzRuntime, type BayzRuntime } from "../src/runtime.js";

const KEY = Buffer.alloc(32, 0x6c).toString("hex");
const TOKEN = "economics-api-token-0123456789";
const AUTH = { authorization: `Bearer ${TOKEN}` };
const JSON_AUTH = { ...AUTH, "content-type": "application/json" };

/**
 * A non-loopback bind address for fixture origins.
 *
 * A loopback provider classifies `LOCAL`, and `LOCAL` is free — which would make
 * every pricing assertion in this file vacuously true. Binding to the host's private
 * address is the posture a real remote provider has, so the classifier has to read
 * the published metadata to decide.
 */
function privateHost(): string {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) {
        return entry.address;
      }
    }
  }
  throw new Error("no non-loopback IPv4 address available for the fixture origin");
}

type Origin = {
  url: string;
  close(): Promise<void>;
  /** Swap what `/models` publishes, to simulate a re-discovery. */
  setModels(models: unknown[]): void;
};

async function startOrigin(models: unknown[]): Promise<Origin> {
  let current = models;
  const server: Server = createServer((request, response) => {
    const url = request.url ?? "";
    if (url.includes("/models")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: current }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        id: "c1",
        choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    );
  });
  const host = privateHost();
  await new Promise<void>((resolve) => server.listen(0, host, resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://${host}:${port}/v1`,
    setModels(next: unknown[]): void {
      current = next;
    },
    close(): Promise<void> {
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

function harness(): { app: FastifyInstance; runtime: BayzRuntime } {
  const dataDir = join(mkdtempSync(join(tmpdir(), "bayz-economics-")), ".bayz");
  const runtime = createBayzRuntime(
    { host: "127.0.0.1", port: 20141, dataDir, dashboardRoot: "/nonexistent" },
    { env: { BAYZ_MASTER_KEY: KEY, BAYZ_API_TOKEN: TOKEN }, notify: () => {} },
  );
  const app = buildApp({
    logger: false,
    apiToken: TOKEN,
    runtime,
    rateLimit: { max: 100000, authMax: 100000 },
  });
  return { app, runtime };
}

function keyFor(runtime: BayzRuntime, id: string, scopes: ClientScope[]): string {
  return runtime.identities.createIdentity({ id, displayName: id, scopes }).key;
}

async function addProvider(
  app: FastifyInstance,
  id: string,
  baseUrl: string,
): Promise<void> {
  const response = await app.inject({
    method: "POST",
    url: "/api/providers",
    headers: JSON_AUTH,
    payload: {
      id,
      kind: "openai-compatible",
      displayName: id,
      baseUrl,
      config: { allowPrivate: true },
    },
  });
  assert.equal(response.statusCode, 201);
}

/**
 * A model published with explicit zero pricing across **every** priced dimension.
 *
 * All four of `prompt`, `completion`, `request`, and `image` are present and zero,
 * because `FREE_VERIFIED` requires proof on each one — a missing dimension is not a
 * proven zero. A fixture with only `prompt` and `completion` classifies `UNKNOWN`,
 * which is the classifier being strict rather than the fixture being free.
 */
function freeModel(id: string): Record<string, unknown> {
  return {
    id,
    pricing: { prompt: "0", completion: "0", request: "0", image: "0" },
  };
}

/** A model published with a real price: unambiguously paid. */
function paidModel(id: string): Record<string, unknown> {
  return { id, pricing: { prompt: "0.0005", completion: "0.0015" } };
}

/** A model with no pricing metadata at all: UNKNOWN, and so never free. */
function unpricedModel(id: string): Record<string, unknown> {
  return { id };
}

test("discover persists the catalogue and keeps the legacy string[] shape", async () => {
  const origin = await startOrigin([
    freeModel("free-a"),
    paidModel("paid-a"),
    unpricedModel("mystery-a"),
  ]);
  const h = harness();
  try {
    await addProvider(h.app, "p1", origin.url);

    // The legacy contract. Several clients and the Phase 3 smoke read `models` as an
    // array of strings; widening it in place would break them for a feature they did
    // not ask for, so the shape is asserted rather than assumed.
    const legacy = await h.app.inject({
      method: "POST",
      url: "/api/providers/p1/discover",
      headers: AUTH,
    });
    assert.equal(legacy.statusCode, 200);
    const legacyBody = legacy.json();
    // Publication order, which is what the existing endpoint has always returned. Not
    // re-sorted here: the point of this assertion is that the legacy shape is unchanged,
    // so it has to assert the legacy behaviour rather than a tidier version of it.
    assert.deepEqual(legacyBody.models, ["free-a", "paid-a", "mystery-a"]);

    // The economics-bearing surface, on its own endpoint.
    const catalogue = await h.app.inject({
      method: "POST",
      url: "/api/providers/p1/catalogue",
      headers: AUTH,
    });
    assert.equal(catalogue.statusCode, 200);
    const entries = catalogue.json().models as { id: string; economics: string }[];
    assert.deepEqual(
      [...entries].sort((a, b) => a.id.localeCompare(b.id)).map((e) => [e.id, e.economics]),
      [
        ["free-a", "FREE_VERIFIED"],
        ["mystery-a", "UNKNOWN"],
        ["paid-a", "PAID"],
      ],
    );

    // Persisted, not merely returned: a later read answers without an upstream call.
    assert.equal(h.runtime.providers.modelEconomics("p1", "free-a"), "FREE_VERIFIED");
    assert.equal(h.runtime.providers.modelEconomics("p1", "paid-a"), "PAID");
    assert.equal(h.runtime.providers.modelEconomics("p1", "mystery-a"), "UNKNOWN");
  } finally {
    h.runtime.close();
    await origin.close();
  }
});

test("the catalogue response carries an id and a classification and nothing else", async () => {
  const origin = await startOrigin([freeModel("free-a")]);
  const h = harness();
  try {
    await addProvider(h.app, "p1", origin.url);
    const response = await h.app.inject({
      method: "POST",
      url: "/api/providers/p1/catalogue",
      headers: AUTH,
    });
    const [entry] = response.json().models as Record<string, unknown>[];

    // Pinned exactly. A `description`, a price, or a raw upstream blob would make this
    // table content-bearing, and the whole point of storing a classification is that
    // the router never has to hold provider prose.
    assert.deepEqual(Object.keys(entry ?? {}).sort(), ["economics", "id"]);
  } finally {
    h.runtime.close();
    await origin.close();
  }
});

test("GET /api/models/free aggregates the free set with no duplicates", async () => {
  const originA = await startOrigin([freeModel("shared"), paidModel("paid-a")]);
  const originB = await startOrigin([freeModel("shared"), freeModel("free-b")]);
  const h = harness();
  try {
    await addProvider(h.app, "p1", originA.url);
    await addProvider(h.app, "p2", originB.url);
    for (const id of ["p1", "p2"]) {
      await h.app.inject({
        method: "POST",
        url: `/api/providers/${id}/catalogue`,
        headers: AUTH,
      });
    }

    const response = await h.app.inject({
      method: "GET",
      url: "/api/models/free",
      headers: AUTH,
    });
    assert.equal(response.statusCode, 200);
    const models = response.json().models as { id: string; providerIds: string[] }[];

    // One entry per model id, not one per (provider, model): the operator's question is
    // "what can I use for nothing", and the same model on two providers is one answer.
    assert.deepEqual(
      models.map((entry) => entry.id),
      ["free-b", "shared"],
    );
    assert.deepEqual(
      models.find((entry) => entry.id === "shared")?.providerIds,
      ["p1", "p2"],
    );

    // Nothing paid and nothing undiscovered leaks into a list whose entire purpose is
    // that using anything on it cannot cost money.
    assert.ok(!models.some((entry) => entry.id === "paid-a"));
  } finally {
    h.runtime.close();
    await originA.close();
    await originB.close();
  }
});

test("a re-discovery removes a model the upstream stopped listing", async () => {
  const origin = await startOrigin([freeModel("free-a"), freeModel("free-gone")]);
  const h = harness();
  try {
    await addProvider(h.app, "p1", origin.url);
    await h.app.inject({
      method: "POST",
      url: "/api/providers/p1/catalogue",
      headers: AUTH,
    });
    assert.equal(h.runtime.providers.listFreeModels().length, 2);

    // Replace, not merge. A model that was free last month must not stay routable
    // forever on stale evidence.
    origin.setModels([freeModel("free-a")]);
    await h.app.inject({
      method: "POST",
      url: "/api/providers/p1/catalogue",
      headers: AUTH,
    });

    const response = await h.app.inject({
      method: "GET",
      url: "/api/models/free",
      headers: AUTH,
    });
    assert.deepEqual(
      (response.json().models as { id: string }[]).map((entry) => entry.id),
      ["free-a"],
    );
  } finally {
    h.runtime.close();
    await origin.close();
  }
});

test("a model reclassified PAID drops out of the free set", async () => {
  const origin = await startOrigin([freeModel("swings")]);
  const h = harness();
  try {
    await addProvider(h.app, "p1", origin.url);
    await h.app.inject({
      method: "POST",
      url: "/api/providers/p1/catalogue",
      headers: AUTH,
    });
    assert.equal(h.runtime.providers.listFreeModels().length, 1);

    origin.setModels([paidModel("swings")]);
    await h.app.inject({
      method: "POST",
      url: "/api/providers/p1/catalogue",
      headers: AUTH,
    });

    assert.deepEqual(h.runtime.providers.listFreeModels(), []);
  } finally {
    h.runtime.close();
    await origin.close();
  }
});

test("a free-only route with no free candidate returns 409 no_free_route", async () => {
  const origin = await startOrigin([paidModel("gpt-4o")]);
  const h = harness();
  try {
    await addProvider(h.app, "p1", origin.url);
    await h.app.inject({
      method: "POST",
      url: "/api/providers/p1/catalogue",
      headers: AUTH,
    });
    await h.app.inject({
      method: "POST",
      url: "/api/providers/p1/credential",
      headers: JSON_AUTH,
      payload: { credential: "sk-economics-test" },
    });
    // No `freeOnly` in the payload: the default must be the safe one.
    const created = await h.app.inject({
      method: "POST",
      url: "/api/routes",
      headers: JSON_AUTH,
      payload: { id: "r1", model: "gpt-4o", providerId: "p1" },
    });
    assert.equal(created.statusCode, 201);
    assert.equal(created.json().freeOnly, true);

    const response = await h.app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: JSON_AUTH,
      payload: { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] },
    });

    // 409, not 503. The operator action differs: this means "add a free provider",
    // where a 503 means "the network is down". Collapsing them would send an operator
    // to check connectivity for a policy refusal.
    assert.equal(response.statusCode, 409);
    const body = response.json();
    assert.equal(body.error.code, "no_free_route");

    // The message names no model, no provider, and no price: a refusal explains that it
    // was deliberate, and anything more becomes a pricing oracle for an unauthenticated
    // probe of what this install can reach.
    const message = String(body.error.message);
    assert.ok(!message.includes("gpt-4o"));
    assert.ok(!message.includes("p1"));
    assert.ok(!/[0-9]/.test(message));
  } finally {
    h.runtime.close();
    await origin.close();
  }
});

test("an unreachable free provider is 502, not confused with a policy refusal", async () => {
  const origin = await startOrigin([freeModel("gpt-4o")]);
  const h = harness();
  try {
    await addProvider(h.app, "p1", origin.url);
    await h.app.inject({
      method: "POST",
      url: "/api/providers/p1/catalogue",
      headers: AUTH,
    });
    await h.app.inject({
      method: "POST",
      url: "/api/providers/p1/credential",
      headers: JSON_AUTH,
      payload: { credential: "sk-economics-test" },
    });
    await h.app.inject({
      method: "POST",
      url: "/api/routes",
      headers: JSON_AUTH,
      payload: { id: "r1", model: "gpt-4o", providerId: "p1" },
    });

    // The model is genuinely free, so policy permits the attempt. Killing the origin
    // makes it a transport failure — and a transport failure must not be reported as
    // an economics refusal, or the operator adds providers to fix a dead network.
    await origin.close();

    const response = await h.app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: JSON_AUTH,
      payload: { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] },
    });

    assert.notEqual(response.statusCode, 409);
    assert.ok(response.statusCode >= 500);
    assert.notEqual(response.json().error.code, "no_free_route");
  } finally {
    h.runtime.close();
  }
});

test("a free model routes successfully under the default free-only policy", async () => {
  const origin = await startOrigin([freeModel("gpt-4o")]);
  const h = harness();
  try {
    await addProvider(h.app, "p1", origin.url);
    await h.app.inject({
      method: "POST",
      url: "/api/providers/p1/catalogue",
      headers: AUTH,
    });
    await h.app.inject({
      method: "POST",
      url: "/api/providers/p1/credential",
      headers: JSON_AUTH,
      payload: { credential: "sk-economics-test" },
    });
    await h.app.inject({
      method: "POST",
      url: "/api/routes",
      headers: JSON_AUTH,
      payload: { id: "r1", model: "gpt-4o", providerId: "p1" },
    });

    // The positive control. Without this, every assertion above would still pass if
    // free-only refused *everything*, which is a safe failure but a useless router.
    const response = await h.app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: JSON_AUTH,
      payload: { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] },
    });
    assert.equal(response.statusCode, 200);
  } finally {
    h.runtime.close();
    await origin.close();
  }
});

test("PATCH can turn free-only off and the route then reaches a paid model", async () => {
  const origin = await startOrigin([paidModel("gpt-4o")]);
  const h = harness();
  try {
    await addProvider(h.app, "p1", origin.url);
    await h.app.inject({
      method: "POST",
      url: "/api/providers/p1/catalogue",
      headers: AUTH,
    });
    await h.app.inject({
      method: "POST",
      url: "/api/providers/p1/credential",
      headers: JSON_AUTH,
      payload: { credential: "sk-economics-test" },
    });
    await h.app.inject({
      method: "POST",
      url: "/api/routes",
      headers: JSON_AUTH,
      payload: { id: "r1", model: "gpt-4o", providerId: "p1" },
    });

    const patched = await h.app.inject({
      method: "PATCH",
      url: "/api/routes/r1",
      headers: JSON_AUTH,
      payload: { freeOnly: false },
    });
    assert.equal(patched.statusCode, 200);
    assert.equal(patched.json().freeOnly, false);

    const response = await h.app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: JSON_AUTH,
      payload: { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] },
    });
    assert.equal(response.statusCode, 200);
  } finally {
    h.runtime.close();
    await origin.close();
  }
});

test("turning free-only off requires routes.write", async () => {
  const origin = await startOrigin([freeModel("gpt-4o")]);
  const h = harness();
  try {
    await addProvider(h.app, "p1", origin.url);
    await h.app.inject({
      method: "POST",
      url: "/api/routes",
      headers: JSON_AUTH,
      payload: { id: "r1", model: "gpt-4o", providerId: "p1" },
    });

    // A reader must not be able to start spending money.
    const readerKey = keyFor(h.runtime, "reader", ["routes.read"]);
    const denied = await h.app.inject({
      method: "PATCH",
      url: "/api/routes/r1",
      headers: { authorization: `Bearer ${readerKey}`, "content-type": "application/json" },
      payload: { freeOnly: false },
    });
    assert.equal(denied.statusCode, 403);

    // And the refusal did not half-apply.
    const route = await h.app.inject({ method: "GET", url: "/api/routes/r1", headers: AUTH });
    assert.equal(route.json().freeOnly, true);
  } finally {
    h.runtime.close();
    await origin.close();
  }
});

test("GET /api/models/free requires models.read", async () => {
  const h = harness();
  try {
    const key = keyFor(h.runtime, "chatter", ["chat.completions"]);
    const denied = await h.app.inject({
      method: "GET",
      url: "/api/models/free",
      headers: { authorization: `Bearer ${key}` },
    });
    assert.equal(denied.statusCode, 403);

    const allowed = await h.app.inject({
      method: "GET",
      url: "/api/models/free",
      headers: { authorization: `Bearer ${keyFor(h.runtime, "reader", ["models.read"])}` },
    });
    assert.equal(allowed.statusCode, 200);
  } finally {
    h.runtime.close();
  }
});

test("turning free-only off is recorded in the audit as metadata only", async () => {
  const origin = await startOrigin([freeModel("gpt-4o")]);
  const h = harness();
  try {
    await addProvider(h.app, "p1", origin.url);
    await h.app.inject({
      method: "POST",
      url: "/api/routes",
      headers: JSON_AUTH,
      payload: { id: "r1", model: "gpt-4o", providerId: "p1" },
    });

    // A registry identity, not the bootstrap token: the audit table's `identity_id` is
    // a foreign key into `client_identities`, and the Phase 6 token is a principal with
    // no row there. An operator acting through a real client key is the case that must
    // be attributable.
    const writerKey = keyFor(h.runtime, "writer", ["routes.write"]);
    await h.app.inject({
      method: "PATCH",
      url: "/api/routes/r1",
      headers: {
        authorization: `Bearer ${writerKey}`,
        "content-type": "application/json",
      },
      payload: { freeOnly: false },
    });

    // Enabling paid spending is exactly the change an operator will later want to
    // explain, so it leaves a trail. The trail is metadata: who, what action, which
    // route id — never a prompt, a price, or a credential.
    const audit = h.runtime.identities.recentAudit();
    const entry = audit.find((row) => row.route === "r1" && row.action === "authorized");
    assert.ok(entry !== undefined);
    assert.equal(entry.identityId, "writer");
    assert.equal(entry.scope, "routes.write");

    const serialized = JSON.stringify(entry);
    assert.ok(!serialized.includes(writerKey));
    assert.ok(!serialized.includes("sk-"));

    /*
     * The stronger assertion: pin the key set.
     *
     * A "no decimal-looking substring" regex cannot express this — the row's own
     * `occurredAt` timestamp contains fractional seconds, so that check either fails on
     * a correct row or has to be loosened until it proves nothing. Pinning the keys is
     * what actually forbids a price, a prompt, or a credential field from being added
     * to this record later.
     */
    assert.deepEqual(Object.keys(entry).sort(), [
      "action",
      "identityId",
      "occurredAt",
      "outcome",
      "route",
      "scope",
    ]);
  } finally {
    h.runtime.close();
    await origin.close();
  }
});

test("re-enabling free-only is not recorded as an authorization event", async () => {
  const origin = await startOrigin([freeModel("gpt-4o")]);
  const h = harness();
  try {
    await addProvider(h.app, "p1", origin.url);
    await h.app.inject({
      method: "POST",
      url: "/api/routes",
      headers: JSON_AUTH,
      payload: { id: "r1", model: "gpt-4o", providerId: "p1", freeOnly: false },
    });

    const writerKey = keyFor(h.runtime, "writer", ["routes.write"]);
    const headers = {
      authorization: `Bearer ${writerKey}`,
      "content-type": "application/json",
    };
    await h.app.inject({
      method: "PATCH",
      url: "/api/routes/r1",
      headers,
      payload: { freeOnly: true },
    });

    // Turning the safeguard back on cannot start costing money. Recording it too would
    // bury the one event worth finding later in routine noise.
    const audit = h.runtime.identities.recentAudit();
    assert.ok(!audit.some((row) => row.route === "r1" && row.action === "authorized"));
  } finally {
    h.runtime.close();
    await origin.close();
  }
});
