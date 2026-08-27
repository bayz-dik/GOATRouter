#!/usr/bin/env node
/**
 * Non-mocked Provider Manager proof for Phase 3.
 *
 * Runs against a real on-disk SQLite database, a real loopback HTTP upstream, and
 * the real global fetch. In-process unit tests with injected fetchers cannot show
 * that discovery actually works over a socket, that a credential really is absent
 * from the bytes on disk, or that no credential reaches the wire URL.
 *
 * Exits non-zero on any failed check.
 */
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const STORAGE_ENTRY = fileURLToPath(
  new URL("../packages/storage/src/index.ts", import.meta.url),
);
const PROVIDERS_ENTRY = fileURLToPath(
  new URL("../packages/providers/src/index.ts", import.meta.url),
);

// The packages are authored in TypeScript, so this script needs tsx's loader.
// Re-exec once with it rather than forcing callers to remember the flag.
if (!process.env.BAYZ_PROVIDER_SMOKE_LOADER) {
  const relaunch = spawnSync(
    process.execPath,
    ["--import", "tsx", fileURLToPath(import.meta.url)],
    {
      stdio: "inherit",
      env: { ...process.env, BAYZ_PROVIDER_SMOKE_LOADER: "1" },
    },
  );
  process.exit(relaunch.status ?? 1);
}

const CREDENTIAL = "sk-live-PROVIDER-SMOKE-must-never-touch-disk-9182";
const GEMINI_KEY = "AIza-PROVIDER-SMOKE-gemini-key-5150";
const KEK_HEX = Buffer.alloc(32, 0x6b).toString("hex");

const captured = [];
const failures = [];
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

function logger(payload) {
  captured.push(JSON.stringify(payload));
}

/** Records every request the manager actually put on the wire. */
const requests = [];

function startUpstream() {
  const server = createServer((request, response) => {
    requests.push({
      url: request.url,
      authorization: request.headers.authorization,
      googKey: request.headers["x-goog-api-key"],
    });

    if (request.url?.startsWith("/v1/models")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          object: "list",
          data: [
            { id: "smoke-model-a" },
            { id: "smoke-model-b" },
            { id: "has space" },
            { id: "smoke-model-a" },
          ],
        }),
      );
      return;
    }
    if (request.url?.startsWith("/v1beta/models")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          models: [{ name: "models/gemini-smoke-flash" }, { name: "models/" }],
        }),
      );
      return;
    }
    if (request.url?.startsWith("/unauthorized")) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: CREDENTIAL }));
      return;
    }
    if (request.url?.startsWith("/flood")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          data: Array.from({ length: 900 }, (_unused, index) => ({
            id: `flood-${index}`,
          })),
        }),
      );
      return;
    }
    response.writeHead(404);
    response.end("nope");
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: server.address().port });
    });
  });
}

function readDatabaseBytes(dataDir) {
  const base = join(dataDir, "bayz.db");
  const parts = [];
  for (const suffix of ["", "-wal", "-shm"]) {
    const file = `${base}${suffix}`;
    if (existsSync(file)) {
      parts.push(readFileSync(file));
    }
  }
  return Buffer.concat(parts);
}

async function main() {
  const root = mkdtempSync(join(tmpdir(), "bayz-provider-smoke-"));
  const dataDir = join(root, ".bayz");
  const { openSecretStorage, StorageError } = await import(STORAGE_ENTRY);
  const { createProviderManager, ProviderError } = await import(PROVIDERS_ENTRY);

  const { server, port } = await startUpstream();
  const base = `http://127.0.0.1:${port}`;

  try {
    section(`1. Register providers against a real upstream on ${base}`);
    let manager = createProviderManager({
      storage: openSecretStorage({
        dataDir,
        env: { BAYZ_MASTER_KEY: KEK_HEX },
        logger,
      }),
      logger,
    });

    try {
      const local = manager.createProvider({
        id: "smoke-local",
        kind: "openai-compatible",
        displayName: "Smoke Local",
        baseUrl: `${base}/`,
        // The origin is a real loopback server, which 9D's egress policy requires an
        // explicit opt-in for.
        config: {
          allowLoopback: true,
          discoveryPath: "/v1/models",
          timeoutMs: 5000,
          modelLimit: 100,
        },
      });
      check("provider row created", local.id === "smoke-local");
      check("base url normalized", local.baseUrl === base);
      check("credential absent at creation", local.credentialPresent === false);
      check("database file exists on disk", existsSync(join(dataDir, "bayz.db")));

      const gemini = manager.createProvider({
        id: "smoke-gemini",
        kind: "gemini",
        displayName: "Smoke Gemini",
        baseUrl: base,
        config: { allowLoopback: true },
      });
      check(
        "gemini defaults to the v1beta discovery path",
        gemini.config.discoveryPath === "/v1beta/models",
      );

      section("2. Store credentials through envelope encryption");
      manager.setCredential("smoke-local", CREDENTIAL);
      manager.setCredential("smoke-gemini", GEMINI_KEY);
      check("credential presence is reported", manager.hasCredential("smoke-local"));
      check(
        "credential presence appears on the view",
        manager.requireProvider("smoke-local").credentialPresent === true,
      );
      check(
        "no credential accessor is exposed",
        typeof manager.getCredential === "undefined",
      );

      section("3. Discover models over a real socket with real fetch");
      const models = await manager.discoverModels("smoke-local");
      check(
        "openai-compatible discovery returned the usable models",
        JSON.stringify(models) === JSON.stringify(["smoke-model-a", "smoke-model-b"]),
      );
      const geminiModels = await manager.discoverModels("smoke-gemini");
      check(
        "gemini discovery stripped the models/ prefix",
        JSON.stringify(geminiModels) === JSON.stringify(["gemini-smoke-flash"]),
      );

      const openAiRequest = requests.find((entry) => entry.url === "/v1/models");
      const geminiRequest = requests.find((entry) => entry.url === "/v1beta/models");
      check(
        "the bearer token reached the upstream header",
        openAiRequest?.authorization === `Bearer ${CREDENTIAL}`,
      );
      check(
        "gemini used x-goog-api-key",
        geminiRequest?.googKey === GEMINI_KEY &&
          geminiRequest?.authorization === undefined,
      );
      check(
        "no credential appeared in any request URL",
        requests.every(
          (entry) =>
            !entry.url.includes(CREDENTIAL) &&
            !entry.url.includes(GEMINI_KEY) &&
            !entry.url.includes("?"),
        ),
      );

      section("4. Hostile upstream responses fail closed");
      manager.updateProvider("smoke-local", {
        config: { allowLoopback: true, discoveryPath: "/unauthorized", timeoutMs: 5000, modelLimit: 100 },
      });
      let authCode;
      let authMessage = "";
      try {
        await manager.discoverModels("smoke-local");
      } catch (error) {
        authCode = error instanceof ProviderError ? error.code : "unknown";
        authMessage = String(error?.message ?? "");
      }
      check("a 401 maps to auth_failed", authCode === "auth_failed");
      check(
        "the upstream error body never reaches the message",
        !authMessage.includes(CREDENTIAL),
      );

      manager.updateProvider("smoke-local", {
        config: { allowLoopback: true, discoveryPath: "/flood", timeoutMs: 5000, modelLimit: 500 },
      });
      const flooded = await manager.discoverModels("smoke-local");
      check("a 900-entry feed is capped at 500", flooded.length === 500);

      manager.updateProvider("smoke-local", {
        config: { allowLoopback: true, discoveryPath: "/v1/models", timeoutMs: 5000, modelLimit: 100 },
      });

      section("5. Hostile registration input is refused");
      let idCode;
      try {
        manager.createProvider({
          id: "bad'; DROP TABLE providers; --",
          kind: "openai-compatible",
          displayName: "Bad",
          baseUrl: base,
          config: { allowLoopback: true },
        });
      } catch (error) {
        idCode = error instanceof ProviderError ? error.code : "unknown";
      }
      check("an injection-shaped id is rejected", idCode === "invalid_provider_id");
      check(
        "the registry is intact after the rejection",
        manager.listProviders().length === 2,
      );

      let configCode;
      try {
        manager.createProvider({
          id: "smuggle",
          kind: "openai-compatible",
          displayName: "Smuggle",
          baseUrl: base,
          config: {
            allowLoopback: true,
            headers: { Authorization: `Bearer ${CREDENTIAL}` },
          },
        });
      } catch (error) {
        configCode = error instanceof ProviderError ? error.code : "unknown";
      }
      check(
        "a header-smuggling config is rejected",
        configCode === "invalid_provider_config",
      );
    } finally {
      manager.close();
    }

    section("6. Reopen in a SEPARATE PROCESS and confirm persistence");
    {
      const child = spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          "-e",
          `
          const { openSecretStorage } = await import(${JSON.stringify(STORAGE_ENTRY)});
          const { createProviderManager } = await import(${JSON.stringify(PROVIDERS_ENTRY)});
          const manager = createProviderManager({
            storage: openSecretStorage({
              dataDir: ${JSON.stringify(dataDir)},
              env: { BAYZ_MASTER_KEY: ${JSON.stringify(KEK_HEX)} },
            }),
          });
          try {
            process.stdout.write(JSON.stringify({
              ids: manager.listProviders().map((p) => p.id),
              credentialPresent: manager.requireProvider("smoke-local").credentialPresent,
              hasAccessor: typeof manager.getCredential !== "undefined",
            }));
          } finally {
            manager.close();
          }
        `,
        ],
        { encoding: "utf8", env: { ...process.env, BAYZ_PROVIDER_SMOKE_LOADER: "1" } },
      );
      check("child process reopened the database", child.status === 0);
      let parsed = {};
      try {
        parsed = JSON.parse(child.stdout.trim());
      } catch {
        // Reported by the checks below.
      }
      check(
        "provider rows survived the reopen",
        JSON.stringify(parsed.ids) ===
          JSON.stringify(["smoke-gemini", "smoke-local"]),
      );
      check(
        "credential survived the reopen and is still only reported as present",
        parsed.credentialPresent === true && parsed.hasAccessor === false,
      );
    }

    section("7. Scan the real bytes on disk");
    {
      const bytes = readDatabaseBytes(dataDir);
      check("database bytes were read", bytes.byteLength > 0);
      check(
        "the credential is absent from bayz.db, -wal, and -shm",
        !bytes.includes(Buffer.from(CREDENTIAL, "utf8")),
      );
      check(
        "the gemini key is absent from bayz.db, -wal, and -shm",
        !bytes.includes(Buffer.from(GEMINI_KEY, "utf8")),
      );
      check(
        "the root key is absent from bayz.db, -wal, and -shm",
        !bytes.includes(Buffer.from(KEK_HEX, "utf8")),
      );
      check(
        "the provider id is present, proving the scan reads real content",
        bytes.includes(Buffer.from("smoke-local", "utf8")),
      );
    }

    section("8. Scan captured log output");
    {
      const logs = captured.join("\n");
      check("log output was captured", captured.length > 0);
      check("no credential in the logs", !logs.includes(CREDENTIAL));
      check("no gemini key in the logs", !logs.includes(GEMINI_KEY));
      check("no root key in the logs", !logs.includes(KEK_HEX));
      check(
        "discovery was logged with a count",
        logs.includes("provider_models_discovered"),
      );
    }

    section("9. A tampered credential fails closed");
    {
      const storage = openSecretStorage({
        dataDir,
        env: { BAYZ_MASTER_KEY: KEK_HEX },
      });
      const tamperedManager = createProviderManager({ storage });
      try {
        storage.corruptForTest("provider:smoke-local:api_key", "ciphertext");
        let code;
        let returned = Symbol("untouched");
        try {
          returned = tamperedManager.hasCredential("smoke-local");
        } catch (error) {
          code = error instanceof StorageError ? error.code : "unknown";
        }
        check("tampering raises secret_corrupt", code === "secret_corrupt");
        check(
          "tampering never reports the credential as merely absent",
          returned !== false,
        );
      } finally {
        tamperedManager.close();
      }
    }

    section("10. Deleting a provider removes its credential");
    {
      const storage = openSecretStorage({
        dataDir,
        env: { BAYZ_MASTER_KEY: KEK_HEX },
      });
      const cleanupManager = createProviderManager({ storage });
      try {
        cleanupManager.deleteProvider("smoke-local");
        cleanupManager.deleteProvider("smoke-gemini");
        check(
          "no provider rows remain",
          cleanupManager.listProviders().length === 0,
        );
        check(
          "no credential outlives its provider",
          storage.list().length === 0,
        );
      } finally {
        cleanupManager.close();
      }
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  console.log(`\n${checks - failures.length}/${checks} checks passed`);
  if (failures.length > 0) {
    console.error("provider smoke: FAIL");
    process.exit(1);
  }
  console.log("provider smoke: PASS");
}

main().catch((error) => {
  console.error("provider smoke: FAIL");
  console.error(error);
  process.exit(1);
});
