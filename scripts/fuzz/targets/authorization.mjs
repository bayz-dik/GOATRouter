/**
 * Fuzz target: bearer-token authorization — 9I Task 3.
 *
 * Real `openSecretStorage` on a temp directory with real envelope crypto and a real identity
 * manager. No stub: the point is that `verifyKey` fails closed on every hostile shape *and*
 * that a revoked identity's still-correct key stops working, which a mock would simply assert
 * about itself.
 *
 * The plan's extra requirements are covered explicitly: a 1 MiB bearer, a bearer with embedded
 * CR/LF, a bearer of 10,000 spaces, and a key valid for a **revoked** identity all end in a
 * refusal. Timing is measured and reported as *indicative* — a same-class claim on a shared
 * Android device under proot would be noise dressed up as a security property.
 */

import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { generateIdentifier, generateUtf8String } from "../generators.mjs";
import { assertGlobalStateUnchanged, globalStateSnapshot } from "./shared.mjs";

const { openSecretStorage } = await import("../../../packages/storage/src/secret-repository.ts");
const { createIdentityManager } = await import("../../../packages/identity/src/manager.ts");

const KEK_HEX = Buffer.alloc(32, 0x3c).toString("hex");

const dataDir = join(mkdtempSync(join(tmpdir(), "bayz-fuzz-auth-")), ".bayz");
const storage = openSecretStorage({ dataDir, env: { BAYZ_MASTER_KEY: KEK_HEX } });
const manager = createIdentityManager({ storage });

/**
 * A live identity, and one that was created then revoked.
 *
 * Method names read from the `IdentityManager` interface: `createIdentity` returning
 * `{ identity, key }`, and `revoke` rather than `delete`. **Revoke, specifically** — the plan
 * asks for "a bearer that is valid for a *revoked* identity", which is the harder case:
 * `delete` removes the stored key so the comparison never happens, while `revoke` leaves the
 * key intact and only the identity's usable state says no. That is the branch worth fuzzing.
 */
const live = manager.createIdentity({ id: "fuzz-live", displayName: "Live", scopes: ["chat.completions"] });
const revoked = manager.createIdentity({ id: "fuzz-revoked", displayName: "Revoked", scopes: ["chat.completions"] });
manager.revoke("fuzz-revoked");

const LIVE_KEY = live.key;
const REVOKED_KEY = revoked.key;

/** Timing samples per class, for the indicative report only. */
const timings = new Map();

function record(kind, ns) {
  const bucket = timings.get(kind) ?? [];
  bucket.push(ns);
  timings.set(kind, bucket);
}

/**
 * Generated inputs are **descriptors that never contain a key**.
 *
 * The first version put the actual bearer strings in the generated value and the harness
 * refused the run at iteration 2 with `credential_shape` — a real 64-hex client key had been
 * generated as fuzz input. That is Task 1's scan doing precisely its job: Task 3 writes failing
 * inputs to a committed corpus, so a recorded input holding a live key would have put it in git
 * history. The fix is not to loosen the scan but to stop generating the secret: `generate`
 * emits a recipe and `run` materialises the bearer, so the key exists only in memory.
 */
function generate(rng) {
  switch (rng.int(0, 11)) {
    case 0:
      // 1 MiB bearer, described rather than materialised for the same reason.
      return { kind: "huge", length: 1024 * 1024 };
    case 1:
      return { kind: "crlf-split", at: rng.int(1, 63) };
    case 2:
      return { kind: "crlf-header" };
    case 3:
      return { kind: "spaces", length: 10_000 };
    case 4:
      return { kind: "revoked" };
    case 5:
      return { kind: "valid" };
    case 6:
      // One character off: the closest possible miss.
      return { kind: "near-miss", at: rng.int(0, 63) };
    case 7:
      return { kind: "case" };
    case 8:
      return { kind: "truncated", length: rng.int(0, 63) };
    case 9:
      return { kind: "extended", extra: rng.int(1, 64) };
    case 10:
      // A well-formed but wrong key: 64 hex characters that belong to nobody. Built from a
      // small numeric seed so the descriptor itself is not credential-shaped.
      return { kind: "random", seed: rng.int(1, 0xffffff) };
    default:
      return { kind: "garbage", value: rng.bool() ? generateIdentifier(rng) : generateUtf8String(rng) };
  }
}

function materialise(input) {
  switch (input.kind) {
    case "huge":
      return "a".repeat(input.length);
    case "spaces":
      return " ".repeat(input.length);
    case "crlf-split":
      return `${LIVE_KEY.slice(0, input.at)}\r\n${LIVE_KEY.slice(input.at)}`;
    case "crlf-header":
      return `${LIVE_KEY}\r\nx-injected: yes`;
    case "revoked":
      return REVOKED_KEY;
    case "valid":
      return LIVE_KEY;
    case "near-miss": {
      const chars = [...LIVE_KEY];
      chars[input.at] = chars[input.at] === "a" ? "b" : "a";
      return chars.join("");
    }
    case "case":
      return LIVE_KEY.toUpperCase();
    case "truncated":
      return LIVE_KEY.slice(0, input.length);
    case "extended":
      return `${LIVE_KEY}${"a".repeat(input.extra)}`;
    case "random":
      return createHash("sha256").update(`bayz-fuzz-auth:${input.seed}`).digest("hex");
    default:
      return input.value;
  }
}

function run(input, { iteration }) {
  const before = globalStateSnapshot();
  const context = `authorization#${iteration}/${input.kind}`;
  const presented = materialise(input);

  const started = process.hrtime.bigint();
  let identity;
  try {
    identity = manager.verifyKey(presented);
  } catch (error) {
    /*
     * `verifyKey` returns `undefined` for a refusal; it does not throw. A throw is therefore a
     * defect regardless of type — an exception escaping the auth path would turn a bad bearer
     * into a 500 and hand a caller a distinguishable outcome.
     */
    throw new Error(`${context}: verifyKey threw instead of refusing: ${error?.name}: ${error?.message}`);
  }
  record(input.kind, Number(process.hrtime.bigint() - started));

  if (input.kind === "valid") {
    if (identity === undefined) throw new Error(`${context}: the live key was refused`);
    if (identity.id !== "fuzz-live") throw new Error(`${context}: the live key resolved to ${identity.id}`);
  } else if (identity !== undefined) {
    // Everything else must fail closed — most sharply the revoked case, where the key itself
    // is still correct and only the identity's state says no.
    throw new Error(`${context}: a ${input.kind} bearer authenticated as ${identity.id}`);
  }

  assertGlobalStateUnchanged(before, context);
}

/**
 * Indicative timing summary.
 *
 * Deliberately **not** an assertion. `verifyKey` shape-checks before hashing, so a malformed
 * bearer genuinely returns faster than a well-formed miss, and that is a documented design
 * choice (a 1 MiB bearer must not cost one SHA-256 per registered client). Claiming
 * indistinguishable timing on a shared Android device under proot would be a fake security
 * property; reporting the medians is honest and still useful.
 */
export function summary() {
  const lines = [];
  for (const [kind, samples] of [...timings.entries()].sort()) {
    const sorted = [...samples].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
    lines.push(`${kind}=${(median / 1000).toFixed(1)}µs/n=${samples.length}`);
  }
  return `indicative bearer timing (not asserted): ${lines.join(" ")}`;
}

export const target = {
  name: "authorization",
  seed: "9i-authorization-1",
  iterations: 5000,
  generate,
  run,
  summary,
};
