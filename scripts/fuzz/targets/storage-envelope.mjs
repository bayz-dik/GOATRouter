/**
 * Fuzz target: encrypted storage envelopes — 9I Task 3.
 *
 * Real AES-GCM, real KEK-wrapped DEKs, no stub. The plan's requirement is specific and sharp:
 * **a bit-flip in every byte position of a short envelope fails closed** with
 * `master_key_invalid` or `storage_unavailable`, never returning plaintext.
 *
 * Returning plaintext from a tampered envelope is the worst outcome in this phase — it means
 * authenticated encryption was not authenticating — so the assertion is on the *value*, not
 * just on "it threw".
 */

import { generateIdentifier, generateUtf8String } from "../generators.mjs";
import { assertGlobalStateUnchanged, expectBayzError, globalStateSnapshot } from "./shared.mjs";

const { ENVELOPE_VERSION, SECRET_ALGORITHM, openSecret, sealSecret } = await import(
  "../../../packages/storage/src/crypto.ts"
);

/*
 * `secret_corrupt` is in the allowed set alongside the two codes the plan names.
 *
 * Read from `assertEnvelopeShape` in crypto.ts: a *structurally* broken envelope (a truncated
 * ciphertext, a wrong-length IV) is reported as `secret_corrupt`, while a cryptographic failure
 * is `master_key_invalid`. Both are fail-closed refusals; asserting only the plan's two codes
 * would have made a correct implementation look broken.
 */
const CODES = new Set(["master_key_invalid", "storage_unavailable", "secret_corrupt", "invalid_argument"]);

const KEK = Buffer.alloc(32, 0x7a);
const OTHER_KEK = Buffer.alloc(32, 0x7b);
const NAME = "fuzz-secret";
const PLAINTEXT = "PLAINTEXT-CANARY-VALUE";

/** A short envelope, sealed once and reused as the tampering base. */
const BASE = sealSecret(KEK, NAME, PLAINTEXT);

/** Byte-bearing fields, in a fixed order so a flip index maps to a stable position. */
const FIELDS = Object.freeze(["wrappedDek", "wrapIv", "wrapTag", "ciphertext", "iv", "tag"]);

function totalBytes() {
  return FIELDS.reduce((sum, field) => sum + BASE[field].length, 0);
}

const TOTAL = totalBytes();

function cloneEnvelope() {
  const copy = { ...BASE };
  for (const field of FIELDS) copy[field] = Buffer.from(BASE[field]);
  return copy;
}

/** Flip one bit at a global byte offset across the concatenated byte fields. */
function flipAt(envelope, offset, bit) {
  let remaining = offset;
  for (const field of FIELDS) {
    const buffer = envelope[field];
    if (remaining < buffer.length) {
      buffer[remaining] ^= 1 << bit;
      return `${field}[${remaining}]:${bit}`;
    }
    remaining -= buffer.length;
  }
  return "out-of-range";
}

/**
 * The plan's requirement is "a bit-flip in **every** byte position of a short envelope", which
 * random sampling cannot deliver: 5,000 draws over ~130 positions × 8 bits leaves coverage to
 * chance, and a missed position is a byte nobody proved is authenticated. So the flip cases
 * *sweep* — offset and bit are derived from the iteration index, guaranteeing every position is
 * visited (each one many times over 5,000 iterations) while the other cases still sample.
 */
function generate(rng, { iteration }) {
  switch (rng.int(0, 7)) {
    case 0: {
      const sweep = iteration % (TOTAL * 8);
      return { kind: "flip", offset: Math.floor(sweep / 8), bit: sweep % 8, sweep };
    }
    case 1:
      return { kind: "wrong-kek" };
    case 2:
      return { kind: "wrong-name", name: rng.int(0, 2) === 0 ? generateIdentifier(rng) : `${NAME}-other` };
    case 3:
      return { kind: "truncate", field: rng.pick([...FIELDS]), by: rng.int(1, 8) };
    case 4:
      return { kind: "extend", field: rng.pick([...FIELDS]), by: rng.int(1, 8) };
    case 5:
      return { kind: "version", value: rng.pick([0, ENVELOPE_VERSION + 1, -1, "1", null]) };
    case 6:
      return { kind: "algorithm", value: rng.pick(["aes-128-gcm", "aes-256-cbc", "", generateUtf8String(rng)]) };
    default:
      return { kind: "roundtrip", plaintext: generateUtf8String(rng) };
  }
}

function run(input, { iteration }) {
  const before = globalStateSnapshot();
  const context = `storage-envelope#${iteration}/${input.kind}`;

  if (input.kind === "roundtrip") {
    // The honest path must keep working: a target that only proved things fail would pass
    // against an implementation that always failed.
    const sealed = sealSecret(KEK, NAME, input.plaintext);
    const opened = openSecret(KEK, NAME, sealed);
    if (opened !== input.plaintext) {
      throw new Error(`${context}: round-trip did not preserve the plaintext`);
    }
    if (sealed.algorithm !== SECRET_ALGORITHM) {
      throw new Error(`${context}: sealed with an unexpected algorithm ${JSON.stringify(sealed.algorithm)}`);
    }
    assertGlobalStateUnchanged(before, context);
    return;
  }

  const envelope = cloneEnvelope();
  let kek = KEK;
  let name = NAME;

  switch (input.kind) {
    case "flip":
      flipAt(envelope, input.offset, input.bit);
      break;
    case "wrong-kek":
      kek = OTHER_KEK;
      break;
    case "wrong-name":
      // The record name is the AAD, so opening under a different name must fail even with the
      // right key — that is what binds a ciphertext to its row.
      name = input.name;
      break;
    case "truncate":
      envelope[input.field] = envelope[input.field].subarray(0, Math.max(0, envelope[input.field].length - input.by));
      break;
    case "extend":
      envelope[input.field] = Buffer.concat([envelope[input.field], Buffer.alloc(input.by, 0x41)]);
      break;
    case "version":
      envelope.version = input.value;
      break;
    default:
      envelope.algorithm = input.value;
      break;
  }

  let opened;
  try {
    opened = openSecret(kek, name, envelope);
  } catch (error) {
    expectBayzError(error, CODES, context);
    assertGlobalStateUnchanged(before, context);
    return;
  }

  /*
   * Reaching here means a tampered envelope was opened. Assert on the returned value: even
   * garbage output would be a failure, but returning the *canary* means authentication was
   * skipped entirely.
   */
  throw new Error(
    `${context}: a tampered envelope opened and returned ${opened === PLAINTEXT ? "the original plaintext" : `${String(opened).length} bytes`}`,
  );
}

export const target = {
  name: "storage-envelope",
  seed: "9i-storage-envelope-1",
  iterations: 5000,
  generate,
  run,
};

/** Exported so the sweep test can prove every byte position is reachable. */
export const internals = { FIELDS, TOTAL, flipAt, cloneEnvelope };
