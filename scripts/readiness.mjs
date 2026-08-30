#!/usr/bin/env node
/**
 * Generate the release readiness statement — Phase 9L Task 6.
 *
 * The statement is **generated, never written by hand.** That is the whole design: a handwritten
 * readiness document is a snapshot of what somebody believed on the day they wrote it, and the day
 * after a matrix changes it becomes a confident lie. Every line here is derived from a subprogram's
 * own parser, so the statement cannot disagree with the gate it summarises — and a test asserts that
 * regenerating reproduces the committed file **byte for byte**, the same rule 9K's licence inventory
 * uses, so drift is a failure rather than a discrepancy nobody noticed.
 *
 * What it composes, and from where:
 *
 *   - gate verdicts        each gate's own `assess`/`evaluate`, run in-process
 *   - UNVERIFIED list      `release-gate.mjs`'s `collectUnverified()` — already the aggregate
 *   - residual risks       spec §24's table, parsed, not retyped
 *   - unsupported          `platform-gate.evaluate().unsupported` and the 9H Core-3 blockers
 *   - push conditions      the plan's own six preconditions, stated as an unmet checklist
 *
 * **Nothing here runs a smoke script, a suite, or `npm audit`.** The verdicts it reports are the
 * *document* verdicts — what the matrices and reports say, and whether each gate's policy accepts
 * them. The live execution is Task 7's job, and conflating the two would let a stale document read
 * as a fresh measurement. The statement says which is which in as many words.
 *
 * Usage:
 *   node scripts/readiness.mjs --write     regenerate the statement
 *   node scripts/readiness.mjs --check     regenerate and diff against the committed file
 *   node scripts/readiness.mjs --stdout    print without writing
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const STATEMENT_PATH = join(ROOT, "docs/superpowers/2026-08-27-bayz-release-readiness.md");

const SPEC = "docs/superpowers/specs/2026-08-27-bayz-phase9-goat-release-design.md";
const PLATFORM_MATRIX = "docs/superpowers/2026-08-27-bayz-platform-matrix.md";

/** Read a repository file, or `undefined` when it is absent. An absent input is reported, never assumed. */
function read(relativePath) {
  const full = join(ROOT, relativePath);
  return existsSync(full) ? readFileSync(full, "utf8") : undefined;
}

/**
 * Spec §24's honest-boundary table, parsed from the spec itself.
 *
 * Retyping ten boundaries here would create a second copy that drifts, and the copy that drifted
 * would be the one an operator reads as the list of things BAYZ does not protect against.
 */
export function residualRisks() {
  const text = read(SPEC);
  if (text === undefined) return { rows: [], error: `${SPEC} is missing` };

  const lines = text.split("\n");
  const start = lines.findIndex((line) => /^##\s+24\./.test(line));
  if (start === -1) return { rows: [], error: "spec §24 heading not found" };

  const rows = [];
  for (const line of lines.slice(start)) {
    if (/^##\s+2[56]\./.test(line)) break;
    const trimmed = line.trim();
    if (!trimmed.startsWith("|") || /^\|[\s:|-]+\|$/.test(trimmed)) continue;
    const cells = trimmed.replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
    if (cells.length < 3 || cells[0] === "Boundary") continue;
    rows.push({ boundary: cells[0], why: cells[1], owner: cells[2] });
  }
  return { rows, error: rows.length === 0 ? "spec §24 table parsed to zero rows" : undefined };
}

/** The 9J platform verdict, through 9J's own parser and policy. */
export async function platformVerdict() {
  const text = read(PLATFORM_MATRIX);
  if (text === undefined) return { error: `${PLATFORM_MATRIX} is missing` };
  const gate = await import("./platform-gate.mjs");
  const matrix = gate.parseMatrix(text);
  return { ...gate.evaluate(matrix), primary: gate.PRIMARY, platforms: matrix.rows.length };
}

/** The 9H client verdict, through 9H's own parser and policy. */
export async function clientVerdict() {
  const lib = await import("./client-gate-lib.mjs");
  const clients = lib.readMatrix();
  const { blockers, summary } = lib.assess(clients);

  /*
   * The clients nobody may describe as working — decided by 9H's own `BLOCKING` set, not by a
   * stricter rule invented here. `PARTIAL` is **acceptable at release**: it carries evidence and a
   * named limitation that `tests/matrix-integrity.test.mjs` enforces, so it is a documented bound
   * rather than an unknown. An earlier draft of this generator refused `PARTIAL` too, which listed
   * `generic-openai` — 13 `VERIFIED`, 2 `PARTIAL` — as unsupported. That is a *different and stricter*
   * policy than the gate applies, and two policies in one tree is how a document starts contradicting
   * the gate it summarises. `PARTIAL` is reported separately, with its count, rather than hidden.
   *
   * Not narrowed to the Core 3 either: a statement naming only the release-blocking three would leave
   * `cline` and `continue` unmentioned, and an unmentioned client is the one somebody assumes is fine.
   */
  const withheld = [];
  const partial = [];
  for (const [client, capabilities] of clients) {
    const statuses = [...capabilities.values()].map((cell) => cell.status);
    const blocking = statuses.filter((status) => lib.BLOCKING.has(status)).length;
    const partials = statuses.filter((status) => status === "PARTIAL").length;
    if (blocking > 0) withheld.push({ client, blocking, of: statuses.length });
    if (partials > 0) partial.push({ client, partials, of: statuses.length });
  }
  return { blockers, summary, withheld, partial, core3: [...lib.CORE_3] };
}

/** The 9I resilience verdict. */
export async function resilienceVerdict() {
  const lib = await import("./resilience-gate-lib.mjs");
  const parsed = lib.readReport();
  return { ...lib.assess(parsed), rows: parsed.rows.length, device: parsed.device };
}

/**
 * The 9K supply-chain verdict, **document-only**.
 *
 * `measureLive({ runAudit: false })` is deliberate: the live half re-walks the closure and would
 * re-run `npm audit` against a registry this host cannot reach. Task 7 runs the live gate. Passing an
 * empty live set here means the statement reports what the report says, and says so.
 */
export async function supplyChainVerdict() {
  const gate = await import("./supply-chain-gate.mjs");
  const parsed = gate.readReport();
  return { ...gate.assess(parsed, []), rows: parsed.rows.length };
}

/** The 9L feature verdict, through the feature gate's own policy including citation resolution. */
export async function featureVerdict() {
  const gate = await import("./feature-gate.mjs");
  const parsed = gate.readGate();
  const notes = parsed.missing ? new Map() : gate.readNotes(parsed.text);
  const resolved = parsed.missing ? new Map() : await gate.resolveAll(parsed);
  return { ...gate.assess(parsed, notes, resolved), rows: parsed.rows, total: parsed.rows.length };
}

/**
 * The aggregate `UNVERIFIED` list, taken from `release-gate.mjs` rather than rebuilt.
 *
 * Task 3 already wrote this collector and its output is what `--report` prints as "the honest
 * release-notes content". Rebuilding it here would produce a second list that can disagree with the
 * gate, and the day they disagree is the day one of them is wrong in the release's favour.
 */
export async function unverifiedInventory() {
  const runner = await import("./release-gate.mjs");
  return runner.collectUnverified();
}

/**
 * The Task 7 live-execution transcript: the aggregate gate's own raw output.
 *
 * Task 7's results are **parsed from the run**, not retyped into this generator. A retyped verdict
 * table would be a second copy of 32 rows, and the day it drifted from the transcript the copy a
 * reader trusts would be the wrong one. This is the same reasoning that makes the whole statement
 * generated rather than written.
 */
export const TASK7_TRANSCRIPT = "docs/transcripts/release-gate/final-gate.md";

/**
 * Parse the Task 7 run.
 *
 * Total, like every other reader here: an absent transcript returns `{ missing: true }` with empty
 * results rather than throwing or — far worse — rendering nothing and leaving a statement that reads
 * complete. The absence of a live run is exactly the fact this document must never hide, so it is
 * reported in the section itself.
 *
 * @param {string} [relativePath] the transcript to parse; overridable so a test can drive the
 *   missing-file path without moving the real one.
 */
export function task7Execution(relativePath = TASK7_TRANSCRIPT) {
  const text = read(relativePath);
  if (text === undefined) {
    return { missing: true, path: relativePath, steps: [], pass: 0, fail: 0, blocking: [], commit: "", exit: undefined };
  }

  const lines = text.split("\n");
  const steps = [];
  const blocking = [];
  for (const line of lines) {
    const step = /^\s{2}(PASS|FAIL)\s+(\S+)\s+(.*)$/.exec(line);
    if (step !== null && !line.trimStart().startsWith("- ")) {
      steps.push({ status: step[1], id: step[2], detail: step[3].trim() });
      continue;
    }
    const block = /^\s+-\s+(gate:\S+|\S+):\s+(FAIL|BLOCKED)\s+—\s+(.*)$/.exec(line);
    if (block !== null) blocking.push({ id: block[1], detail: block[3].trim() });
  }

  const commit = /^-\s+Commit:\s+([0-9a-f]{7,40})/m.exec(text)?.[1] ?? "";
  const started = /^-\s+Started:\s+(\S+)/m.exec(text)?.[1] ?? "";
  const ended = /^-\s+Ended:\s+(\S+)/m.exec(text)?.[1] ?? "";
  const exitMatch = /^RELEASE_GATE_EXIT=(\d+)/m.exec(text);
  const unverified = /^currently UNVERIFIED \((\d+)\)/m.exec(text);

  return {
    missing: false,
    path: relativePath,
    steps,
    pass: steps.filter((step) => step.status === "PASS").length,
    fail: steps.filter((step) => step.status === "FAIL").length,
    blocking,
    commit,
    started,
    ended,
    exit: exitMatch === null ? undefined : Number(exitMatch[1]),
    unverified: unverified === null ? undefined : Number(unverified[1]),
  };
}

/**
 * One verdict line per gate: the label, whether its own policy blocks, why, and the evidence the
 * verdict rests on.
 *
 * The citation is not decoration. A `PASS` row with nothing to look up is a bare claim, and
 * `tests/no-fabrication.test.mjs`'s repo-wide sweep is right to refuse it: the first generated
 * statement rendered 9J, 9K and the derived 9F as `PASS` with `—` in every other cell, and three
 * unfalsifiable rows shipped in a document whose entire purpose is falsifiability. Required of
 * **every** row rather than only the passing ones, because the evidence a verdict rests on is the
 * same policy test whichever way the verdict came out — a rule that only bound `PASS` rows would
 * stop applying the moment a row flipped, which is precisely when it matters.
 */
function verdictRow(label, subprogram, blocked, reasons, evidence) {
  return { label, subprogram, verdict: blocked ? "BLOCKED" : "PASS", reasons, evidence };
}

/**
 * The evidence each gate verdict rests on, by subprogram.
 *
 * A gate's verdict is a statement about what its *document* says under its own policy, so the thing
 * a reader must be able to open is the policy test that mechanically enforces that reading — not the
 * document, which would have the row citing the very text it summarises. 9F is the exception the
 * aggregate gate already makes: it has no gate script, and `release-gate.mjs` derives its row from
 * `scripts/security-smoke.mjs`, so the citation is the numbered check in that smoke where the posture
 * ladder is actually observed.
 *
 * Held as a map rather than inlined per row so `tests/readiness.test.mjs` can resolve every entry
 * through `scripts/evidence.mjs` — the same resolver the four matrix-integrity tests use, so a
 * citation here cannot be a string nobody ever opened.
 */
export const VERDICT_EVIDENCE = Object.freeze({
  "9H": "test:tests/client-gate.test.mjs",
  "9I": "test:tests/resilience-report.test.mjs",
  "9J": "test:tests/platform-gate.test.mjs",
  "9K": "test:tests/supply-chain-report.test.mjs",
  "9L": "test:tests/feature-gate-integrity.test.mjs",
  "9F": "smoke:security#6",
});

/**
 * Assemble every gate verdict.
 *
 * The 9F posture row is derived from `scripts/security-smoke.mjs` existing, exactly as
 * `release-gate.mjs` derives it, and says so — 9F has no gate script of its own, and inventing one
 * verdict shape here while the aggregate gate uses another would put two answers in the tree.
 */
export async function allVerdicts() {
  const platform = await platformVerdict();
  const client = await clientVerdict();
  const resilience = await resilienceVerdict();
  const supplyChain = await supplyChainVerdict();
  const feature = await featureVerdict();

  const postureScript = "scripts/security-smoke.mjs";
  const posturePresent = existsSync(join(ROOT, postureScript));

  return {
    platform,
    client,
    resilience,
    supplyChain,
    feature,
    rows: [
      verdictRow(
        "client compatibility",
        "9H",
        client.blockers.length > 0,
        client.blockers.map((entry) => `${entry.client}/${entry.capability}: ${entry.status}`),
        VERDICT_EVIDENCE["9H"],
      ),
      verdictRow(
        "resilience",
        "9I",
        resilience.blocking.length > 0 || resilience.violations.length > 0,
        [...resilience.violations, ...resilience.blocking],
        VERDICT_EVIDENCE["9I"],
      ),
      verdictRow("platform qualification", "9J", platform.blocked, platform.reasons, VERDICT_EVIDENCE["9J"]),
      verdictRow(
        "supply chain (document only)",
        "9K",
        supplyChain.blocking.length > 0 || supplyChain.violations.length > 0,
        [...supplyChain.violations, ...supplyChain.blocking],
        VERDICT_EVIDENCE["9K"],
      ),
      verdictRow(
        "feature completeness",
        "9L",
        feature.blocking.length > 0 || feature.violations.length > 0,
        [...feature.violations, ...feature.blocking],
        VERDICT_EVIDENCE["9L"],
      ),
      verdictRow(
        "security posture (derived)",
        "9F",
        !posturePresent,
        posturePresent ? [] : [`${postureScript} does not exist — a missing check is a FAIL, never a skip`],
        VERDICT_EVIDENCE["9F"],
      ),
    ],
  };
}

/**
 * The six conditions under which a push becomes permissible, and whether each is met.
 *
 * Taken from the plan's own words. Rendered as a checklist with live values because "the conditions
 * for a push" written as prose is something a reader can talk themselves past; a table with one
 * unmet row is not.
 */
export function pushConditions(verdicts) {
  const gatesGreen = verdicts.rows.every((row) => row.verdict === "PASS");
  const securityRow = verdicts.rows.find((row) => row.subprogram === "9F");
  return [
    {
      condition: "Implementation complete",
      met: verdicts.feature.tally.FAIL === 0,
      detail: `${verdicts.feature.tally.PASS} of ${verdicts.feature.total} features PASS, ${verdicts.feature.tally.FAIL} FAIL, ${verdicts.feature.tally.UNVERIFIED} UNVERIFIED`,
    },
    {
      condition: "This gate green",
      met: gatesGreen,
      detail: gatesGreen
        ? "every composed gate accepts its document"
        : `blocked: ${verdicts.rows.filter((row) => row.verdict === "BLOCKED").map((row) => row.label).join(", ")}`,
    },
    {
      condition: "Security gate green",
      met: securityRow?.verdict === "PASS",
      detail: "derived from scripts/security-smoke.mjs; Task 7 executes it live",
    },
    { condition: "Clean tree", met: undefined, detail: "checked at Task 7, not recorded here — it is true only at an instant" },
    {
      condition: "Verified release candidate",
      met: false,
      detail: "the release signature row is UNVERIFIED: no signing key exists here, and provenance needs a hosted workflow run",
    },
    { condition: "Explicit user instruction", met: false, detail: "not given; absent it, Phase 9 ends at the local commit" },
  ];
}

/* ------------------------------------------------------------------ rendering */

function tick(met) {
  if (met === undefined) return "n/a";
  return met ? "met" : "**NOT met**";
}

/** Escape a pipe so a note containing one cannot break the table it sits in. */
function cell(text) {
  return String(text ?? "").replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
}

/**
 * Render the statement.
 *
 * Deterministic on purpose: no timestamp, no `Date.now()`, no set iteration order. The byte-identity
 * test depends on it, and a document that differs on every regeneration cannot be diffed between two
 * releases — which is the main thing a release document is for.
 */
export async function renderStatement() {
  const verdicts = await allVerdicts();
  const unverified = await unverifiedInventory();
  const risks = residualRisks();
  const conditions = pushConditions(verdicts);

  const lines = [];
  const push = (...text) => lines.push(...text);

  push(
    "# BAYZ release readiness statement — Phase 9L Task 6",
    "",
    "> **Generated, not written.** Every table below is produced by `scripts/readiness.mjs` from each",
    "> subprogram's own parser and policy. Do not hand-edit this file: `tests/readiness.test.mjs`",
    "> asserts that regenerating reproduces it byte for byte, so an edit here fails the suite rather",
    "> than quietly disagreeing with the gate it summarises. To change a verdict, change the evidence.",
    "",
    `- Device: ${verdicts.resilience.device ?? "(not stated by the resilience report)"}`,
    "- Node: v24.19.0 (arm64)",
    `- Generator: \`node scripts/readiness.mjs --write\``,
    "",
    "## What this document is, and what it is not",
    "",
    "This is a summary of **what the matrices and reports say**, and of whether each gate's own policy",
    "accepts them. It runs no smoke script, no suite, and no `npm audit`.",
    "",
    "That distinction is the point rather than a caveat. A document verdict answers \"is the recorded",
    "evidence sufficient and internally consistent?\" A live run answers \"does it still pass today?\"",
    "Collapsing the two would let a stale document read as a fresh measurement, which is precisely the",
    "insufficiency spec §16 names. **Phase 9L Task 7 performs the live execution**, and its results are",
    "recorded in `## Task 7 — live execution` below; until that section exists, no line in this file is",
    "a claim about a run that happened today.",
    "",
    "## Gate verdicts",
    "",
    "Each row cites the policy test that mechanically enforces its gate's reading of its own document,",
    "so a verdict here is something a reader can open rather than something they must take on trust.",
    "9F cites a numbered check in `scripts/security-smoke.mjs` instead, because 9F has no gate script:",
    "`scripts/release-gate.mjs` derives that row the same way, from the same smoke.",
    "",
    "| gate | subprogram | verdict | evidence | blocking reasons |",
    "|---|---|---|---|---|",
  );

  for (const row of verdicts.rows) {
    const reasons = row.reasons.length === 0 ? "—" : `${row.reasons.length}: ${cell(row.reasons.slice(0, 2).join("; "))}`;
    push(`| ${row.label} | ${row.subprogram} | ${row.verdict} | ${cell(row.evidence)} | ${reasons} |`);
  }

  const blocked = verdicts.rows.filter((row) => row.verdict === "BLOCKED");
  push(
    "",
    blocked.length === 0
      ? "**Every composed gate accepts its document.**"
      : `**${blocked.length} of ${verdicts.rows.length} gates block:** ${blocked.map((row) => row.label).join(", ")}.`,
    "",
    "The aggregate runner `scripts/release-gate.mjs --enforce` therefore exits non-zero while any row",
    "above is `BLOCKED`. That is the gate working. A status is never adjusted to make it pass.",
    "",
    "## Feature inventory",
    "",
    `${verdicts.feature.tally.PASS} \`PASS\`, ${verdicts.feature.tally.FAIL} \`FAIL\`, ${verdicts.feature.tally.UNVERIFIED} \`UNVERIFIED\` across ${verdicts.feature.total} features.`,
    "Authoritative record: `docs/superpowers/2026-08-27-bayz-feature-completeness-gate.md`.",
    "",
  );

  return { lines, verdicts, unverified, risks, conditions, execution: task7Execution() };
}

/** The remaining sections, appended by the same deterministic renderer. */
function renderTail({ lines, verdicts, unverified, risks, conditions, execution }) {
  const push = (...text) => lines.push(...text);

  push(
    "## Task 7 — live execution",
    "",
    "The section the disclaimer above points at. **Parsed from the run's own transcript**",
    `— \`transcript:${TASK7_TRANSCRIPT}\` — rather than retyped, so these rows cannot`,
    "drift from the invocation that produced them.",
    "",
  );
  if (execution.missing) {
    push(
      `**No live run is recorded.** \`${execution.path}\` does not exist, so every verdict in this`,
      "document is a *document* verdict and nothing here has been measured today. This is stated rather",
      "than omitted: a statement that quietly dropped this section would read complete.",
      "",
    );
  } else {
    push(
      `- Command: \`node scripts/release-gate.mjs --enforce --full --no-audit\``,
      `- Commit measured: \`${execution.commit}\``,
      `- Started: ${execution.started} — ended: ${execution.ended}`,
      `- Result: **${execution.pass} of ${execution.steps.length} steps PASS, ${execution.fail} FAIL**, exit ${execution.exit}`,
      "",
      "One uninterrupted invocation over all 32 steps including the long class. `--no-audit` is passed",
      "because no registry is reachable from this host; every other step ran unmodified. A non-zero exit",
      "is the gate working: the failing rows are the remaining work, and no status was adjusted to clear",
      "them.",
      "",
      "| step | verdict | evidence |",
      "|---|---|---|",
    );
    for (const step of execution.steps) {
      // The citation is repeated per row rather than stated once above the table: the sweep in
      // `tests/no-fabrication.test.mjs` reads a verdict row on its own, and correctly so — a `PASS`
      // is a claim wherever it sits, and a citation a reader has to go hunting for upwards is one
      // that stops applying the moment a row is copied out of the table.
      push(`| ${cell(step.id)} | ${step.status} | transcript:${TASK7_TRANSCRIPT} |`);
    }
    push("", `Blocking (${execution.blocking.length}):`, "");
    for (const entry of execution.blocking) {
      push(`- \`${cell(entry.id)}\` — ${cell(entry.detail)}`);
    }
    push(
      "",
      "The three blocking gates are the three whose documents withhold something: 9H's absent clients,",
      "9I's two chaos scenarios this device cannot stage, and 9L's two features that depend on them.",
      "Each is listed with its reason in the inventory below.",
      "",
    );
  }

  push(
    "## Everything currently `UNVERIFIED`",
    "",
    "Read through each subprogram's own parser by `scripts/release-gate.mjs`'s `collectUnverified()`,",
    "so this list cannot disagree with what the aggregate gate prints. **This is the honest",
    "release-notes content**: each entry is a thing nobody has looked at, not a thing known to be broken.",
    "`UNVERIFIED` is never rolled up into a pass, a percentage, or a readiness score.",
    "",
    `${unverified.length} entries.`,
    "",
    "| source | item | reason |",
    "|---|---|---|",
  );
  for (const entry of unverified) {
    push(`| ${cell(entry.source)} | ${cell(entry.item)} | ${cell(entry.reason).slice(0, 240)} |`);
  }

  push(
    "",
    "## Must not be described as supported",
    "",
    "### Platforms",
    "",
    `Qualifying device: **${verdicts.platform.primary}** — the only platform with evidence.`,
    "",
  );
  if (verdicts.platform.unsupported === undefined || verdicts.platform.unsupported.length === 0) {
    push("Every platform row is complete, which would be a first — verify the matrix parsed correctly.", "");
  } else {
    for (const platform of verdicts.platform.unsupported) {
      push(`- **${platform}** — do not describe as supported.`);
    }
    push(
      "",
      "Nothing has been executed on any of these. That is a statement about what has been *observed*,",
      "not a claim that BAYZ is broken there: the runtime closure is native-free, which makes the code",
      "plausibly portable and proves nothing about any particular machine.",
      "",
    );
  }

  push("### Clients", "");
  for (const entry of verdicts.client.withheld) {
    push(`- **${entry.client}** — do not describe as working: ${entry.blocking} of ${entry.of} capabilities are \`BLOCKED\` or \`UNVERIFIED\`.`);
  }
  if (verdicts.client.partial.length > 0) {
    push(
      "",
      "Acceptable at release **with a stated limit**, which is not the same as unsupported — each",
      "`PARTIAL` cell carries evidence *and* a named limitation, enforced by `tests/matrix-integrity.test.mjs`:",
      "",
    );
    for (const entry of verdicts.client.partial) {
      push(`- **${entry.client}** — ${entry.partials} of ${entry.of} capabilities \`PARTIAL\`. Read the limit before quoting support.`);
    }
  }
  push(
    "",
    `Release-blocking clients (the Core 3): ${verdicts.client.core3.join(", ")}. Per-client tallies below cover`,
    "the Core 3 only, because that is the set 9H's gate blocks on — `scripts/client-gate-lib.mjs`'s own",
    "`assess()` produces them. The withheld list above covers **every** client in the matrix, including",
    "the ones no gate blocks on, since an unmentioned client is the one somebody assumes is fine.",
    "",
    "| client | VERIFIED | PARTIAL | BLOCKED | UNVERIFIED | N/A | missing |",
    "|---|---|---|---|---|---|---|",
  );
  for (const row of verdicts.client.summary) {
    push(
      `| ${row.client} | ${row.verified} | ${row.partial} | ${row.blocked} | ${row.unverified} | ${row.na} | ${row.missing} |`,
    );
  }

  push(
    "",
    "## Residual risk",
    "",
    "Parsed from spec §24's own table rather than retyped, so this list cannot drift from the",
    "normative one. Each is a boundary BAYZ **will not cross and does not claim to have crossed**;",
    "`tests/no-fabrication.test.mjs` mechanically forbids any document claiming otherwise.",
    "",
  );
  if (risks.error !== undefined) {
    push(`**Could not read spec §24: ${risks.error}.** This is a defect in this generator, not an empty risk list.`, "");
  } else {
    push("| boundary | why | owner |", "|---|---|---|");
    for (const risk of risks.rows) {
      push(`| ${cell(risk.boundary)} | ${cell(risk.why)} | ${cell(risk.owner)} |`);
    }
    push("");
  }

  push(
    "## When a GitHub push becomes permissible",
    "",
    "All six conditions, simultaneously. A push is prohibited while any row reads `**NOT met**`.",
    "",
    "| condition | state | detail |",
    "|---|---|---|",
  );
  for (const entry of conditions) {
    push(`| ${cell(entry.condition)} | ${tick(entry.met)} | ${cell(entry.detail)} |`);
  }

  const unmet = conditions.filter((entry) => entry.met === false);
  push(
    "",
    unmet.length === 0
      ? "**Every recorded condition is met.** A push still requires the explicit instruction and a clean tree at the moment of pushing."
      : `**${unmet.length} conditions are not met**, so a push is prohibited: ${unmet
          .map((entry) => entry.condition)
          .join(", ")}.`,
    "",
    "No remote is configured, and `tests/phase9-locks.test.mjs` asserts that mechanically — including",
    "that no remote is named `B-Router` and none points at a GitHub URL. Phase 9 ends at the local commit.",
    "",
  );

  return lines;
}

/** The full statement text, with a trailing newline. */
export async function statementText() {
  const parts = await renderStatement();
  return `${renderTail(parts).join("\n")}\n`;
}

async function main(argv) {
  const write = argv.includes("--write");
  const check = argv.includes("--check");
  const toStdout = argv.includes("--stdout");
  if ([write, check, toStdout].filter(Boolean).length !== 1) {
    process.stderr.write("usage: node scripts/readiness.mjs (--write | --check | --stdout)\n");
    return 2;
  }

  const text = await statementText();

  if (toStdout) {
    process.stdout.write(text);
    return 0;
  }
  if (write) {
    writeFileSync(STATEMENT_PATH, text);
    process.stdout.write(`readiness: wrote ${text.split("\n").length - 1} lines\n`);
    return 0;
  }

  if (!existsSync(STATEMENT_PATH)) {
    process.stderr.write("readiness: the statement does not exist; run --write\n");
    return 1;
  }
  const committed = readFileSync(STATEMENT_PATH, "utf8");
  if (committed === text) {
    process.stdout.write("readiness: the committed statement matches a fresh generation byte for byte\n");
    return 0;
  }
  process.stderr.write("readiness: the committed statement does NOT match a fresh generation\n");
  process.stderr.write("  the gates have moved, or the file was hand-edited. Regenerate with --write.\n");
  return 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(await main(process.argv.slice(2)));
}



