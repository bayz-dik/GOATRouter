import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const doctor = await import(join(root, "scripts/doctor-lib.mjs"));

function makeRuntime(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), "bayz-doctor-"));
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

/** A real, valid, empty SQLite database file at `dir`. */
function makeRealSqlite(dir) {
  const db = new DatabaseSync(join(dir, "bayz.db"));
  db.exec("CREATE TABLE schema_migrations (version INTEGER, applied_at TEXT)");
  db.exec("INSERT INTO schema_migrations VALUES (1, '2026-01-01T00:00:00.000Z')");
  db.exec("PRAGMA user_version = 1");
  db.close();
}

function minimalFiles(dir) {
  makeRealSqlite(dir);
  writeFileSync(join(dir, "master.key"), "a".repeat(32));
  writeFileSync(join(dir, "integrity.json"), '{"maxOpenCounter":1}');
}

test("runDoctor reports missing master.key as a failure", async () => {
  const dir = makeRuntime({ "bayz.db": "x", "integrity.json": "{}" });
  try {
    const results = await doctor.runDoctor({ dir });
    const mk = results.find((r) => r.name === "master key");
    assert.equal(mk.status, "fail");
    const db = results.find((r) => r.name === "database");
    assert.equal(db.status, "pass");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runDoctor reports a missing database as a failure", async () => {
  const dir = makeRuntime({ "master.key": "a".repeat(32), "integrity.json": "{}" });
  try {
    const results = await doctor.runDoctor({ dir });
    assert.equal(results.find((r) => r.name === "database").status, "fail");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runDoctor flags a stale pidfile as a warning", async () => {
  const dir = makeRuntime({});
  minimalFiles(dir);
  writeFileSync(join(dir, "bayz.pid"), "999999999");
  try {
    const results = await doctor.runDoctor({ dir });
    const pf = results.find((r) => r.name === "pidfile");
    assert.equal(pf.status, "warn");
    assert.match(pf.detail, /stale/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runDoctor reports a corrupt database integrity as a failure", async () => {
  const dir = makeRuntime({ "master.key": "a".repeat(32), "integrity.json": "{}" });
  writeFileSync(join(dir, "bayz.db"), "not-a-valid-sqlite-database");
  try {
    const results = await doctor.runDoctor({ dir });
    const integ = results.find((r) => r.name === "database integrity");
    assert.equal(integ.status, "fail");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runDoctor on a healthy minimal runtime has no failures", async () => {
  const dir = makeRuntime({});
  minimalFiles(dir);
  try {
    const results = await doctor.runDoctor({ dir });
    const failures = results.filter((r) => r.status === "fail");
    assert.deepEqual(
      failures.map((f) => f.name),
      [],
      `unexpected failures for healthy minimal runtime: ${JSON.stringify(failures)}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("probeHealth recognizes a real GOAT health payload but not a foreign ok-service", async () => {
  const { createServer } = await import("node:http");
  const portOf = (srv) => {
    const a = srv.address();
    if (a === null || typeof a === "string") throw new Error("no numeric port");
    return a.port;
  };
  // GOAT-style payload
  const goatSrv = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok", version: "0.1.0", uptimeSeconds: 42 }));
  });
  await new Promise((r) => goatSrv.listen(0, "127.0.0.1", () => r()));
  const goatPort = portOf(goatSrv);

  // 9Router-style: answers {status:"ok"} but no uptimeSeconds/version shape
  const fakeSrv = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok", service: "9router-sim" }));
  });
  await new Promise((r) => fakeSrv.listen(0, "127.0.0.1", () => r()));
  const fakePort = portOf(fakeSrv);

  try {
    const goat = await doctor.probeHealth("127.0.0.1", goatPort);
    assert.equal(goat.ok, true, "real GOAT health not recognized");
    assert.equal(goat.version, "0.1.0");
    const fake = await doctor.probeHealth("127.0.0.1", fakePort);
    assert.equal(fake.ok, false, "a foreign {status:ok} service was mistaken for GOAT");
  } finally {
    goatSrv.close();
    fakeSrv.close();
  }
});

test("redactLog hides bearer tokens, api keys, and long hex literals", () => {
  const out = doctor.redactLog(
    "Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456\n" +
      "key=sk-abcdefgh12345678\n" +
      "AIzaSyA1234567890123456789012345678901234567\n" +
      "hash=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  );
  assert.ok(!out.includes("Bearer abcde"), "bearer token not redacted");
  assert.ok(!out.includes("sk-abcdefgh"), "api key not redacted");
  assert.ok(!out.includes("AIzaSyA"), "google key not redacted");
  assert.ok(out.includes("[REDACTED]"));
});

test("safeRepair removes a stale pidfile and creates a missing data dir", () => {
  const dir = mkdtempSync(join(tmpdir(), "bayz-repair-"));
  writeFileSync(join(dir, "bayz.pid"), "999999999");
  const missing = mkdtempSync(join(tmpdir(), "bayz-repair-")) + "/does-not-exist";
  try {
    doctor.safeRepair({ dir });
    assert.ok(!existsSync(join(dir, "bayz.pid")), "stale pidfile not removed");
    doctor.safeRepair({ dir: missing });
    assert.ok(existsSync(missing), "data dir not created");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    try { rmSync(missing, { recursive: true, force: true }); } catch {}
  }
});
