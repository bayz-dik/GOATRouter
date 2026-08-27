#!/usr/bin/env node
/**
 * Non-mocked per-client security proof for Phase 9C.
 *
 * The property under test is blast radius: three real client identities against a
 * real listener, and revoking one must leave the others working while provider
 * credentials stay unreachable to all of them. That is a statement about a running
 * system, not about a function, so everything here is real — a real database, a real
 * HTTP listener, real `fetch`, and a real upstream origin.
 *
 * Exits non-zero on any failed check.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

if (!process.env.BAYZ_IDENTITY_SMOKE_LOADER) {
  const relaunch = spawnSync(
    process.execPath,
    ["--import", "tsx", fileURLToPath(import.meta.url)],
    { stdio: "inherit", env: { ...process.env, BAYZ_IDENTITY_SMOKE_LOADER: "1" } },
  );
  process.exit(relaunch.status ?? 1);
}

const ADMIN_TOKEN = "identity-smoke-admin-token-0123456789";
const KEK_HEX = Buffer.alloc(32, 0x6c).toString("hex");
const CREDENTIAL = "sk-identity-smoke-provider-credential";
const PROXY_PASSWORD = "hunter2-identity-smoke-proxy";
const COMPLETION = "IDENTITY-SMOKE-COMPLETION";

const failures = [];
const bodies = [];
let checks = 0;

function check(label, condition) {
  checks += 1;
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    console.error(`  FAIL ${label}`);
    failures.push(label);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

async function startOrigin() {
  const server = createHttpServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.writeHead(200, { "content-type": "application/json" });
      if (request.url?.includes("/chat/completions")) {
        response.end(
          JSON.stringify({
            model: "smoke-model",
            choices: [
              { message: { role: "assistant", content: COMPLETION }, finish_reason: "stop" },
            ],
          }),
        );
        return;
      }
      response.end(JSON.stringify({ data: [{ id: "smoke-model" }] }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: server.address().port,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function main() {
  const { buildApp } = await import("../apps/server/src/app.ts");
  const { createBayzRuntime } = await import("../apps/server/src/runtime.ts");

  const dataDir = join(mkdtempSync(join(tmpdir(), "bayz-identity-smoke-")), ".bayz");
  const logLines = [];
  const runtime = createBayzRuntime(
    { host: "127.0.0.1", port: 0, dataDir, dashboardRoot: "/nonexistent" },
    {
      env: { BAYZ_MASTER_KEY: KEK_HEX, BAYZ_API_TOKEN: ADMIN_TOKEN },
      notify: () => {},
      logger: (payload) => logLines.push(JSON.stringify(payload)),
    },
  );
  const app = buildApp({
    logger: false,
    apiToken: ADMIN_TOKEN,
    runtime,
    rateLimit: { max: 100000, authMax: 100000 },
  });
  const origin = await startOrigin();
  let base = "";

  async function call(method, path, options = {}) {
    const headers = {};
    const token = options.token ?? ADMIN_TOKEN;
    if (token !== null) {
      headers.authorization = `Bearer ${token}`;
    }
    if (options.body !== undefined) {
      headers["content-type"] = "application/json";
    }
    const response = await fetch(`${base}${path}`, {
      method,
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    const text = await response.text();
    bodies.push(text);
    let json;
    try {
      json = text.length > 0 ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    return { status: response.status, text, json };
  }

  try {
    await app.listen({ host: "127.0.0.1", port: 0 });
    base = `http://127.0.0.1:${app.server.address().port}`;

    section(`1. Real listener on ${base}`);
    check("the listener bound loopback", app.server.address().address === "127.0.0.1");

    // Provider, credential, and route, created through the real management API so a
    // real credential genuinely exists to be protected.
    check(
      "the provider was created",
      (
        await call("POST", "/api/providers", {
          body: {
            id: "smoke",
            kind: "openai-compatible",
            displayName: "Smoke Origin",
            baseUrl: `http://127.0.0.1:${origin.port}`,
            config: { allowLoopback: true },
          },
        })
      ).status === 201,
    );
    check(
      "the credential was stored",
      (
        await call("PUT", "/api/providers/smoke/credential", {
          body: { value: CREDENTIAL },
        })
      ).status === 204,
    );
    check(
      "the proxy was created",
      (
        await call("POST", "/api/proxies", {
          body: { id: "tunnel", kind: "http", host: "127.0.0.1", port: 9, username: "u" },
        })
      ).status === 201,
    );
    check(
      "the proxy password was stored",
      (
        await call("PUT", "/api/proxies/tunnel/password", {
          body: { value: PROXY_PASSWORD },
        })
      ).status === 204,
    );
    check(
      "the route was created",
      (
        await call("POST", "/api/routes", {
          body: { id: "r1", model: "smoke-model", providerId: "smoke" },
        })
      ).status === 201,
    );

    section("2. Three independent client identities");
    const keys = {};
    for (const preset of ["opencode", "hermes", "antigravity"]) {
      const created = await call("POST", "/api/identities", {
        body: {
          id: preset,
          displayName: preset,
          scopes: ["chat.completions", "models.read"],
          preset,
        },
      });
      check(`the ${preset} identity was created`, created.status === 201);
      check(
        `the ${preset} key was returned once and is 32 bytes`,
        /^[0-9a-f]{64}$/.test(created.json?.key ?? ""),
      );
      keys[preset] = created.json.key;
    }
    check(
      "the three keys are all different",
      new Set(Object.values(keys)).size === 3,
    );

    section("3. Each identity authenticates independently");
    for (const [name, key] of Object.entries(keys)) {
      const models = await call("GET", "/v1/models", { token: key });
      check(`${name} can list models`, models.status === 200);
      const chat = await call("POST", "/v1/chat/completions", {
        token: key,
        body: {
          model: "smoke-model",
          messages: [{ role: "user", content: `hello from ${name}` }],
        },
      });
      check(`${name} can chat`, chat.status === 200);
      check(
        `${name} received the completion`,
        chat.json?.choices?.[0]?.message?.content === COMPLETION,
      );
    }

    section("4. No client can reach a provider credential or a proxy password");
    for (const [name, key] of Object.entries(keys)) {
      const attempts = await Promise.all([
        call("GET", "/api/providers", { token: key }),
        call("GET", "/api/providers/smoke", { token: key }),
        call("GET", "/api/proxies", { token: key }),
        call("GET", "/api/proxies/tunnel", { token: key }),
        call("GET", "/api/routes", { token: key }),
        call("GET", "/api/status", { token: key }),
        call("GET", "/api/identities", { token: key }),
        call("GET", "/api/usage/requests", { token: key }),
        call("DELETE", "/api/usage/requests", { token: key }),
      ]);
      check(
        `${name} is forbidden on every management route`,
        attempts.every((attempt) => attempt.status === 403),
      );
      check(
        `no ${name} refusal leaks a secret`,
        attempts.every(
          (attempt) =>
            !attempt.text.includes(CREDENTIAL) && !attempt.text.includes(PROXY_PASSWORD),
        ),
      );

      // The credential path itself: GET does not exist, and the writes are refused.
      const credentialRead = await call("GET", "/api/providers/smoke/credential", {
        token: key,
      });
      check(`${name} gets 404 on a credential read`, credentialRead.status === 404);
      const credentialWrite = await call("PUT", "/api/providers/smoke/credential", {
        token: key,
        body: { value: "sk-attempted-overwrite" },
      });
      check(`${name} is forbidden from overwriting a credential`, credentialWrite.status === 403);
    }

    section("5. No client can mint or escalate an identity");
    const escalation = await call("POST", "/api/identities", {
      token: keys.opencode,
      body: { id: "minted", displayName: "Minted", scopes: ["admin"] },
    });
    check("a client cannot mint an admin identity", escalation.status === 403);
    check(
      "the minted identity does not exist",
      (await call("GET", "/api/identities/minted")).status === 404,
    );

    section("6. Revoking one client leaves the others working");
    check(
      "the opencode identity was revoked",
      (await call("DELETE", "/api/identities/opencode")).status === 204,
    );
    check(
      "the revoked key no longer authenticates",
      (await call("GET", "/v1/models", { token: keys.opencode })).status === 401,
    );
    for (const name of ["hermes", "antigravity"]) {
      check(
        `${name} still authenticates after opencode was revoked`,
        (await call("GET", "/v1/models", { token: keys[name] })).status === 200,
      );
    }
    check(
      "the revoked identity is still visible for audit",
      (await call("GET", "/api/identities/opencode")).json?.revoked === true,
    );
    check(
      "the provider credential is still usable by the admin token",
      (
        await call("POST", "/v1/chat/completions", {
          body: {
            model: "smoke-model",
            messages: [{ role: "user", content: "admin still works" }],
          },
        })
      ).status === 200,
    );

    section("7. Rotation invalidates the old key only");
    const rotated = await call("POST", "/api/identities/hermes/rotate");
    check("the rotation returned a new key", /^[0-9a-f]{64}$/.test(rotated.json?.key ?? ""));
    check("the new key differs from the old", rotated.json.key !== keys.hermes);
    check(
      "the old hermes key fails",
      (await call("GET", "/v1/models", { token: keys.hermes })).status === 401,
    );
    check(
      "the new hermes key works",
      (await call("GET", "/v1/models", { token: rotated.json.key })).status === 200,
    );
    check(
      "antigravity is unaffected by the hermes rotation",
      (await call("GET", "/v1/models", { token: keys.antigravity })).status === 200,
    );
    keys.hermes = rotated.json.key;

    section("8. The audit is metadata only");
    const audit = await call("GET", "/api/identities/audit?limit=200");
    check("the audit is readable by admin", audit.status === 200);
    const actions = new Set((audit.json?.audit ?? []).map((row) => row.action));
    check("creation is audited", actions.has("created"));
    check("authentication is audited", actions.has("authenticated"));
    check("rotation is audited", actions.has("rotated"));
    check("revocation is audited", actions.has("revoked"));
    check(
      "no audit row carries a key",
      !audit.text.match(/[0-9a-f]{64}/) &&
        !Object.values(keys).some((key) => audit.text.includes(key)),
    );
    check(
      "no audit row carries a credential",
      !audit.text.includes(CREDENTIAL) && !audit.text.includes(PROXY_PASSWORD),
    );

    section("9. Restart persistence");
    // A separate process opens the same database, proving revocation and key custody
    // are on disk rather than in memory.
    const probe = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "-e",
        `
        const { openSecretStorage } = await import("@bayz/storage");
        const { createIdentityManager } = await import("@bayz/identity");
        const storage = openSecretStorage({
          dataDir: ${JSON.stringify(dataDir)},
          env: { BAYZ_MASTER_KEY: ${JSON.stringify(KEK_HEX)} },
        });
        const manager = createIdentityManager({ storage });
        const result = {
          revokedStillFails: manager.verifyKey(${JSON.stringify(keys.opencode)}) === undefined,
          hermesStillWorks: manager.verifyKey(${JSON.stringify(keys.hermes)})?.id === "hermes",
          identityCount: manager.list().length,
        };
        console.log(JSON.stringify(result));
        storage.close();
        `,
      ],
      { cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8" },
    );
    let reopened;
    try {
      reopened = JSON.parse(probe.stdout.trim().split("\n").pop());
    } catch {
      reopened = undefined;
    }
    check("the reopen probe ran", probe.status === 0 && reopened !== undefined);
    check("revocation survived the reopen", reopened?.revokedStillFails === true);
    check("the rotated key survived the reopen", reopened?.hermesStillWorks === true);
    check("all three identities survived", reopened?.identityCount === 3);

    section("10. Leak drill across disk, logs, and responses");
    let bytes = Buffer.alloc(0);
    for (const suffix of ["", "-wal", "-shm"]) {
      const path = join(dataDir, `bayz.db${suffix}`);
      if (existsSync(path)) {
        bytes = Buffer.concat([bytes, readFileSync(path)]);
      }
    }
    check("the database files were read", bytes.length > 0);
    for (const [label, secret] of [
      ["opencode key", keys.opencode],
      ["hermes key", keys.hermes],
      ["antigravity key", keys.antigravity],
      ["provider credential", CREDENTIAL],
      ["proxy password", PROXY_PASSWORD],
      ["admin token", ADMIN_TOKEN],
    ]) {
      check(
        `the ${label} is absent from disk`,
        !bytes.includes(Buffer.from(secret, "utf8")),
      );
    }

    const logs = logLines.join("\n");
    for (const [label, secret] of [
      ["opencode key", keys.opencode],
      ["hermes key", keys.hermes],
      ["antigravity key", keys.antigravity],
      ["provider credential", CREDENTIAL],
      ["proxy password", PROXY_PASSWORD],
    ]) {
      check(`the ${label} is absent from the logs`, !logs.includes(secret));
    }

    // Every response captured during this run, excluding the two creation responses
    // that legitimately carry a key exactly once.
    const creationBodies = bodies.filter((body) => body.includes('"keyShownOnce":true'));
    check("exactly four responses carried a key", creationBodies.length === 4);
    const otherBodies = bodies.filter((body) => !body.includes('"keyShownOnce":true'));
    for (const [label, secret] of [
      ["antigravity key", keys.antigravity],
      ["provider credential", CREDENTIAL],
      ["proxy password", PROXY_PASSWORD],
    ]) {
      check(
        `the ${label} appears in no other response`,
        !otherBodies.some((body) => body.includes(secret)),
      );
    }
  } finally {
    await app.close();
    runtime.close();
    await origin.close();
  }

  console.log(`\n${checks - failures.length}/${checks} checks passed`);
  if (failures.length > 0) {
    console.error("identity smoke: FAIL");
    process.exit(1);
  }
  console.log("identity smoke: PASS");
}

main().catch((error) => {
  console.error("identity smoke crashed:", error);
  process.exit(1);
});
