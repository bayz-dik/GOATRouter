import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

/**
 * Guards on the per-client configuration guides in `docs/clients/`.
 *
 * The guides are the one place a compatibility claim can be made in prose, where the
 * matrix's machine-checked cells cannot reach it. A guide saying "streaming works" for a
 * client whose `stream` cell is `UNVERIFIED` would be a fake compatibility claim that no
 * existing test could see — `tests/matrix-integrity.test.mjs` reads the matrix, not the
 * documentation.
 *
 * So the documentation is held to the matrix rather than trusted:
 *
 * 1. Every required guide exists.
 * 2. Every guide states the correct base URL, and none states a wrong one.
 * 3. A guide may only write a bare `VERIFIED` where that client's row genuinely has one.
 * 4. Where a guide restates a status table, every row must match the matrix cell exactly,
 *    and every citation must be the one the matrix carries.
 * 5. Every repository path a guide references must exist — except paths explicitly
 *    described as future work.
 */

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const CLIENTS_DIR = new URL("../docs/clients/", import.meta.url);
const MATRIX_URL = new URL(
  "../docs/superpowers/2026-08-27-bayz-client-compatibility-matrix.md",
  import.meta.url,
);

/** The four guides 9H Task 3 requires, plus the index. */
const GUIDES = ["opencode", "antigravity", "hermes", "generic-openai"];

const BASE_URL = "http://127.0.0.1:20128/v1";

/**
 * Paths a guide may reference before they exist, because it is describing future work.
 *
 * Deliberately explicit rather than a pattern: a typo'd real path must fail, and the only
 * way to keep that true is to enumerate the genuine exceptions.
 */
const FUTURE_PATHS = new Set([
  "scripts/verify-antigravity.mjs",
  "scripts/verify-opencode.mjs",
  "scripts/verify-hermes.mjs",
]);

function isTableRow(line) {
  const trimmed = line.trim();
  return trimmed.startsWith("|") && !/^\|[\s:|-]+\|$/.test(trimmed);
}

function cellsOf(line) {
  const trimmed = line.trim();
  return trimmed
    .slice(1, trimmed.endsWith("|") ? -1 : undefined)
    .split("|")
    .map((cell) => cell.trim());
}

/** The matrix, as `client -> capability -> { status, note }`. */
function readMatrix() {
  const source = readFileSync(MATRIX_URL, "utf8");
  const clients = new Map();
  let current;
  for (const line of source.split("\n")) {
    const heading = /^###\s+`?([A-Za-z0-9._-]+)`?\s*$/.exec(line);
    if (heading !== null) {
      current = heading[1];
      clients.set(current, new Map());
      continue;
    }
    if (current === undefined || !isTableRow(line)) {
      continue;
    }
    const [capability, status, note] = cellsOf(line);
    if (capability === undefined || capability.toLowerCase() === "capability") {
      continue;
    }
    clients.get(current)?.set(capability, { status, note });
  }
  return clients;
}

function guideSource(name) {
  return readFileSync(new URL(`${name}.md`, CLIENTS_DIR), "utf8");
}

test("every required client guide exists, plus an index", () => {
  for (const name of GUIDES) {
    assert.ok(
      existsSync(new URL(`${name}.md`, CLIENTS_DIR)),
      `docs/clients/${name}.md is missing`,
    );
  }
  assert.ok(existsSync(new URL("README.md", CLIENTS_DIR)), "docs/clients/README.md is missing");
});

test("every guide documents the correct base URL and no other", () => {
  for (const name of [...GUIDES, "README"]) {
    const source = guideSource(name);
    assert.ok(source.includes(BASE_URL), `${name}.md never states the base URL ${BASE_URL}`);

    // Any other loopback BAYZ URL would be a wrong instruction a user would paste. The
    // fixture ports inside code fences are the origin's, not BAYZ's, so only the
    // documented management port is allowed to appear.
    for (const match of source.matchAll(/http:\/\/127\.0\.0\.1:(\d+)/g)) {
      assert.equal(
        match[1],
        "20128",
        `${name}.md references port ${match[1]}; only 20128 is documented`,
      );
    }
  }
});

test("a guide may only claim VERIFIED where the matrix row actually has one", () => {
  const matrix = readMatrix();

  for (const name of GUIDES) {
    const row = matrix.get(name);
    assert.notEqual(row, undefined, `the matrix has no ${name} row`);
    const hasVerified = [...row.values()].some(
      ({ status }) => status === "VERIFIED" || status === "PARTIAL",
    );

    const source = guideSource(name);
    const claims = source
      .split("\n")
      .filter((line) => /\bVERIFIED\b/.test(line) && !/\bUNVERIFIED\b/.test(line));

    if (!hasVerified) {
      /*
       * A client with no evidence at all: the word may appear only in a negation
       * ("presence is not verification", "not verified"), never as a claim. The guides for
       * absent or untried clients are exactly where an over-claim would be most tempting
       * and least visible.
       */
      assert.deepEqual(
        claims,
        [],
        `${name}.md claims VERIFIED but every ${name} matrix cell is UNVERIFIED`,
      );
    }
  }
});

test("a guide's restated status table matches the matrix cell for cell", () => {
  const matrix = readMatrix();

  for (const name of GUIDES) {
    const source = guideSource(name);
    const row = matrix.get(name);
    let compared = 0;

    for (const line of source.split("\n")) {
      if (!isTableRow(line)) {
        continue;
      }
      const cells = cellsOf(line);
      if (cells.length < 2) {
        continue;
      }
      const [capability, rawStatus] = cells;
      const cell = row.get(capability);
      if (cell === undefined) {
        // Not a capability table — the guides also contain field-reference tables.
        continue;
      }
      const status = rawStatus.replaceAll("*", "").trim();
      if (!/^(VERIFIED|PARTIAL|BLOCKED|UNVERIFIED|N\/A)$/.test(status)) {
        // A prose table keyed by capability name (the "open question" tables), which is
        // not a status claim and must not be read as one.
        continue;
      }

      compared += 1;
      assert.equal(
        status,
        cell.status,
        `${name}.md says ${capability} is ${status}, the matrix says ${cell.status}`,
      );

      // Any citation the guide prints must be one the matrix actually carries, so a guide
      // cannot promote a cell by citing a check the matrix never accepted.
      const guideCitations = [...cells.slice(2).join(" ").matchAll(/smoke:[a-z-]+#\d+/g)].map(
        (match) => match[0],
      );
      for (const citation of guideCitations) {
        assert.ok(
          cell.note.includes(citation),
          `${name}.md cites ${citation} for ${capability}, which the matrix does not`,
        );
      }
    }

    // `generic-openai` is the one guide that restates the whole row; asserted positively so
    // this test cannot pass by silently comparing nothing.
    if (name === "generic-openai") {
      assert.equal(compared, 17, `expected 17 compared cells, compared ${compared}`);
    }
  }
});

test("every repository path a guide references exists", () => {
  const pathPattern = /(?:packages|apps|scripts|docs|tests)\/[A-Za-z0-9._/-]+\.(?:ts|tsx|mjs|md|json|yaml)/g;
  let checked = 0;

  for (const name of [...GUIDES, "README"]) {
    const source = guideSource(name);
    for (const match of source.matchAll(pathPattern)) {
      const path = match[0];
      if (FUTURE_PATHS.has(path)) {
        continue;
      }
      checked += 1;
      assert.ok(
        existsSync(new URL(path, `file://${REPO_ROOT}`)),
        `${name}.md references ${path}, which does not exist`,
      );
    }
  }

  assert.ok(checked > 0, "the path scan must have read real references");
  console.log(`  repository paths resolved across the guides: ${checked}`);
});

test("no guide invents a client config field for a client that is absent", () => {
  /*
   * `antigravity` is not installed on this host, so there is nothing to read a field name
   * from. A config snippet in that guide could only have been guessed — and OpenCode
   * (camelCase `baseURL`/`apiKey`, JSON) and Hermes (snake_case `base_url`, YAML, a derived
   * env-var) disagree on nearly every one, so there is no safe default to generalise from.
   *
   * The check inspects **fenced code blocks only**, and looks for an *assignment*. That
   * distinction matters: the guide names `baseURL` and `base_url` in prose precisely to
   * explain that it does not know which applies, and banning the words would push the
   * document toward being vaguer about its own uncertainty. What must not exist is a block
   * a reader could copy as configuration.
   */
  const source = guideSource("antigravity");

  const fences = [...source.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map((match) => match[1]);
  assert.ok(fences.length > 0, "antigravity.md should still show the BAYZ-side API calls");

  /*
   * No exemption for lines that happen to contain the real base URL, and the optional
   * closing quote matters.
   *
   * Two holes in the first drafts of this guard, both found by mutating an invented JSON
   * block into the guide and watching the test still pass:
   *
   * 1. It excused any line mentioning `127.0.0.1:20128`, reasoning that the `curl`
   *    examples needed it. The `curl` blocks make no field assignment, so the exemption
   *    bought nothing and let the fabrication through.
   * 2. `baseURL\s*[:=]` does not match JSON, where the text is `"baseURL":` — a quote sits
   *    between the key and the colon. A YAML-shaped pattern silently ignored every JSON
   *    config block, which is the shape most likely to be invented here.
   */
  const assignment = /["']?(baseURL|apiKey|api_key|base_url|endpoint|apiBase|api_base)["']?\s*[:=]/i;
  for (const block of fences) {
    const offending = block.split("\n").find((line) => assignment.test(line));
    assert.equal(
      offending,
      undefined,
      `antigravity.md has a copyable client-config assignment: ${offending?.trim()}`,
    );
  }

  // And it must state the absence, rather than merely omitting the configuration.
  assert.ok(
    /not installed|absent/i.test(source),
    "antigravity.md must state that the client is absent from this host",
  );
});
