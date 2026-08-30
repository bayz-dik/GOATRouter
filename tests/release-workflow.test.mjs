import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * The hosted keyless release workflow — Phase 9K Task 5, owner-decided signing mode.
 *
 * **Owner decision: keyless Sigstore-style signing and provenance through GitHub OIDC.** There is no
 * long-lived private key anywhere — not in this repository, not in its history, not on the Termux
 * development host. Hosted CI mints a short-lived identity per workflow run.
 *
 * This workflow **has never executed**: no remote is configured. So every assertion here is
 * *structural* — the file is read and checked as text. That is genuinely worth doing (a workflow whose
 * permissions are wrong is wrong before it ever runs, and reviewing it after a leak is too late), but
 * it must not be mistaken for runtime evidence. The load-bearing test in this file is the last one:
 * **nothing may cite this workflow as evidence of anything.**
 *
 * The security properties asserted, each a real way a release workflow gets compromised:
 *
 *   - `id-token: write` exists **only** on the job that signs. It is the credential that lets a job
 *     mint an OIDC identity, and a workflow-wide grant hands it to every step including third-party
 *     actions.
 *   - Every release-critical action is pinned to a **full 40-character commit SHA**. A tag is mutable;
 *     `@v4` silently becomes whatever the tag owner repoints it to, which is how `tj-actions/changed-files`
 *     was compromised in March 2025.
 *   - No `secrets.*` anywhere. Keyless signing needs none, so a secret reference would mean either a
 *     smuggled long-lived key or an unnecessary exposure.
 *   - No `pull_request_target`, and no `workflow_run` with checkout of a PR ref — the two triggers that
 *     run untrusted code with write-capable credentials.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW = join(ROOT, ".github/workflows/release-provenance.yml");
const MATRIX = join(ROOT, "docs/superpowers/2026-08-27-bayz-platform-matrix.md");
const REPORT = join(ROOT, "docs/superpowers/2026-08-27-bayz-supply-chain-report.md");

function workflow() {
  assert.ok(existsSync(WORKFLOW), `${WORKFLOW} does not exist`);
  return readFileSync(WORKFLOW, "utf8");
}

/**
 * The workflow with whole-line `#` comments removed.
 *
 * Needed because this file's own header comment *documents* the security rules — it names
 * `id-token: write` and `secrets.*` in prose to explain why they are constrained. Scanning raw text
 * for those strings flags the documentation rather than the configuration, and the honest fix is to
 * assert against what GitHub actually executes. Inline trailing comments are kept, since the pinned-SHA
 * version comments are themselves asserted elsewhere.
 */
function configOnly(text) {
  return text
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
}

/** Split into top-level `jobs:` blocks, so per-job permissions can be checked in isolation. */
function jobs(text) {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line === "jobs:");
  assert.notEqual(start, -1, "the workflow has no jobs: block");

  const result = new Map();
  let current;
  for (const line of lines.slice(start + 1)) {
    const header = /^ {2}([a-z][\w-]*):\s*$/.exec(line);
    if (header !== null) {
      current = header[1];
      result.set(current, []);
      continue;
    }
    if (current !== undefined) result.get(current).push(line);
  }
  return new Map([...result].map(([name, body]) => [name, body.join("\n")]));
}

test("the workflow exists and is dispatch-only", () => {
  const text = workflow();
  /*
   * `workflow_dispatch` and a release tag are the only acceptable triggers. `push` on every branch
   * would sign development commits, and there is nothing to release from them.
   */
  assert.match(text, /^on:/m, "no trigger block");
  assert.match(text, /workflow_dispatch:/, "not manually dispatchable");
  assert.ok(!/pull_request_target:/.test(text), "pull_request_target grants write credentials to untrusted code");
  assert.ok(!/^\s*schedule:/m.test(text), "a scheduled release workflow would publish unattended");
});

test("the workflow's default permissions are read-only", () => {
  const text = workflow();
  const topLevel = text.slice(0, text.indexOf("jobs:"));
  assert.match(topLevel, /^permissions:\s*\n\s+contents:\s*read\s*$/m, `top-level permissions are not contents: read:\n${topLevel}`);
  assert.ok(!/^permissions:\s*write-all/m.test(text), "write-all permissions");
});

test("id-token: write is granted only to the signing job", () => {
  /*
   * The single most important line in the file. `id-token: write` is what lets a job mint an OIDC
   * token — the whole basis of keyless signing. Granted workflow-wide, every step including every
   * third-party action inherits the ability to impersonate this repository to Sigstore.
   */
  const text = configOnly(workflow());
  const topLevel = text.slice(0, text.indexOf("jobs:"));
  assert.ok(!/id-token:/.test(topLevel), "id-token is granted at the workflow level, not per job");

  const withIdToken = [...jobs(text)].filter(([, body]) => /id-token:\s*write/.test(body)).map(([name]) => name);
  assert.deepEqual(withIdToken, ["sign"], `id-token: write appears in unexpected jobs: ${withIdToken.join(", ")}`);
});

test("no job is granted repository write or admin scope", () => {
  const text = workflow();
  for (const [name, body] of jobs(text)) {
    assert.ok(!/contents:\s*write/.test(body), `job ${name} can write repository contents`);
    assert.ok(!/packages:\s*write/.test(body), `job ${name} can publish packages`);
    assert.ok(!/actions:\s*write/.test(body), `job ${name} can modify workflows`);
    assert.ok(!/administration:/.test(body), `job ${name} requests administration scope`);
  }
  // `attestations: write` is legitimate and required to store a provenance attestation; assert it is
  // confined to the signing job rather than absent.
  const withAttestations = [...jobs(text)].filter(([, body]) => /attestations:\s*write/.test(body)).map(([name]) => name);
  assert.deepEqual(withAttestations, ["sign"], `attestations: write appears in: ${withAttestations.join(", ")}`);
});

test("every action is pinned to a full commit SHA, not a tag", () => {
  /*
   * A mutable tag is the supply-chain attack that actually happens: `tj-actions/changed-files` was
   * compromised in March 2025 by repointing tags, and every workflow using `@v35` executed the
   * attacker's code. A 40-hex SHA cannot be repointed.
   */
  const text = workflow();
  const uses = [...text.matchAll(/uses:\s*(\S+)/g)].map((match) => match[1]);
  assert.ok(uses.length >= 3, `expected several actions, found ${uses.length}`);

  for (const reference of uses) {
    assert.match(
      reference,
      /^[\w.-]+\/[\w.-]+(?:\/[\w.-]+)*@[0-9a-f]{40}$/,
      `not pinned to a full commit SHA: ${reference}`,
    );
  }
});

test("each pinned SHA carries a version comment, so it can be audited and updated", () => {
  // A bare SHA is unreviewable: nobody can tell v4.2.2 from a hostile fork by looking at it.
  const text = workflow();
  for (const line of text.split("\n")) {
    if (!/uses:\s*\S+@[0-9a-f]{40}/.test(line)) continue;
    assert.match(line, /#\s*v?\d+\.\d+\.\d+/, `pinned action has no version comment: ${line.trim()}`);
  }
});

test("the workflow references no secret and no long-lived key", () => {
  /*
   * Keyless signing needs no secret at all. Any `secrets.*` reference here would mean a long-lived
   * credential was smuggled in — exactly what the owner's decision rules out.
   */
  const text = configOnly(workflow());
  assert.ok(!/secrets\./.test(text), "the workflow references a secret");
  assert.ok(!/NPM_TOKEN|GPG_|SIGNING_KEY|PRIVATE_KEY/i.test(text), "the workflow references key material");
  assert.ok(!/npm\s+publish/.test(text), "the workflow publishes to a registry");
});

test("the workflow verifies the artifact it signed, binding digest to provenance", () => {
  /*
   * Signing one artifact and shipping another is the failure this guards against. The workflow must
   * run the repository's own verifier after signing, against the same directory.
   */
  const text = workflow();
  assert.match(text, /scripts\/sign-release\.mjs/, "the workflow never produces digests");
  assert.match(text, /scripts\/verify-release\.mjs/, "the workflow never verifies what it signed");
  assert.match(text, /subject-path/, "no artifact is bound as an attestation subject");
});

test("the gate and the report run in the workflow", () => {
  const text = workflow();
  assert.match(text, /scripts\/supply-chain-gate\.mjs/, "the release workflow does not run the supply-chain gate");
  assert.match(text, /--enforce/, "the gate runs in report mode only");
});

/**
 * Whether a document line invokes the release workflow illegitimately.
 *
 * Returns a reason string, or `null` when the mention is an acceptable disclaimer. Shared by the
 * live document scan and by the negative controls below, so the rule that guards the real documents
 * is the same rule proven able to fail.
 */
const WORKFLOW_NEGATION = /\b(no|not|never|cannot|does not|inert|unverified|unpushed|without|prohibit)\b/i;

export function workflowCitationViolation(line) {
  if (!line.includes("release-provenance")) return null;

  if (line.trimStart().startsWith("|")) {
    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
    const [, status = "", evidence = "", notes = ""] = cells;
    if (evidence.includes("release-provenance")) return "cites the release workflow as evidence, and it has never run";
    if (status === "PASS") return "claims PASS on a row that invokes the unrun workflow";
    if (!WORKFLOW_NEGATION.test(notes)) return "invokes the release workflow without disclaiming it";
    return null;
  }

  if (!WORKFLOW_NEGATION.test(line)) return "invokes the release workflow as though it had run";
  return null;
}

test("nothing in the repository cites this workflow as evidence", () => {
  /*
   * **The load-bearing test.** A workflow that has never executed proves nothing, and the temptation
   * is to let its existence upgrade a matrix cell or a report row. Committing a file is not evidence.
   *
   * The rule is *structural where it can be, negation-aware where it cannot*, which is stronger than
   * banning the filename outright:
   *
   *   - In a verdict table, the **evidence cell** may never reference the workflow, and a row that
   *     mentions it may not carry a `PASS`. That is the actual cheat — a cell laundering an unpushed
   *     file into a verdict — and a substring ban never checked which column the name appeared in.
   *   - In prose, and in a row's notes, a mention must be a **negation**: the documents are required
   *     elsewhere to record that hosted signing is unperformed, and Task 8's report cannot state that
   *     the signature row is `UNVERIFIED` *because* the workflow has never run without naming it. A
   *     blanket ban would forbid the disclaimer and the claim alike, and the way that gets resolved
   *     under time pressure is by deleting the disclaimer — losing the honest statement to protect a
   *     test that was aiming at the opposite thing. Same negation-aware shape as the
   *     `reproducible build` guard in `tests/build-determinism.test.mjs`.
   */
  for (const path of [MATRIX, REPORT]) {
    if (!existsSync(path)) continue;
    for (const [index, line] of readFileSync(path, "utf8").split("\n").entries()) {
      const violation = workflowCitationViolation(line);
      assert.equal(violation, null, `${path}:${index + 1} ${violation}`);
    }
  }
});

test("the citation rule is not vacuous: every way of laundering the workflow is caught", () => {
  /*
   * The positive control. A negation-aware rule is one edit away from accepting everything — the
   * negation list contains `not`, and almost any sentence can be made to contain `not`. So each
   * cheat shape is asserted to fire, and the real disclaimers are asserted to pass, because a rule
   * that matched nothing would report a clean document forever.
   */
  const caught = [
    "| signature | PASS | test:.github/workflows/release-provenance.yml | signed by the hosted workflow |",
    "| signature | UNVERIFIED | evidence:release-provenance | hosted run |",
    "| signature | PASS | test:tests/release-signing.test.mjs | verified by release-provenance.yml |",
    "| signature | UNVERIFIED | | release-provenance.yml signs every release |",
    "Releases are signed keylessly by `.github/workflows/release-provenance.yml`.",
  ];
  for (const line of caught) {
    assert.notEqual(workflowCitationViolation(line), null, `this should have been caught: ${line}`);
  }

  const allowed = [
    "| signature | UNVERIFIED | | `.github/workflows/release-provenance.yml` exists and is inert — no remote is configured. |",
    "- **`.github/workflows/release-provenance.yml` has never executed.** No row here cites it.",
    "| offline | PASS | test:tests/offline.test.mjs | 12 suites with egress blocked |",
    "Performed by `release-provenance.yml`, which has not run on this host.",
  ];
  for (const line of allowed) {
    assert.equal(workflowCitationViolation(line), null, `this honest line was rejected: ${line}`);
  }
});

test("the workflow records that it has never run", () => {
  // Stated in the file itself, so a reader of the workflow alone cannot mistake it for proven.
  const text = workflow();
  assert.match(text, /never (been )?(executed|run)/i, "the workflow does not record that it has never run");
  assert.match(text, /UNVERIFIED/, "the workflow does not name its own unverified status");
});
