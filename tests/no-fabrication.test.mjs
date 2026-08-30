import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..");

const evidence = await import(join(ROOT, "scripts/evidence.mjs"));

/**
 * Anti-fabrication enforcement — Phase 9L Task 4.
 *
 * The subprogram's teeth. Every other gate checks that a thing *runs*; this one checks that the
 * prose does not assert more than the runs support. Four rules, each of which had to be shaped by
 * the real corpus rather than by an invented example:
 *
 * 1. **A capacity or performance figure must be sourced.** An unsourced benchmark number is the
 *    cheapest thing in this repository to fabricate — nobody can refute `40,000 req/s` without
 *    rerunning the harness.
 * 2. **A configured bound is not a measurement.** `64 KiB`, `250 ms`, `±60s` are design decisions.
 *    A rule that cried wolf on every plan document would be switched off within a week, which is
 *    strictly worse than not having it.
 * 3. **A forbidden security term trips as a *claim*, not as a mention.** The specs deliberately name
 *    the guarantees BAYZ refuses to make. A substring ban would fail against the very documents
 *    establishing the honesty policy — the rule defeating its own purpose.
 * 4. **Support claims may not run ahead of the matrices.** Read from 9J's and 9H's own documents, so
 *    the README cannot drift ahead of the evidence by editing only the README.
 *
 * Every rule is asserted in **both** directions: against the real corpus, and against a synthesised
 * document built to trip it. Without the second half a rule hardcoded to accept everything would
 * pass every test here — the trap 9H Task 6, 9K Task 8 and 9L Task 2 each had to avoid.
 *
 * **Transcripts are the source, so they are out of scope.** `docs/transcripts/**` is what a
 * `transcript:` citation *points at*; demanding that a transcript cite a transcript would either be
 * satisfied by having it cite itself — which proves nothing — or would refuse the only real
 * measurements in the tree. They are excluded deliberately, and a test asserts the exclusion is
 * narrow rather than a hole big enough to hide a claim in.
 */

/** Tracked markdown, from git rather than a directory walk: an untracked scratch file is not a claim. */
function trackedMarkdown() {
  return execFileSync("git", ["ls-files", "--", "*.md"], { cwd: ROOT, encoding: "utf8" })
    .split("\n")
    .filter((path) => path.length > 0);
}

/**
 * The documents that make claims: everything tracked except the transcripts.
 *
 * Deliberately *not* a list of directories. `packaging/README.md` and
 * `scripts/fuzz/corpus/regression/README.md` are both tracked markdown outside `docs/`, and an
 * earlier version of this scope silently skipped them — a scope that omits a document by accident is
 * indistinguishable from a scan that finds nothing.
 */
export function claimScope(paths) {
  return paths.filter((path) => !path.startsWith("docs/transcripts/"));
}

const CORPUS = claimScope(trackedMarkdown()).map((path) => ({
  path,
  lines: readFileSync(join(ROOT, path), "utf8").split("\n"),
}));

function isTableRow(line) {
  return line.trim().startsWith("|");
}

function isTableSeparator(line) {
  return /^\|[\s:|-]+\|$/.test(line.trim());
}

/**
 * Group lines into blocks of consecutive non-blank lines.
 *
 * The scope a citation covers. A markdown table's numbers live in its rows and its provenance lives
 * in the sentence introducing it, and demanding a citation *per row* would have forced 9I's load
 * table to repeat one transcript path five times — which nobody maintains, so it drifts.
 */
export function blocksOf(lines) {
  const blocks = [];
  let start = null;
  const close = (end) => {
    if (start !== null) blocks.push({ start, end, text: lines.slice(start, end + 1).join("\n") });
    start = null;
  };
  lines.forEach((line, index) => {
    if (line.trim() === "") close(index - 1);
    else if (start === null) start = index;
  });
  close(lines.length - 1);
  return blocks;
}

/** A table inherits the paragraph immediately above it, which is where "measured by X" is written. */
function scopeIndex(lines) {
  const blocks = blocksOf(lines);
  const scopes = new Map();
  blocks.forEach((block, position) => {
    let text = block.text;
    if (isTableRow(lines[block.start]) && position > 0) {
      const previous = blocks[position - 1];
      if (block.start - previous.end <= 2) text = `${previous.text}\n${text}`;
    }
    for (let line = block.start; line <= block.end; line++) scopes.set(line, text);
  });
  return scopes;
}

/* ------------------------------------------------------------------ the rules, as pure predicates */

/** A rate or capacity figure: a number bound to a throughput unit. Always a measurement. */
export const RATE_FIGURE =
  /\b\d[\d.,]*\s*(?:req\/s|requests\/s|rps|MB\/s|MiB\/s)\b|\b\d[\d.,]*\s+concurrent requests\b/i;

/** A word that presents a number as an observed *result* rather than a chosen bound. */
export const RESULT_MARKER = /\b(?:p50|p95|p99|ttfb|throughput|measured|median)\b/i;

/** A duration or per-sample rate, the shape a latency result takes. */
export const DURATION = /\b\d[\d.,]*\s*(?:ms|µs|us|s)\b|\bKiB\/sample\b/i;

/**
 * Vocabulary that marks a number as a **configured bound** — a design decision, not an observation.
 *
 * Exempting these is not a loophole for a rate figure: `RATE_FIGURE` bypasses this list entirely,
 * because `40 req/s` is a measurement however it is worded. The exemption only reaches the
 * marker-plus-duration shape, where "measured 250 ms budget" really is describing a limit.
 */
export const BOUND_VOCABULARY =
  /\b(?:budget|cap|capped|caps|limit|limits|limited|bounds?|bounded|timeout|interval|retention|window|every|default|threshold|beyond|under|over|within|per|max|maximum|min|minimum|tolerance)\b|N=2\^|±/i;

/** Anything that names where a number came from: a citation, or the script/test that produced it. */
export const SOURCE_REFERENCE =
  /transcript:[\w./-]+|smoke:[a-z][a-z0-9-]*#\d+(?:-\d+)?|test:[\w./-]+|(?:scripts|tests|packages|apps)\/[\w./-]+\.(?:mjs|ts|tsx|json)/;

/** Every unsourced figure in one document. Exported so a fixture can be run through the same code. */
export function unsourcedFigures(lines) {
  const scopes = scopeIndex(lines);
  const findings = [];
  lines.forEach((line, index) => {
    if (isTableSeparator(line)) return;
    const rate = RATE_FIGURE.test(line);
    const result = RESULT_MARKER.test(line) && DURATION.test(line);
    if (!rate && !result) return;
    if (!rate && BOUND_VOCABULARY.test(line)) return;
    if (SOURCE_REFERENCE.test(line)) return;
    if (SOURCE_REFERENCE.test(scopes.get(index) ?? "")) return;
    findings.push({ line: index + 1, text: line.trim() });
  });
  return findings;
}

/* ------------------------------------------------------- forbidden claims, negation-aware */

/**
 * Whether `offset` sits inside an inline code span or a quoted phrase.
 *
 * Both are *mentions of a string*, not assertions. Two real cases forced this: the Phase 2 design
 * writes "Verified on this machine (Node `v24.19.0`, `linux arm64`)", where the backticked platform
 * triple names the runtime that was measured rather than claiming 9J's `Linux ARM64` row; and §25.6
 * writes `— not *"you will never be charged"*`, quoting the forbidden claim in order to refuse it.
 * Treating either as an assertion would force deleting honest text to satisfy the scanner.
 */
export function insideCodeOrQuote(line, offset) {
  let ticks = 0;
  let doubles = 0;
  for (let index = 0; index < offset; index++) {
    if (line[index] === "`") ticks++;
    else if (line[index] === '"') doubles++;
  }
  return ticks % 2 === 1 || doubles % 2 === 1;
}

/**
 * The forbidden terms, and the reason each is forbidden rather than merely discouraged.
 *
 * Each names a guarantee BAYZ has decided it cannot make. A document asserting one would be making
 * a **security** claim the implementation does not support, which is the most damaging class of
 * fabrication in the tree: it changes what an operator thinks they are protected against.
 */
export const FORBIDDEN_TERMS = Object.freeze([
  /zeroiz\w*/i,
  /zerois\w*/i,
  /memory wiped/i,
  /securely erased/i,
  /reproducible build/i,
  /tamper-proof/i,
  /unhackable/i,
  /military-grade/i,
  /bank-grade/i,
  /100% secure/i,
]);

/**
 * Negation markers, checked over the **sentence** rather than the line.
 *
 * Line-scoping was tried first and is wrong in both directions: a refusal wrapped across two lines
 * loses its `not`, and a claim can be smuggled onto a line whose *other* clause happens to contain
 * the word "not". The sentence is the unit a reader parses, so it is the unit the rule uses.
 */
export const NEGATION =
  /\b(?:no|not|never|cannot|can't|don't|doesn't|forbid\w*|refus\w*|prohibit\w*|impossible|without|unverified|absent)\b|honest limit/i;

/**
 * A sentence recording a **deliberately planted** false claim that a test caught.
 *
 * 9K's plan records "the tarball verdict reworded to claim a reproducible build (2 red)" — the
 * mutation-proof log. Requiring that sentence to carry a negation would mean deleting the record of
 * the mutation in order to satisfy the rule guarding against the claim, which is the same trap 9L
 * Task 1 hit with a `PASS`-shaped example in prose. A mutation record is evidence *for* the policy.
 */
export const MUTATION_RECORD = /\b(?:mutation|mutations|reworded|red\)|red,|caught|reverted|positive control)\b/i;

/** The sentence containing `offset`, bounded by sentence punctuation and by paragraph breaks. */
export function sentenceAt(text, offset) {
  const before = Math.max(
    text.lastIndexOf(". ", offset),
    text.lastIndexOf("\n\n", offset),
    text.lastIndexOf("! ", offset),
  );
  const period = text.indexOf(". ", offset);
  const paragraph = text.indexOf("\n\n", offset);
  const after = Math.min(period === -1 ? text.length : period + 1, paragraph === -1 ? text.length : paragraph);
  return text.slice(before === -1 ? 0 : before + 1, after);
}

/** Forbidden terms *claimed* — mentioned with no negation in their sentence. */
export function forbiddenClaims(lines) {
  const text = lines.join("\n");
  const findings = [];
  let offset = 0;
  lines.forEach((line, index) => {
    const lineStart = offset;
    offset += line.length + 1;
    for (const term of FORBIDDEN_TERMS) {
      const match = term.exec(line);
      if (match === null) continue;
      if (insideCodeOrQuote(line, match.index)) return;
      const sentence = sentenceAt(text, lineStart + match.index);
      if (NEGATION.test(sentence) || MUTATION_RECORD.test(sentence)) continue;
      findings.push({ line: index + 1, term: match[0], text: line.trim() });
      return;
    }
  });
  return findings;
}

/**
 * The §25.6 boundary, in its own rule because it is a claim about **money**.
 *
 * The strong form promises the operator will never be charged. BAYZ classifies from provider
 * metadata, so a provider that misreports its own pricing is misclassified and BAYZ cannot detect
 * it. The honest claim is the narrower one, and it is the one the README must carry.
 */
export const NEVER_CHARGED =
  /\b(?:never|not|no|won't|will not)\b[^.\n]{0,60}\b(?:be\s+)?charged\b|\bguarantee[sd]?\b[^.\n]{0,40}\bfree\b[^.\n]{0,40}\bforever\b/i;

/**
 * Phrasings that make a charging sentence honest rather than a guarantee.
 *
 * Two shapes are real in this repository and neither is the forbidden claim. §25.1 writes "must never
 * be charged **because BAYZ silently chose a paid route**" — an attribution to the one cause BAYZ
 * actually controls, which is exactly the narrow claim §25.6 permits. And the plan and spec both
 * *name* the strong form in order to forbid it; a rule that failed against its own policy statement
 * would be the third time this subprogram met that trap.
 */
export const HONEST_CHARGING =
  /\bbecause\b[^.\n]{0,40}\b(?:BAYZ|silently|chose|selected)\b|\b(?:no guarantee|not a guarantee|cannot|does not|is not|never claims|claiming|claims|forbid\w*|refus\w*|honest|stronger version)\b/i;

export function overStrongMoneyClaims(lines) {
  const text = lines.join("\n");
  const findings = [];
  let offset = 0;
  lines.forEach((line, index) => {
    const lineStart = offset;
    offset += line.length + 1;
    const match = NEVER_CHARGED.exec(line);
    if (match === null) return;
    if (insideCodeOrQuote(line, match.index)) return;
    const sentence = sentenceAt(text, lineStart + match.index);
    // A sentence that *refuses* the guarantee names it; only an assertion is a finding.
    if (HONEST_CHARGING.test(sentence)) return;
    findings.push({ line: index + 1, text: line.trim() });
  });
  return findings;
}

/* --------------------------------------------- cross-reading the 9J and 9H matrices */

const PLATFORM_MATRIX = "docs/superpowers/2026-08-27-bayz-platform-matrix.md";
const CLIENT_MATRIX = "docs/superpowers/2026-08-27-bayz-client-compatibility-matrix.md";

/**
 * 9J's own parser, imported rather than re-implemented.
 *
 * A hardcoded platform list here would be a second copy of the matrix, and the copy that drifts
 * would be this one — the README would then be checked against last week's evidence.
 */
const platformGate = await import(join(ROOT, "scripts/platform-gate.mjs"));

/** Platform rows with any non-`PASS` mandatory cell — i.e. the platforms nobody may call supported. */
export function notFullyPassingPlatforms() {
  const matrix = platformGate.parseMatrix(readFileSync(join(ROOT, PLATFORM_MATRIX), "utf8"));
  return matrix.rows
    .filter((row) => row.cells.some((cell) => cell.status !== "PASS" && cell.status !== "N/A"))
    .map((row) => row.platform);
}

/**
 * Clients with any non-`VERIFIED` capability in 9H's matrix — the clients nobody may call working.
 *
 * Only rows whose second cell is a **status from the closed vocabulary** count. Each client section
 * also carries a transcript inventory table (`| chat-stream.md | what it captures |`), and reading
 * its prose second column as a status made `hermes` — 17 of 17 `VERIFIED` — look unverified, which
 * would have suppressed a real claim about a genuinely verified client.
 */
export function notFullyVerifiedClients() {
  const lines = readFileSync(join(ROOT, CLIENT_MATRIX), "utf8").split("\n");
  const clients = new Map();
  let current;
  for (const line of lines) {
    const heading = /^###\s+`?([A-Za-z0-9._-]+)`?\s*$/.exec(line);
    if (heading !== null) {
      current = heading[1];
      continue;
    }
    if (current === undefined || !isTableRow(line) || isTableSeparator(line)) continue;
    const cells = line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
    if (cells.length < 2) continue;
    if (!ANY_VERDICT.test(cells[1])) continue;
    if (!clients.has(current)) clients.set(current, []);
    clients.get(current).push(cells[1]);
  }
  if (clients.size === 0) throw new Error("no-fabrication: parsed zero client sections from the 9H matrix");
  return [...clients]
    .filter(([, statuses]) => statuses.some((status) => !/^VERIFIED\b/.test(status)))
    .map(([client]) => client);
}

/** Words that turn a platform or client name into an assertion that it works. */
export const SUPPORT_CLAIM = /\b(?:supported|supports|works|working|verified|compatible)\b/i;

/**
 * Phrasings that make a `VERIFIED`-adjacent sentence a report *about the matrix* rather than a claim.
 *
 * The 9H plan is full of sentences like "update the matrix `opencode` row from them — tally
 * `{VERIFIED: 16, …}`". Those are records of what the matrix says, and the matrix is the authority
 * this rule reads. Requiring them to carry a negation would mean the plan could not record its own
 * outcome, and the only way to satisfy the scan would be to delete the record.
 */
export const MATRIX_REPORT =
  /\b(?:matrix|tally|row|rows|cell|cells|column|status|statuses|UNVERIFIED|PARTIAL|BLOCKED|transcript)\b/;

/**
 * Support claims running ahead of a matrix, sentence-scoped like the forbidden-term rule.
 *
 * `subjects` are matched with a word boundary and a non-path prefix, so `docs/clients/cline.md` in a
 * file path is not read as a claim about Cline, and a backticked identifier is skipped because
 * `` `opencode` `` names a preset string rather than asserting the client works.
 */
export function aheadOfEvidence(lines, subjects) {
  const text = lines.join("\n");
  const findings = [];
  let offset = 0;
  lines.forEach((line, index) => {
    const lineStart = offset;
    offset += line.length + 1;
    if (!SUPPORT_CLAIM.test(line)) return;
    for (const subject of subjects) {
      const pattern = new RegExp(`(^|[^\\w/-])${subject.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
      const match = pattern.exec(line);
      if (match === null) continue;
      if (insideCodeOrQuote(line, match.index + match[1].length)) continue;
      const sentence = sentenceAt(text, lineStart + match.index);
      if (NEGATION.test(sentence) || MATRIX_REPORT.test(sentence)) continue;
      if (/\b(?:blocked|untested|do not claim|plausibl\w+)\b/i.test(sentence)) continue;
      findings.push({ line: index + 1, subject, text: line.trim() });
      return;
    }
  });
  return findings;
}

/* ------------------------------------------------------- the repo-wide PASS sweep */

/** A verdict that asserts something was observed to work. */
const POSITIVE_VERDICT = /^(?:PASS|VERIFIED|PARTIAL)\b/;
const ANY_VERDICT = /^(?:PASS|FAIL|UNVERIFIED|N\/A|VERIFIED|PARTIAL|BLOCKED)\b/;

/**
 * A citation, in either the `kind:path` form or the bare backticked-path form the 9H client pages use.
 *
 * Both forms are accepted because both are real in this repository and the rule is about whether a
 * reader can look the claim up, not about punctuation. The bare form is *resolved* in the test, not
 * merely matched — a backticked path that does not exist is the exact defect 9L Task 1 found.
 */
export function citationsIn(cell) {
  const refs = [...cell.matchAll(/(?:smoke:[a-z][a-z0-9-]*#\d+(?:-\d+)?|test:[\w./-]+|transcript:[\w./-]+)/g)].map(
    (match) => match[0],
  );
  if (refs.length > 0) return refs;
  return [...cell.matchAll(/`((?:docs|scripts|tests|packages|apps)\/[\w./-]+\.(?:md|mjs|ts|tsx|json))`/g)].map((match) =>
    match[1].startsWith("docs/transcripts/") ? `transcript:${match[1]}` : `test:${match[1]}`,
  );
}

/** Every positively-claimed table row and the citations it carries, across a whole document. */
export function positiveRows(lines) {
  const rows = [];
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (!isTableRow(trimmed) || isTableSeparator(trimmed)) return;
    const cells = trimmed.replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
    const verdicts = cells.filter((cell) => ANY_VERDICT.test(cell));
    if (verdicts.length === 0) return;
    const verdict = verdicts[verdicts.length - 1];
    if (!POSITIVE_VERDICT.test(verdict)) return;
    rows.push({ line: index + 1, verdict, citations: citationsIn(trimmed), text: trimmed });
  });
  return rows;
}

/* ============================================================== the figure rule */

test("no capacity or performance figure is unsourced in any claim-scope document", () => {
  const findings = CORPUS.flatMap((doc) =>
    unsourcedFigures(doc.lines).map((finding) => `${doc.path}:${finding.line} — ${finding.text.slice(0, 120)}`),
  );
  assert.deepEqual(findings, [], `unsourced capacity/performance figures:\n${findings.join("\n")}`);
});

test("the figure rule fires on a fabricated benchmark, in prose and in a table", () => {
  // The positive control. A rule that accepts everything would pass the test above trivially, and
  // this is the exact shape a fabricated number takes: a plausible figure, no provenance.
  assert.equal(unsourcedFigures(["BAYZ sustains 40,000 req/s on commodity hardware."]).length, 1);
  assert.equal(unsourcedFigures(["| chat | 12,000 req/s | good |"]).length, 1);
  assert.equal(unsourcedFigures(["Streaming p95 was 4 ms."]).length, 1);
  assert.equal(unsourcedFigures(["Measured throughput of 900 req/s."]).length, 1);
});

test("the figure rule accepts a figure whose own line, or whose table's paragraph, names the source", () => {
  assert.deepEqual(unsourcedFigures(["| c=1 | PASS | transcript:docs/transcripts/load/load.md | 36.8 req/s |"]), []);
  assert.deepEqual(
    unsourcedFigures([
      "Full series in `transcript:docs/transcripts/load/load.md`.",
      "",
      "| c | p50 | req/s |",
      "|---|---|---|",
      "| 1 | 26.5 ms | 36.8 |",
    ]),
    [],
  );
});

test("the figure rule does not trip on a configured bound", () => {
  /*
   * The must-pass cases, taken from the real 9B, 9F and 9I plans rather than invented. A rule that
   * cried wolf on every plan document would be switched off within a week — strictly worse than no
   * rule, because the switching-off is silent.
   */
  const bounds = [
    "a line exceeding 64 KiB throws `response_too_large`; total buffered bytes exceeding 2 MiB throws",
    "a stale timestamp beyond ±60s is refused (bounded LRU of 4096 nonces)",
    "assert no iteration exceeds a 250 ms budget (a hang is a DoS)",
    "Sample every 15 s and record: heap used, heap total, external, RSS",
    "a `parameters` blob beyond 32 KiB is refused; more than 64 tools is refused",
    "tolerance 256 KiB, measured as a post-collection floor",
  ];
  for (const line of bounds) {
    assert.deepEqual(unsourcedFigures([line]), [], `a configured bound tripped the figure rule: ${line}`);
  }
});

test("a rate figure is never exempted as a bound, however it is worded", () => {
  // The asymmetry is deliberate and is the loophole this closes: `req/s` is a measurement even in a
  // sentence full of bound vocabulary, so `RATE_FIGURE` bypasses the exemption entirely.
  assert.equal(unsourcedFigures(["the default throughput limit is 5,000 req/s"]).length, 1);
});

/* ============================================================== forbidden claims */

test("no tracked document claims a guarantee BAYZ refuses to make", () => {
  const findings = CORPUS.flatMap((doc) =>
    forbiddenClaims(doc.lines).map(
      (finding) => `${doc.path}:${finding.line} claims '${finding.term}' — ${finding.text.slice(0, 110)}`,
    ),
  );
  assert.deepEqual(findings, [], `forbidden security claims:\n${findings.join("\n")}`);
});

test("every existing mention of a forbidden term is a refusal, and there are many of them", () => {
  /*
   * The negation carve-out validated against the real corpus, not an invented example. If this count
   * ever drops to zero the test above becomes vacuous — a scan finding nothing because there is
   * nothing to find reads identically to a scan that works.
   */
  const mentions = CORPUS.flatMap((doc) =>
    doc.lines.filter((line) => FORBIDDEN_TERMS.some((term) => term.test(line))),
  );
  assert.ok(mentions.length >= 12, `expected at least the twelve measured mentions, found ${mentions.length}`);
});

test("the forbidden-term rule fires on a bare claim and passes its negation", () => {
  assert.equal(forbiddenClaims(["Key material is zeroized after use."]).length, 1);
  assert.equal(forbiddenClaims(["BAYZ produces a reproducible build."]).length, 1);
  assert.equal(forbiddenClaims(["The database is tamper-proof."]).length, 1);
  assert.equal(forbiddenClaims(["BAYZ is unhackable."]).length, 1);
  assert.deepEqual(forbiddenClaims(["**BAYZ does not claim reproducible builds.**"]), []);
  assert.deepEqual(forbiddenClaims(["No claim of memory zeroization is made."]), []);
  assert.deepEqual(forbiddenClaims(["**Honest limit:** JavaScript cannot guarantee zeroization."]), []);
});

test("the negation carve-out is sentence-scoped, so a neighbouring 'not' cannot launder a claim", () => {
  // Line-scoping accepted this. Two sentences on one line: one honest refusal, one real claim.
  const smuggled = ["The proxy is not enabled by default. Secrets are zeroized from memory."];
  assert.equal(forbiddenClaims(smuggled).length, 1, "a claim was laundered by an unrelated negation");
});

/* ============================================================== the §25.6 money boundary */

test("no document claims the operator will never be charged", () => {
  const findings = CORPUS.flatMap((doc) =>
    overStrongMoneyClaims(doc.lines).map((finding) => `${doc.path}:${finding.line} — ${finding.text.slice(0, 120)}`),
  );
  assert.deepEqual(findings, [], `over-strong free-tier claims:\n${findings.join("\n")}`);
});

test("the money rule fires on the strong form and passes the honest one", () => {
  assert.equal(overStrongMoneyClaims(["Free-only mode means you will never be charged."]).length, 1);
  assert.deepEqual(
    overStrongMoneyClaims([
      "There is no guarantee you will never be charged: BAYZ classifies from provider metadata.",
    ]),
    [],
  );
});

test("the README carries the honest §25.6 form rather than the strong one", () => {
  const readme = readFileSync(join(ROOT, "README.md"), "utf8");
  assert.match(
    readme,
    /never (?:chose|selected|choose|select)[^.\n]{0,80}\bpaid\b/i,
    "the README must state the honest free-only claim: BAYZ never chose a paid model without metadata saying it was free",
  );
  assert.deepEqual(overStrongMoneyClaims(readme.split("\n")), []);
});

/* ============================================================== ahead of the matrices */

test("the matrices really do withhold something, or the two rules below are vacuous", () => {
  const platforms = notFullyPassingPlatforms();
  const clients = notFullyVerifiedClients();
  assert.ok(platforms.length > 0, "9J's matrix passes every platform, so the platform rule checks nothing");
  assert.ok(clients.length > 0, "9H's matrix verifies every client, so the client rule checks nothing");
  // Named, so a matrix edit that silently promotes a row shows up here rather than as a quiet pass.
  assert.ok(platforms.includes("Windows x64"), `Windows x64 should still be unverified: ${platforms.join(", ")}`);
  assert.ok(clients.includes("antigravity"), `antigravity should still be unverified: ${clients.join(", ")}`);
  /*
   * The other direction, and it is not symmetry for its own sake. An over-broad parser that reported
   * *every* client as unverified would make the rule below silently suppress every honest sentence in
   * the tree — including the record that Hermes was driven for real. That happened: each client section
   * also holds a transcript inventory table, and reading its prose column as a status marked `hermes`
   * unverified despite 17 of 17.
   */
  assert.ok(!clients.includes("hermes"), "hermes is 17/17 VERIFIED, so the parser is reading the wrong column");
  assert.ok(clients.includes("opencode"), "opencode is 16/17, so it belongs in the withheld list");
});

test("no document claims support for a platform whose 9J row is not PASS", () => {
  const platforms = notFullyPassingPlatforms();
  const findings = CORPUS.filter((doc) => doc.path !== PLATFORM_MATRIX).flatMap((doc) =>
    aheadOfEvidence(doc.lines, platforms).map(
      (finding) => `${doc.path}:${finding.line} claims ${finding.subject} — ${finding.text.slice(0, 110)}`,
    ),
  );
  assert.deepEqual(findings, [], `support claimed ahead of the platform matrix:\n${findings.join("\n")}`);
});

test("no document claims a client works whose 9H row is not VERIFIED", () => {
  const clients = notFullyVerifiedClients();
  const findings = CORPUS.filter((doc) => doc.path !== CLIENT_MATRIX && !doc.path.startsWith("docs/clients/")).flatMap(
    (doc) =>
      aheadOfEvidence(doc.lines, clients).map(
        (finding) => `${doc.path}:${finding.line} claims ${finding.subject} — ${finding.text.slice(0, 110)}`,
      ),
  );
  assert.deepEqual(findings, [], `client support claimed ahead of the client matrix:\n${findings.join("\n")}`);
});

test("the ahead-of-evidence rule fires on a real drift, and not on a file path", () => {
  assert.equal(aheadOfEvidence(["Windows x64 is fully supported."], ["Windows x64"]).length, 1);
  assert.equal(aheadOfEvidence(["Cline works against BAYZ."], ["cline"]).length, 1);
  assert.deepEqual(aheadOfEvidence(["**Do not claim support for:** Windows x64."], ["Windows x64"]), []);
  // A path is not a claim: `docs/clients/cline.md` names a document, not a verified client.
  assert.deepEqual(aheadOfEvidence(["See docs/clients/cline.md for a supported-client template."], ["cline"]), []);
});

/* ============================================================== the repo-wide PASS sweep */

test("every positively-claimed row in every tracked matrix or report carries a citation", () => {
  /*
   * A repo-wide sweep rather than a per-document one, so a matrix a future phase adds without wiring
   * it into a gate is still caught. Run over **all** tracked markdown including transcripts: a
   * transcript is out of scope for the *figure* rule because it is the source, but a `PASS` row is a
   * verdict wherever it appears.
   */
  const findings = [];
  for (const path of trackedMarkdown()) {
    const lines = readFileSync(join(ROOT, path), "utf8").split("\n");
    for (const row of positiveRows(lines)) {
      if (row.citations.length > 0) continue;
      findings.push(`${path}:${row.line} ${row.verdict} with no citation — ${row.text.slice(0, 110)}`);
    }
  }
  assert.deepEqual(findings, [], `positive verdicts with no evidence:\n${findings.join("\n")}`);
});

test("every citation in a positively-claimed row resolves on disk", async () => {
  /*
   * The step that separates this from a pattern match. 9L Task 1 found fifteen citations in a shipped
   * report pointing at a script name that resolved to nothing, precisely because every earlier copy
   * of the rule was a regex that never opened a file.
   */
  let checked = 0;
  const findings = [];
  for (const path of trackedMarkdown()) {
    const lines = readFileSync(join(ROOT, path), "utf8").split("\n");
    for (const row of positiveRows(lines)) {
      for (const citation of row.citations) {
        checked++;
        const result = await evidence.resolveEvidence(citation);
        if (result.ok) continue;
        findings.push(`${path}:${row.line} ${citation} — ${result.reason}`);
      }
    }
  }
  assert.ok(checked > 100, `expected the sweep to check a substantial corpus, checked ${checked}`);
  assert.deepEqual(findings, [], `unresolvable citations behind a positive verdict:\n${findings.join("\n")}`);
});

test("the sweep reads the last verdict cell, so a legend row is not mistaken for a claim", () => {
  // Legends explain the vocabulary; they are documentation, not verdicts. The rule reads the row's
  // final status cell, which a legend row does not have in verdict position.
  const legend = ["| status | meaning |", "|---|---|", "| `PASS` | Observed working, with evidence. |"];
  assert.deepEqual(positiveRows(legend), []);
  // But a real claim in the same shape is still caught.
  assert.equal(positiveRows(["| install | PASS | |"]).length, 1);
});

/* ============================================================== scope */

test("the claim scope covers the README, the handoff, and docs, and excludes only transcripts", () => {
  const scoped = claimScope(trackedMarkdown());
  assert.ok(scoped.includes("README.md"), "the README must be in scope — it is the document users read");
  assert.ok(scoped.includes("WORK-HANDOFF.md"), "WORK-HANDOFF.md must be in scope");
  assert.ok(scoped.some((path) => path.startsWith("docs/superpowers/specs/")), "the specs must be in scope");
  assert.ok(scoped.some((path) => path.startsWith("docs/superpowers/plans/")), "the plans must be in scope");
  assert.ok(scoped.some((path) => path.startsWith("docs/clients/")), "the client pages must be in scope");
  assert.deepEqual(
    scoped.filter((path) => path.startsWith("docs/transcripts/")),
    [],
    "transcripts are the source a citation points at, so they are excluded from the figure rule",
  );
  // The exclusion must stay narrow. If it ever grew to cover a claims document, the scan would go
  // quiet without failing, which is the failure mode this whole file exists to prevent.
  const excluded = trackedMarkdown().filter((path) => !scoped.includes(path));
  assert.deepEqual(
    excluded.filter((path) => !path.startsWith("docs/transcripts/")),
    [],
    `the only excluded documents may be transcripts; also excluded: ${excluded.join(", ")}`,
  );
  assert.ok(CORPUS.length >= 40, `expected a substantial corpus, scanned ${CORPUS.length} documents`);
});




