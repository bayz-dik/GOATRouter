import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  MODEL_ECONOMICS,
  classifyModelEconomics,
  isFreeEconomics,
  type ModelEconomics,
} from "../src/index.js";

/**
 * Free-first model economics.
 *
 * The single failure mode this whole file guards: **treating an unproven model as
 * free.** That is the one that costs an operator real money, so `UNKNOWN` is asserted
 * first and hardest, and every path that could invent a zero price is pinned.
 */

function classify(
  entry: unknown,
  overrides: { kind?: "openai-compatible" | "openrouter" | "gemini" | "custom-openai"; allowLoopback?: boolean } = {},
): ModelEconomics {
  return classifyModelEconomics({
    kind: overrides.kind ?? "openrouter",
    entry,
    allowLoopback: overrides.allowLoopback ?? false,
  });
}

test("the six economics values are exactly as specified and frozen", () => {
  assert.deepEqual(
    [...MODEL_ECONOMICS],
    ["FREE_VERIFIED", "FREE_TIER", "FREE_PREVIEW", "LOCAL", "PAID", "UNKNOWN"],
  );
  assert.ok(Object.isFrozen(MODEL_ECONOMICS));
});

test("UNKNOWN and PAID are not free", () => {
  // Asserted first and explicitly. Treating UNKNOWN as free is the failure mode that
  // spends the operator's money, so it is the most important assertion in the file.
  assert.equal(isFreeEconomics("UNKNOWN"), false);
  assert.equal(isFreeEconomics("PAID"), false);
});

test("the four genuinely free classifications are free", () => {
  assert.equal(isFreeEconomics("FREE_VERIFIED"), true);
  assert.equal(isFreeEconomics("FREE_TIER"), true);
  assert.equal(isFreeEconomics("FREE_PREVIEW"), true);
  assert.equal(isFreeEconomics("LOCAL"), true);
});

test("isFreeEconomics covers every value with no gap", () => {
  for (const value of MODEL_ECONOMICS) {
    assert.equal(typeof isFreeEconomics(value), "boolean", value);
  }
  assert.equal(
    MODEL_ECONOMICS.filter((value) => isFreeEconomics(value)).length,
    4,
    "exactly four values are free",
  );
});

test("FREE_VERIFIED requires complete zero pricing", () => {
  assert.equal(
    classify({
      id: "meta/llama-3-8b",
      pricing: { prompt: "0", completion: "0", request: "0", image: "0" },
    }),
    "FREE_VERIFIED",
  );
});

test("any non-zero priced dimension is PAID", () => {
  for (const dimension of ["prompt", "completion", "request", "image"]) {
    const pricing: Record<string, string> = {
      prompt: "0",
      completion: "0",
      request: "0",
      image: "0",
    };
    pricing[dimension] = "0.0000005";
    assert.equal(classify({ id: "m", pricing }), "PAID", dimension);
  }
});

test("a missing priced dimension is UNKNOWN, not FREE_VERIFIED", () => {
  // A missing field is not a proven zero. Defaulting it to zero would classify a model
  // as free on the strength of a field the upstream simply did not send.
  assert.equal(
    classify({ id: "m", pricing: { prompt: "0", completion: "0", request: "0" } }),
    "UNKNOWN",
  );
  assert.equal(classify({ id: "m", pricing: { prompt: "0" } }), "UNKNOWN");
  assert.equal(classify({ id: "m", pricing: {} }), "UNKNOWN");
});

test("a non-object pricing value is UNKNOWN", () => {
  for (const pricing of [null, "free", 0, 0.0, true, [], ["0"], undefined]) {
    assert.equal(classify({ id: "m", pricing }), "UNKNOWN", JSON.stringify(pricing));
  }
});

test("a prototype-polluted pricing object is UNKNOWN", () => {
  const pricing = Object.create({
    prompt: "0",
    completion: "0",
    request: "0",
    image: "0",
  }) as Record<string, string>;
  // Inherited prices were never sent by the upstream. Reading them would let a crafted
  // payload manufacture a free classification.
  assert.equal(classify({ id: "m", pricing }), "UNKNOWN");
});

test("a non-numeric price string is UNKNOWN rather than leniently parsed", () => {
  // `parseFloat("0.0000000abc")` returns 0. Using it would silently invent a free
  // model out of malformed metadata.
  for (const bad of [
    "0.0000000abc",
    "abc",
    "",
    " ",
    "0,0",
    "1/2",
    "0x0",
    "Infinity",
    "NaN",
    "0 ",
    " 0",
    "+0",
    "١٠",
  ]) {
    assert.equal(
      classify({
        id: "m",
        pricing: { prompt: bad, completion: "0", request: "0", image: "0" },
      }),
      "UNKNOWN",
      `accepted ${JSON.stringify(bad)}`,
    );
  }
});

test("a non-string price is UNKNOWN even when numerically zero", () => {
  // The catalogue format is strings. Accepting a number here would mean two code paths
  // for the same field and one of them unvalidated.
  for (const value of [0, 0.0, false, null, {}, []]) {
    assert.equal(
      classify({
        id: "m",
        pricing: { prompt: value, completion: "0", request: "0", image: "0" },
      }),
      "UNKNOWN",
      JSON.stringify(value),
    );
  }
});

test("zero written in other exact forms is still zero and therefore free", () => {
  for (const zero of ["0.0", "0e0", "-0", "0.000000", "0.0e10"]) {
    assert.equal(
      classify({
        id: "m",
        pricing: { prompt: zero, completion: "0", request: "0", image: "0" },
      }),
      "FREE_VERIFIED",
      `rejected ${zero}`,
    );
  }
});

test("a tiny but non-zero price is PAID", () => {
  for (const price of ["1e-9", "0.000000001", "0.0000000000001"]) {
    assert.equal(
      classify({
        id: "m",
        pricing: { prompt: price, completion: "0", request: "0", image: "0" },
      }),
      "PAID",
      price,
    );
  }
});

test("a negative price is UNKNOWN, because it is nonsense rather than a discount", () => {
  for (const price of ["-1", "-0.5", "-1e-9"]) {
    assert.equal(
      classify({
        id: "m",
        pricing: { prompt: price, completion: "0", request: "0", image: "0" },
      }),
      "UNKNOWN",
      price,
    );
  }
});

test("a loopback provider is LOCAL regardless of entry content", () => {
  // A local runtime has no per-token cost to the operator, whatever its catalogue says.
  for (const kind of ["openai-compatible", "gemini", "custom-openai"] as const) {
    assert.equal(
      classify({ id: "m", pricing: { prompt: "999", completion: "999" } }, {
        kind,
        allowLoopback: true,
      }),
      "LOCAL",
      kind,
    );
    assert.equal(classify(undefined, { kind, allowLoopback: true }), "LOCAL", kind);
  }
});

test("pricing wins over a :free name convention", () => {
  assert.equal(
    classify({
      id: "meta/llama-3-8b:free",
      pricing: { prompt: "0", completion: "0", request: "0", image: "0" },
    }),
    "FREE_VERIFIED",
  );
  // And a priced model named `:free` is PAID, not free. The name is not evidence.
  assert.equal(
    classify({
      id: "meta/llama-3-8b:free",
      pricing: { prompt: "0.001", completion: "0", request: "0", image: "0" },
    }),
    "PAID",
  );
});

test("a :free id with no pricing metadata is UNKNOWN — a name is not proof", () => {
  // The attack: a hostile or careless catalogue names every paid model `:free`, and a
  // router that trusted the suffix would route paid traffic believing it was free.
  assert.equal(classify({ id: "vendor/model:free" }), "UNKNOWN");
  assert.equal(classify({ id: "vendor/model:free", pricing: {} }), "UNKNOWN");
  assert.equal(classify({ id: "free" }), "UNKNOWN");
  assert.equal(classify({ id: "free-tier-model" }), "UNKNOWN");
});

test("FREE_TIER comes from a documented marker, never from prose", () => {
  assert.equal(classify({ id: "m", free_tier: true }), "FREE_TIER");
  assert.equal(classify({ id: "m", freeTier: true }), "FREE_TIER");
});

test("FREE_PREVIEW comes from a documented marker", () => {
  assert.equal(classify({ id: "m", free_preview: true }), "FREE_PREVIEW");
  assert.equal(classify({ id: "m", freePreview: true }), "FREE_PREVIEW");
});

test("a marker that is not exactly true does not classify", () => {
  // "Boolean-ish" would let `"false"`, `0`, and `[]` all mean different things by
  // accident. Only a real `true` counts.
  for (const value of ["true", 1, "yes", {}, [], "false", 0, null]) {
    assert.equal(
      classify({ id: "m", free_tier: value }),
      "UNKNOWN",
      JSON.stringify(value),
    );
  }
});

test("a description containing the word free changes nothing", () => {
  assert.equal(
    classify({ id: "m", description: "Completely free to use, no charge, $0" }),
    "UNKNOWN",
  );
  assert.equal(
    classify({
      id: "m",
      description: "free free free",
      pricing: { prompt: "0.01", completion: "0.01", request: "0", image: "0" },
    }),
    "PAID",
  );
});

test("pricing outranks a free-tier marker", () => {
  // Proven pricing is stronger evidence than a flag, in both directions.
  assert.equal(
    classify({
      id: "m",
      free_tier: true,
      pricing: { prompt: "0.01", completion: "0", request: "0", image: "0" },
    }),
    "PAID",
  );
  assert.equal(
    classify({
      id: "m",
      free_tier: true,
      pricing: { prompt: "0", completion: "0", request: "0", image: "0" },
    }),
    "FREE_VERIFIED",
  );
});

test("a non-object entry is UNKNOWN", () => {
  for (const entry of [null, undefined, "m", 0, true, [], () => "m"]) {
    assert.equal(classify(entry), "UNKNOWN", JSON.stringify(entry) ?? "fn");
  }
});

test("a prototype-polluted entry is UNKNOWN", () => {
  const entry = Object.create({
    pricing: { prompt: "0", completion: "0", request: "0", image: "0" },
  }) as Record<string, unknown>;
  entry.id = "m";
  assert.equal(classify(entry), "UNKNOWN");
});

test("the classifier is pure and does not mutate its input", () => {
  const entry = {
    id: "m",
    pricing: { prompt: "0", completion: "0", request: "0", image: "0" },
  };
  const before = JSON.stringify(entry);
  const first = classify(entry);
  const second = classify(entry);
  assert.equal(first, second);
  assert.equal(JSON.stringify(entry), before);
});

test("a 1 MiB entry is bounded rather than walked", () => {
  const entry = {
    id: "m",
    description: "x".repeat(1024 * 1024),
    pricing: { prompt: "0", completion: "0", request: "0", image: "0" },
  };
  const started = Date.now();
  assert.equal(classify(entry), "FREE_VERIFIED");
  // Only named fields are read, so size is irrelevant. A generic deep walk would make
  // catalogue size an operator-visible cost.
  assert.ok(Date.now() - started < 200);
});

test("a deeply nested entry does not recurse without bound", () => {
  let nested: Record<string, unknown> = { end: true };
  for (let depth = 0; depth < 50_000; depth += 1) {
    nested = { next: nested };
  }
  assert.equal(classify({ id: "m", extra: nested }), "UNKNOWN");
});

test("a huge pricing string is refused rather than parsed", () => {
  assert.equal(
    classify({
      id: "m",
      pricing: { prompt: `0.${"0".repeat(100_000)}`, completion: "0", request: "0", image: "0" },
    }),
    "UNKNOWN",
  );
});

test("no per-model price literal or economics table exists in the source", () => {
  // A maintained price list would be wrong within a week and would make BAYZ the
  // authority on someone else's pricing. The classifier reads metadata; it does not
  // remember prices.
  const dir = join(import.meta.dirname, "..", "src");
  const sources = readdirSync(dir)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => ({ name, text: readFileSync(join(dir, name), "utf8") }));
  assert.ok(sources.length > 0);

  for (const { name, text } of sources) {
    const code = text
      // Comments legitimately mention model names and example prices.
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");

    for (const vendor of ["gpt-4", "claude-3", "llama-3", "gemini-1.5", "mistral"]) {
      assert.ok(
        !code.toLowerCase().includes(vendor),
        `${name} names the model ${vendor}`,
      );
    }
    // A decimal price literal, e.g. 0.000015. Zero itself is fine; a fraction is a
    // price.
    assert.ok(
      !/[^\w.]0\.0{2,}\d/.test(code),
      `${name} contains what looks like a per-token price literal`,
    );
  }
});

test("every returned value is a member of the enum", () => {
  const entries: unknown[] = [
    undefined,
    null,
    {},
    { id: "m" },
    { id: "m", pricing: { prompt: "0", completion: "0", request: "0", image: "0" } },
    { id: "m", pricing: { prompt: "1", completion: "0", request: "0", image: "0" } },
    { id: "m", free_tier: true },
    { id: "m", free_preview: true },
  ];
  for (const entry of entries) {
    assert.ok(
      (MODEL_ECONOMICS as readonly string[]).includes(classify(entry)),
      JSON.stringify(entry),
    );
    assert.ok(
      (MODEL_ECONOMICS as readonly string[]).includes(
        classify(entry, { allowLoopback: true }),
      ),
    );
  }
});
