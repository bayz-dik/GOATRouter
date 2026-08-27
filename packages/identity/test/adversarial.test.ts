import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openSecretStorage, type SecretStorage } from "@bayz/storage";
import {
  CLIENT_SCOPES,
  IdentityError,
  createIdentityManager,
  createIdentityRepository,
  type IdentityManager,
} from "../src/index.js";

const KEY = Buffer.alloc(32, 0x1e).toString("hex");
const SRC = new URL("../src/", import.meta.url).pathname;

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      found.push(...sourceFiles(full));
    } else if (entry.endsWith(".ts")) {
      found.push(full);
    }
  }
  return found;
}

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}

function harness(): { storage: SecretStorage; manager: IdentityManager } {
  const dataDir = join(mkdtempSync(join(tmpdir(), "bayz-identity-adv-")), ".bayz");
  const storage = openSecretStorage({ dataDir, env: { BAYZ_MASTER_KEY: KEY } });
  return { storage, manager: createIdentityManager({ storage }) };
}

test("no source file declares a key-read accessor", () => {
  const files = sourceFiles(SRC);
  assert.ok(files.length >= 4, "the scan must find the sources");
  for (const file of files) {
    const code = stripComments(readFileSync(file, "utf8"));
    for (const forbidden of [
      /\bgetKey\s*\(/,
      /\breadKey\s*\(/,
      /\brevealKey\s*\(/,
      /\bexportKey\s*\(/,
      /\bfetchKey\s*\(/,
      /\bshowKey\s*\(/,
      /\bgetCredential\s*\(/,
      /\bgetPassword\s*\(/,
    ]) {
      assert.ok(!forbidden.test(code), `${file} matches ${forbidden}`);
    }
  }
});

test("no source file names a provider or proxy secret", () => {
  // The blast-radius boundary, enforced against the source text rather than only by
  // the scoped view: this package must have no way to *spell* another owner's secret.
  for (const file of sourceFiles(SRC)) {
    const code = stripComments(readFileSync(file, "utf8"));
    for (const forbidden of ["provider:", "proxy:", "api:token", "api_key", "master.key"]) {
      assert.ok(!code.includes(forbidden), `${file} references ${forbidden}`);
    }
  }
});

test("the only scoped prefix this package uses is client", () => {
  const uses = sourceFiles(SRC)
    .map((file) => readFileSync(file, "utf8"))
    .join("\n")
    .match(/scopedSecretStorage\([^)]*\)/g);
  assert.ok(uses !== null && uses.length >= 1);
  for (const use of uses) {
    assert.ok(use.includes('"client"'), `unexpected scope in ${use}`);
  }
});

test("a hostile scopes payload is refused", (t) => {
  const { storage, manager } = harness();
  t.after(() => storage.close());

  const hostile: unknown[] = [
    JSON.parse('{"__proto__":{"polluted":true}}'),
    Array.from({ length: 10000 }, () => "chat.completions"),
    [{ nested: { deeply: ["chat.completions"] } }],
    [["chat.completions"]],
    [Symbol("chat.completions")],
    new Set(["chat.completions"]),
    { 0: "chat.completions", length: 1 },
    "chat.completions",
    [null],
    [undefined],
    [true],
  ];
  for (const scopes of hostile) {
    assert.throws(
      () =>
        manager.createIdentity({
          id: "hostile",
          displayName: "Hostile",
          scopes: scopes as string[],
        }),
      (error: unknown) => error instanceof IdentityError,
      `accepted scopes ${JSON.stringify(scopes)?.slice(0, 60)}`,
    );
  }
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  assert.deepEqual(manager.list(), []);
});

test("a 1 MiB key is refused before hashing", (t) => {
  const { storage, manager } = harness();
  t.after(() => storage.close());

  manager.createIdentity({
    id: "victim",
    displayName: "Victim",
    scopes: ["chat.completions"],
  });
  const started = process.hrtime.bigint();
  assert.equal(manager.verifyKey("f".repeat(1024 * 1024)), undefined);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(elapsedMs < 100, `took ${elapsedMs}ms`);
});

test("wrong-key verification shows no length correlation", (t) => {
  const { storage, manager } = harness();
  t.after(() => storage.close());

  manager.createIdentity({
    id: "timed",
    displayName: "Timed",
    scopes: ["chat.completions"],
  });

  // Statistical and deliberately generous, documented as *indicative* rather than
  // proof: a real timing analysis needs thousands of samples on a quiet machine, and
  // this is a shared Android device. What it does catch is a gross regression such
  // as switching to `===` on raw strings, which short-circuits on the first byte.
  const measure = (candidate: string): number => {
    const started = process.hrtime.bigint();
    for (let index = 0; index < 200; index += 1) {
      manager.verifyKey(candidate);
    }
    return Number(process.hrtime.bigint() - started) / 1e6;
  };

  const early = measure(`0${"0".repeat(63)}`);
  const late = measure(`${"0".repeat(63)}1`);
  const ratio = Math.max(early, late) / Math.max(1, Math.min(early, late));
  assert.ok(ratio < 5, `timing ratio ${ratio.toFixed(2)} suggests a short-circuit`);
});

test("an identity id shaped for SQL injection is refused and the table survives", (t) => {
  const { storage, manager } = harness();
  t.after(() => storage.close());

  manager.createIdentity({
    id: "survivor",
    displayName: "Survivor",
    scopes: ["chat.completions"],
  });

  for (const id of [
    "x'; DROP TABLE client_identities;--",
    "x' OR '1'='1",
    "x\"; DELETE FROM secrets;--",
    "x'); UPDATE client_identities SET scopes_json='[\"admin\"]';--",
  ]) {
    assert.throws(
      () => manager.createIdentity({ id, displayName: "Injection", scopes: ["admin"] }),
      (error: unknown) =>
        error instanceof IdentityError && error.code === "invalid_identity_id",
    );
  }
  assert.equal(manager.list().length, 1);
  assert.deepEqual(manager.get("survivor")?.scopes, ["chat.completions"]);
  assert.ok(storage.list().some((meta) => meta.name === "client:survivor:key"));
});

test("a hostile id cannot escape the secret scope", (t) => {
  const { storage, manager } = harness();
  t.after(() => storage.close());

  // Each of these would, if accepted, produce a physical secret name outside
  // `client:<id>:` — which is exactly the containment the scoped view provides.
  for (const id of [
    "a:b",
    "a/b",
    "../provider",
    "a..b",
    "provider:p1:api_key",
    "a b",
  ]) {
    assert.throws(
      () => manager.createIdentity({ id, displayName: "Escape", scopes: ["admin"] }),
      (error: unknown) => error instanceof IdentityError,
      `accepted id ${id}`,
    );
  }
});

test("a tampered scopes row cannot introduce an unknown scope", (t) => {
  const { storage, manager } = harness();
  t.after(() => storage.close());

  const { key } = manager.createIdentity({
    id: "tampered",
    displayName: "Tampered",
    scopes: ["chat.completions"],
  });
  storage.sql
    .prepare("UPDATE client_identities SET scopes_json = ? WHERE id = ?")
    .run('["superuser"]', "tampered");

  // Fails closed: the identity becomes unusable rather than authenticating with an
  // uninterpretable authority. Critically, this must not throw — a corrupt row
  // taking down authentication for every other client would turn one bad record
  // into a denial of service.
  assert.equal(manager.verifyKey(key), undefined);

  const healthy = manager.createIdentity({
    id: "healthy",
    displayName: "Healthy",
    scopes: ["chat.completions"],
  });
  assert.equal(
    manager.verifyKey(healthy.key)?.id,
    "healthy",
    "one corrupt row must not lock out every other client",
  );
});

test("every scope the repository accepts is in the declared vocabulary", (t) => {
  const { storage } = harness();
  t.after(() => storage.close());
  const repository = createIdentityRepository(storage.sql);

  for (const scope of CLIENT_SCOPES) {
    const created = repository.create({
      id: `scope-${scope.replace(/\./g, "-")}`,
      displayName: scope,
      scopes: [scope],
    });
    assert.deepEqual(created.scopes, [scope]);
  }
  assert.equal(repository.list().length, CLIENT_SCOPES.length);
});

test("no source file imports a filesystem or process module", () => {
  for (const file of sourceFiles(SRC)) {
    const code = readFileSync(file, "utf8");
    for (const forbidden of ["node:fs", "node:child_process", "node:vm", "node:net"]) {
      assert.ok(!code.includes(forbidden), `${file} imports ${forbidden}`);
    }
  }
});

test("no source file uses eval or dynamic function construction", () => {
  for (const file of sourceFiles(SRC)) {
    const code = stripComments(readFileSync(file, "utf8"));
    assert.ok(!/\beval\s*\(/.test(code), `${file} uses eval`);
    assert.ok(!/new\s+Function\s*\(/.test(code), `${file} constructs a function`);
  }
});

test("a key from a deleted identity does not authenticate a recreated one", (t) => {
  const { storage, manager } = harness();
  t.after(() => storage.close());

  const first = manager.createIdentity({
    id: "recycled",
    displayName: "First",
    scopes: ["chat.completions"],
  });
  manager.delete("recycled");
  const second = manager.createIdentity({
    id: "recycled",
    displayName: "Second",
    scopes: ["admin"],
  });

  // Reusing an id must not resurrect the old credential, which would silently grant
  // the old key the new identity's scopes.
  assert.equal(manager.verifyKey(first.key), undefined);
  assert.equal(manager.verifyKey(second.key)?.id, "recycled");
});

test("a hostile display name cannot become a scope or an id", (t) => {
  const { storage, manager } = harness();
  t.after(() => storage.close());

  const { identity } = manager.createIdentity({
    id: "inert",
    displayName: '{"scopes":["admin"]}',
    scopes: ["chat.completions"],
  });
  assert.deepEqual(identity.scopes, ["chat.completions"]);
  assert.equal(identity.id, "inert");
});
