/**
 * The evidence vocabulary — Phase 9L Task 1.
 *
 * One definition of "what a citation is" and "what it takes for a citation to resolve", replacing
 * four inline copies of the same regex (9H Task 1, 9I Task 7, 9J Task 1, 9K Task 8). Each of those
 * subprograms was specified to stand alone, so each carried its own copy — and they had already
 * drifted before this file existed: 9H's rejected a contiguous range (`smoke:chaos#31-44`) that 9I's
 * report legitimately uses, and only 9K's accepted `test:<path>::<name>`. Four copies of one rule
 * will drift, and the copy that drifts will be the one guarding the claim that matters.
 *
 * ## The grammar
 *
 *   smoke:<script>#<n>        a numbered check in a smoke script
 *   smoke:<script>#<n>-<m>    a contiguous range of numbered checks
 *   test:<path>               an automated test file
 *   test:<path>::<name>       one named test inside that file
 *   transcript:<path>         a recorded run
 *
 * The **range** form is in the union deliberately, beyond the plan's four shapes: a chaos scenario
 * really does span numbered checks, `docs/superpowers/2026-08-27-bayz-resilience-report.md` already
 * cites eight of them, and the alternative was either a comma list or a fourth divergent regex. A
 * comma list stays rejected, and that is not an oversight — `smoke:load#4,9,14,19,24` makes a
 * citation unfalsifiable, because no single check can be looked up to confirm or refute it.
 *
 * ## What resolution actually proves, and what it does not
 *
 * `resolveEvidence` is a *file-system* check, not a run. It proves the cited thing exists, is
 * non-empty, and — for a test file — contains real assertions. It cannot prove the test passes; only
 * running it does that, which is what the gates are for. Two bounds are worth naming because a
 * reader will otherwise over-read a green result:
 *
 *   - **`bound: "manifest"`.** The smoke script publishes `docs/evidence/<script>.json` on a fully
 *     passing run, so the cited check number is checked against the number of checks that really
 *     ran, and a per-capability citation is checked against the check that really covers it.
 *   - **`bound: "numbering-only"`.** The script emits numbered checks but publishes no manifest, so
 *     the number's *upper* bound is unverified — `#9999` in such a script resolves. This is reported
 *     rather than hidden, so a caller that needs the stronger form can demand `bound === "manifest"`
 *     instead of discovering the weakness later.
 *
 * A script that emits **no** numbered output at all is refused outright: `#n` cannot mean anything
 * there, and accepting it would be accepting a number nobody could ever look up.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The citation kinds, in the order the plan lists them. */
export const EVIDENCE_KINDS = Object.freeze(["smoke", "test", "transcript"]);

/**
 * The single evidence grammar.
 *
 * Exported because three existing tests assert *shape* against a regex directly and rewriting all of
 * them to call `parseEvidence` would be a larger change than this task's consolidation warrants. New
 * code should prefer `parseEvidence`, which additionally rejects a traversal path that this pattern
 * would accept — `[\w./-]+` matches `..`, so the regex alone is not a safety boundary.
 */
export const EVIDENCE_RE = /^(?:smoke:[a-z][a-z0-9-]*#\d+(?:-\d+)?|test:[\w./-]+(?:::[^|]+)?|transcript:[\w./-]+)$/;

/** Minimum `assert` occurrences before a test file counts as having real assertions. */
const MIN_ASSERTIONS = 1;

/**
 * Parse a citation into its parts, or `undefined` if it is not a citation at all.
 *
 * Deliberately total: every rejection returns `undefined` rather than throwing, because callers scan
 * documents where a malformed cell is a finding to report with its location, not an exception to
 * unwind through.
 */
export function parseEvidence(ref) {
  if (typeof ref !== "string") return undefined;
  const trimmed = ref.trim();
  if (trimmed !== ref || trimmed.length === 0) return undefined;
  if (!EVIDENCE_RE.test(trimmed)) return undefined;

  const separator = trimmed.indexOf(":");
  const kind = trimmed.slice(0, separator);
  const rest = trimmed.slice(separator + 1);

  if (kind === "smoke") {
    const [script, numbers] = rest.split("#");
    const [from, to] = numbers.split("-").map(Number);
    // A range must ascend. `#44-31` parses under the regex and means nothing, and a zero-length or
    // descending range is the shape a hand-edited number takes.
    if (from < 1) return undefined;
    if (to !== undefined && to <= from) return undefined;
    return { kind, target: script, number: from, ...(to === undefined ? {} : { last: to }) };
  }

  const [path, testName] = rest.split("::");
  if (!isSafeRepoPath(path)) return undefined;
  if (testName !== undefined && testName.trim().length === 0) return undefined;
  return { kind, target: path, ...(testName === undefined ? {} : { testName }) };
}

/**
 * Whether a cited path stays inside the repository.
 *
 * `..` is rejected before resolution *and* the resolved path is checked with `relative()` rather than
 * a string prefix test — a prefix test says `<root>-sibling` is inside `<root>`, which it is not.
 */
export function isSafeRepoPath(path) {
  if (typeof path !== "string" || path.length === 0) return false;
  if (isAbsolute(path)) return false;
  if (path.split(/[/\\]/).includes("..")) return false;
  const rel = relative(ROOT, resolve(ROOT, path));
  return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * The conventional locations for a smoke script named `<name>`.
 *
 * `-run.mjs` is in the list because of a live miss this consolidation found: the resilience report
 * cites `smoke:fuzz#1-3` fifteen times and the script is `scripts/fuzz-run.mjs`. Every previous copy
 * of this rule was a regex that never opened the file, so fifteen citations pointing at a script name
 * that resolved to nothing had been sitting in a shipped document unnoticed.
 */
function smokeScriptCandidates(name) {
  return [
    join(ROOT, "scripts", `${name}.mjs`),
    join(ROOT, "scripts", `${name}-smoke.mjs`),
    join(ROOT, "scripts", `${name}-run.mjs`),
  ];
}

/**
 * Every script file a smoke entry point could print numbered checks from.
 *
 * The entry point plus its same-directory relative imports, one level deep. `chaos-smoke.mjs` is
 * thirty lines of orchestration and prints nothing itself: its numbering lives in `chaos-lib.mjs`.
 * Looking only at the entry point would refuse every citation into the chaos suite, which is the
 * opposite of the intended answer.
 */
function scriptClosure(entry) {
  const files = [entry];
  let source = "";
  try {
    source = readFileSync(entry, "utf8");
  } catch {
    return files;
  }
  for (const match of source.matchAll(/from\s+"\.\/([\w.-]+\.mjs)"|import\("\.\/([\w.-]+\.mjs)"\)/g)) {
    const name = match[1] ?? match[2];
    const path = join(dirname(entry), name);
    if (existsSync(path) && !files.includes(path)) files.push(path);
  }
  return files;
}

/**
 * Whether a smoke script emits *numbered* checks.
 *
 * Structural: the closure must both maintain a check counter and print it. Matching only the printed
 * template would accept a script that prints a literal number, and matching only the counter would
 * accept one that counts without ever showing the number — either way the cited `#n` would be
 * unlookupable in the output a reader actually sees.
 */
function emitsNumberedChecks(entry) {
  return scriptClosure(entry).some((path) => {
    let source = "";
    try {
      source = readFileSync(path, "utf8");
    } catch {
      return false;
    }
    return /checkNumber\s*(?:\+=|\+\+|=\s*0)/.test(source) && /\$\{String\(checkNumber\)|\$\{checkNumber\}/.test(source);
  });
}

/** Read a smoke script's published evidence manifest, or `undefined`. */
export function readManifest(script) {
  const path = join(ROOT, "docs/evidence", `${script}.json`);
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function fail(reason) {
  return { ok: false, reason };
}

/**
 * Resolve a citation against the repository.
 *
 * Returns `{ ok, reason }`, plus `bound` for a `smoke:` citation and `assertions` for a `test:` one,
 * so a caller can demand a stronger guarantee than "it resolved".
 *
 * `async` because the plan's interface says so and because a future transcript check may want to
 * stream a large file; nothing here awaits today, and pretending otherwise with a fake `await` would
 * be worse than an async function that happens to be synchronous.
 *
 * @param {string} ref
 * @param {{ capability?: string }} [options] capability name, checked against the manifest when the
 *   citation is `smoke:` and the script publishes one — this is what caught
 *   `smoke:client-conformance#99` sitting in a cell that harness never exercises.
 */
export async function resolveEvidence(ref, options = {}) {
  const parsed = parseEvidence(ref);
  if (parsed === undefined) return fail(`${JSON.stringify(ref)} is not a valid evidence reference`);

  if (parsed.kind === "smoke") return resolveSmoke(parsed, options);

  const absolute = join(ROOT, parsed.target);
  if (!existsSync(absolute)) return fail(`${parsed.target} does not exist`);
  let stats;
  try {
    stats = statSync(absolute);
  } catch {
    return fail(`${parsed.target} cannot be read`);
  }
  if (stats.isDirectory()) return fail(`${parsed.target} is a directory, not a file`);
  if (stats.size === 0) return fail(`${parsed.target} is empty`);

  const source = readFileSync(absolute, "utf8");
  if (source.trim().length === 0) return fail(`${parsed.target} is blank`);

  if (parsed.kind === "transcript") return { ok: true, reason: "transcript exists and is non-empty" };

  /*
   * A test file with no assertions is the cheapest way to launder a `PASS`: the path resolves, the
   * file is non-empty, and it proves nothing. Counting `assert` covers `node:assert`, `expect`-free
   * Vitest usage, and `t.assert.*`; a suite using only `expect()` would be missed, and there is none
   * in this repository — asserted by the test, so the day one appears the gap is a failure rather
   * than a silent acceptance.
   */
  const assertions = (source.match(/\bassert\b|\bexpect\(/g) ?? []).length;
  if (assertions < MIN_ASSERTIONS) return fail(`${parsed.target} contains no assertions`);

  if (parsed.testName !== undefined && !source.includes(parsed.testName)) {
    return fail(`${parsed.target} contains no test named ${JSON.stringify(parsed.testName)}`);
  }

  return { ok: true, reason: `${assertions} assertion(s)`, assertions };
}

function resolveSmoke(parsed, options) {
  const script = smokeScriptCandidates(parsed.target).find((path) => existsSync(path));
  if (script === undefined) {
    return fail(`no script matches scripts/${parsed.target}.mjs or scripts/${parsed.target}-smoke.mjs`);
  }
  if (!emitsNumberedChecks(script)) {
    return fail(`${parsed.target} emits no numbered checks, so #${parsed.number} cannot be cited`);
  }

  const manifest = readManifest(parsed.target);
  if (manifest === undefined) {
    return {
      ok: true,
      bound: "numbering-only",
      reason: `${parsed.target} emits numbered checks but publishes no manifest, so the upper bound is unverified`,
    };
  }

  const total = Number(manifest.totalChecks);
  if (!Number.isInteger(total) || total < 1) {
    return fail(`docs/evidence/${parsed.target}.json states no usable totalChecks`);
  }
  const highest = parsed.last ?? parsed.number;
  if (highest > total) {
    return fail(`cites check #${highest} but ${parsed.target} ran ${total} checks`);
  }

  if (options.capability !== undefined) {
    const expected = manifest.capabilities?.[options.capability];
    if (expected === undefined) {
      return fail(`${parsed.target} publishes no check for capability ${JSON.stringify(options.capability)}`);
    }
    if (Number(expected) !== parsed.number) {
      return fail(`cites check #${parsed.number} but ${parsed.target} reports #${expected} for ${options.capability}`);
    }
  }

  return { ok: true, bound: "manifest", reason: `check #${highest} of ${total}` };
}
