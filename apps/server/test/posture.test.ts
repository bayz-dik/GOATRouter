import assert from "node:assert/strict";
import type { NetworkInterfaceInfo } from "node:os";
import { mkdtempSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import {
  POSTURES,
  POSTURE_LIMITS,
  POSTURE_REQUIREMENTS,
  PostureError,
  derivePosture,
  hostsForBind,
  isLoopbackPeer,
  resolvePosture,
  type BayzPosture,
  type PostureRequirement,
} from "../src/posture.js";
import { createBayzRuntime, type BayzRuntime } from "../src/runtime.js";

const KEY = Buffer.alloc(32, 0x71).toString("hex");
const TOKEN = "posture-token-0123456789abcdef";

/** A full set of protections, so a test can remove exactly one and see it named. */
const ALL_PROTECTIONS: Record<string, string> = {
  BAYZ_ALLOW_REMOTE: "true",
  BAYZ_TLS_CERT: "/tmp/cert.pem",
  BAYZ_TLS_KEY: "/tmp/key.pem",
  BAYZ_TLS_CLIENT_CA: "/tmp/ca.pem",
};

function dataDir(): string {
  return join(mkdtempSync(join(tmpdir(), "bayz-posture-")), ".bayz");
}

test("posture is derived from the bind address, not from a flag", () => {
  assert.equal(derivePosture("127.0.0.1"), "loopback");
  assert.equal(derivePosture("::1"), "loopback");
  assert.equal(derivePosture("[::1]"), "loopback");
  assert.equal(derivePosture("localhost"), "loopback");
  // Any 127.x is loopback, not only .0.1.
  assert.equal(derivePosture("127.0.0.53"), "loopback");

  assert.equal(derivePosture("10.0.0.5"), "lan");
  assert.equal(derivePosture("172.16.4.1"), "lan");
  assert.equal(derivePosture("172.31.255.254"), "lan");
  assert.equal(derivePosture("192.168.1.10"), "lan");
  assert.equal(derivePosture("169.254.10.1"), "lan");
  assert.equal(derivePosture("100.64.0.1"), "lan");
  assert.equal(derivePosture("fd00::1"), "lan");
  assert.equal(derivePosture("fe80::1%eth0"), "lan");

  assert.equal(derivePosture("8.8.8.8"), "remote");
  assert.equal(derivePosture("172.32.0.1"), "remote", "172.32 is outside RFC 1918");
  assert.equal(derivePosture("2606:4700::1111"), "remote");
  assert.equal(derivePosture("router.example.com"), "remote");
});

test("a wildcard bind is remote, not lan", () => {
  // The most dangerous possible misclassification: `0.0.0.0` binds every interface the
  // host has, including any public one, so it must take the strictest posture.
  assert.equal(derivePosture("0.0.0.0"), "remote");
  assert.equal(derivePosture("::"), "remote");
  assert.equal(derivePosture("*"), "remote");
});

test("an unknown or empty host is remote, never loopback", () => {
  // Fail-safe direction: something that cannot be shown to be local is treated as the
  // most exposed thing it could be.
  assert.equal(derivePosture(""), "remote");
  assert.equal(derivePosture("   "), "remote");
  assert.equal(derivePosture("not a host"), "remote");
});

test("loopback keeps today's behaviour exactly", () => {
  // Regression guard. Phase 6 shipped 120/10 and no concurrency cap was enforced; if
  // this changes, every existing local install silently gets new limits.
  const resolved = resolvePosture({ host: "127.0.0.1", env: {} });
  assert.equal(resolved.posture, "loopback");
  assert.equal(resolved.limits.max, 120);
  assert.equal(resolved.limits.authMax, 10);
  assert.equal(resolved.denyAdminOverWire, false);
  assert.equal(resolved.tls, false);
  // No protections are demanded, so a bare loopback start cannot fail on posture.
  assert.deepEqual(POSTURE_REQUIREMENTS.loopback, []);
});

test("lan and remote tighten the rate limit and add a concurrency cap", () => {
  const lan = resolvePosture({
    host: "192.168.1.10",
    env: { ...ALL_PROTECTIONS },
    apiTokenExplicit: true,
  });
  const remote = resolvePosture({
    host: "203.0.113.7",
    env: { ...ALL_PROTECTIONS },
    apiTokenExplicit: true,
  });

  assert.ok(lan.limits.max < POSTURE_LIMITS.loopback.max);
  assert.ok(lan.limits.authMax < POSTURE_LIMITS.loopback.authMax);
  assert.ok(remote.limits.max < lan.limits.max);
  assert.ok(remote.limits.authMax < lan.limits.authMax);
  assert.ok(remote.limits.concurrency < lan.limits.concurrency);
  assert.ok(lan.limits.concurrency < POSTURE_LIMITS.loopback.concurrency);
});

test("lan without TLS is a startup failure, not a warning", () => {
  assert.throws(
    () =>
      resolvePosture({
        host: "192.168.1.10",
        env: { BAYZ_ALLOW_REMOTE: "true" },
        apiTokenExplicit: true,
      }),
    (error: unknown) => {
      assert.ok(error instanceof PostureError);
      assert.equal(error.posture, "lan");
      assert.equal(error.requirement, "tls");
      // The message must name what is missing, so an operator can act on it.
      assert.match(error.message, /BAYZ_TLS_CERT/);
      return true;
    },
  );
});

test("remote without mTLS or signing is a startup failure", () => {
  const env = {
    BAYZ_ALLOW_REMOTE: "true",
    BAYZ_TLS_CERT: "/tmp/cert.pem",
    BAYZ_TLS_KEY: "/tmp/key.pem",
  };
  assert.throws(
    () => resolvePosture({ host: "203.0.113.7", env, apiTokenExplicit: true }),
    (error: unknown) =>
      error instanceof PostureError && error.requirement === "client_authentication",
  );

  // Either one satisfies it; neither is optional.
  assert.doesNotThrow(() =>
    resolvePosture({
      host: "203.0.113.7",
      env: { ...env, BAYZ_TLS_CLIENT_CA: "/tmp/ca.pem" },
      apiTokenExplicit: true,
    }),
  );
  assert.doesNotThrow(() =>
    resolvePosture({
      host: "203.0.113.7",
      env: { ...env, BAYZ_REQUIRE_SIGNING: "true" },
      apiTokenExplicit: true,
    }),
  );
});

test("remote without BAYZ_ALLOW_REMOTE is a startup failure", () => {
  assert.throws(
    () =>
      resolvePosture({
        host: "203.0.113.7",
        env: { ...ALL_PROTECTIONS, BAYZ_ALLOW_REMOTE: undefined },
        apiTokenExplicit: true,
      }),
    (error: unknown) =>
      error instanceof PostureError && error.requirement === "explicit_remote_opt_in",
  );
});

test("a generated token is refused for lan and remote", () => {
  for (const host of ["192.168.1.10", "203.0.113.7"]) {
    assert.throws(
      () => resolvePosture({ host, env: { ...ALL_PROTECTIONS }, apiTokenExplicit: false }),
      (error: unknown) =>
        error instanceof PostureError && error.requirement === "explicit_api_token",
      `${host} accepted a generated token`,
    );
  }
});

/**
 * The no-silent-downgrade property, enumerated rather than sampled.
 *
 * For every posture and every protection it mandates, removing exactly that one must
 * produce a startup failure naming exactly that requirement. A hand-written list of
 * cases would drift the moment a requirement is added; this cannot.
 */
test("no silent downgrade: every mandatory protection fails on its own", () => {
  const envFor = (requirement: PostureRequirement): Record<string, string | undefined> => {
    const env: Record<string, string | undefined> = { ...ALL_PROTECTIONS };
    if (requirement === "explicit_remote_opt_in") {
      delete env.BAYZ_ALLOW_REMOTE;
    }
    if (requirement === "tls") {
      delete env.BAYZ_TLS_CERT;
      delete env.BAYZ_TLS_KEY;
    }
    if (requirement === "client_authentication") {
      delete env.BAYZ_TLS_CLIENT_CA;
    }
    return env;
  };

  const hosts: Record<BayzPosture, string> = {
    loopback: "127.0.0.1",
    lan: "192.168.1.10",
    remote: "203.0.113.7",
  };

  let checked = 0;
  for (const posture of POSTURES) {
    for (const requirement of POSTURE_REQUIREMENTS[posture]) {
      const env = envFor(requirement);
      const apiTokenExplicit = requirement !== "explicit_api_token";
      assert.throws(
        () => resolvePosture({ host: hosts[posture], env, apiTokenExplicit }),
        (error: unknown) => {
          assert.ok(
            error instanceof PostureError,
            `${posture}/${requirement} did not raise a PostureError`,
          );
          assert.equal(
            error.requirement,
            requirement,
            `${posture} reported ${error.requirement} when ${requirement} was missing`,
          );
          return true;
        },
      );
      checked += 1;
    }
  }
  // Seven mandatory protections across the three postures; a requirement added without
  // a case fails the count rather than passing unnoticed.
  assert.equal(checked, 7);
});

test("a fully configured lan and remote listener starts", () => {
  for (const host of ["192.168.1.10", "203.0.113.7"]) {
    const resolved = resolvePosture({
      host,
      env: { ...ALL_PROTECTIONS },
      apiTokenExplicit: true,
    });
    assert.equal(resolved.tls, true);
    assert.equal(resolved.mutualTls, true);
    assert.equal(resolved.denyAdminOverWire, true);
  }
});

test("isLoopbackPeer recognises local peers and refuses unknowns", () => {
  assert.equal(isLoopbackPeer("127.0.0.1"), true);
  assert.equal(isLoopbackPeer("::1"), true);
  // A dual-stack listener reports the mapped form.
  assert.equal(isLoopbackPeer("::ffff:127.0.0.1"), true);
  assert.equal(isLoopbackPeer("192.168.1.10"), false);
  assert.equal(isLoopbackPeer("8.8.8.8"), false);
  assert.equal(isLoopbackPeer(undefined), false, "an unknown peer must not be trusted");
  assert.equal(isLoopbackPeer(""), false);
});

test("hostsForBind yields the addresses a listener actually answers", () => {
  // A concrete loopback bind contributes only itself.
  assert.deepEqual(hostsForBind("127.0.0.1"), ["127.0.0.1"]);
  assert.deepEqual(hostsForBind("localhost"), ["localhost"]);
  // A concrete non-loopback bind contributes that exact address — the Host a
  // LAN client sends when it opens https://<that-ip>:<port>.
  assert.deepEqual(hostsForBind("192.168.1.50"), ["192.168.1.50"]);
  // IPv6 keeps its bracketless canonical form.
  assert.deepEqual(hostsForBind("[::1]"), ["::1"]);
  // An empty bind contributes nothing extra (the loopback defaults still stand).
  assert.deepEqual(hostsForBind(undefined), []);
  assert.deepEqual(hostsForBind(""), []);
});

test("hostsForBind on a wildcard covers the machine's real interfaces", () => {
  const hosts = hostsForBind("0.0.0.0");
  // Every returned host must be a real interface the wildcard could bind.
  const real = new Set<string>();
  for (const infos of Object.values(networkInterfaces()) as NetworkInterfaceInfo[][]) {
    for (const info of infos ?? []) {
      if (info.internal || (info.family === "IPv6" && info.address.toLowerCase().startsWith("fe8"))) {
        continue;
      }
      real.add(info.address.toLowerCase());
    }
  }
  // Loopback itself stays in the guard's default set and is not duplicated here.
  assert.ok(!hosts.includes("127.0.0.1"));
  // A wildcard must be usable to expose the service; if the host has any
  // non-loopback interface, that address must appear.
  assert.ok(
    real.size === 0 || hosts.length > 0,
    "a machine with a real interface must derive at least one host",
  );
  for (const h of hosts) {
    assert.ok(real.has(h), `derived host ${h} must be a real interface address`);
  }
});

/* ------------------------------------------------------------------ *
 * Wire-level behaviour
 * ------------------------------------------------------------------ */

type Harness = { app: FastifyInstance; runtime: BayzRuntime };

function harness(posture?: BayzPosture): Harness {
  const runtime = createBayzRuntime(
    { host: "127.0.0.1", port: 20141, dataDir: dataDir(), dashboardRoot: "/nonexistent" },
    { env: { BAYZ_MASTER_KEY: KEY, BAYZ_API_TOKEN: TOKEN }, notify: () => {} },
  );
  const app = buildApp({
    logger: false,
    apiToken: TOKEN,
    runtime,
    rateLimit: { max: 100000, authMax: 100000 },
    ...(posture === undefined ? {} : { posture }),
  });
  return { app, runtime };
}

test("the posture appears in /api/status as a string", async (t) => {
  const { app, runtime } = harness("lan");
  t.after(async () => {
    runtime.close();
    await app.close();
  });

  const response = await app.inject({
    method: "GET",
    url: "/api/status",
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(response.statusCode, 200);
  const body = response.json() as { posture: string };
  assert.equal(body.posture, "lan");
  assert.equal(typeof body.posture, "string");
});

test("status reports loopback by default, so existing installs are unchanged", async (t) => {
  const { app, runtime } = harness();
  t.after(async () => {
    runtime.close();
    await app.close();
  });

  const body = (
    await app.inject({
      method: "GET",
      url: "/api/status",
      headers: { authorization: `Bearer ${TOKEN}` },
    })
  ).json() as { posture: string };
  assert.equal(body.posture, "loopback");
});

test("admin scope is refused over a non-loopback connection even with a valid admin key", async (t) => {
  const { app, runtime } = harness("lan");
  t.after(async () => {
    runtime.close();
    await app.close();
  });

  const admin = runtime.identities.createIdentity({
    id: "wire-admin",
    displayName: "Wire Admin",
    scopes: ["admin"],
  }).key;

  // A genuinely valid admin credential, arriving from off-machine. Management of the
  // deployment stays on the machine: one leaked header must not reach provider
  // credentials, proxy passwords, or root-key rotation.
  const denied = await app.inject({
    method: "GET",
    url: "/api/identities",
    headers: { authorization: `Bearer ${admin}` },
    remoteAddress: "192.168.1.50",
  });
  assert.equal(denied.statusCode, 403);
  const body = denied.json() as { error: { code: string; message: string } };
  assert.equal(body.error.code, "forbidden");
  assert.match(body.error.message, /loopback/i);

  // Same key, same app, arriving locally: permitted. This is what proves the refusal is
  // about the connection rather than about the credential.
  const allowed = await app.inject({
    method: "GET",
    url: "/api/identities",
    headers: { authorization: `Bearer ${admin}` },
    remoteAddress: "127.0.0.1",
  });
  assert.equal(allowed.statusCode, 200);
});

test("the bootstrap token is also refused admin routes over the wire", async (t) => {
  const { app, runtime } = harness("remote");
  t.after(async () => {
    runtime.close();
    await app.close();
  });

  // The Phase 6 token carries `admin`, so exempting it would leave the largest hole
  // exactly where the ladder is supposed to close it.
  const denied = await app.inject({
    method: "POST",
    url: "/api/security/rotate-root-key",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    payload: {},
    remoteAddress: "203.0.113.9",
  });
  assert.equal(denied.statusCode, 403);
});

test("non-admin scopes still work over the wire in lan posture", async (t) => {
  const { app, runtime } = harness("lan");
  t.after(async () => {
    runtime.close();
    await app.close();
  });

  const reader = runtime.identities.createIdentity({
    id: "wire-reader",
    displayName: "Wire Reader",
    scopes: ["providers.read"],
  }).key;

  // The ladder restricts `admin`, not the product. A chat or read client is exactly who
  // a `lan` deployment exists to serve.
  const response = await app.inject({
    method: "GET",
    url: "/api/providers",
    headers: { authorization: `Bearer ${reader}` },
    remoteAddress: "192.168.1.50",
  });
  assert.equal(response.statusCode, 200);
});

/* ------------------------------------------------------------------ *
 * The in-flight concurrency cap
 *
 * `POSTURE_LIMITS.concurrency` is part of the ladder, so it has to be *enforced*
 * rather than merely reported. A declared-but-unused limit is a hollow contract: an
 * operator reading `/api/status` would believe a protection exists that nothing
 * applies.
 * ------------------------------------------------------------------ */

/** An app with a deferred guarded route, so requests can be held genuinely in flight. */
function slowApp(concurrency: number): {
  app: FastifyInstance;
  release: () => void;
  started: () => number;
} {
  let resolveAll: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    resolveAll = resolve;
  });
  let started = 0;

  const app = buildApp({
    logger: false,
    apiToken: TOKEN,
    registerTestRoutes: true,
    rateLimit: { max: 100000, authMax: 100000 },
    concurrency,
  });
  app.get("/__test/slow", async () => {
    started += 1;
    await gate;
    return { ok: true };
  });
  app.get("/__test/boom", async () => {
    started += 1;
    throw new Error("deliberate");
  });

  return { app, release: () => resolveAll?.(), started: () => started };
}

/**
 * Await a response with a deadline.
 *
 * Without this an un-enforced cap makes the suite *hang* instead of fail, because the
 * over-limit request reaches the deferred handler and waits on the gate forever. A
 * hang is a useless RED: it reports nothing about which assertion is unmet.
 */
async function within<T>(work: Promise<T>, label: string, ms = 2000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} did not settle within ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/** Spin until `condition` holds, bounded, so a wait cannot become a hang. */
async function until(condition: () => boolean, label: string, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`${label} never became true within ${ms}ms`);
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test("the in-flight cap refuses the request beyond it and recovers afterwards", async (t) => {
  const { app, release, started } = slowApp(2);
  t.after(async () => {
    release();
    await app.close();
  });

  const held = [
    app.inject({
      method: "GET",
      url: "/__test/slow",
      headers: { authorization: `Bearer ${TOKEN}` },
    }),
    app.inject({
      method: "GET",
      url: "/__test/slow",
      headers: { authorization: `Bearer ${TOKEN}` },
    }),
  ];
  // Let both reach the handler, so the cap is genuinely full rather than racing.
  await until(() => started() === 2, "two requests in flight");

  const refused = await within(
    app.inject({
      method: "GET",
      url: "/__test/slow",
      headers: { authorization: `Bearer ${TOKEN}` },
    }),
    "the over-limit request",
  );
  assert.equal(refused.statusCode, 429);
  const body = refused.json() as { error: { code: string; message: string } };
  assert.equal(body.error.code, "rate_limited");
  assert.ok(refused.headers["retry-after"] !== undefined, "a refusal must say when to retry");
  assert.equal(started(), 2, "the refused request must never reach the handler");

  release();
  const settled = await within(Promise.all(held), "the held requests");
  assert.deepEqual(
    settled.map((response) => response.statusCode),
    [200, 200],
    "the held requests must complete normally",
  );

  // The slot is returned, so the cap is a cap and not a one-way budget.
  const after = await within(
    app.inject({
      method: "GET",
      url: "/__test/slow",
      headers: { authorization: `Bearer ${TOKEN}` },
    }),
    "a request after the cap drained",
  );
  assert.equal(after.statusCode, 200);
});

test("a slot is released on a failed request, not only on a successful one", async (t) => {
  const { app, release } = slowApp(1);
  t.after(async () => {
    release();
    await app.close();
  });

  // A handler that throws still consumed a slot; leaking it would let a few 500s
  // wedge the listener permanently, which is a denial of service built out of a
  // protection.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await within(
      app.inject({
        method: "GET",
        url: "/__test/boom",
        headers: { authorization: `Bearer ${TOKEN}` },
      }),
      `error attempt ${attempt}`,
    );
    assert.equal(response.statusCode, 500, `attempt ${attempt} was not an error`);
  }

  const ok = await within(
    app.inject({
      method: "GET",
      url: "/__test/guarded",
      headers: { authorization: `Bearer ${TOKEN}` },
    }),
    "a request after five failures",
  );
  assert.equal(ok.statusCode, 200, "the cap did not recover after failures");
});

test("a rejected request does not leak a slot either", async (t) => {
  const { app, release } = slowApp(1);
  t.after(async () => {
    release();
    await app.close();
  });

  // An unauthenticated request is refused inside the same hook that acquires the
  // slot. If acquisition and release disagree about that path, an attacker can
  // exhaust the cap with credential-free requests.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const denied = await within(
      app.inject({ method: "GET", url: "/__test/guarded" }),
      `denied attempt ${attempt}`,
    );
    assert.equal(denied.statusCode, 401);
  }

  const ok = await within(
    app.inject({
      method: "GET",
      url: "/__test/guarded",
      headers: { authorization: `Bearer ${TOKEN}` },
    }),
    "a request after five rejections",
  );
  assert.equal(ok.statusCode, 200);
});

test("the health probe is exempt from the in-flight cap", async (t) => {
  const { app, release, started } = slowApp(1);
  t.after(async () => {
    release();
    await app.close();
  });

  const held = app.inject({
    method: "GET",
    url: "/__test/slow",
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  await until(() => started() === 1, "one request in flight");

  // Same reasoning as the rate limiter: a supervisor's liveness check must not be
  // starved by traffic, or the cap turns a busy listener into a restarted one.
  const health = await within(
    app.inject({ method: "GET", url: "/api/health" }),
    "the health probe",
  );
  assert.equal(health.statusCode, 200);

  release();
  assert.equal((await within(held, "the held request")).statusCode, 200);
});

test("no cap is enforced when none is configured, preserving Phase 6 behaviour", async (t) => {
  const { app, release, started } = slowApp(Number.NaN);
  t.after(async () => {
    release();
    await app.close();
  });

  // `slowApp` passes the value straight through, so this also pins the validation
  // direction: a nonsense cap must not silently become 0 and refuse everything.
  const held = Array.from({ length: 8 }, () =>
    app.inject({
      method: "GET",
      url: "/__test/slow",
      headers: { authorization: `Bearer ${TOKEN}` },
    }),
  );
  await until(() => started() === 8, "eight requests in flight");
  release();
  const settled = await within(Promise.all(held), "eight uncapped requests");
  assert.ok(
    settled.every((response) => response.statusCode === 200),
    "an unconfigured or invalid cap must not refuse traffic",
  );
});

test("every posture's declared concurrency limit is actually enforceable", () => {
  // The ladder reports these numbers, so each must be a usable cap rather than a
  // decorative field.
  for (const posture of POSTURES) {
    const limit = POSTURE_LIMITS[posture].concurrency;
    assert.ok(
      Number.isInteger(limit) && limit >= 1,
      `${posture} declares an unusable concurrency limit: ${limit}`,
    );
  }
});

test("in loopback posture a remote-looking peer is still refused admin", async (t) => {
  // Defence in depth: loopback posture means the listener is *bound* locally, so a
  // non-local peer should be impossible. If one appears anyway (a proxy in front, a
  // spoofed header), the admin refusal must not depend on the posture flag alone.
  const { app, runtime } = harness();
  t.after(async () => {
    runtime.close();
    await app.close();
  });

  const admin = runtime.identities.createIdentity({
    id: "local-admin",
    displayName: "Local Admin",
    scopes: ["admin"],
  }).key;

  const response = await app.inject({
    method: "GET",
    url: "/api/identities",
    headers: { authorization: `Bearer ${admin}` },
    remoteAddress: "10.1.2.3",
  });
  assert.equal(response.statusCode, 403);
});
