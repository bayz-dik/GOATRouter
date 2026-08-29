import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { LOCKFILE_VERSION, checkLockfile, parseLockfile } from "../scripts/lockfile-check.mjs";

/**
 * Lockfile integrity and provenance — Phase 9K Task 2.
 *
 * This task pins properties the repository **already satisfies**, which is the entire point: the check
 * exists to catch the day one of them stops being true. A `sha1` integrity hash or a tarball URL on an
 * unexpected host is not a thing that happens gradually — it happens in one commit, and this is what
 * notices.
 *
 * Because of that, every assertion here is paired with a **mutated copy** of the real lockfile. A test
 * that only ever sees a clean file tells you nothing about whether it would catch a violation; that is
 * the vacuity trap this whole phase is written against.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LOCK_PATH = join(ROOT, "package-lock.json");
const CHECK = join(ROOT, "scripts/lockfile-check.mjs");

/**
 * Measured baseline, 2026-08-29, after the 9K Task 1 `@fastify/static` security upgrade.
 *
 * The plan's stated figures were 270 entries and nine workspace links. Both are corrected here from
 * measurement: there are **264** entries and **12** workspace links. The link count differs because
 * the plan counted the nine `packages/*` workspaces and forgot that `apps/server`, `apps/dashboard`,
 * and `packages/telemetry` are linked too — `node_modules/@bayz/*` has twelve entries.
 */
const ENTRY_COUNT = 264;
const WORKSPACE_LINK_COUNT = 12;
const WORKSPACE_DEFINITION_COUNT = 12;
const RESOLVED_COUNT = 239;

function realLock() {
  return parseLockfile(readFileSync(LOCK_PATH, "utf8"));
}

/** Write a mutated copy of the real lockfile and return its path. */
function mutatedLock(mutate) {
  const lock = JSON.parse(readFileSync(LOCK_PATH, "utf8"));
  mutate(lock);
  const dir = mkdtempSync(join(tmpdir(), "bayz-lock-mut-"));
  const path = join(dir, "package-lock.json");
  writeFileSync(path, JSON.stringify(lock, null, 2));
  return path;
}

/** The first non-link, resolved entry — the one a mutation can safely target. */
function firstResolvedKey(lock) {
  for (const [key, entry] of Object.entries(lock.packages)) {
    if (key === "" || entry.link === true) continue;
    if (typeof entry.resolved === "string") return key;
  }
  throw new Error("no resolved entry found in the lockfile");
}

test("the lockfile version is pinned at 3", () => {
  assert.equal(realLock().lockfileVersion, LOCKFILE_VERSION);
});

test("every resolved entry carries a sha512 integrity hash", () => {
  const verdict = checkLockfile(realLock(), { root: ROOT });
  assert.deepEqual(verdict.missingIntegrity, [], "some resolved entries have no integrity hash");
  assert.deepEqual(verdict.weakIntegrity, [], "some entries carry a non-sha512 integrity hash");
  assert.equal(verdict.resolvedCount, RESOLVED_COUNT, `resolved entry count changed to ${verdict.resolvedCount}`);
});

test("a sha1 integrity hash is refused", () => {
  /*
   * The mutation the plan explicitly asks for. `sha1` is collision-broken, so an entry that only
   * carries `sha1-` cannot be trusted to identify its tarball — and npm will happily accept one.
   */
  const lock = JSON.parse(readFileSync(mutatedLock((l) => {
    const key = firstResolvedKey(l);
    l.packages[key].integrity = "sha1-4rNhLpuY1EOtF3Vk0h9OZQBc8ZE=";
  }), "utf8"));

  const verdict = checkLockfile(parseLockfile(JSON.stringify(lock)), { root: ROOT });
  assert.equal(verdict.weakIntegrity.length, 1, "a sha1 integrity hash was accepted");
  assert.equal(verdict.ok, false);
});

test("a missing integrity hash is refused", () => {
  const lock = mutatedLock((l) => {
    delete l.packages[firstResolvedKey(l)].integrity;
  });
  const verdict = checkLockfile(parseLockfile(readFileSync(lock, "utf8")), { root: ROOT });
  assert.equal(verdict.missingIntegrity.length, 1, "an entry with no integrity hash was accepted");
  assert.equal(verdict.ok, false);
});

test("a workspace definition entry is not mistaken for a package with a missing origin", () => {
  /*
   * npm records each workspace twice: once keyed by its repository path (`apps/server`) describing the
   * directory, and once as `node_modules/@bayz/server` with `link: true`. The path-keyed entry has a
   * version but no `resolved` and no `integrity`, which is correct — it is not a download.
   *
   * The first version of this check reported all twelve as violations. Pinned here so the exemption
   * cannot silently widen: the count is fixed, and the exemption only applies to keys outside
   * `node_modules/` whose directory actually exists.
   */
  const verdict = checkLockfile(realLock(), { root: ROOT });
  assert.equal(
    verdict.workspaceDefinitions.length,
    WORKSPACE_DEFINITION_COUNT,
    `workspace definitions changed to ${verdict.workspaceDefinitions.length}`,
  );
  for (const key of verdict.workspaceDefinitions) {
    assert.ok(!key.startsWith("node_modules/"), `${key} was exempted but lives under node_modules/`);
  }
});

test("a registry package with a version but no origin is still refused", () => {
  // The exemption above must not swallow this: a `node_modules/` entry with a version and no
  // `resolved` is a package npm cannot fetch reproducibly.
  const path = mutatedLock((l) => {
    delete l.packages[firstResolvedKey(l)].resolved;
  });
  const verdict = checkLockfile(parseLockfile(readFileSync(path, "utf8")), { root: ROOT });
  assert.ok(
    verdict.missingIntegrity.some((problem) => /no resolved origin/.test(problem)),
    `an origin-less registry entry was accepted: ${JSON.stringify(verdict.missingIntegrity)}`,
  );
  assert.equal(verdict.ok, false);
});

test("every resolved URL points at registry.npmjs.org", () => {
  const verdict = checkLockfile(realLock(), { root: ROOT });
  assert.deepEqual(verdict.foreignOrigins, [], "some entries resolve to a non-npm host");
});

test("a git, file, http, or foreign-host origin is refused", () => {
  /*
   * Four separate substitution shapes, because they are four separate supply-chain attacks: a `git+`
   * URL installs whatever the branch says today, a `file:` outside the workspace installs whatever is
   * on the build machine, `http:` is trivially interceptable, and a look-alike host is the classic
   * typosquat delivery route.
   */
  const origins = [
    "git+ssh://git@github.com/evil/pkg.git#abc1234",
    "file:../../../../etc/passwd",
    "http://registry.npmjs.org/fastify/-/fastify-5.12.1.tgz",
    "https://registry.npmjs.org.evil.example/fastify/-/fastify-5.12.1.tgz",
  ];
  for (const origin of origins) {
    const path = mutatedLock((l) => {
      l.packages[firstResolvedKey(l)].resolved = origin;
    });
    const verdict = checkLockfile(parseLockfile(readFileSync(path, "utf8")), { root: ROOT });
    assert.equal(verdict.foreignOrigins.length, 1, `origin was accepted: ${origin}`);
    assert.equal(verdict.ok, false, `origin did not fail the check: ${origin}`);
  }
});

test("workspace links are exempt from the resolved and integrity requirements", () => {
  /*
   * A `link: true` entry legitimately has neither — it is a symlink into this repository, not a
   * download. Exempting them is correct; exempting anything *else* would be a hole, so the count is
   * pinned and each link is checked to be a real directory below.
   */
  const verdict = checkLockfile(realLock(), { root: ROOT });
  assert.equal(verdict.workspaceLinks.length, WORKSPACE_LINK_COUNT, `workspace links changed to ${verdict.workspaceLinks.length}`);
  assert.deepEqual(verdict.brokenLinks, [], "some workspace links do not resolve to a real directory");
});

test("a workspace link pointing outside the repository is refused", () => {
  // A link is only safe because it stays in-tree. One pointing at an absolute path elsewhere is a
  // dependency on the build machine's filesystem.
  const path = mutatedLock((l) => {
    for (const [key, entry] of Object.entries(l.packages)) {
      if (entry.link === true) {
        l.packages[key].resolved = "/etc";
        break;
      }
    }
  });
  const verdict = checkLockfile(parseLockfile(readFileSync(path, "utf8")), { root: ROOT });
  assert.equal(verdict.brokenLinks.length, 1, "a link pointing outside the repository was accepted");
  assert.equal(verdict.ok, false);
});

test("every non-link dependency has an exact resolved version, so npm ci is deterministic", () => {
  /*
   * The structural form of `npm ci` determinism: if no entry carries a range, no range can be resolved
   * at install time, so two installs of the same lockfile cannot differ.
   */
  const verdict = checkLockfile(realLock(), { root: ROOT });
  assert.deepEqual(verdict.inexactVersions, [], "some entries do not pin an exact version");
});

test("a range in place of an exact version is refused", () => {
  const path = mutatedLock((l) => {
    l.packages[firstResolvedKey(l)].version = "^5.0.0";
  });
  const verdict = checkLockfile(parseLockfile(readFileSync(path, "utf8")), { root: ROOT });
  assert.equal(verdict.inexactVersions.length, 1, "a version range was accepted");
  assert.equal(verdict.ok, false);
});

test("the total entry count is pinned so an unexplained addition shows in the diff", () => {
  const verdict = checkLockfile(realLock(), { root: ROOT });
  assert.equal(
    verdict.entryCount,
    ENTRY_COUNT,
    `the lockfile grew or shrank from ${ENTRY_COUNT} to ${verdict.entryCount}. Read the diff, confirm the change was intended, then update this constant deliberately.`,
  );
});

test("a lockfile with no packages map is refused rather than read as clean", () => {
  // Fail closed. An empty parse must never look like a clean lockfile.
  assert.throws(() => parseLockfile('{"lockfileVersion":3}'), /packages/i);
  assert.throws(() => parseLockfile("not json"), /parse|json/i);
});

test("a lockfileVersion other than 3 is refused", () => {
  const path = mutatedLock((l) => {
    l.lockfileVersion = 2;
  });
  const verdict = checkLockfile(parseLockfile(readFileSync(path, "utf8")), { root: ROOT });
  assert.equal(verdict.ok, false, "a lockfileVersion of 2 was accepted");
  assert.ok(
    verdict.problems.some((problem) => /lockfileVersion/.test(problem)),
    `the version problem was not reported: ${JSON.stringify(verdict.problems)}`,
  );
});

test("the check runs as a script and exits 0 on the real lockfile", () => {
  const stdout = execFileSync(process.execPath, [CHECK], { encoding: "utf8" });
  assert.match(stdout, /lockfile integrity: PASS/, `the check did not pass: ${stdout}`);
  assert.match(stdout, new RegExp(`${RESOLVED_COUNT} resolved`), "the check did not state the resolved count");
});

test("the check exits non-zero when pointed at a mutated lockfile", () => {
  /*
   * The script-level proof that the gate can fail. Running the real binary, not just the exported
   * function, because an `--enforce` path that never actually exits non-zero is a common and invisible
   * defect.
   */
  const path = mutatedLock((l) => {
    l.packages[firstResolvedKey(l)].integrity = "sha1-4rNhLpuY1EOtF3Vk0h9OZQBc8ZE=";
  });
  let status = 0;
  let output = "";
  try {
    output = execFileSync(process.execPath, [CHECK, "--lockfile", path], { encoding: "utf8" });
  } catch (error) {
    status = error.status ?? 1;
    output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
  }
  assert.equal(status, 1, `the check passed a mutated lockfile: ${output}`);
  assert.match(output, /lockfile integrity: FAIL/, output);
  assert.ok(existsSync(path), "the mutated fixture vanished");
});
