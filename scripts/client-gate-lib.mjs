/**
 * Matrix reader and gate policy for `scripts/client-gate.mjs` — 9H Task 6.
 *
 * Separate from both the entry script and the reporting code because of a real constraint,
 * not taste: the entry cannot both export the policy *and* `await import` the runner, since
 * the runner needs the policy — that is a circular top-level await, and Node exits 13 with
 * "unsettled top-level await" rather than deadlocking visibly. Policy lives here, the runner
 * imports it, the entry only dispatches.
 */
import { readFileSync } from "node:fs";

const MATRIX_URL = new URL(
  "../docs/superpowers/2026-08-27-bayz-client-compatibility-matrix.md",
  import.meta.url,
);

/** Release-blocking clients, per spec §12 and the plan's "Core 3". */
const CORE_3 = Object.freeze(["opencode", "antigravity", "hermes"]);

/**
 * Statuses that block a release.
 *
 * `BLOCKED` = attempted and does not work. `UNVERIFIED` = never attempted, so nothing is
 * known. Both block; the second is arguably more dangerous, which is why Task 1 refused to
 * collapse them into one "not passing" bucket.
 */
const BLOCKING = Object.freeze(new Set(["BLOCKED", "UNVERIFIED"]));

/**
 * Statuses acceptable at release.
 *
 * `PARTIAL` carries evidence *and* a named limitation that `tests/matrix-integrity.test.mjs`
 * enforces, so it is a documented bound rather than an unknown. `N/A` means the client has no
 * such surface — demanding evidence for a capability that cannot exist would make the gate
 * unsatisfiable.
 */
const ACCEPTABLE = Object.freeze(new Set(["VERIFIED", "PARTIAL", "N/A"]));

/**
 * All seventeen capabilities are mandatory.
 *
 * The plan says "mandatory column" without narrowing the list, and spec §25 added
 * `free-only routing` as explicitly not optional. Inventing a subset would be a quiet
 * decision that some capability does not matter; instead every one is required and `N/A`
 * expresses "this client has no such surface".
 */
const MANDATORY = Object.freeze([
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

/**
 * Parse the matrix into `client -> capability -> { status, note }`.
 *
 * Only rows whose status cell is a real status word are taken. The document also contains
 * prose tables keyed by capability name — the "what a VERIFIED here would mean" legend and
 * the per-client transcript tables — and reading one of those as a status row would silently
 * invent a verdict.
 */
function readMatrix() {
  const source = readFileSync(MATRIX_URL, "utf8");
  const clients = new Map();
  let current;
  for (const line of source.split("\n")) {
    const heading = /^###\s+`?([A-Za-z0-9._-]+)`?\s*$/.exec(line);
    if (heading !== null) {
      current = heading[1];
      if (!clients.has(current)) {
        clients.set(current, new Map());
      }
      continue;
    }
    if (current === undefined || !isTableRow(line)) {
      continue;
    }
    const [capability, rawStatus, note] = cellsOf(line);
    if (capability === undefined || rawStatus === undefined) {
      continue;
    }
    const status = rawStatus.replaceAll("*", "").trim();
    if (!ACCEPTABLE.has(status) && !BLOCKING.has(status)) {
      continue;
    }
    clients.get(current)?.set(capability, { status, note: note ?? "" });
  }
  return clients;
}

/** Collect every blocking cell, and a per-client tally. */
function assess(clients) {
  const blockers = [];
  const summary = [];

  for (const client of CORE_3) {
    const row = clients.get(client);
    if (row === undefined) {
      /*
       * A Core 3 client with no row is the worst case: the matrix is silent about a
       * release-blocking client. That must never read as "nothing blocking", so it is a
       * blocker in its own right rather than an absence the loop skips over.
       */
      blockers.push({
        client,
        capability: "(entire row)",
        status: "MISSING",
        note: "the matrix has no row for this Core 3 client",
      });
      summary.push({ client, verified: 0, partial: 0, blocked: 0, unverified: 0, na: 0, missing: MANDATORY.length });
      continue;
    }

    const tally = { verified: 0, partial: 0, blocked: 0, unverified: 0, na: 0, missing: 0 };
    for (const capability of MANDATORY) {
      const cell = row.get(capability);
      if (cell === undefined) {
        tally.missing += 1;
        blockers.push({
          client,
          capability,
          status: "MISSING",
          note: "no cell for this mandatory capability",
        });
        continue;
      }
      if (cell.status === "VERIFIED") tally.verified += 1;
      else if (cell.status === "PARTIAL") tally.partial += 1;
      else if (cell.status === "BLOCKED") tally.blocked += 1;
      else if (cell.status === "UNVERIFIED") tally.unverified += 1;
      else if (cell.status === "N/A") tally.na += 1;

      if (BLOCKING.has(cell.status)) {
        blockers.push({ client, capability, status: cell.status, note: cell.note });
      }
    }
    summary.push({ client, ...tally });
  }

  return { blockers, summary };
}

export { ACCEPTABLE, BLOCKING, CORE_3, MANDATORY, assess, readMatrix };
