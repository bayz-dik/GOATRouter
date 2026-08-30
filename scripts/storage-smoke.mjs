#!/usr/bin/env node
/**
 * Non-mocked storage proof for Phase 2.
 *
 * Runs against a real on-disk SQLite database and a real child process, because
 * in-process tests alone cannot demonstrate cross-process persistence or prove
 * that plaintext is absent from the actual bytes on disk.
 *
 * Exits non-zero on any failed check.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const STORAGE_ENTRY = fileURLToPath(
  new URL("../packages/storage/src/index.ts", import.meta.url),
);

// The storage package is authored in TypeScript, so this script needs tsx's
// loader. Re-exec once with it rather than forcing every caller to remember the
// flag, which keeps `node scripts/storage-smoke.mjs` working as documented.
if (!process.env.BAYZ_SMOKE_LOADER) {
  const relaunch = spawnSync(
    process.execPath,
    ["--import", "tsx", fileURLToPath(import.meta.url)],
    { stdio: "inherit", env: { ...process.env, BAYZ_SMOKE_LOADER: "1" } },
  );
  process.exit(relaunch.status ?? 1);
}

const SENTINEL = "sk-live-SMOKE-SENTINEL-must-never-touch-disk-4242";
const SECOND_SENTINEL = "sk-live-SMOKE-SECOND-0987654321";
const KEK_HEX = Buffer.alloc(32, 0x3c).toString("hex");
const ROTATED_KEK_HEX = Buffer.alloc(32, 0x4d).toString("hex");
const WRONG_KEK_HEX = Buffer.alloc(32, 0x5e).toString("hex");

const captured = [];
const failures = [];
let checks = 0;

/**
 * Record one check, numbered.
 *
 * The number is what makes a citation resolvable: 9L Task 1's `resolveEvidence` refuses
 * `smoke:<script>#<n>` against a script that prints no numbers, because `#n` cannot be looked up in
 * output that has none — and 9L Task 2's feature inventory needs exactly that citation for the
 * Phase 1-8 features this script proves. **Numbers are contractual: append checks, never insert
 * one**, or every citation after the insertion point silently starts pointing at the wrong check.
 */
function check(label, condition) {
  checks += 1;
  if (condition) {
    console.log(`  ok   ${String(checks).padStart(2)}  ${label}`);
  } else {
    console.error(`  FAIL ${String(checks).padStart(2)}  ${label}`);
    failures.push(`#${checks} ${label}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

function logger(payload) {
  captured.push(JSON.stringify(payload));
}

async function loadStorage() {
  const module = await import(STORAGE_ENTRY);
  return module;
}

/** Read every on-disk artifact SQLite may have written, including WAL and SHM. */
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
  const root = mkdtempSync(join(tmpdir(), "bayz-smoke-"));
  const dataDir = join(root, ".bayz");
  const { openSecretStorage, EnvKeyProvider, StorageError } = await loadStorage();

  section("1. Open real storage and write a secret");
  let schemaVersion;
  let journalMode;
  let driver;
  let keyProvider;
  let keyId;
  {
    const storage = openSecretStorage({
      dataDir,
      env: { BAYZ_MASTER_KEY: KEK_HEX },
      logger,
    });
    try {
      storage.put("provider:openai:api_key", SENTINEL);
      storage.put("provider:anthropic:api_key", SECOND_SENTINEL);
      ({ schemaVersion, journalMode, driver, keyProvider, keyId } = storage);
      console.log(
        `  schemaVersion=${schemaVersion} journalMode=${journalMode} driver=${driver}`,
      );
      console.log(`  keyProvider=${keyProvider} keyId=${keyId}`);
      check("database file exists on disk", existsSync(join(dataDir, "bayz.db")));
      check("secret reads back in-process", storage.get("provider:openai:api_key") === SENTINEL);
      check("journal mode is wal", journalMode === "wal");
      check("driver is node:sqlite", driver === "node:sqlite");
      check("keyId is a fingerprint", /^kek_[0-9a-f]{32}$/.test(keyId));
      check(
        "two records use different wrapped DEKs",
        Buffer.compare(
          Buffer.from(storage.inspect("provider:openai:api_key").wrappedDek),
          Buffer.from(storage.inspect("provider:anthropic:api_key").wrappedDek),
        ) !== 0,
      );
    } finally {
      storage.close();
    }
  }

  section("2. Reopen in a SEPARATE PROCESS and read the secret back");
  {
    const child = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "-e",
        `
        const { openSecretStorage } = await import(${JSON.stringify(STORAGE_ENTRY)});
        const storage = openSecretStorage({
          dataDir: ${JSON.stringify(dataDir)},
          env: { BAYZ_MASTER_KEY: ${JSON.stringify(KEK_HEX)} },
        });
        try {
          const value = storage.get("provider:openai:api_key");
          const second = storage.get("provider:anthropic:api_key");
          process.stdout.write(JSON.stringify({
            ok: value === ${JSON.stringify(SENTINEL)} && second === ${JSON.stringify(SECOND_SENTINEL)},
            schemaVersion: storage.schemaVersion,
            appliedMigrations: storage.appliedMigrations,
            count: storage.list().length,
          }));
        } finally {
          storage.close();
        }
        `,
      ],
      { encoding: "utf8" },
    );

    check("child process exited cleanly", child.status === 0);
    let parsed = {};
    try {
      parsed = JSON.parse(child.stdout.trim());
    } catch {
      console.error(`  child stdout: ${child.stdout}`);
      console.error(`  child stderr: ${child.stderr}`);
    }
    check("cross-process read returned the original plaintext", parsed.ok === true);
    check("schema version survived the reopen", parsed.schemaVersion === schemaVersion);
    check("reopen applied no further migrations", parsed.appliedMigrations === 0);
    check("both secrets are present", parsed.count === 2);
  }

  section("3. Scan raw database bytes for plaintext and key material");
  {
    const bytes = readDatabaseBytes(dataDir);
    check("database bytes were read", bytes.byteLength > 0);
    check(
      "sentinel plaintext absent from db/wal/shm",
      !bytes.includes(Buffer.from(SENTINEL, "utf8")),
    );
    check(
      "second sentinel absent from db/wal/shm",
      !bytes.includes(Buffer.from(SECOND_SENTINEL, "utf8")),
    );
    check(
      "base64 of sentinel absent",
      !bytes.includes(Buffer.from(Buffer.from(SENTINEL).toString("base64"), "utf8")),
    );
    check(
      "utf16 of sentinel absent",
      !bytes.includes(Buffer.from(SENTINEL, "utf16le")),
    );
    check(
      "raw KEK bytes absent from database",
      !bytes.includes(Buffer.from(KEK_HEX, "hex")),
    );
    check(
      "hex KEK absent from database",
      !bytes.includes(Buffer.from(KEK_HEX, "utf8")),
    );
    check(
      "no master.key written when the key came from the environment",
      !existsSync(join(dataDir, "master.key")),
    );
  }

  section("4. Scan captured log output");
  {
    const log = captured.join("\n");
    check("logs were captured", captured.length > 0);
    check("sentinel absent from logs", !log.includes(SENTINEL));
    check("second sentinel absent from logs", !log.includes(SECOND_SENTINEL));
    check("KEK absent from logs", !log.includes(KEK_HEX));
    check("no key-shaped hex run in logs", !/[0-9a-f]{64}/.test(log));
  }

  section("5. Rotate the root key and re-read every secret");
  {
    const storage = openSecretStorage({
      dataDir,
      env: { BAYZ_MASTER_KEY: KEK_HEX },
      logger,
    });
    try {
      const before = Buffer.from(storage.inspect("provider:openai:api_key").ciphertext);
      const result = storage.rotateRootKey(
        new EnvKeyProvider({ BAYZ_MASTER_KEY: ROTATED_KEK_HEX }),
      );
      const after = Buffer.from(storage.inspect("provider:openai:api_key").ciphertext);

      check("rotation covered both records", result.rotated === 2);
      check("rotation reported a new keyId", result.keyId !== keyId);
      check(
        "secret ciphertext unchanged by rotation (rewrap only)",
        Buffer.compare(before, after) === 0,
      );
      check(
        "secret still readable after rotation",
        storage.get("provider:openai:api_key") === SENTINEL,
      );
      check(
        "second secret still readable after rotation",
        storage.get("provider:anthropic:api_key") === SECOND_SENTINEL,
      );
    } finally {
      storage.close();
    }
  }

  section("6. The superseded key must no longer open the database");
  {
    let code;
    try {
      const storage = openSecretStorage({
        dataDir,
        env: { BAYZ_MASTER_KEY: KEK_HEX },
      });
      storage.close();
    } catch (error) {
      code = error instanceof StorageError ? error.code : "unknown";
    }
    check("old key rejected after rotation", code === "master_key_mismatch");
  }

  section("7. A wrong key fails closed");
  {
    let code;
    try {
      const storage = openSecretStorage({
        dataDir,
        env: { BAYZ_MASTER_KEY: WRONG_KEK_HEX },
      });
      storage.close();
    } catch (error) {
      code = error instanceof StorageError ? error.code : "unknown";
    }
    check(
      "wrong key fails closed",
      code === "master_key_mismatch" || code === "secret_corrupt",
    );
  }

  section("8. Tampered ciphertext fails closed");
  {
    const storage = openSecretStorage({
      dataDir,
      env: { BAYZ_MASTER_KEY: ROTATED_KEK_HEX },
    });
    try {
      storage.corruptForTest("provider:openai:api_key", "ciphertext");
      let code;
      let returned = Symbol("untouched");
      try {
        returned = storage.get("provider:openai:api_key");
      } catch (error) {
        code = error instanceof StorageError ? error.code : "unknown";
      }
      check("tampered ciphertext raises secret_corrupt", code === "secret_corrupt");
      check("tampered read returned nothing", typeof returned === "symbol");
    } finally {
      storage.close();
    }
  }

  section("9. Zero-config mode generates a protected key file");
  {
    const zeroConfigDir = join(mkdtempSync(join(tmpdir(), "bayz-smoke-zc-")), ".bayz");
    const storage = openSecretStorage({ dataDir: zeroConfigDir, env: {}, logger });
    try {
      storage.put("zero:config", SENTINEL);
      check("zero-config uses the secure file provider", storage.keyProvider === "secure-file");
      check("zero-config round-trip works", storage.get("zero:config") === SENTINEL);
    } finally {
      storage.close();
    }

    const keyFile = join(zeroConfigDir, "master.key");
    check("master.key was created", existsSync(keyFile));
    const keyBytes = readFileSync(keyFile);
    check("master.key holds 32 bytes", keyBytes.byteLength === 32);

    const mode = statSync(keyFile).mode & 0o777;
    check(`master.key mode is 0600 (actual 0${mode.toString(8)})`, mode === 0o600);
    const dirMode = statSync(zeroConfigDir).mode & 0o777;
    check(`data dir mode is 0700 (actual 0${dirMode.toString(8)})`, dirMode === 0o700);

    for (const suffix of ["", "-wal", "-shm"]) {
      const file = join(zeroConfigDir, `bayz.db${suffix}`);
      if (!existsSync(file)) {
        continue;
      }
      const fileMode = statSync(file).mode & 0o777;
      check(
        `bayz.db${suffix} is not group/world readable (0${fileMode.toString(8)})`,
        (fileMode & 0o077) === 0,
      );
    }

    const bytes = readDatabaseBytes(zeroConfigDir);
    check(
      "generated key is not recoverable from the database alone",
      !bytes.includes(keyBytes),
    );
    check("sentinel absent from zero-config database", !bytes.includes(Buffer.from(SENTINEL, "utf8")));
    rmSync(zeroConfigDir, { recursive: true, force: true });
  }

  rmSync(root, { recursive: true, force: true });

  console.log(`\n${checks - failures.length}/${checks} checks passed`);
  if (failures.length > 0) {
    console.error(`\nFAILED CHECKS:\n${failures.map((f) => `  - ${f}`).join("\n")}`);
    process.exitCode = 1;
    return;
  }
  console.log("storage smoke: PASS");
}

await main();
