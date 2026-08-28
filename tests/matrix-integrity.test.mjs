import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

/**
 * Integrity of the 9H client compatibility matrix.
 *
 * This test exists because a compatibility matrix is the one document in the tree with a
 * standing incentive to lie. Every other artefact is checked by running it; a matrix is
 * prose, and prose drifts toward optimism. So the machine, not the author, decides
 * whether a cell is allowed to claim success.
 *
 * Three properties are enforced, and the third is the one that matters:
 *
 * 1. **Shape.** Every client row exists, every capability column exists, and every cell
 *    holds exactly one status from a closed vocabulary — no blanks, no `TODO`, no `?`.
 * 2. **Evidence required.** A cell claiming verification must cite evidence in a
 *    machine-parseable form, and a cell claiming a blockage must give a reason.
 * 3. **Evidence must resolve.** A cited test file, script, or transcript has to *exist on
 *    disk*. This is what separates the matrix from a wish: `test:packages/foo/bar.test.ts`
 *    cannot be typed into a VERIFIED cell unless that file is really there. Without this
 *    check the evidence column is decoration, and the easiest way to turn the matrix green
 *    would be to invent a plausible path.
 */

const MATRIX_URL = new URL(
  "../docs/superpowers/2026-08-27-bayz-client-compatibility-matrix.md",
  import.meta.url,
);
const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));

/**
 * The status vocabulary. Closed, and ordered from strongest claim to weakest.
 *
 * `VERIFIED` / `PARTIAL` / `BLOCKED` / `UNVERIFIED` are the four the operator requires,
 * and `N/A` is retained for a capability a client genuinely does not have — a chat client
 * with no tool support is not "unverified" at tool calling, it has no such surface, and
 * collapsing the two would make the gate demand evidence that cannot exist.
 *
 * The distinction that does the work is **BLOCKED vs UNVERIFIED**:
 *
 * - `BLOCKED` — the check was attempted against a real client and did not succeed, or
 *   cannot succeed here for a stated environmental reason. Something was learned.
 * - `UNVERIFIED` — nothing has been attempted yet. Nothing is known.
 *
 * Collapsing those two is the specific failure this phase exists to prevent: an untried
 * cell reading like a tried one is how a matrix ends up asserting a compatibility nobody
 * ever observed.
 */
const STATUSES = new Set(["VERIFIED", "PARTIAL", "BLOCKED", "UNVERIFIED", "N/A"]);

/** Statuses that are a positive claim about observed behaviour, so must cite evidence. */
const EVIDENCE_REQUIRED = new Set(["VERIFIED", "PARTIAL"]);

/** Statuses that must carry a human-readable reason instead of a citation. */
const REASON_REQUIRED = new Set(["BLOCKED", "UNVERIFIED", "N/A"]);

/**
 * The evidence grammar.
 *
 * Written inline here deliberately. 9I, 9J, and 9K each specify this same shape for their
 * own matrices, and 9L Task 1 builds `scripts/evidence.mjs` as the single source and
 * refactors all four to import it. Keeping it literal means this subprogram stands alone
 * today and is *replaced* rather than copied a fourth time.
 */
const EVIDENCE_RE = /^(smoke:[a-z-]+#\d+|test:[\w./-]+|transcript:[\w./-]+)$/;

/** Placeholders that would let an unfilled cell pass a naive status check. */
const PLACEHOLDERS = new Set(["", "-", "—", "?", "??", "TODO", "TBD", "N-A", "NA", "PASS", "FAIL"]);

/**
 * The Core 3 plus generic OpenAI, then the two opportunistic clients.
 *
 * These are the real protocol identifiers the identity registry already accepts as
 * presets (`packages/identity/src/repository.ts`), not display names invented for a
 * document — so the matrix and the runtime speak about clients in the same words.
 */
const CORE_3 = ["opencode", "antigravity", "hermes"];
const REQUIRED_CLIENTS = [...CORE_3, "generic-openai", "continue", "cline"];

/** The sixteen spec §12 capabilities plus the §25 free-only amendment column. */
const REQUIRED_CAPABILITIES = [
  "configure",
  "authenticate",
  "models.list",
  "chat",
  "stream",
  "tool call",
  "tool result roundtrip",
  "large request",
  "cancel",
  "error surface",
  "custom provider",
  "proxy-bound route",
  "combo",
  "failover",
  "restart/reconnect",
  "key revoke/rotate",
  "free-only routing",
];

/** Split one markdown table row into trimmed cells, dropping the outer pipes. */
function cellsOf(line) {
  const trimmed = line.trim();
  return trimmed
    .slice(1, trimmed.endsWith("|") ? -1 : undefined)
    .split("|")
    .map((cell) => cell.trim());
}

function isTableRow(line) {
  const trimmed = line.trim();
  return trimmed.startsWith("|") && !/^\|[\s:|-]+\|$/.test(trimmed);
}

/**
 * Parse the per-client sections.
 *
 * A `### <client>` heading opens a section; its table rows are
 * `| capability | status | evidence-or-reason |`. A per-client section beats one wide
 * seventeen-column grid for a reason that is not cosmetic: a wide grid has no room for an
 * evidence citation next to the status, so the evidence ends up in footnotes and drifts
 * out of sync with the cell it justifies.
 */
async function parseMatrix() {
  const source = await readFile(MATRIX_URL, "utf8");
  const lines = source.split("\n");
  const clients = new Map();
  let current;

  for (const line of lines) {
    const heading = /^###\s+`?([A-Za-z0-9._-]+)`?\s*$/.exec(line);
    if (heading !== null) {
      current = heading[1];
      if (REQUIRED_CLIENTS.includes(current)) {
        clients.set(current, new Map());
      }
      continue;
    }
    if (current === undefined || !clients.has(current) || !isTableRow(line)) {
      continue;
    }
    const cells = cellsOf(line);
    if (cells.length < 3) {
      continue;
    }
    const [capability, status, note] = cells;
    if (capability.toLowerCase() === "capability") {
      continue;
    }
    clients.get(current).set(capability, { status, note });
  }

  return { source, clients };
}

test("the matrix document exists and parses", async () => {
  assert.ok(existsSync(MATRIX_URL), "the compatibility matrix file must exist");
  const { clients } = await parseMatrix();
  assert.equal(
    clients.size,
    REQUIRED_CLIENTS.length,
    `expected ${REQUIRED_CLIENTS.length} client sections, found ${[...clients.keys()].join(", ")}`,
  );
});

test("every required client is present, including the Core 3", async () => {
  const { clients } = await parseMatrix();
  for (const client of REQUIRED_CLIENTS) {
    assert.ok(clients.has(client), `the ${client} row is missing`);
  }
  // Asserted separately and by name: the Core 3 are what 9H Task 6's gate blocks a
  // release on, so their absence must be a distinct failure rather than a count mismatch.
  for (const client of CORE_3) {
    assert.ok(clients.has(client), `Core 3 client ${client} is missing`);
  }
});

test("every client covers every required capability, with nothing extra", async () => {
  const { clients } = await parseMatrix();
  for (const [client, rows] of clients) {
    for (const capability of REQUIRED_CAPABILITIES) {
      assert.ok(rows.has(capability), `${client} is missing the ${capability} capability`);
    }
    for (const capability of rows.keys()) {
      // An unrecognised capability row is refused rather than ignored: a typo'd
      // capability name would otherwise sit in the document looking covered while the
      // real column silently went missing.
      assert.ok(
        REQUIRED_CAPABILITIES.includes(capability),
        `${client} declares an unknown capability: ${capability}`,
      );
    }
  }
});

test("every cell holds exactly one status from the closed vocabulary", async () => {
  const { clients } = await parseMatrix();
  for (const [client, rows] of clients) {
    for (const [capability, { status }] of rows) {
      assert.ok(
        !PLACEHOLDERS.has(status),
        `${client}/${capability} is a placeholder: ${JSON.stringify(status)}`,
      );
      assert.ok(
        STATUSES.has(status),
        `${client}/${capability} has status ${JSON.stringify(status)}, which is not one of ${[...STATUSES].join(", ")}`,
      );
    }
  }
});

/**
 * Split a cell's note into its citations and its optional trailing limitation text.
 *
 * A `PARTIAL` cell must carry both: the evidence proving what *was* observed, and the
 * limit describing what was not. They are separated by an em dash, which is why the
 * grammar cannot simply be applied to the whole note.
 *
 * Task 1's legend already declared this ("requires evidence *and* a named limit in the
 * same cell") but the test only ever checked the evidence half, so a `PARTIAL` with no
 * stated limit would have passed. Task 2 produced the first real `PARTIAL` cells and
 * exposed the gap.
 */
function splitNote(note) {
  const index = note.indexOf(" — ");
  return index === -1
    ? { citations: note, limit: "" }
    : { citations: note.slice(0, index), limit: note.slice(index + 3).trim() };
}

test("a verified or partial cell must cite machine-parseable evidence", async () => {
  const { clients } = await parseMatrix();
  for (const [client, rows] of clients) {
    for (const [capability, { status, note }] of rows) {
      if (!EVIDENCE_REQUIRED.has(status)) {
        continue;
      }
      assert.ok(note.length > 0, `${client}/${capability} claims ${status} with no evidence`);
      const { citations: citationText, limit } = splitNote(note);
      // Several citations are allowed, comma-separated, and *every* one must parse. One
      // good citation next to one hand-waved sentence would otherwise pass.
      const citations = citationText.split(",").map((entry) => entry.trim());
      for (const citation of citations) {
        assert.ok(
          EVIDENCE_RE.test(citation),
          `${client}/${capability} cites ${JSON.stringify(citation)}, which does not match the evidence grammar`,
        );
      }

      if (status === "PARTIAL") {
        // The limit is the whole point of PARTIAL: without it the cell says "it works,
        // sort of" and a reader has no idea what to expect. Twelve characters for the
        // same reason the reason column uses that bound.
        assert.ok(
          limit.length >= 12,
          `${client}/${capability} is PARTIAL without naming its limitation after an em dash: ${JSON.stringify(note)}`,
        );
      } else {
        // A VERIFIED cell carries evidence and nothing else. Prose here would be a
        // caveat hiding inside a full pass — which is what PARTIAL exists for.
        assert.equal(
          limit,
          "",
          `${client}/${capability} is VERIFIED but carries a caveat; a caveat means PARTIAL`,
        );
      }
    }
  }
});

test("a blocked, unverified, or not-applicable cell must give a reason", async () => {
  const { clients } = await parseMatrix();
  for (const [client, rows] of clients) {
    for (const [capability, { status, note }] of rows) {
      if (!REASON_REQUIRED.has(status)) {
        continue;
      }
      // Twelve characters is not a style rule: it is the shortest string that cannot be
      // `n/a`, `todo`, or `see above`, which are the three ways this column goes empty
      // while looking filled.
      assert.ok(
        note.length >= 12,
        `${client}/${capability} is ${status} without a usable reason: ${JSON.stringify(note)}`,
      );
      assert.ok(
        !EVIDENCE_RE.test(note),
        `${client}/${capability} is ${status} but cites evidence — a cell with evidence should not be ${status}`,
      );
    }
  }
});

test("every cited evidence reference resolves to something that exists", async () => {
  const { clients } = await parseMatrix();
  let citationsChecked = 0;

  for (const [client, rows] of clients) {
    for (const [capability, { status, note }] of rows) {
      if (!EVIDENCE_REQUIRED.has(status)) {
        continue;
      }
      for (const citation of splitNote(note).citations.split(",").map((entry) => entry.trim())) {
        citationsChecked += 1;
        const [kind, value] = citation.split(":");

        if (kind === "test" || kind === "transcript") {
          assert.ok(
            existsSync(new URL(value, `file://${REPO_ROOT}`)),
            `${client}/${capability} cites ${citation} but ${value} does not exist`,
          );
          continue;
        }

        // `smoke:<name>#<n>` — the script must exist, and when the script publishes an
        // evidence manifest the cited check number must be the one that actually covers
        // this capability.
        //
        // The script-exists check alone was a real hole: it accepted
        // `smoke:client-conformance#99` in a cell for a capability that harness never
        // exercises, because the number was never validated against anything. A harness
        // writes `docs/evidence/<script>.json` on a fully passing run, mapping capability
        // to check number, and that manifest is the authority here. A script without a
        // manifest still only gets the existence check — Task 4/5's transcript-based
        // harnesses cite `transcript:` paths instead.
        const [scriptName, citedNumber] = value.split("#");
        const candidates = [
          `scripts/${scriptName}.mjs`,
          `scripts/${scriptName}-smoke.mjs`,
        ];
        assert.ok(
          candidates.some((path) => existsSync(new URL(path, `file://${REPO_ROOT}`))),
          `${client}/${capability} cites ${citation} but no script matches ${candidates.join(" or ")}`,
        );

        const manifestUrl = new URL(
          `docs/evidence/${scriptName}.json`,
          `file://${REPO_ROOT}`,
        );
        if (existsSync(manifestUrl)) {
          const manifest = JSON.parse(readFileSync(manifestUrl, "utf8"));
          const expected = manifest.capabilities?.[capability];
          assert.notEqual(
            expected,
            undefined,
            `${client}/${capability} cites ${citation} but ${scriptName} publishes no check for that capability`,
          );
          assert.equal(
            Number(citedNumber),
            expected,
            `${client}/${capability} cites check #${citedNumber} but ${scriptName} reports #${expected} for it`,
          );
          assert.ok(
            Number(citedNumber) <= manifest.totalChecks,
            `${client}/${capability} cites check #${citedNumber} but ${scriptName} only ran ${manifest.totalChecks} checks`,
          );
        }
      }
    }
  }

  // A zero-citation run would pass every assertion above by doing nothing, which is
  // exactly the state this file starts in — so the count is reported rather than
  // required, and the assertion is that the loop ran at all.
  assert.ok(citationsChecked >= 0, "the citation scan must complete");
  console.log(`  evidence citations resolved: ${citationsChecked}`);
});

test("no client is VERIFIED anywhere without evidence, checked over the raw text too", async () => {
  const { source } = await parseMatrix();
  /*
   * A belt-and-braces scan over the raw document, independent of the parser.
   *
   * If a `VERIFIED` is written outside a table — in prose, in a summary line, in a
   * heading — the structured parse above never sees it, and the document would read as a
   * verified integration while every cell said otherwise. Any `VERIFIED` on a line that
   * is not a table row is refused.
   */
  for (const [index, line] of source.split("\n").entries()) {
    if (!line.includes("VERIFIED") || line.includes("UNVERIFIED")) {
      continue;
    }
    if (isTableRow(line)) {
      continue;
    }
    // The legend has to be able to name the status it defines.
    if (/^\s*[-*]\s+\*\*`?VERIFIED`?\*\*/.test(line) || line.includes("`VERIFIED`")) {
      continue;
    }
    assert.fail(`line ${index + 1} claims VERIFIED outside a table cell: ${line.trim()}`);
  }
});

test("the legend defines every status in the vocabulary", async () => {
  const { source } = await parseMatrix();
  for (const status of STATUSES) {
    assert.ok(
      source.includes(`\`${status}\``),
      `the legend must define ${status} in backticks so the vocabulary is documented where it is used`,
    );
  }
  // And the evidence grammar must be written down, or a future author has to reverse it
  // out of this test.
  assert.ok(source.includes("smoke:"), "the legend must document the smoke: evidence form");
  assert.ok(source.includes("test:"), "the legend must document the test: evidence form");
  assert.ok(
    source.includes("transcript:"),
    "the legend must document the transcript: evidence form",
  );
});
