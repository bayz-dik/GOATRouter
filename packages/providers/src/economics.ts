import type { ProviderKind } from "./url.js";

/**
 * Model economics.
 *
 * FREE-FIRST is a product lock, and the way a free-first router loses is by deciding
 * an unproven model is free. So the design rule here is evidentiary: a classification
 * of free requires *proof* in the catalogue metadata, and everything else is
 * `UNKNOWN`. `UNKNOWN` is not "probably fine"; it is not free, and `isFreeEconomics`
 * says so.
 *
 * There is deliberately no price table and no model-name-to-economics map. A
 * maintained price list would be stale within a week and would make BAYZ the authority
 * on someone else's pricing. An executable source scan in `economics.test.ts` enforces
 * that.
 */
export const MODEL_ECONOMICS = Object.freeze([
  /** Proven zero across every priced dimension the catalogue reports. */
  "FREE_VERIFIED",
  /** A documented free-tier marker in the catalogue. */
  "FREE_TIER",
  /** A documented preview or promotional marker. */
  "FREE_PREVIEW",
  /** A local runtime: no per-token cost to the operator at all. */
  "LOCAL",
  /** Proven to cost something. */
  "PAID",
  /** Not determinable. **Not free.** */
  "UNKNOWN",
] as const);

export type ModelEconomics = (typeof MODEL_ECONOMICS)[number];

/**
 * Whether routing may treat this model as costing the operator nothing.
 *
 * `UNKNOWN` and `PAID` are false. This is the function FREE-ONLY routing gates on, so
 * a lenient reading here would be a real bill.
 */
export function isFreeEconomics(value: ModelEconomics): boolean {
  return (
    value === "FREE_VERIFIED" ||
    value === "FREE_TIER" ||
    value === "FREE_PREVIEW" ||
    value === "LOCAL"
  );
}

/** The dimensions that must *all* be proven zero for `FREE_VERIFIED`. */
const PRICED_DIMENSIONS = ["prompt", "completion", "request", "image"] as const;

/** Long enough for any real price, short enough that parsing is never a cost. */
const MAX_PRICE_LENGTH = 32;

/**
 * A price literal, strictly.
 *
 * Deliberately not `parseFloat`: `parseFloat("0.0000000abc")` returns 0, which would
 * invent a free model out of malformed metadata. Leading/trailing space, `+`,
 * separators, hex, `Infinity`, and non-ASCII digits are all refused rather than
 * coerced.
 */
const PRICE_RE = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][-+]?[0-9]+)?$/;

type PriceReading =
  | { kind: "zero" }
  | { kind: "positive" }
  /** Malformed, negative, absent, or otherwise not evidence of anything. */
  | { kind: "indeterminate" };

function readPrice(value: unknown): PriceReading {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_PRICE_LENGTH) {
    return { kind: "indeterminate" };
  }
  if (!PRICE_RE.test(value)) {
    return { kind: "indeterminate" };
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return { kind: "indeterminate" };
  }
  if (parsed === 0) {
    // Covers "0", "0.0", "0e0", and "-0": all exactly zero.
    return { kind: "zero" };
  }
  if (parsed < 0) {
    // Nonsense metadata rather than a discount. Refusing to interpret it is the only
    // honest option — a negative price means the catalogue is wrong about something.
    return { kind: "indeterminate" };
  }
  return { kind: "positive" };
}

/** An own-property read that never follows the prototype chain. */
function own(record: object, key: string): unknown {
  return Object.hasOwn(record, key) ? (record as Record<string, unknown>)[key] : undefined;
}

/**
 * A plain object, or nothing.
 *
 * A non-plain prototype is refused: inherited fields were never sent by the upstream,
 * and reading them would let a crafted payload manufacture a free classification.
 */
function plainObject(value: unknown): object | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return undefined;
  }
  return value;
}

/** Only an exact `true`. "Boolean-ish" would make `"false"` and `0` meaningful. */
function markerSet(entry: object, keys: readonly string[]): boolean {
  return keys.some((key) => own(entry, key) === true);
}

const FREE_TIER_KEYS = ["free_tier", "freeTier"] as const;
const FREE_PREVIEW_KEYS = ["free_preview", "freePreview"] as const;

export type ClassifyModelEconomicsInput = {
  kind: ProviderKind;
  /** The raw catalogue entry, untrusted. Never escapes this function. */
  entry: unknown;
  /** A loopback provider is a local runtime. */
  allowLoopback: boolean;
};

/**
 * Classify one catalogue entry.
 *
 * Pure, and bounded: only named fields are read, at a fixed depth, so a 1 MiB entry or
 * a 50,000-deep nesting costs nothing. A generic deep walk would turn catalogue size
 * into an operator-visible cost and give a hostile upstream a lever.
 *
 * Evidence order, strongest first:
 *
 * 1. **Local runtime.** No per-token cost exists, whatever the catalogue claims.
 * 2. **Complete zero pricing.** Proof, and it outranks a marker in both directions —
 *    a `free_tier: true` entry with a real price is `PAID`.
 * 3. **A documented marker.** Weaker than pricing but still something the upstream
 *    actually asserted.
 * 4. **Everything else** is `UNKNOWN`. Notably a `:free` id suffix, which is a naming
 *    convention rather than evidence: a hostile or careless catalogue could name every
 *    paid model `:free`.
 */
export function classifyModelEconomics(
  input: ClassifyModelEconomicsInput,
): ModelEconomics {
  if (input.allowLoopback === true) {
    // Checked before the entry is even examined: a local runtime costs the operator
    // nothing per token, so its catalogue's price claims are irrelevant.
    return "LOCAL";
  }

  const entry = plainObject(input.entry);
  if (entry === undefined) {
    return "UNKNOWN";
  }

  const pricing = plainObject(own(entry, "pricing"));
  if (pricing !== undefined) {
    const readings = PRICED_DIMENSIONS.map((dimension) =>
      readPrice(own(pricing, dimension)),
    );
    if (readings.some((reading) => reading.kind === "positive")) {
      return "PAID";
    }
    if (readings.every((reading) => reading.kind === "zero")) {
      // Every dimension present and proven zero. A *missing* dimension is not a
      // proven zero, which is why this is `every` over the full list rather than over
      // the keys the upstream happened to send.
      return "FREE_VERIFIED";
    }
    // Pricing was present but incomplete or malformed. Fall through: a marker is
    // weaker evidence, but it is still evidence.
  }

  if (markerSet(entry, FREE_TIER_KEYS)) {
    return "FREE_TIER";
  }
  if (markerSet(entry, FREE_PREVIEW_KEYS)) {
    return "FREE_PREVIEW";
  }

  // No proof. Not free.
  return "UNKNOWN";
}
