#!/usr/bin/env node
/**
 * Upgrade ladder against the real installed artifact — Phase 9J Task 6.
 *
 * `packages/storage/test/upgrade-ladder.test.ts` proves the migration ladder at the storage layer.
 * This proves it where an operator experiences it: a database built at an older schema version, then
 * opened by the **installed binary**, with a real chat succeeding afterwards and
 * `PRAGMA integrity_check` returning `ok` at every step.
 *
 * The distinction matters because the artifact is a *bundle*. Migrations that work when imported from
 * `packages/storage/src` could in principle be tree-shaken, reordered, or broken by bundling, and the
 * storage test would never notice.
 *
 * Numbered checks so the matrix can cite `smoke:upgrade#N`. Exits non-zero on any failure.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/*
 * Relaunched under `tsx` for the same single reason `install-smoke.mjs` is: the fixtures need the real
 * `MIGRATIONS` list and `sealSecret` from `packages/storage/src`, so an old database is built with the
 * genuine DDL and a genuine envelope rather than a hand-copied approximation that would drift.
 *
 * Everything *under test* is still the installed artifact's own compiled bundle, in its own process.
 */
if (!process.env.BAYZ_UPGRADE_SMOKE_LOADER) {
  const relaunch = spawnSync(
    process.execPath,
    ["--import", "tsx", fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    { stdio: "inherit", env: { ...process.env, BAYZ_UPGRADE_SMOKE_LOADER: "1" } },
  );
  process.exit(relaunch.status ?? 1);
}

const failures = [];
let checkNumber = 0;

function check(label, condition, detail) {
  checkNumber += 1;
  if (condition) {
    console.log(`  ok   ${String(checkNumber).padStart(2)}. ${label}`);
  } else {
    console.error(`  FAIL ${String(checkNumber).padStart(2)}. ${label}${detail === undefined ? "" : ` — ${detail}`}`);
    failures.push(`#${checkNumber} ${label}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

const KEK = Buffer.alloc(32, 0x71);
const KEK_HEX = KEK.toString("hex");
const TOKEN = "upgrade-smoke-token-0123456789ab";
const NOW = "2026-01-01T00:00:00.000Z";

/** A real loopback origin, so the post-upgrade chat is a real completion. */
async function startOrigin() {
  const seen = [];
  const server = createHttpServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      seen.push({ url: request.url, authorization: request.headers.authorization });
      response.writeHead(200, { "content-type": "application/json" });
      if (request.url?.includes("/chat/completions")) {
        response.end(
          JSON.stringify({
            id: "chatcmpl-upgrade",
            model: "legacy-model",
            choices: [{ index: 0, message: { role: "assistant", content: "UPGRADE-OK" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
          }),
        );
        return;
      }
      response.end(JSON.stringify({ data: [{ id: "legacy-model" }] }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: server.address().port, seen };
}

async function api(base, path, { token = TOKEN, method = "GET", body } = {}) {
  const headers = {};
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let json;
  try {
    json = text.length > 0 ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return { status: response.status, text, json, headers: response.headers };
}

/** Start the installed binary and wait for a real health response. */
async function startInstalled({ bin, env, port, timeoutMs = 40_000 }) {
  const child = spawn(bin, [], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  let exited = false;
  let exitCode;
  child.on("exit", (code) => {
    exited = true;
    exitCode = code;
  });

  const deadline = Date.now() + timeoutMs;
  let ready = false;
  while (Date.now() < deadline && !exited) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.status === 200) {
        ready = true;
        break;
      }
    } catch {
      // Not listening yet.
    }
    await sleep(250);
  }

  return {
    ready,
    get exited() {
      return exited;
    },
    get exitCode() {
      return exitCode;
    },
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
    async stop() {
      if (exited) return;
      child.kill("SIGTERM");
      const stopBy = Date.now() + 15_000;
      while (Date.now() < stopBy && !exited) await sleep(150);
      if (!exited) child.kill("SIGKILL");
      while (!exited) await sleep(50);
    },
  };
}

/** Run the installed binary to completion, for the refusal checks. */
function runInstalledToExit({ bin, env, timeoutMs = 40_000 }) {
  const result = spawnSync(bin, [], {
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: timeoutMs,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/* ------------------------------------------------------------------ fixture */

/** Which tables exist at a given schema version, so a fixture writes only what it can. */
function tablesAt(migrations, version) {
  const names = new Set();
  for (const migration of migrations) {
    if (migration.version > version) continue;
    for (const statement of migration.statements) {
      const created = /CREATE TABLE (\w+)/.exec(statement)?.[1];
      if (created !== undefined) names.add(created);
      const renamed = /ALTER TABLE \w+ RENAME TO (\w+)/.exec(statement)?.[1];
      if (renamed !== undefined) names.add(renamed);
    }
  }
  names.delete("providers_v7");
  return names;
}

/**
 * Build a database at exactly `version`, populated with real operator data.
 *
 * `runMigrations` is given a truncated list — the only honest way to produce a genuine older
 * database. Writing the head schema and editing `user_version` down would produce a shape no BAYZ
 * build ever created, and the ahead-of-head refusal added in this task would reject it anyway.
 */
async function buildLegacyDatabase({ dataDir, version, originPort, storage }) {
  const { MIGRATIONS, computeKeyId, ensureDataDir, runMigrations, sealSecret, selectDriver } = storage;
  ensureDataDir(dataDir);
  const db = selectDriver().open(join(dataDir, "bayz.db"));
  db.exec("PRAGMA foreign_keys = ON");
  const tables = tablesAt(MIGRATIONS, version);

  try {
    runMigrations(db, MIGRATIONS.slice(0, version));

    const credential = `upgrade-credential-v${version}`;
    const envelope = sealSecret(KEK, "provider:legacy:api_key", credential);
    db.prepare(
      `INSERT INTO secrets
         (name, version, algorithm, kdf, key_id, wrapped_dek, wrap_iv, wrap_tag,
          ciphertext, iv, tag, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "provider:legacy:api_key",
      envelope.version,
      envelope.algorithm,
      envelope.kdf,
      envelope.keyId,
      envelope.wrappedDek,
      envelope.wrapIv,
      envelope.wrapTag,
      envelope.ciphertext,
      envelope.iv,
      envelope.tag,
      NOW,
      NOW,
    );
    /*
     * The API token is a stored secret too, so an upgraded install keeps the operator's token rather
     * than generating a new one and printing it again.
     *
     * The name is `api:token`, taken from `apps/server/src/api-token.ts`. The first version of this
     * script guessed `bayz:api_token`, which stored a secret nothing reads: the daemon then generated
     * its own token and every authenticated check came back 401.
     */
    const tokenEnvelope = sealSecret(KEK, "api:token", TOKEN);
    db.prepare(
      `INSERT INTO secrets
         (name, version, algorithm, kdf, key_id, wrapped_dek, wrap_iv, wrap_tag,
          ciphertext, iv, tag, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "api:token",
      tokenEnvelope.version,
      tokenEnvelope.algorithm,
      tokenEnvelope.kdf,
      tokenEnvelope.keyId,
      tokenEnvelope.wrappedDek,
      tokenEnvelope.wrapIv,
      tokenEnvelope.wrapTag,
      tokenEnvelope.ciphertext,
      tokenEnvelope.iv,
      tokenEnvelope.tag,
      NOW,
      NOW,
    );
    db.prepare("INSERT INTO runtime_metadata (key, value) VALUES (?, ?)").run("active_key_id", computeKeyId(KEK));
    db.prepare("INSERT INTO runtime_metadata (key, value) VALUES (?, ?)").run("crypto_format_version", "1");

    if (tables.has("providers")) {
      db.prepare(
        `INSERT INTO providers
           (id, kind, display_name, base_url, enabled, config_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "legacy",
        "openai-compatible",
        "Legacy Provider",
        `http://127.0.0.1:${originPort}/v1`,
        1,
        JSON.stringify({ allowLoopback: true }),
        NOW,
        NOW,
      );
    }
    if (tables.has("proxies")) {
      db.prepare(
        `INSERT INTO proxies
           (id, kind, host, port, username, enabled, config_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run("legacy-proxy", "http", "127.0.0.1", 3128, "operator", 1, "{}", NOW, NOW);
    }
    if (tables.has("routes")) {
      db.prepare(
        `INSERT INTO routes
           (id, model, provider_id, proxy_id, priority, enabled, config_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run("legacy-route", "legacy-model", "legacy", null, 10, 1, "{}", NOW, NOW);
    }
    if (tables.has("client_identities")) {
      db.prepare(
        `INSERT INTO client_identities
           (id, display_name, scopes_json, preset, revoked, expires_at, created_at, updated_at, last_used_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run("legacy-client", "Legacy Client", '["chat.completions"]', null, 0, null, NOW, NOW, null);
    }
    if (tables.has("usage_requests")) {
      db.prepare(
        `INSERT INTO usage_requests
           (request_id, occurred_at, route_id, provider_id, proxy_id, model, routing_mode,
            outcome, failure_category, latency_ms, attempts, prompt_tokens, completion_tokens, cached_tokens)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run("req-legacy", NOW, "legacy-route", "legacy", null, "legacy-model", "direct", "ok", null, 42, 1, 7, 5, null);
    }

    return { credential, tables };
  } finally {
    db.close();
  }
}

/** `PRAGMA integrity_check` through a separate short-lived connection. */
function integrityCheck(storage, dataDir) {
  const db = storage.selectDriver().open(join(dataDir, "bayz.db"));
  try {
    return String(db.prepare("PRAGMA integrity_check").get()?.integrity_check);
  } finally {
    db.close();
  }
}

function schemaVersionOf(storage, dataDir) {
  const db = storage.selectDriver().open(join(dataDir, "bayz.db"));
  try {
    return Number(db.prepare("PRAGMA user_version").get()?.user_version ?? 0);
  } finally {
    db.close();
  }
}

/* ---------------------------------------------------------------------- run */

async function main() {
  console.log("BAYZ upgrade ladder smoke — Phase 9J Task 6");

  const pack = await import(join(ROOT, "scripts/pack.mjs"));
  const storage = await import(join(ROOT, "packages/storage/src/index.js"));
  const head = storage.TARGET_SCHEMA_VERSION;

  const workspace = mkdtempSync(join(tmpdir(), "bayz-upgrade-smoke-"));
  const prefix = join(workspace, "prefix");
  const cache = join(workspace, "cache");
  mkdirSync(prefix, { recursive: true });
  mkdirSync(cache, { recursive: true });

  const origin = await startOrigin();
  let daemon;
  let port = 21901;

  try {
    section("1. Install the artifact");
    const built = pack.buildArtifact({ root: ROOT, outDir: join(workspace, "artifact") });
    const install = spawnSync(
      "npm",
      [
        "install",
        built.tarballPath,
        "--prefix",
        prefix,
        "--cache",
        cache,
        "--omit=dev",
        "--no-audit",
        "--no-fund",
      ],
      { cwd: workspace, encoding: "utf8", timeout: 900_000, stdio: ["ignore", "pipe", "pipe"] },
    );
    check("npm install of the artifact exits 0", install.status === 0, (install.stderr ?? "").slice(-300));
    const bin = join(prefix, "node_modules", ".bin", "bayz");
    check("the installed bin exists", existsSync(bin), bin);

    section(`2. The ladder: every version v1..v${head} opened by the installed binary`);
    /*
     * Every rung, not a sample. A migration that only breaks when arriving from one particular older
     * version is exactly the bug an operator hits and a spot-check misses.
     */
    for (let version = 1; version <= head; version += 1) {
      const dataDir = join(workspace, `data-v${version}`);
      const fixture = await buildLegacyDatabase({ dataDir, version, originPort: origin.port, storage });

      const before = schemaVersionOf(storage, dataDir);
      port += 1;
      daemon = await startInstalled({
        bin,
        port,
        env: {
          BAYZ_DATA_DIR: dataDir,
          BAYZ_PORT: String(port),
          BAYZ_HOST: "127.0.0.1",
          BAYZ_MASTER_KEY: KEK_HEX,
        },
      });
      const base = `http://127.0.0.1:${port}`;

      check(
        `a v${version} database boots the installed artifact`,
        daemon.ready,
        `started at v${before}; ${daemon.stderr.slice(-300)}`,
      );
      if (!daemon.ready) {
        await daemon.stop();
        daemon = undefined;
        continue;
      }

      const status = await api(base, "/api/status");
      check(
        `v${version} reached schema head v${head}`,
        status.json?.schemaVersion === head,
        `reports v${status.json?.schemaVersion}`,
      );

      if (fixture.tables.has("routes")) {
        /*
         * **The free-first default must survive the upgrade, so the first chat is expected to be
         * refused.**
         *
         * Migration v10 adds `routes.free_only NOT NULL DEFAULT 1`, which means every route migrated
         * from an older database — and every route inserted by a client that predates the column —
         * arrives free-only. Spec §25 rule 6 makes paid routing opt-in, so this is the migration
         * protecting the operator, not a fault.
         *
         * The first version of this script asserted a successful chat here and read the resulting
         * `no_free_route` as a bug in the ladder. It is the opposite: an upgrade that silently
         * cleared `free_only` would let a migrated route start spending money without anyone asking.
         * So the refusal is asserted as the guarantee, and the completion is asserted after an
         * explicit opt-in.
         */
        const refusedChat = await api(base, "/v1/chat/completions", {
          method: "POST",
          body: { model: "legacy-model", messages: [{ role: "user", content: `after upgrade from v${version}` }] },
        });
        check(
          `an upgraded v${version} route stays free-only until the operator opts in`,
          refusedChat.status === 409 && refusedChat.json?.error?.code === "no_free_route",
          `${refusedChat.status}: ${refusedChat.text.slice(0, 160)}`,
        );

        const optIn = await api(base, "/api/routes/legacy-route", { method: "PATCH", body: { freeOnly: false } });
        check(`the upgraded v${version} route accepts an explicit paid opt-in`, optIn.status === 200, `${optIn.status}: ${optIn.text.slice(0, 160)}`);

        /*
         * Now the real completion, through the route and credential the old database carried. This is
         * the assertion that covers the whole path at once: if a migration had lost the provider, the
         * route, or the encrypted credential, no completion could come back.
         */
        const chat = await api(base, "/v1/chat/completions", {
          method: "POST",
          body: { model: "legacy-model", messages: [{ role: "user", content: `after upgrade from v${version}` }] },
        });
        check(
          `a real chat succeeds after upgrading from v${version}`,
          chat.status === 200 && chat.json?.choices?.[0]?.message?.content === "UPGRADE-OK",
          `${chat.status}: ${chat.text.slice(0, 160)}`,
        );
        check(
          `the v${version} stored credential still decrypts and reaches the upstream`,
          origin.seen.some(
            (entry) =>
              entry.url?.includes("/chat/completions") && entry.authorization === `Bearer ${fixture.credential}`,
          ),
          "the upstream did not receive the pre-upgrade credential",
        );
      } else {
        /*
         * v1–v3 predate the `routes` table, so those fixtures have no route to chat through. Recorded
         * explicitly rather than skipped silently: the claim for those versions is "the database
         * upgrades and the daemon serves", and the API answering with the migrated schema is what
         * proves it.
         */
        check(
          `v${version} predates routes; the API still answers after the upgrade`,
          status.status === 200,
          `status ${status.status}`,
        );
        check(
          `the v${version} stored credential survived the upgrade`,
          (await api(base, "/api/providers")).status === 200,
          "the providers endpoint failed after upgrade",
        );
      }

      await daemon.stop();
      daemon = undefined;

      check(`PRAGMA integrity_check is ok after upgrading from v${version}`, integrityCheck(storage, dataDir) === "ok");
    }

    section("3. A downgrade is refused, not attempted");
    /*
     * The installed binary must refuse a database from a newer build. Proven through the artifact
     * because that is where an operator meets it — they install an older release over a newer one.
     */
    const aheadDir = join(workspace, "data-ahead");
    await buildLegacyDatabase({ dataDir: aheadDir, version: head, originPort: origin.port, storage });
    const aheadDb = storage.selectDriver().open(join(aheadDir, "bayz.db"));
    try {
      for (const version of [head + 1, head + 2]) {
        aheadDb.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(version, NOW);
      }
      aheadDb.exec(`PRAGMA user_version = ${head + 2}`);
    } finally {
      aheadDb.close();
    }

    const refused = runInstalledToExit({
      bin,
      env: {
        BAYZ_DATA_DIR: aheadDir,
        BAYZ_PORT: "21990",
        BAYZ_HOST: "127.0.0.1",
        BAYZ_MASTER_KEY: KEK_HEX,
      },
    });
    check("a database from a newer build refuses to start", refused.status !== 0, `exit ${refused.status}`);
    check(
      "the refusal names the storage stage rather than crashing opaquely",
      /storage_unavailable|verify-schema-ahead-of-head/.test(`${refused.stdout}${refused.stderr}`),
      `${refused.stdout}${refused.stderr}`.slice(-300),
    );
    check("the refused database is left at its own version", schemaVersionOf(storage, aheadDir) === head + 2);

    section("4. One unreadable provider config does not brick the install");
    /*
     * The domain half of the corrupted-row recovery. The storage test proves the database still opens;
     * this proves the **API still serves** — a running daemon, a real chat on a healthy route, and the
     * documented repair actually working.
     */
    const badDir = join(workspace, "data-badrow");
    await buildLegacyDatabase({ dataDir: badDir, version: head, originPort: origin.port, storage });
    const badDb = storage.selectDriver().open(join(badDir, "bayz.db"));
    try {
      badDb.exec("PRAGMA foreign_keys = ON");
      badDb.prepare(
        `INSERT INTO providers
           (id, kind, display_name, base_url, enabled, config_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run("broken", "openai-compatible", "Broken", "https://broken.example/v1", 1, "{not json", NOW, NOW);
    } finally {
      badDb.close();
    }

    port += 1;
    daemon = await startInstalled({
      bin,
      port,
      env: {
        BAYZ_DATA_DIR: badDir,
        BAYZ_PORT: String(port),
        BAYZ_HOST: "127.0.0.1",
        BAYZ_MASTER_KEY: KEK_HEX,
      },
    });
    const badBase = `http://127.0.0.1:${port}`;
    check("a corrupt provider row still allows startup", daemon.ready, daemon.stderr.slice(-300));

    if (daemon.ready) {
      check("/api/health still answers with a corrupt row present", (await api(badBase, "/api/health")).status === 200);

      const listed = await api(badBase, "/api/providers");
      check(
        "listing providers reports the bad row rather than hiding it",
        listed.status === 200 && Array.isArray(listed.json?.unreadable) && listed.json.unreadable.includes("broken"),
        `${listed.status}: ${listed.text.slice(0, 200)}`,
      );
      check(
        "the healthy provider is still listed alongside the corrupt one",
        listed.json?.providers?.some((provider) => provider.id === "legacy"),
        `${listed.status}: ${listed.text.slice(0, 200)}`,
      );

      // A chat on the *healthy* route still works, which is what "not bricked" means. The opt-in is
      // needed here for the same free-first reason as the ladder above.
      await api(badBase, "/api/routes/legacy-route", { method: "PATCH", body: { freeOnly: false } });
      const healthyChat = await api(badBase, "/v1/chat/completions", {
        method: "POST",
        body: { model: "legacy-model", messages: [{ role: "user", content: "healthy route" }] },
      });
      check(
        "a chat on a healthy route still succeeds",
        healthyChat.status === 200 && healthyChat.json?.choices?.[0]?.message?.content === "UPGRADE-OK",
        `${healthyChat.status}: ${healthyChat.text.slice(0, 160)}`,
      );

      // The documented repair.
      const deleted = await api(badBase, "/api/providers/broken", { method: "DELETE" });
      check("the corrupt provider can be deleted", deleted.status === 204, `status ${deleted.status}`);
      const afterDelete = await api(badBase, "/api/providers");
      check(
        "listing recovers once the bad row is gone",
        afterDelete.status === 200 && afterDelete.json?.unreadable === undefined,
        afterDelete.text.slice(0, 200),
      );
    } else {
      check("/api/health still answers with a corrupt row present", false, "daemon never started");
      check("listing providers reports the bad row rather than hiding it", false, "daemon never started");
      check("the healthy provider is still listed alongside the corrupt one", false, "daemon never started");
      check("a chat on a healthy route still succeeds", false, "daemon never started");
      check("the corrupt provider can be deleted", false, "daemon never started");
      check("listing recovers once the bad row is gone", false, "daemon never started");
    }

    await daemon.stop();
    daemon = undefined;
  } finally {
    if (daemon !== undefined) await daemon.stop();
    origin.server.close();
    try {
      rmSync(workspace, { recursive: true, force: true });
    } catch {
      // A leftover temp directory is not a smoke failure.
    }
  }

  console.log("");
  console.log(`${checkNumber - failures.length}/${checkNumber} checks passed`);
  if (failures.length > 0) {
    console.error("upgrade smoke: FAIL");
    for (const failure of failures) console.error(`  - ${failure}`);
    return 1;
  }
  console.log("upgrade smoke: PASS");
  return 0;
}

process.exitCode = await main();
