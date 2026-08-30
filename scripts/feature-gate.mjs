#!/usr/bin/env node
/**
 * Feature completeness gate — Phase 9L Task 2.
 *
 * Reads `docs/superpowers/2026-08-27-bayz-feature-completeness-gate.md` and decides whether the
 * release is feature-complete. The document is the record; this file is the policy, and the policy
 * does not trust the record any further than it can check it.
 *
 * **Built here rather than in Task 3, which is where the plan lists it.** Task 3 composes "the
 * feature gate from Task 2", and a gate with no parser is not composable — Task 2's integrity test
 * needs exactly the same parse, so the alternative was two parsers for one document. Same shape as
 * `supply-chain-gate.mjs`: `--report` prints, `--enforce` decides, neither guesses.
 *
 * ## The rules that carry weight
 *
 * Four of them, and they exist because §16 names four specific ways a feature gets called done
 * without being done:
 *
 *   1. **Backend `PASS` with UI reachability `FAIL`/`UNVERIFIED` cannot be overall `PASS`.** "The
 *      backend exists but no UI can reach it" is the first thing §16 lists as insufficient.
 *   2. **A `PASS` must cite `smoke:` or `transcript:` when its owning subprogram has a smoke
 *      script.** A unit test mocking the boundary that matters is the third thing §16 lists, and the
 *      distinction is only enforceable by demanding the citation form that implies a real run.
 *   3. **No two features may share an evidence reference.** One transcript proving one thing cannot
 *      prove two, and a shared citation is how a row gets credit for work done elsewhere.
 *   4. **A missing or extra row is a violation.** Every per-row rule passes by having nothing to
 *      check, so the row set is pinned: 29 features from §17 plus the §25.5 amendment, no fewer so a
 *      feature cannot be dropped, no more so a row cannot be invented to pad the table.
 *
 * `UNVERIFIED` is never collapsed into `PASS`, and unlike the supply-chain gate there is **no
 * advisory exemption list**: this is the final gate, and an exempt row here would be a feature
 * shipped on a promise. A row that cannot be proven blocks, and the honest response is to fix the
 * feature or accept that the release is not GOAT-complete.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseEvidence, resolveEvidence } from "./evidence.mjs";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const GATE_PATH = join(ROOT, "docs/superpowers/2026-08-27-bayz-feature-completeness-gate.md");

/** The four verdicts. Anything else is a malformed document, not a new status. */
export const STATUSES = new Set(["PASS", "FAIL", "UNVERIFIED", "N/A"]);

/**
 * The §17 inventory, in order, with the §25.5 amendment's two additions.
 *
 * Twenty-nine rows. The count is pinned in the spec and re-pinned here because "how many features
 * does BAYZ have" is the question a dropped row quietly changes the answer to.
 */
export const FEATURES = Object.freeze([
  "Foundation",
  "Secure storage",
  "Provider manager",
  "Custom providers",
  "Model discovery",
  "Proxy manager",
  "HTTP CONNECT",
  "SOCKS5",
  "Multi-provider proxy",
  "Easy proxy UX",
  "Routing",
  "Combo",
  "Failover",
  "OpenAI-compatible API",
  "Authentication",
  "Streaming",
  "Tool / function calling",
  "Usage telemetry",
  "Flux Core live data",
  "Provider constellation",
  "Client integrations",
  "Per-client security",
  "Fortress security",
  "Restart / persistence",
  "Packaging",
  "Upgrade",
  "Cross-platform qualification",
  "Free-first model discovery",
  "Free-only routing",
]);

/**
 * Which subprograms ship a smoke script, and therefore which features may not reach `PASS` on a
 * unit-test citation alone.
 *
 * Measured from `scripts/*-smoke.mjs` rather than listed by hand, so a subprogram that gains a smoke
 * script starts constraining its features immediately instead of when someone remembers.
 */
export const SMOKE_BACKED_SUBPROGRAMS = Object.freeze({
  "Phase 1": "api",
  "Phase 2": "storage",
  "Phase 3": "provider",
  "Phase 4": "proxy",
  "Phase 5": "router",
  "Phase 6": "api",
  "Phase 7": "dashboard",
  "Phase 8": "usage",
  "9B": "stream",
  "9C": "identity",
  "9D": "custom-provider",
  "9E": "proxy-ux",
  "9F": "security",
  "9G": "injection",
  "9H": "client-conformance",
  "9I": "chaos",
  "9J": "install",
});

/** Citation kinds that imply something actually ran. */
const REAL_RUN_KINDS = new Set(["smoke", "transcript"]);

/** Split a markdown table row into trimmed cells, dropping the outer pipes. */
function cellsOf(line) {
  const trimmed = line.trim();
  return trimmed
    .slice(1, trimmed.endsWith("|") ? -1 : undefined)
    .split("|")
    .map((cell) => cell.trim());
}

function isSeparator(line) {
  return /^\|[\s:|-]+\|$/.test(line.trim());
}

/**
 * Parse the gate document into rows.
 *
 * Strict about shape: a line that looks like a row but does not parse is recorded as `malformed`
 * rather than skipped, because a gate that silently ignores what it cannot read is a gate that
 * passes an empty file.
 */
export function readGate(path = GATE_PATH) {
  if (!existsSync(path)) {
    return { rows: [], malformed: [], device: undefined, missing: true, path };
  }

  const text = readFileSync(path, "utf8");
  const rows = [];
  const malformed = [];
  let inTable = false;

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|")) {
      inTable = false;
      continue;
    }
    if (isSeparator(trimmed)) continue;

    const cells = cellsOf(trimmed);
    if (cells[0] === "feature") {
      inTable = true;
      continue;
    }
    if (!inTable) continue;

    if (cells.length !== 6) {
      malformed.push(`${cells[0] ?? trimmed}: expected 6 cells, found ${cells.length}`);
      continue;
    }
    const [feature, subprogram, backend, ui, evidence, overall] = cells;
    rows.push({ feature, subprogram, backend, ui, evidence, overall });
  }

  const device = /^- Device: (.+)$/m.exec(text)?.[1];
  return { rows, malformed, device, missing: false, path, text };
}

/**
 * The reason a non-`PASS` verdict gives, read from the document's per-row notes section.
 *
 * Notes live below the table under `#### <feature>` headings rather than in a seventh column, and
 * that is a readability decision with a real consequence: a reason long enough to be useful makes a
 * table cell unreadable, and an unreadable table is one nobody checks.
 */
export function readNotes(text) {
  const notes = new Map();
  let current;
  for (const line of text.split("\n")) {
    const heading = /^####\s+(.+?)\s*$/.exec(line);
    if (heading !== null) {
      current = heading[1];
      notes.set(current, []);
      continue;
    }
    if (current !== undefined) notes.get(current).push(line);
  }
  return new Map([...notes].map(([name, body]) => [name, body.join("\n").trim()]));
}

/**
 * Apply the policy.
 *
 * `blocking` is what makes `--enforce` non-zero. `violations` are integrity problems with the
 * document itself — a shape the gate cannot vouch for — and they block too, because a gate that
 * cannot read its input has not passed it.
 *
 * @param {ReturnType<typeof readGate>} parsed
 * @param {Map<string, string>} notes
 * @param {Map<string, {ok: boolean, reason: string, kind?: string}>} resolved citation → outcome
 */
export function assess(parsed, notes = new Map(), resolved = new Map()) {
  const blocking = [];
  const violations = [];

  if (parsed.missing) {
    violations.push(`the feature completeness gate is missing at ${parsed.path}`);
    return { blocking, violations, tally: { PASS: 0, FAIL: 0, UNVERIFIED: 0, "N/A": 0 } };
  }
  for (const entry of parsed.malformed) violations.push(`malformed row — ${entry}`);

  const seen = new Map();
  for (const row of parsed.rows) {
    if (!FEATURES.includes(row.feature)) violations.push(`'${row.feature}' is not a §17 feature`);
    seen.set(row.feature, (seen.get(row.feature) ?? 0) + 1);
  }
  for (const feature of FEATURES) {
    const count = seen.get(feature) ?? 0;
    if (count === 0) violations.push(`there is no '${feature}' row, which is mandatory`);
    if (count > 1) violations.push(`'${feature}' appears ${count} times`);
  }

  const evidenceOwners = new Map();
  const tally = { PASS: 0, FAIL: 0, UNVERIFIED: 0, "N/A": 0 };

  for (const row of parsed.rows) {
    for (const [column, status] of [["backend", row.backend], ["UI reachability", row.ui], ["overall", row.overall]]) {
      if (!STATUSES.has(status)) violations.push(`${row.feature}/${column}: ${JSON.stringify(status)} is not a status`);
    }
    if (tally[row.overall] !== undefined) tally[row.overall] += 1;

    /*
     * §16's first insufficiency, mechanised. A backend that works and a UI that cannot reach it is
     * the most common way a feature gets called done, because both halves look green in isolation.
     */
    if (row.overall === "PASS" && row.backend === "PASS" && (row.ui === "FAIL" || row.ui === "UNVERIFIED")) {
      blocking.push(`${row.feature}: overall PASS with UI reachability ${row.ui} — a backend no UI can reach is not a feature`);
    }
    if (row.overall === "PASS" && row.backend !== "PASS") {
      blocking.push(`${row.feature}: overall PASS with backend ${row.backend}`);
    }

    if (row.overall === "FAIL") blocking.push(`${row.feature}: FAIL`);
    if (row.overall === "UNVERIFIED") blocking.push(`${row.feature}: UNVERIFIED`);

    // Every non-PASS verdict must say what was not done. A bare one is indistinguishable from
    // having forgotten — the same reasoning the audit policy applies to an expired deferral.
    for (const [column, status] of [["backend", row.backend], ["UI reachability", row.ui], ["overall", row.overall]]) {
      if (status === "PASS") continue;
      const note = notes.get(row.feature) ?? "";
      if (note.trim().length < 40) {
        violations.push(`${row.feature}: ${column} is ${status} with no substantive documented reason`);
        break;
      }
    }

    if (row.overall !== "PASS") continue;

    const parsedRef = parseEvidence(row.evidence);
    if (parsedRef === undefined) {
      violations.push(`${row.feature}: PASS without a valid evidence reference (${JSON.stringify(row.evidence)})`);
      continue;
    }

    const outcome = resolved.get(row.evidence);
    if (outcome !== undefined && !outcome.ok) {
      blocking.push(`${row.feature}: evidence ${row.evidence} does not resolve — ${outcome.reason}`);
    }

    /*
     * §16's third insufficiency. A `test:` citation is a unit test, and for a feature whose owning
     * subprogram ships a smoke script that is exactly the "mocks the boundary that matters" case.
     * The subprogram column can name two (`Phase 2 / 9F`), so any of them having a script is enough.
     */
    const subprograms = row.subprogram.split("/").map((entry) => entry.trim());
    const smokeScript = subprograms.map((entry) => SMOKE_BACKED_SUBPROGRAMS[entry]).find((entry) => entry !== undefined);
    if (smokeScript !== undefined && !REAL_RUN_KINDS.has(parsedRef.kind)) {
      blocking.push(
        `${row.feature}: PASS citing ${row.evidence}, but ${row.subprogram} ships scripts/${smokeScript}*.mjs — a unit test cannot carry this row`,
      );
    }

    // One transcript proving one thing cannot prove two.
    const owner = evidenceOwners.get(row.evidence);
    if (owner !== undefined) {
      violations.push(`${row.feature} and ${owner} both cite ${row.evidence} — one piece of evidence cannot prove two features`);
    } else {
      evidenceOwners.set(row.evidence, row.feature);
    }
  }

  return { blocking, violations, tally };
}

/** Resolve every `PASS` row's citation, so `assess` can be synchronous and testable. */
export async function resolveAll(parsed) {
  const resolved = new Map();
  for (const row of parsed.rows) {
    if (row.overall !== "PASS" || resolved.has(row.evidence)) continue;
    resolved.set(row.evidence, await resolveEvidence(row.evidence));
  }
  return resolved;
}

function formatReport(parsed, notes, verdict) {
  const lines = [
    "BAYZ feature completeness gate — Phase 9L",
    `  document: ${parsed.path.replace(`${ROOT}/`, "")}`,
    `  device:   ${parsed.device ?? "(not stated)"}`,
    `  features: ${parsed.rows.length} of ${FEATURES.length} — ` +
      `${verdict.tally.PASS} PASS, ${verdict.tally.FAIL} FAIL, ${verdict.tally.UNVERIFIED} UNVERIFIED, ${verdict.tally["N/A"]} N/A`,
    "",
    "rows:",
  ];
  for (const row of parsed.rows) {
    lines.push(
      `  ${row.overall.padEnd(11)} ${row.feature.padEnd(30)} backend=${row.backend.padEnd(11)} ui=${row.ui.padEnd(11)} ${row.evidence}`,
    );
  }

  const unverified = parsed.rows.filter((row) => row.overall === "UNVERIFIED" || row.overall === "FAIL");
  if (unverified.length > 0) {
    lines.push("", "not verified — this list is the honest release-notes content:");
    for (const row of unverified) {
      const note = (notes.get(row.feature) ?? "(no reason documented)").split("\n")[0];
      lines.push(`  - ${row.feature}: ${row.overall} — ${note}`);
    }
  }

  if (verdict.violations.length > 0) {
    lines.push("", "integrity violations:");
    for (const entry of verdict.violations) lines.push(`  - ${entry}`);
  }
  if (verdict.blocking.length > 0) {
    lines.push("", "blocking:");
    for (const entry of verdict.blocking) lines.push(`  - ${entry}`);
  }

  lines.push(
    "",
    "  UNVERIFIED is never collapsed into PASS, and this gate has no advisory exemption:",
    "  it is the final gate, so a row that cannot be proven blocks the release.",
  );
  return lines.join("\n");
}

function usage() {
  process.stderr.write(
    "usage: node scripts/feature-gate.mjs (--report | --enforce)\n" +
      "  --report   print every row and exit 0\n" +
      "  --enforce  exit non-zero on any FAIL, UNVERIFIED, unevidenced PASS, or integrity violation\n",
  );
  process.exit(2);
}

async function main(argv) {
  const report = argv.includes("--report");
  const enforce = argv.includes("--enforce");
  const known = new Set(["--report", "--enforce"]);
  if (argv.some((entry) => !known.has(entry))) usage();
  // "Report and enforce" has two plausible meanings — print then fail, or print instead of failing —
  // and guessing one would let a release script believe it enforced when it only reported.
  if (report === enforce) usage();

  const parsed = readGate();
  const notes = parsed.missing ? new Map() : readNotes(parsed.text);
  const resolved = await resolveAll(parsed);
  const verdict = assess(parsed, notes, resolved);

  process.stdout.write(`${formatReport(parsed, notes, verdict)}\n\n`);

  if (report) {
    process.stdout.write("feature gate: REPORT (use --enforce to gate a release)\n");
    return 0;
  }

  const problems = [...verdict.violations, ...verdict.blocking];
  if (problems.length > 0) {
    process.stdout.write(`feature gate: FAIL — ${problems.length} blocking item(s)\n`);
    return 1;
  }
  process.stdout.write("feature gate: PASS\n");
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(await main(process.argv.slice(2)));
}
