/**
 * Scenario body for `scripts/verify-hermes.mjs` — 9H Task 5.
 *
 * Drives the real `hermes` binary (v0.20.5) against a real BAYZ listener, one client
 * process at a time. Run `node scripts/verify-hermes.mjs`, never this file directly.
 *
 * Hermes is slower per run than OpenCode — it loads plugins, skills, and a large tool
 * registry before its first request — so scenarios are ordered cheapest-first and the
 * client timeout is generous.
 */
import { existsSync, statSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

const lib = await import("./verify-client-lib.mjs");
const { configureHermes } = await import("./verify-hermes-config.mjs");

const {
  CAPABILITIES,
  makeRecorder,
  makeRedactor,
  makeTranscriptWriter,
  privateHost,
  runClient,
  sockets,
  startBayz,
  startConnectProxy,
  startOrigin,
} = lib;

const ADMIN_TOKEN = "verify-hermes-admin-token-0123456789";
const KEK_HEX = Buffer.alloc(32, 0x71).toString("hex");
const CREDENTIAL = "VERIFY-HERMES-PROVIDER-CREDENTIAL-3c2b1a";
const PROXY_USER = "bayzproxy";
const PROXY_PASSWORD = "VERIFY-HERMES-PROXY-PASSWORD-7f6e5d";
const MODEL = "probe-model";
const CLIENT_TIMEOUT_MS = 300000;

const TRANSCRIPT_DIR = new URL("../docs/transcripts/hermes/", import.meta.url);
const redact = makeRedactor([
  [ADMIN_TOKEN, "<ADMIN-TOKEN-REDACTED>"],
  [CREDENTIAL, "<PROVIDER-CREDENTIAL-REDACTED>"],
  [PROXY_PASSWORD, "<PROXY-PASSWORD-REDACTED>"],
  [KEK_HEX, "<MASTER-KEY-REDACTED>"],
]);
const writeTranscript = makeTranscriptWriter({
  dir: TRANSCRIPT_DIR,
  title: "Hermes Agent → BAYZ",
  preamble:
    "Captured by `scripts/verify-hermes.mjs` against the real `hermes` binary (v0.20.5) and a\n" +
    "real BAYZ listener, in a throwaway `HERMES_HOME` so the operator's live configuration was\n" +
    "never read or written. Secrets are redacted by name; ports, temp paths, UUIDs, and timings\n" +
    "are normalised so a re-run reproduces these bytes.",
  redact,
});

const { cells, failures, record, fail, audit } = makeRecorder(CAPABILITIES);

function section(title) {
  console.log(`\n${title}`);
}

/** A real executable file on PATH — not `command -v`, which a builtin would satisfy. */
function findExecutable(name) {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (dir.length === 0) {
      continue;
    }
    const candidate = join(dir, name);
    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      /* unreadable PATH entry */
    }
  }
  return undefined;
}

function freshDataDir(label) {
  return join(mkdtempSync(join(tmpdir(), `bayz-verify-hm-${label}-`)), ".bayz");
}

async function seed(bayz, { providerId = "hm-origin", routeId = "hm-route", port, freeOnly = false, model = MODEL } = {}) {
  await bayz.admin("POST", "/api/providers", {
    id: providerId,
    kind: "openai-compatible",
    displayName: "Hermes Verification Origin",
    baseUrl: `http://127.0.0.1:${port}`,
    config: { allowLoopback: true },
  });
  await bayz.admin("PUT", `/api/providers/${providerId}/credential`, { value: CREDENTIAL });
  await bayz.admin("POST", "/api/routes", {
    id: routeId,
    model,
    providerId,
    ...(freeOnly ? {} : { freeOnly: false }),
  });
  const created = await bayz.admin("POST", "/api/identities", {
    id: "hermes",
    displayName: "Hermes Agent",
    scopes: ["chat.completions", "models.read"],
    preset: "hermes",
  });
  return created.json?.key;
}

/** One-shot Hermes turn: `-z` prints only the final response, `-t ""` disables tools. */
function oneShot(prompt, setup, { toolsets = "", onSpawn } = {}) {
  const args = ["-z", prompt, "-t", toolsets, "--ignore-rules", "--yolo"];
  return runClient("hermes", args, {
    env: setup.env,
    cwd: setup.cwd,
    timeoutMs: CLIENT_TIMEOUT_MS,
    onSpawn,
  });
}

export {
  ADMIN_TOKEN,
  CAPABILITIES,
  CLIENT_TIMEOUT_MS,
  CREDENTIAL,
  MODEL,
  PROXY_PASSWORD,
  PROXY_USER,
  audit,
  cells,
  configureHermes,
  fail,
  failures,
  findExecutable,
  freshDataDir,
  oneShot,
  privateHost,
  record,
  redact,
  section,
  seed,
  sockets,
  startBayz,
  startConnectProxy,
  startOrigin,
  writeTranscript,
  KEK_HEX,
};

export async function main() {
  return (await import("./verify-hermes-run.mjs")).run();
}
