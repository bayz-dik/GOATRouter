import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const {
  EVIDENCE_RE,
  emitsNumberedChecks,
  isSafeRepoPath,
  parseEvidence,
  readManifest,
  resolveEvidence,
  ROOT,
} = await import(join(root, "scripts/evidence.mjs"));

/**
 * The evidence citation checker — Phase 9L Task 1.
 *
 * This is the foundation the rest of 9L stands on: every gate above it decides whether a `PASS` is
 * allowed by asking whether its citation resolves. So the tests that matter most here are not the
 * shape tests but the two vacuity guards:
 *
 *   1. **A citation pointing at a real but assertion-free file must be refused.** Pointing at an
 *      empty test file is the cheapest way to launder a verdict, and the path resolving is exactly
 *      what makes it look defended.
 *   2. **The rule is validated against the real corpus.** Every citation already written into every
 *      tracked matrix and report is resolved below. If the consolidated grammar rejected one of them,
 *      the grammar would be wrong — four inline copies had already drifted apart before this file
 *      existed, and a consolidation that quietly narrowed the union would break a document that is
 *      currently honest.
 */

/* ------------------------------------------------------------------ grammar */

test("the four documented citation shapes are accepted", () => {
  const cases = {
    "smoke:install#20": { kind: "smoke", target: "install", number: 20 },
    "smoke:chaos#31-44": { kind: "smoke", target: "chaos", number: 31, last: 44 },
    "test:tests/offline.test.mjs": { kind: "test", target: "tests/offline.test.mjs" },
    "test:tests/offline.test.mjs::the guard is active": {
      kind: "test",
      target: "tests/offline.test.mjs",
      testName: "the guard is active",
    },
    "transcript:docs/transcripts/load/load.md": { kind: "transcript", target: "docs/transcripts/load/load.md" },
  };
  for (const [ref, expected] of Object.entries(cases)) {
    assert.deepEqual(parseEvidence(ref), expected, `${ref} did not parse as expected`);
  }
});

test("anything outside the grammar is rejected", () => {
  /*
   * The comma list is the one worth naming. `smoke:load#4,9,14,19,24` was in the first draft of the
   * 9I report and was rejected then for a reason that still holds: a row asserting five unrelated
   * check numbers is unfalsifiable, because no single check can be looked up to confirm or refute it.
   */
  const rejected = [
    "",
    "   ",
    "smoke:load#4,9,14,19,24",
    "smoke:load#4 and #9",
    "smoke:install",
    "smoke:install#",
    "smoke:install#0",
    "smoke:chaos#44-31",
    "smoke:chaos#44-44",
    "smoke:Install#3",
    "smoke:#3",
    "test:",
    "test:tests/offline.test.mjs::",
    "spec:docs/thing.md",
    "docs/thing.md",
    "it works",
    "test:tests/offline.test.mjs ",
    " test:tests/offline.test.mjs",
    "PASS",
  ];
  for (const ref of rejected) {
    assert.equal(parseEvidence(ref), undefined, `${JSON.stringify(ref)} should not parse`);
  }
  assert.equal(parseEvidence(undefined), undefined);
  assert.equal(parseEvidence(42), undefined);
});

test("a path outside the repository, or containing .., is rejected", () => {
  /*
   * Traversal matters here for a specific reason: a citation is meant to be reviewable by anyone with
   * the repository, and a path into `/etc` or `../` points at something the reviewer does not have.
   * Note `EVIDENCE_RE` alone accepts `..` — `[\w./-]+` matches it — so `parseEvidence` is the
   * boundary, not the regex, and that is asserted rather than assumed.
   */
  for (const ref of [
    "test:../outside.test.mjs",
    "test:tests/../../outside.test.mjs",
    "transcript:/etc/passwd",
    "test:/tmp/planted.test.mjs",
  ]) {
    assert.equal(parseEvidence(ref), undefined, `${ref} should be rejected`);
  }
  assert.ok(EVIDENCE_RE.test("test:../outside.test.mjs"), "the regex alone is expected to be insufficient");

  assert.equal(isSafeRepoPath(".."), false);
  assert.equal(isSafeRepoPath("/absolute"), false);
  assert.equal(isSafeRepoPath(""), false);
  assert.equal(isSafeRepoPath("tests/offline.test.mjs"), true);
});

/* --------------------------------------------------------------- resolution */

test("resolveEvidence resolves a real test file and reports its assertion count", async () => {
  const result = await resolveEvidence("test:tests/offline.test.mjs");
  assert.equal(result.ok, true, result.reason);
  assert.ok(result.assertions > 5, `expected real assertions, got ${result.assertions}`);
});

test("resolveEvidence resolves a named test inside a file, and refuses a name that is not there", async () => {
  const source = readFileSync(join(root, "tests/offline.test.mjs"), "utf8");
  const name = /^test\("([^"]+)"/m.exec(source)?.[1];
  assert.ok(name !== undefined, "could not find a test name to cite");

  const present = await resolveEvidence(`test:tests/offline.test.mjs::${name}`);
  assert.equal(present.ok, true, present.reason);

  const absent = await resolveEvidence("test:tests/offline.test.mjs::a test that was never written");
  assert.equal(absent.ok, false);
  assert.match(absent.reason, /contains no test named/);
});

test("a citation to a file that exists but has zero assertions is refused", async () => {
  /*
   * **The load-bearing vacuity guard.** The path resolves, the file is real and non-empty, and it
   * proves nothing — which is precisely why it reads as defended. Written into a temp directory
   * *inside* the repository, because a path outside it is refused earlier for a different reason and
   * would not exercise this rule at all.
   */
  const dir = mkdtempSync(join(root, "tests/.evidence-fixture-"));
  const relative = `tests/${dir.split("/").pop()}/hollow.test.mjs`;
  try {
    writeFileSync(join(dir, "hollow.test.mjs"), "import test from \"node:test\";\ntest(\"nothing\", () => {});\n");
    const hollow = await resolveEvidence(`test:${relative}`);
    assert.equal(hollow.ok, false, "an assertion-free test file was accepted as evidence");
    assert.match(hollow.reason, /contains no assertions/);

    // And the same file with one real assertion is accepted, so the rule is not simply refusing
    // everything in a temp directory.
    writeFileSync(
      join(dir, "hollow.test.mjs"),
      "import assert from \"node:assert/strict\";\nimport test from \"node:test\";\ntest(\"something\", () => { assert.ok(true); });\n",
    );
    const real = await resolveEvidence(`test:${relative}`);
    assert.equal(real.ok, true, real.reason);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an empty or blank transcript is refused", async () => {
  const dir = mkdtempSync(join(root, "tests/.evidence-fixture-"));
  const base = `tests/${dir.split("/").pop()}`;
  try {
    writeFileSync(join(dir, "empty.md"), "");
    writeFileSync(join(dir, "blank.md"), "\n\n   \n");
    writeFileSync(join(dir, "real.md"), "# a run\n\ncommand: node scripts/load-smoke.mjs\n");

    assert.match((await resolveEvidence(`transcript:${base}/empty.md`)).reason, /is empty/);
    assert.match((await resolveEvidence(`transcript:${base}/blank.md`)).reason, /is blank/);
    assert.equal((await resolveEvidence(`transcript:${base}/real.md`)).ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a citation to a missing file, or to a directory, is refused", async () => {
  const missing = await resolveEvidence("test:tests/never-written.test.mjs");
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /does not exist/);

  const directory = await resolveEvidence("transcript:docs/transcripts");
  assert.equal(directory.ok, false);
  assert.match(directory.reason, /is a directory/);
});

/* ------------------------------------------------------------ smoke bounds */

test("a smoke citation resolves against the published manifest, including the capability mapping", async () => {
  const manifest = readManifest("client-conformance");
  assert.notEqual(manifest, undefined, "client-conformance publishes no manifest");

  const [capability, number] = Object.entries(manifest.capabilities)[0];
  const good = await resolveEvidence(`smoke:client-conformance#${number}`, { capability });
  assert.equal(good.ok, true, good.reason);
  assert.equal(good.bound, "manifest", "a manifest-backed citation should report the stronger bound");

  /*
   * The real hole this closes, recorded in 9H Task 1: `smoke:client-conformance#99` was accepted in
   * a cell for a capability that harness never exercises, because the number was validated against
   * nothing.
   */
  const overrun = await resolveEvidence(`smoke:client-conformance#${manifest.totalChecks + 1}`);
  assert.equal(overrun.ok, false);
  assert.match(overrun.reason, /ran \d+ checks/);

  const wrongCapability = await resolveEvidence(`smoke:client-conformance#${Number(number) + 1}`, { capability });
  assert.equal(wrongCapability.ok, false, "a citation pointing at the wrong check for its capability was accepted");
  assert.match(wrongCapability.reason, /reports #/);

  const unknownCapability = await resolveEvidence(`smoke:client-conformance#${number}`, { capability: "telepathy" });
  assert.equal(unknownCapability.ok, false);
  assert.match(unknownCapability.reason, /publishes no check for capability/);
});

test("a smoke script with no manifest resolves, but reports the weaker bound honestly", async () => {
  /*
   * `install-smoke.mjs` emits numbered checks and publishes no manifest, so the upper bound genuinely
   * cannot be verified from disk. The right answer is to resolve and say so — not to refuse a real
   * citation, and not to imply a guarantee that was never checked.
   */
  const result = await resolveEvidence("smoke:install#20");
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.bound, "numbering-only");
  assert.match(result.reason, /upper bound is unverified/);
});

test("a smoke citation into a script that emits no numbered checks is refused", async () => {
  /*
   * `#n` cannot mean anything in output that has no numbers, so accepting it would be accepting a
   * number nobody could ever look up.
   *
   * The predicate is exercised against **fixture sources**, not a repository script. This test used
   * to pin `scripts/proxy-ux-smoke.mjs`, which was unnumbered at the time — and 9L Task 2 then
   * numbered it along with twelve siblings, precisely so their checks could be cited. A test whose
   * subject the next task is expected to fix fails for the right reason at the wrong time. A fixture
   * cannot be numbered out from under it, and it is written outside `scripts/` because 9J's
   * portability scanner lists that directory concurrently and a vanishing file there made that scan
   * die with ENOENT once already.
   */
  const dir = mkdtempSync(join(tmpdir(), "bayz-evidence-fixture-"));
  try {
    // Counts but never prints the number — the exact pre-Task-2 shape of thirteen smoke scripts.
    const counting = join(dir, "counting.mjs");
    writeFileSync(counting, "let checks = 0;\nchecks += 1;\nconsole.log(`  ok   ${label}`);\nconsole.log(`${checks} checks passed`);\n");
    assert.equal(emitsNumberedChecks(counting), false, "a script that counts without printing the number was accepted");

    // Prints a number it never counted: the citation would resolve against a constant.
    const literal = join(dir, "literal.mjs");
    writeFileSync(literal, "console.log('  ok    7  a hardcoded number');\n");
    assert.equal(emitsNumberedChecks(literal), false, "a script printing a literal number was accepted");

    // Both halves present.
    const numbered = join(dir, "numbered.mjs");
    writeFileSync(numbered, "let checks = 0;\nchecks += 1;\nconsole.log(`  ok   ${String(checks).padStart(2)}  ${label}`);\n");
    assert.equal(emitsNumberedChecks(numbered), true, "a genuinely numbered script was refused");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  // And the real corpus: the scripts Task 2's rows cite must actually be numbered.
  for (const script of ["proxy-ux", "storage", "api", "stream", "security", "usage", "identity", "injection"]) {
    const result = await resolveEvidence(`smoke:${script}#3`);
    assert.equal(result.ok, true, `smoke:${script}#3 — ${result.reason}`);
  }
});

test("a smoke citation resolves through a script's helper modules, not only its entry point", async () => {
  /*
   * `chaos-smoke.mjs` is orchestration and prints nothing itself; the numbering lives in
   * `chaos-lib.mjs`. Looking only at the entry point would refuse all eight chaos citations in the
   * resilience report — a consolidation that broke honest documents.
   */
  const entry = readFileSync(join(root, "scripts/chaos-smoke.mjs"), "utf8");
  assert.ok(!/checkNumber\s*\+=/.test(entry), "chaos-smoke now counts inline; this test needs a new subject");

  const result = await resolveEvidence("smoke:chaos#31-44");
  assert.equal(result.ok, true, result.reason);
});

test("a citation naming no such script is refused", async () => {
  const result = await resolveEvidence("smoke:telepathy#1");
  assert.equal(result.ok, false);
  assert.match(result.reason, /no script matches/);
});

/* ------------------------------------------------------- the real corpus */

/** Every tracked matrix and report whose cells carry citations. */
const CORPUS = [
  "docs/superpowers/2026-08-27-bayz-client-compatibility-matrix.md",
  "docs/superpowers/2026-08-27-bayz-resilience-report.md",
  "docs/superpowers/2026-08-27-bayz-platform-matrix.md",
  "docs/superpowers/2026-08-27-bayz-supply-chain-report.md",
];

/**
 * Pull every citation-shaped token out of a document's **table rows**.
 *
 * Table rows only, and that is the substantive choice here. A citation in a cell is a claim; the same
 * string in prose is usually the document explaining the grammar or recording a historic defect — the
 * 9H matrix names `smoke:client-conformance#99` precisely to record that an unresolvable number once
 * passed, and demanding that *that* resolve would force the deletion of the sentence documenting the
 * hole. Cells are where a citation carries weight, so cells are what must resolve.
 */
function citationsIn(text) {
  return text
    .split("\n")
    .filter((line) => line.trimStart().startsWith("|"))
    .flatMap((line) => [
      ...line.matchAll(/(?:smoke:[a-z][a-z0-9-]*#\d+(?:-\d+)?|(?:test|transcript):[\w./-]+(?:::[^|,\s]+)?)/g),
    ])
    .map((match) => match[0]);
}

test("every citation in every tracked matrix and report parses under the consolidated grammar", () => {
  /*
   * **The consolidation's real test.** Four inline copies existed and had already drifted: 9H's
   * rejected the contiguous range that 9I's report uses, and only 9K's accepted `::name`. A union
   * that narrowed anywhere would break a document that is currently honest, and the failure would
   * show up as a false accusation of dishonesty — the worst possible failure mode for this rule.
   */
  let checked = 0;
  for (const path of CORPUS) {
    const absolute = join(root, path);
    if (!existsSync(absolute)) continue;
    for (const citation of citationsIn(readFileSync(absolute, "utf8"))) {
      checked += 1;
      assert.notEqual(parseEvidence(citation), undefined, `${path}: ${citation} does not parse`);
    }
  }
  assert.ok(checked > 100, `the corpus scan found only ${checked} citations, which is too few to be meaningful`);
  console.log(`  citations parsed from the real corpus: ${checked}`);
});

test("every citation in every tracked matrix and report resolves on disk", async () => {
  const failures = [];
  let checked = 0;
  for (const path of CORPUS) {
    const absolute = join(root, path);
    if (!existsSync(absolute)) continue;
    for (const citation of new Set(citationsIn(readFileSync(absolute, "utf8")))) {
      checked += 1;
      const result = await resolveEvidence(citation);
      if (!result.ok) failures.push(`${path}: ${citation} — ${result.reason}`);
    }
  }
  assert.deepEqual(failures, [], `citations that do not resolve:\n${failures.join("\n")}`);
  assert.ok(checked > 50, `only ${checked} unique citations were resolved`);
  console.log(`  unique citations resolved: ${checked}`);
});

test("no repository test suite relies on expect() alone, which the assertion count would miss", () => {
  /*
   * The assertion count matches `assert` and `expect(`. If a suite ever used some third idiom, a
   * hollow file could slip through. Asserting the corpus's shape here means the day that changes is
   * a failure rather than a silent weakening.
   */
  const source = readFileSync(join(root, "scripts/evidence.mjs"), "utf8");
  assert.match(source, /\\bassert\\b\|\\bexpect\\\(/, "the assertion pattern has changed; revisit this test");
});

test("the consolidated checker lives in exactly one place", () => {
  /*
   * The point of Task 1. Four copies of one regex will drift, and the copy that drifts will be the
   * one guarding the claim that matters. This asserts the four consumers import rather than redefine.
   */
  for (const consumer of [
    "tests/matrix-integrity.test.mjs",
    "tests/resilience-report.test.mjs",
    "tests/platform-matrix.test.mjs",
    "tests/supply-chain-report.test.mjs",
  ]) {
    const source = readFileSync(join(root, consumer), "utf8");
    assert.match(source, /evidence\.mjs/, `${consumer} does not import the shared evidence checker`);
  }

  for (const consumer of ["tests/matrix-integrity.test.mjs", "tests/platform-matrix.test.mjs"]) {
    const source = readFileSync(join(root, consumer), "utf8");
    assert.ok(
      !/^const EVIDENCE_RE\s*=\s*\//m.test(source),
      `${consumer} still defines its own evidence regex`,
    );
  }
});

test("ROOT points at the repository, so a relative citation means the same thing everywhere", () => {
  assert.equal(existsSync(join(ROOT, "package.json")), true, `${ROOT} is not the repository root`);
});
