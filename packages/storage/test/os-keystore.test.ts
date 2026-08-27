import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  DpapiKeyProvider,
  KeychainKeyProvider,
  OsKeystoreKeyProvider,
  SecretServiceKeyProvider,
  StorageError,
  keystoreSupport,
  resolveKeyProvider,
  type CommandResult,
  type CommandRunner,
  type KeystoreSupportEntry,
} from "../src/index.js";

const KEK_BYTES = 32;
const HEX = Buffer.alloc(KEK_BYTES, 0x5a).toString("hex");

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "bayz-keystore-"));
}

type RecordedCall = { file: string; args: string[]; input: string | undefined };

function ok(stdout = ""): CommandResult {
  return { status: 0, stdout, stderr: "", failedToSpawn: false };
}

function failed(status: number, stderr = ""): CommandResult {
  return { status, stdout: "", stderr, failedToSpawn: false };
}

const NOT_SPAWNED: CommandResult = {
  status: null,
  stdout: "",
  stderr: "",
  failedToSpawn: true,
};

function recorder(handler: (call: RecordedCall) => CommandResult): {
  calls: RecordedCall[];
  run: CommandRunner;
} {
  const calls: RecordedCall[] = [];
  const run: CommandRunner = (file, args, options) => {
    const call: RecordedCall = {
      file,
      args: [...args],
      input: options?.input,
    };
    calls.push(call);
    return handler(call);
  };
  return { calls, run };
}

/** A runner that answers every probe and lookup, so availability is the only variable. */
function workingSecretService(stored: string | null): {
  calls: RecordedCall[];
  run: CommandRunner;
} {
  let value = stored;
  return recorder((call) => {
    if (call.args[0] === "--version") return ok("secret-tool 0.21\n");
    if (call.args[0] === "lookup") {
      // secret-tool signals "no such item" with exit 1 and no output at all.
      return value === null ? failed(1) : ok(`${value}\n`);
    }
    if (call.args[0] === "store") {
      value = (call.input ?? "").trim();
      return ok();
    }
    return failed(2, "unexpected verb");
  });
}

const LINUX_ENV = { DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus" };

test("every OS keystore provider is unavailable on this device and refuses to load", () => {
  // Measured reality: Termux/Android ARM64 has no secret-tool, no security, no
  // keyctl. The providers must report that rather than pretending.
  const providers = [
    new SecretServiceKeyProvider(),
    new KeychainKeyProvider(),
    new DpapiKeyProvider({ dataDir: tempDir() }),
    new OsKeystoreKeyProvider(),
  ];

  for (const provider of providers) {
    assert.equal(
      provider.available,
      false,
      `${provider.backend} must not claim availability on this device`,
    );
    assert.throws(
      () => provider.loadKek(),
      (error: unknown) =>
        error instanceof StorageError && error.code === "master_key_invalid",
      `${provider.backend} must refuse to load when unavailable`,
    );
  }
});

test("availability is a platform probe, not a process.platform read", () => {
  // A Linux box with a session bus but no Secret Service binary is unavailable.
  const missing = new SecretServiceKeyProvider({
    platform: "linux",
    env: LINUX_ENV,
    runner: () => NOT_SPAWNED,
  });
  assert.equal(missing.available, false);

  // Same platform, same env, working binary: available.
  const present = new SecretServiceKeyProvider({
    platform: "linux",
    env: LINUX_ENV,
    runner: workingSecretService(HEX).run,
  });
  assert.equal(present.available, true);

  // A binary that answers with a failure status is not a working keystore.
  const broken = new SecretServiceKeyProvider({
    platform: "linux",
    env: LINUX_ENV,
    runner: () => failed(127, "not found"),
  });
  assert.equal(broken.available, false);
});

test("Secret Service requires a session bus even when the binary exists", () => {
  const provider = new SecretServiceKeyProvider({
    platform: "linux",
    env: {},
    runner: workingSecretService(HEX).run,
  });
  assert.equal(provider.available, false);
});

test("each backend is gated to its own platform", () => {
  const alwaysOk: CommandRunner = () => ok("1\n");

  assert.equal(
    new KeychainKeyProvider({ platform: "linux", runner: alwaysOk }).available,
    false,
    "keychain must not activate off darwin even if a `security` binary exists",
  );
  assert.equal(
    new DpapiKeyProvider({
      platform: "linux",
      runner: alwaysOk,
      dataDir: tempDir(),
    }).available,
    false,
    "dpapi must not activate off win32",
  );
  assert.equal(
    new SecretServiceKeyProvider({
      platform: "darwin",
      env: LINUX_ENV,
      runner: alwaysOk,
    }).available,
    false,
    "secret-service must not activate off linux",
  );
  assert.equal(
    new KeychainKeyProvider({ platform: "darwin", runner: alwaysOk }).available,
    true,
  );
  assert.equal(
    new DpapiKeyProvider({
      platform: "win32",
      runner: alwaysOk,
      dataDir: tempDir(),
    }).available,
    true,
  );
});

test("a stored key is returned as 32 raw bytes", () => {
  const provider = new SecretServiceKeyProvider({
    platform: "linux",
    env: LINUX_ENV,
    runner: workingSecretService(HEX).run,
  });
  const kek = provider.loadKek();
  assert.equal(kek.byteLength, KEK_BYTES);
  assert.equal(kek.toString("hex"), HEX);
});

test("a malformed stored value is rejected instead of stretched or truncated", () => {
  for (const stored of ["", "not-hex", HEX.slice(0, 62), `${HEX}ab`]) {
    const provider = new SecretServiceKeyProvider({
      platform: "linux",
      env: LINUX_ENV,
      runner: workingSecretService(stored).run,
    });
    assert.throws(
      () => provider.loadKek(),
      (error: unknown) =>
        error instanceof StorageError && error.code === "master_key_invalid",
      `expected ${JSON.stringify(stored)} to be rejected`,
    );
  }
});

test("a provider that claims availability but cannot load raises and stores nothing", () => {
  // The dangerous failure mode: a keystore that answers its probe, then errors on
  // lookup. Generating a fresh key there would silently orphan every existing
  // ciphertext, so this must raise.
  const { calls, run } = recorder((call) => {
    if (call.args[0] === "--version") return ok("secret-tool 0.21\n");
    return failed(1, "org.freedesktop.DBus.Error.ServiceUnknown");
  });

  const provider = new SecretServiceKeyProvider({
    platform: "linux",
    env: LINUX_ENV,
    runner: run,
  });
  assert.equal(provider.available, true);
  assert.throws(
    () => provider.loadKek(),
    (error: unknown) =>
      error instanceof StorageError && error.code === "master_key_invalid",
  );
  assert.equal(
    calls.filter((call) => call.args[0] === "store").length,
    0,
    "a failed lookup must never fall through to storing a new key",
  );
});

test("a first run stores a generated key without exposing it in process arguments", () => {
  const store = workingSecretService(null);
  const provider = new SecretServiceKeyProvider({
    platform: "linux",
    env: LINUX_ENV,
    runner: store.run,
  });

  const kek = provider.loadKek();
  assert.equal(kek.byteLength, KEK_BYTES);

  const stored = store.calls.filter((call) => call.args[0] === "store");
  assert.equal(stored.length, 1, "exactly one store call");
  assert.equal(
    stored[0]!.input?.trim(),
    kek.toString("hex"),
    "the key travels on stdin",
  );

  // Process arguments are world-readable through /proc and ps, so the key must
  // never appear there.
  const everyArgument = store.calls
    .flatMap((call) => call.args)
    .join(" ");
  assert.doesNotMatch(everyArgument, /[0-9a-f]{64}/);
  assert.doesNotMatch(everyArgument, new RegExp(kek.toString("hex")));

  // A second load reads the stored key back rather than generating another.
  assert.deepEqual(provider.loadKek(), kek);
  assert.equal(
    store.calls.filter((call) => call.args[0] === "store").length,
    1,
    "a stored key is never overwritten",
  );
});

test("a store whose write does not persist raises instead of reporting success", () => {
  // The keystore accepts the write and then still has nothing: a silent success
  // here would hand back a key the next start cannot find.
  const { run } = recorder((call) => {
    if (call.args[0] === "--version") return ok("secret-tool 0.21\n");
    if (call.args[0] === "lookup") return failed(1);
    if (call.args[0] === "store") return ok();
    return failed(2);
  });

  const provider = new SecretServiceKeyProvider({
    platform: "linux",
    env: LINUX_ENV,
    runner: run,
  });
  assert.throws(
    () => provider.loadKek(),
    (error: unknown) =>
      error instanceof StorageError && error.code === "master_key_invalid",
  );
});

test("the keychain adapter keeps the key off the command line", () => {
  let stored: string | null = null;
  // Models `security(1)`: reads pass the item's non-secret coordinates in argv,
  // but a write goes through `security -i`, whose interactive mode takes the whole
  // command — including the password — on stdin.
  const { calls, run } = recorder((call) => {
    if (call.args[0] === "list-keychains") return ok("login.keychain-db\n");
    if (call.args[0] === "find-generic-password") {
      // 44 is the documented "item not found" status of security(1).
      return stored === null ? failed(44) : ok(`${stored}\n`);
    }
    if (call.args[0] === "-i") {
      const command = (call.input ?? "").split("\n")[0] ?? "";
      if (!command.startsWith("add-generic-password")) return failed(2);
      stored = command.split(/\s+/).pop()!.trim();
      return ok();
    }
    return failed(2);
  });

  const provider = new KeychainKeyProvider({ platform: "darwin", runner: run });
  const kek = provider.loadKek();
  assert.equal(kek.byteLength, KEK_BYTES);
  assert.equal(stored, kek.toString("hex"));
  assert.doesNotMatch(calls.flatMap((call) => call.args).join(" "), /[0-9a-f]{64}/);
});

test("the DPAPI adapter protects through stdin and writes an owner-only blob", () => {
  const dataDir = tempDir();
  let protectedBlob: string | null = null;
  const { calls, run } = recorder((call) => {
    const script = call.args[call.args.length - 1] ?? "";
    if (script.includes("PSVersion")) return ok("7\n");
    // Unprotect is checked first: the .NET class name is `ProtectedData`, so an
    // unprotect script also contains the substring "Protect".
    if (script.includes("Unprotect")) {
      return ok(
        `${Buffer.from((call.input ?? "").trim(), "base64").toString("utf8")}\n`,
      );
    }
    if (script.includes("Protect")) {
      protectedBlob = Buffer.from((call.input ?? "").trim(), "utf8").toString(
        "base64",
      );
      return ok(`${protectedBlob}\n`);
    }
    return failed(2);
  });

  const provider = new DpapiKeyProvider({
    platform: "win32",
    runner: run,
    dataDir,
  });
  const kek = provider.loadKek();
  assert.equal(kek.byteLength, KEK_BYTES);

  // The plaintext key must not be in argv, and the blob on disk must not contain it.
  assert.doesNotMatch(calls.flatMap((call) => call.args).join(" "), /[0-9a-f]{64}/);
  const files = readdirSync(dataDir);
  assert.ok(files.length > 0, "the protected blob is persisted");
  for (const file of files) {
    const raw = readFileSync(join(dataDir, file)).toString("utf8");
    assert.doesNotMatch(
      raw,
      new RegExp(kek.toString("hex")),
      `${file} contains the plaintext root key`,
    );
  }

  // Reopening reads the same key back through Unprotect.
  const reopened = new DpapiKeyProvider({
    platform: "win32",
    runner: run,
    dataDir,
  });
  assert.deepEqual(reopened.loadKek(), kek);
});

test("FORTRESS prefers an available OS keystore over a passphrase", () => {
  const dataDir = tempDir();
  const logged: Record<string, unknown>[] = [];
  const provider = resolveKeyProvider({
    dataDir,
    env: { BAYZ_PASSPHRASE: "unlock the fortress" },
    mode: "FORTRESS",
    keystore: new SecretServiceKeyProvider({
      platform: "linux",
      env: LINUX_ENV,
      runner: workingSecretService(HEX).run,
    }),
    logger: (payload) => logged.push(payload),
  });

  assert.equal(provider.kind, "os-keystore");
  assert.equal(provider.loadKek().toString("hex"), HEX);
  assert.equal(
    logged.filter((entry) => entry.event === "key-provider-fallback").length,
    0,
    "no fallback is logged when the keystore was used",
  );
});

test("FORTRESS falls back to the passphrase and logs a metadata-only reason", () => {
  const logged: Record<string, unknown>[] = [];
  const passphrase = "zzz-unique-unlock-factor-zzz";
  const provider = resolveKeyProvider({
    dataDir: tempDir(),
    env: { BAYZ_PASSPHRASE: passphrase },
    mode: "FORTRESS",
    logger: (payload) => logged.push(payload),
  });

  assert.equal(provider.kind, "passphrase");
  const fallback = logged.find((entry) => entry.event === "key-provider-fallback");
  assert.ok(fallback, "the downgrade from OS custody must be visible");
  assert.equal(fallback.from, "os-keystore");
  assert.equal(fallback.to, "passphrase");
  assert.equal(typeof fallback.reason, "string");

  const serialized = JSON.stringify(logged);
  assert.doesNotMatch(serialized, new RegExp(passphrase));
  assert.doesNotMatch(serialized, /[0-9a-f]{64}/);
});

test("FORTRESS without a keystore and without a passphrase still fails closed", () => {
  assert.throws(
    () => resolveKeyProvider({ dataDir: tempDir(), env: {}, mode: "FORTRESS" }),
    (error: unknown) =>
      error instanceof StorageError && error.code === "master_key_invalid",
  );
});

test("keystoreSupport records the platform matrix as data", () => {
  const entries = keystoreSupport();
  const statuses = new Set(["IMPLEMENTED", "UNVERIFIED", "N/A"]);
  for (const entry of entries) {
    assert.ok(statuses.has(entry.status), `bad status ${entry.status}`);
    assert.equal(typeof entry.reason, "string");
    assert.ok(entry.reason.length > 0);
  }

  const byBackend = new Map<string, KeystoreSupportEntry>(
    entries.map((entry) => [entry.backend, entry]),
  );

  // On this device none of the three can be exercised, so none may read
  // IMPLEMENTED. UNVERIFIED is the honest answer; it is never collapsed to PASS.
  for (const backend of ["dpapi", "keychain", "secret-service"]) {
    const entry = byBackend.get(backend);
    assert.ok(entry, `missing matrix row for ${backend}`);
    assert.equal(
      entry.status,
      "UNVERIFIED",
      `${backend} must be UNVERIFIED on this device`,
    );
  }

  // Android/Termux has no Node-reachable keystore at all, which is a different
  // claim from "present but unproven".
  assert.equal(byBackend.get("android-keystore")?.status, "N/A");
});

test("no keystore adapter builds a command from an interpolated string", () => {
  // Resolved from this file, not from cwd: the workspace script runs with cwd at
  // packages/storage while a repo-root run has cwd at the repo root.
  const dir = fileURLToPath(new URL("../src/keystore/", import.meta.url));
  const sources = readdirSync(dir).filter((file) => file.endsWith(".ts"));
  assert.ok(sources.length >= 3, "expected the three platform adapters");

  const childProcessImporters: string[] = [];
  for (const file of sources) {
    const source = readFileSync(join(dir, file), "utf8");
    assert.doesNotMatch(
      source,
      /\b(exec|execSync|execFile|execFileSync|spawn|spawnSync)\s*\(\s*[`'"][^`'"]*\$\{/,
      `${file} interpolates a command string`,
    );
    assert.doesNotMatch(source, /shell\s*:\s*true/, `${file} enables a shell`);
    assert.doesNotMatch(
      source,
      /\bexecSync\b|\bexec\s*\(/,
      `${file} uses a shell-interpreting child_process API`,
    );
    if (/from\s+"node:child_process"/.test(source)) {
      childProcessImporters.push(file);
    }
  }

  // One choke point keeps the argv-array rule reviewable.
  assert.deepEqual(childProcessImporters, ["exec.ts"]);
});

test("keystore providers do not leak key material through stringification", () => {
  const provider = new SecretServiceKeyProvider({
    platform: "linux",
    env: LINUX_ENV,
    runner: workingSecretService(HEX).run,
  });
  provider.loadKek();
  const serialized = `${String(provider)} ${JSON.stringify(provider)}`;
  assert.doesNotMatch(serialized, /[0-9a-f]{64}/);
});
