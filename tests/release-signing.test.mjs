import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { DIGEST_MANIFEST, computeDigests, keyIsInsideRepository, parseManifest } from "../scripts/sign-release.mjs";

/**
 * Release digests and signing — Phase 9K Task 5.
 *
 * **Owner decision: release signing is keyless Sigstore-style provenance through GitHub OIDC.** No
 * long-lived private key exists in this repository, none is stored on this Termux host, and hosted CI
 * obtains a short-lived identity through OIDC when the project is eventually connected to GitHub.
 *
 * That decision splits this task cleanly in two, and the split is the important part:
 *
 *   - **Locally executable and fully tested here:** the `SHA256SUMS` manifest, digest verification,
 *     tamper detection, and the refusals — a key inside the repository, a key written anywhere by this
 *     script, a manifest naming a missing file.
 *   - **Not executable here, reported `UNVERIFIED`:** anything requiring a GitHub OIDC token. There is
 *     no remote, no workflow run, and no `cosign` on this device. A local build is therefore *unsigned*
 *     and says so; a green run of this suite must never be read as "the release is signed".
 *
 * The `openssl`/`gpg` path from the plan is retained for an operator who supplies their own key at
 * release time, because that is the one signing route that works with no network and no CI. It is
 * tested with a throwaway key generated **outside** the repository under a temp path.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SIGN = join(ROOT, "scripts/sign-release.mjs");
const VERIFY = join(ROOT, "scripts/verify-release.mjs");
const DOC = join(ROOT, "docs/release-verification.md");

/** A disposable release directory holding two files that stand in for the tarball and the SBOM. */
function stageRelease() {
  const dir = mkdtempSync(join(tmpdir(), "bayz-release-"));
  writeFileSync(join(dir, "bayz-router-0.1.0.tgz"), "pretend tarball bytes\n");
  writeFileSync(join(dir, "bayz-0.1.0.cdx.json"), '{"bomFormat":"CycloneDX"}\n');
  return dir;
}

/** Run a script, returning status and combined output rather than throwing. */
function run(script, args) {
  try {
    return { status: 0, output: execFileSync(process.execPath, [script, ...args], { encoding: "utf8" }) };
  } catch (error) {
    return { status: error.status ?? 1, output: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
}

/**
 * An Ed25519 keypair under a temp path, never inside the repository.
 *
 * `openssl` is present on this device (3.5.5). If it ever is not, the signing tests report the tool as
 * unavailable rather than failing — which is the behaviour the plan asks for anyway.
 */
function throwawayKey() {
  const dir = mkdtempSync(join(tmpdir(), "bayz-key-"));
  const priv = join(dir, "release.key");
  const pub = join(dir, "release.pub");
  execFileSync("openssl", ["genpkey", "-algorithm", "ed25519", "-out", priv], { stdio: "ignore" });
  execFileSync("openssl", ["pkey", "-in", priv, "-pubout", "-out", pub], { stdio: "ignore" });
  return { dir, priv, pub };
}

test("the digest manifest covers every release file with a sha256", () => {
  const dir = stageRelease();
  const result = run(SIGN, ["--dir", dir]);
  assert.equal(result.status, 0, result.output);

  const manifest = parseManifest(readFileSync(join(dir, DIGEST_MANIFEST), "utf8"));
  assert.equal(manifest.length, 2, `expected 2 entries, got ${manifest.length}`);
  for (const entry of manifest) {
    assert.match(entry.digest, /^[0-9a-f]{64}$/, `${entry.name} has a malformed digest`);
  }
  // Standard `sha256sum -c` format, so a user can verify without our tooling at all.
  const raw = readFileSync(join(dir, DIGEST_MANIFEST), "utf8");
  assert.match(raw, /^[0-9a-f]{64} {2}\S+$/m, `not sha256sum format:\n${raw}`);
});

test("an unsigned build reports UNVERIFIED and exits 0", () => {
  /*
   * A local build with no key is the normal case on this host and must not be conflated with a signed
   * release. It exits 0 — being unsigned is not an error — while saying so unambiguously.
   */
  const dir = stageRelease();
  const result = run(SIGN, ["--dir", dir]);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /UNVERIFIED: unsigned build/, result.output);
  assert.ok(!existsSync(join(dir, `${DIGEST_MANIFEST}.sig`)), "an unsigned build wrote a signature");
});

test("the script refuses a key inside the repository tree", () => {
  /*
   * A signing key committed by accident is unrecoverable trust loss: it is in the history, in every
   * clone, and in every mirror. The refusal is asserted through the real CLI, not just the predicate.
   */
  const dir = stageRelease();
  const insideKey = join(ROOT, "release-test.key");
  writeFileSync(insideKey, "not a real key\n");
  try {
    const result = run(SIGN, ["--dir", dir, "--key", insideKey]);
    assert.equal(result.status, 1, `an in-repo key was accepted: ${result.output}`);
    assert.match(result.output, /inside the repository/i, result.output);
  } finally {
    execFileSync("rm", ["-f", insideKey]);
  }
  assert.ok(!existsSync(insideKey), "the test left a key file in the repository");
});

test("keyIsInsideRepository catches nested and relative paths, not just the root", () => {
  // Unit-level, because the CLI test above can only exercise one path shape.
  assert.equal(keyIsInsideRepository(join(ROOT, "release.key"), ROOT), true);
  assert.equal(keyIsInsideRepository(join(ROOT, "scripts", "deep", "release.key"), ROOT), true);
  assert.equal(keyIsInsideRepository(join(ROOT, "..", "outside.key"), ROOT), false);
  assert.equal(keyIsInsideRepository("/tmp/outside.key", ROOT), false);
  // A sibling directory whose name merely starts with the repo path must not count as inside.
  assert.equal(keyIsInsideRepository(`${ROOT}-sibling/release.key`, ROOT), false);
});

test("the script never writes a private key anywhere", () => {
  /*
   * The second refusal the plan asks for, asserted by *observation* rather than by reading the source:
   * the release directory is listed before and after, and nothing key-shaped may appear.
   */
  const dir = stageRelease();
  const key = throwawayKey();
  const before = new Set(readdirSync(dir));
  const result = run(SIGN, ["--dir", dir, "--key", key.priv]);
  assert.equal(result.status, 0, result.output);

  const added = readdirSync(dir).filter((name) => !before.has(name));
  // `SHA256SUMS` and its detached signature are the only two files signing may produce.
  assert.deepEqual(added.sort(), [DIGEST_MANIFEST, `${DIGEST_MANIFEST}.sig`], `unexpected files written: ${added}`);
  for (const name of readdirSync(dir)) {
    const content = readFileSync(join(dir, name), "latin1").slice(0, 4000);
    assert.ok(!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(content), `${name} contains private key material`);
  }
});

test("a signed manifest verifies against the public key", () => {
  const dir = stageRelease();
  const key = throwawayKey();
  assert.equal(run(SIGN, ["--dir", dir, "--key", key.priv]).status, 0);

  const result = run(VERIFY, ["--dir", dir, "--pubkey", key.pub]);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /signature: VERIFIED/, result.output);
});

test("a single flipped byte in a release file fails verification", () => {
  /*
   * The property that makes the manifest worth having. One byte, not a wholesale replacement, because
   * a digest check that only catches gross substitution is not a digest check.
   */
  const dir = stageRelease();
  const key = throwawayKey();
  run(SIGN, ["--dir", dir, "--key", key.priv]);

  const target = join(dir, "bayz-router-0.1.0.tgz");
  const bytes = readFileSync(target);
  bytes[0] ^= 0x01;
  writeFileSync(target, bytes);

  const result = run(VERIFY, ["--dir", dir, "--pubkey", key.pub]);
  assert.equal(result.status, 1, `tampering was not detected: ${result.output}`);
  assert.match(result.output, /digest mismatch/i, result.output);
});

test("a manifest naming a missing file fails", () => {
  const dir = stageRelease();
  run(SIGN, ["--dir", dir]);
  execFileSync("rm", ["-f", join(dir, "bayz-0.1.0.cdx.json")]);

  const result = run(VERIFY, ["--dir", dir]);
  assert.equal(result.status, 1, `a missing file was tolerated: ${result.output}`);
  assert.match(result.output, /missing/i, result.output);
});

test("unsigned and forged are distinct outcomes", () => {
  /*
   * **The most important assertion in this file.** If "no signature" and "bad signature" produce the
   * same message or the same exit path, an attacker who strips a signature gets the same treatment as
   * an honest local build — which is precisely the confusion signing exists to prevent.
   */
  const dir = stageRelease();
  const key = throwawayKey();

  // Unsigned: digests verify, signature absent, exit 0 with UNVERIFIED.
  run(SIGN, ["--dir", dir]);
  const unsigned = run(VERIFY, ["--dir", dir, "--pubkey", key.pub]);
  assert.equal(unsigned.status, 0, unsigned.output);
  assert.match(unsigned.output, /UNVERIFIED: no signature present/, unsigned.output);
  assert.ok(!/FORGED|signature: INVALID/.test(unsigned.output), "unsigned was reported as invalid");

  // Forged: a signature exists and does not verify. Non-zero, and named differently.
  writeFileSync(join(dir, `${DIGEST_MANIFEST}.sig`), Buffer.from("garbage signature bytes"));
  const forged = run(VERIFY, ["--dir", dir, "--pubkey", key.pub]);
  assert.equal(forged.status, 1, forged.output);
  assert.match(forged.output, /signature: INVALID/, forged.output);
  assert.ok(!/UNVERIFIED: no signature present/.test(forged.output), "a forged signature was reported as merely unsigned");
});

test("verification binds the artifact digest to the signature, not merely to the file list", () => {
  /*
   * Signing a manifest that does not actually pin the bytes would let someone swap the artifact and
   * keep a valid signature. Here the manifest is edited to a *different but well-formed* digest, the
   * old signature is left in place, and both checks must fail: the digest against the file, and the
   * signature against the edited manifest.
   */
  const dir = stageRelease();
  const key = throwawayKey();
  run(SIGN, ["--dir", dir, "--key", key.priv]);

  const manifestPath = join(dir, DIGEST_MANIFEST);
  const edited = readFileSync(manifestPath, "utf8").replace(/^[0-9a-f]{64}/m, "0".repeat(64));
  writeFileSync(manifestPath, edited);

  const result = run(VERIFY, ["--dir", dir, "--pubkey", key.pub]);
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /digest mismatch/i, result.output);
  assert.match(result.output, /signature: INVALID/, result.output);
});

test("the scripts use execFile with argument arrays, never a shell string", () => {
  /*
   * The 9J portability rule. A shell string here would take an operator-supplied key path into a
   * shell. Matched against the shell-invoking forms specifically — a bare `/re/.exec(line)` is string
   * matching, not process execution, so the pattern is anchored to the `child_process` names.
   */
  for (const path of [SIGN, VERIFY]) {
    const source = readFileSync(path, "utf8");
    assert.ok(!/\bexecSync\s*\(/.test(source), `${path} uses execSync`);
    assert.ok(!/\bspawnSync\s*\([^,)]*\)/.test(source), `${path} calls spawnSync with no argument array`);
    assert.ok(!/\b(child_process\.)?exec\s*\(\s*[`'"]/.test(source), `${path} passes a command string to exec`);
    assert.ok(!/shell:\s*true/.test(source), `${path} passes shell: true`);
    assert.match(source, /execFileSync\(/, `${path} does not use execFileSync`);
  }
});

test("a missing tool yields UNVERIFIED rather than a crash", () => {
  /*
   * `openssl` exists here, so absence is simulated by pointing the script at a tool name that cannot
   * exist. The distinction matters: "I could not check" must never surface as "the signature is bad".
   */
  const dir = stageRelease();
  const key = throwawayKey();
  const result = run(SIGN, ["--dir", dir, "--key", key.priv, "--tool", "definitely-not-a-real-tool"]);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /UNVERIFIED: definitely-not-a-real-tool not available/, result.output);
  // And the digests still got written, because that half needs no external tool.
  assert.ok(existsSync(join(dir, DIGEST_MANIFEST)), "the digest manifest was skipped");
});

test("hosted keyless signing is described and reported UNVERIFIED, never faked", () => {
  /*
   * The owner chose keyless Sigstore-style provenance via GitHub OIDC. That cannot run here: no
   * remote, no workflow run, no OIDC issuer, no `cosign`. The scripts must say so plainly instead of
   * printing something that looks like success.
   */
  const dir = stageRelease();
  const result = run(SIGN, ["--dir", dir, "--mode", "keyless"]);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /UNVERIFIED: keyless signing requires GitHub OIDC/, result.output);
  assert.ok(!/signature: VERIFIED|provenance: VERIFIED/.test(result.output), "keyless mode claimed success locally");
  assert.ok(!existsSync(join(dir, `${DIGEST_MANIFEST}.sig`)), "keyless mode wrote a signature locally");
});

test("no signing key material exists anywhere in the repository", () => {
  /*
   * A standing guard, not a one-off check: every tracked file is scanned, so an accidentally committed
   * key fails this suite rather than being found by someone else later.
   *
   * It matches **real PEM key material** — the dashed `-----BEGIN … PRIVATE KEY-----` delimiter
   * followed by a line of base64 body — rather than the bare words. Several files legitimately contain
   * the delimiter *as a search pattern*: `scripts/pack.mjs` scans the tarball for it, and
   * `tests/fuzz-harness.test.mjs` and `tests/pack.test.mjs` plant it as a counter-case to prove that
   * scan is not vacuous. Matching the words alone would flag the very code that prevents key leaks,
   * which is the kind of false positive that gets a guard deleted.
   */
  const tracked = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean);
  const pem = /-----BEGIN (?:RSA |EC |OPENSSH |PGP |DSA )?PRIVATE KEY(?: BLOCK)?-----\s*\n[A-Za-z0-9+/=]{40,}/;

  const offenders = [];
  for (const file of tracked) {
    if (/\.(png|jpg|jpeg|gif|ico|woff2?|tgz|db)$/.test(file)) continue;
    let content;
    try {
      content = readFileSync(join(ROOT, file), "utf8");
    } catch {
      continue; // unreadable or binary; the tarball scan in pack.mjs covers shipped bytes
    }
    if (pem.test(content)) offenders.push(file);
  }
  assert.deepEqual(offenders, [], `private key material is committed in: ${offenders.join(", ")}`);
});

test("the PEM guard actually matches real key material", () => {
  /*
   * The positive control for the test above. Without it, tightening the pattern to avoid false
   * positives could quietly turn the guard into something that matches nothing at all — a guard that
   * cannot fire is worse than no guard, because it reads as protection.
   *
   * A real throwaway Ed25519 key is generated under a temp path and the same pattern must match it.
   */
  const key = throwawayKey();
  const pem = /-----BEGIN (?:RSA |EC |OPENSSH |PGP |DSA )?PRIVATE KEY(?: BLOCK)?-----\s*\n[A-Za-z0-9+/=]{40,}/;
  const content = readFileSync(key.priv, "utf8");
  assert.ok(pem.test(content), `the guard does not match a real PEM private key:\n${content.slice(0, 80)}`);

  // And it must NOT match the bare delimiter used as a search pattern, with no base64 body.
  assert.ok(!pem.test('const marker = "-----BEGIN PRIVATE KEY-----";\n'), "the guard flags a bare pattern string");
});

test("the verification guide states what a signature does not prove", () => {
  assert.ok(existsSync(DOC), `${DOC} does not exist`);
  const doc = readFileSync(DOC, "utf8");
  assert.match(doc, /sha256sum -c/, "the guide does not give a tool-free verification command");
  assert.match(doc, /does not prove/i, "the guide does not state the limits of a signature");
  assert.match(doc, /reproducib/i, "the guide does not disclaim reproducibility");
  assert.match(doc, /build machine/i, "the guide does not disclaim build-machine integrity");
  assert.match(doc, /OIDC/, "the guide does not describe the keyless hosted path");
  assert.match(doc, /UNVERIFIED/, "the guide does not explain the UNVERIFIED state");
});
