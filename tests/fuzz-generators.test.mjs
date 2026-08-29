import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * Phase 9I Task 2 — input-shape generators and the committed corpus.
 *
 * Two properties matter more than the shape list itself:
 *
 *   1. **Every generator is pure given an rng.** That is what makes a failing iteration in
 *      Task 3 replayable from a seed. A generator that read the clock, or kept state across
 *      calls, would produce a crash nobody can reproduce.
 *   2. **The corpus carries no credential-shaped data.** Corpus files are committed, so this
 *      reuses Task 1's `findCredentialShape` rather than a second scanner that could drift
 *      from the first — two scanners disagreeing is how a secret gets through.
 */

const HERE = fileURLToPath(new URL(".", import.meta.url));
const FUZZ_DIR = join(HERE, "..", "scripts", "fuzz");
const CORPUS_DIR = join(FUZZ_DIR, "corpus");

const { createRng, findCredentialShape, MAX_INPUT_BYTES } = await import(join(FUZZ_DIR, "harness.mjs"));
const generators = await import(join(FUZZ_DIR, "generators.mjs"));

const REQUIRED_GENERATORS = [
  "generateJsonValue",
  "generateUtf8String",
  "generateInvalidUtf8Bytes",
  "generateHeaderPair",
  "generateUrl",
  "generateIdentifier",
  "generateSseStream",
  "generateSocks5Handshake",
  "generateConnectHandshake",
  "generateSqliteHostileString",
];

/** Draw `count` values and return them, so purity can be compared across two rngs. */
function draw(fn, seed, count = 200) {
  const rng = createRng(seed);
  const out = [];
  for (let i = 0; i < count; i += 1) out.push(fn(rng));
  return out;
}

function stable(value) {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return `buf:${Buffer.from(value).toString("base64")}`;
  }
  return JSON.stringify(value, (_key, v) => {
    if (typeof v === "bigint") return `bigint:${v}`;
    if (Buffer.isBuffer(v) || v instanceof Uint8Array) return `buf:${Buffer.from(v).toString("base64")}`;
    if (typeof v === "number" && Object.is(v, -0)) return "neg-zero";
    return v;
  });
}

/** Collect every string appearing anywhere in a value, for shape assertions. */
function stringsOf(value, depth = 0, out = []) {
  if (depth > 80) return out;
  if (typeof value === "string") {
    out.push(value);
    return out;
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    out.push(Buffer.from(value).toString("latin1"));
    return out;
  }
  if (value === null || typeof value !== "object") return out;
  if (Array.isArray(value)) {
    for (const entry of value) stringsOf(entry, depth + 1, out);
    return out;
  }
  for (const [key, entry] of Object.entries(value)) {
    out.push(key);
    stringsOf(entry, depth + 1, out);
  }
  return out;
}

function maxDepth(value, depth = 0) {
  if (depth > 200 || value === null || typeof value !== "object") return depth;
  let deepest = depth;
  const entries = Array.isArray(value) ? value : Object.values(value);
  for (const entry of entries) {
    const d = maxDepth(entry, depth + 1);
    if (d > deepest) deepest = d;
  }
  return deepest;
}

function maxArrayLength(value, depth = 0) {
  if (depth > 200 || value === null || typeof value !== "object") return 0;
  let longest = Array.isArray(value) ? value.length : 0;
  const entries = Array.isArray(value) ? value : Object.values(value);
  for (const entry of entries) {
    const n = maxArrayLength(entry, depth + 1);
    if (n > longest) longest = n;
  }
  return longest;
}

test("every required generator is exported as a function", () => {
  for (const name of REQUIRED_GENERATORS) {
    assert.equal(typeof generators[name], "function", `missing generator: ${name}`);
  }
  assert.ok(Array.isArray(generators.GENERATORS), "GENERATORS registry is missing");
  assert.deepEqual(
    generators.GENERATORS.map((g) => g.name).sort(),
    [...REQUIRED_GENERATORS].sort(),
    "the registry must list exactly the required generators",
  );
  for (const entry of generators.GENERATORS) {
    assert.equal(typeof entry.generate, "function", `${entry.name} has no generate`);
  }
});

test("every generator is pure given an rng", () => {
  /*
   * Same seed, two independent rngs, identical output. This is the property Task 3's
   * replayability rests on; a generator holding state across calls or reading the clock
   * would fail here.
   */
  for (const name of REQUIRED_GENERATORS) {
    const a = draw(generators[name], `purity-${name}`).map(stable);
    const b = draw(generators[name], `purity-${name}`).map(stable);
    assert.deepEqual(b, a, `${name} is not pure given an rng`);
  }
});

test("every generator varies with the seed", () => {
  // A generator returning a constant would pass the purity test while fuzzing nothing.
  for (const name of REQUIRED_GENERATORS) {
    const a = draw(generators[name], "vary-a").map(stable);
    const b = draw(generators[name], "vary-b").map(stable);
    assert.notDeepEqual(b, a, `${name} does not depend on the rng`);
    assert.ok(new Set(a).size > 1, `${name} produced a single shape across 200 draws`);
  }
});

test("no generator exceeds the harness input cap", () => {
  // A generator over 1 MiB would abort every Task 3 run with input_too_large.
  for (const name of REQUIRED_GENERATORS) {
    for (const value of draw(generators[name], `cap-${name}`, 120)) {
      const bytes =
        typeof value === "string"
          ? Buffer.byteLength(value)
          : Buffer.isBuffer(value) || value instanceof Uint8Array
            ? value.length
            : Buffer.byteLength(stable(value) ?? "");
      assert.ok(bytes <= MAX_INPUT_BYTES, `${name} produced ${bytes} bytes, over the cap`);
    }
  }
});

test("no generator emits credential-shaped data", () => {
  // Task 3 saves failing inputs to the committed regression corpus.
  for (const name of REQUIRED_GENERATORS) {
    for (const value of draw(generators[name], `cred-${name}`, 300)) {
      const hit = findCredentialShape(value);
      assert.equal(hit, null, `${name} emitted credential-shaped data: ${JSON.stringify(hit)}`);
    }
  }
});

test("the JSON generator emits prototype-pollution keys", () => {
  const seen = new Set();
  for (const value of draw(generators.generateJsonValue, "json-proto", 4000)) {
    for (const s of stringsOf(value)) {
      if (s === "__proto__" || s === "constructor" || s === "prototype") seen.add(s);
    }
  }
  for (const key of ["__proto__", "constructor", "prototype"]) {
    assert.ok(seen.has(key), `JSON generator never emitted ${key}`);
  }
});

test("the JSON generator reaches depth 64 and arrays of 10,000", () => {
  let deepest = 0;
  let longest = 0;
  for (const value of draw(generators.generateJsonValue, "json-extremes", 4000)) {
    const d = maxDepth(value);
    if (d > deepest) deepest = d;
    const n = maxArrayLength(value);
    if (n > longest) longest = n;
  }
  assert.ok(deepest >= 64, `deepest nesting was ${deepest}, expected at least 64`);
  assert.ok(longest >= 10_000, `longest array was ${longest}, expected at least 10,000`);
});

test("the JSON generator emits the awkward numeric and string shapes", () => {
  const found = { negZero: false, e400: false, nanish: false, surrogate: false, nul: false };
  for (const value of draw(generators.generateJsonValue, "json-awkward", 6000)) {
    const encoded = stable(value) ?? "";
    if (encoded.includes("neg-zero")) found.negZero = true;
    if (encoded.includes("1e400") || encoded.includes("1e+400")) found.e400 = true;
    for (const s of stringsOf(value)) {
      if (s === "NaN" || s === "Infinity" || s === "-Infinity") found.nanish = true;
      if (/[\ud800-\udfff]/.test(s) && !/[\ud800-\udbff][\udc00-\udfff]/.test(s)) found.surrogate = true;
      if (s.includes("\u0000")) found.nul = true;
    }
  }
  for (const [key, hit] of Object.entries(found)) {
    assert.ok(hit, `JSON generator never emitted the ${key} shape`);
  }
});

test("the URL generator emits the alternate loopback encodings 9D refuses", () => {
  /*
   * 9D Task 1's egress policy refuses these because they all resolve to 127.0.0.1 while
   * looking like ordinary hosts. If the generator cannot produce them, the url target
   * cannot prove the policy still holds.
   */
  const wanted = ["2130706433", "0177.0.0.1", "0x7f.0.0.1"];
  const schemes = ["file:", "gopher:"];
  const seen = new Set();
  let userinfo = false;

  for (const value of draw(generators.generateUrl, "url-shapes", 6000)) {
    const text = String(value);
    for (const w of wanted) if (text.includes(w)) seen.add(w);
    for (const s of schemes) if (text.startsWith(s)) seen.add(s);
    if (/^[a-z]+:\/\/[^/@\s]+@/.test(text)) userinfo = true;
  }

  for (const w of [...wanted, ...schemes]) {
    assert.ok(seen.has(w), `URL generator never emitted ${w}`);
  }
  assert.ok(userinfo, "URL generator never emitted a userinfo form");
});

test("the URL generator also emits the metadata and link-local hosts 9F blocks", () => {
  // SSRF protection covers more than loopback; the corpus should exercise the whole policy.
  const wanted = ["169.254.169.254", "metadata.google.internal", "[::1]", "10.", "192.168."];
  const seen = new Set();
  for (const value of draw(generators.generateUrl, "url-ssrf", 6000)) {
    const text = String(value);
    for (const w of wanted) if (text.includes(w)) seen.add(w);
  }
  for (const w of wanted) assert.ok(seen.has(w), `URL generator never emitted ${w}`);
});

test("the identifier generator emits SQL injection, traversal, and homoglyph shapes", () => {
  let sql = false;
  let traversal = false;
  let homoglyph = false;
  let overlong = false;

  for (const value of draw(generators.generateIdentifier, "ident-shapes", 6000)) {
    const text = String(value);
    if (/('|--|;|\bDROP\b|\bUNION\b|\bOR\b\s+1=1)/i.test(text)) sql = true;
    if (text.includes("../") || text.includes("..\\") || text.includes("%2e%2e")) traversal = true;
    // Cyrillic а/е/о and Greek ο are the classic ASCII look-alikes.
    if (/[\u0430\u0435\u043e\u03bf\u0410\u0415\u041e]/.test(text)) homoglyph = true;
    if (text.length > 128) overlong = true;
  }

  assert.ok(sql, "identifier generator never emitted a SQL-injection shape");
  assert.ok(traversal, "identifier generator never emitted a path-traversal shape");
  assert.ok(homoglyph, "identifier generator never emitted a Unicode homoglyph");
  assert.ok(overlong, "identifier generator never exceeded the documented identifier bound");
});

test("the invalid-UTF-8 generator really produces invalid sequences", () => {
  /*
   * A generator that claimed to emit invalid UTF-8 but produced valid bytes would silently
   * test nothing, so decode strictly and require actual failures.
   */
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let invalid = 0;
  const values = draw(generators.generateInvalidUtf8Bytes, "bad-utf8", 300);
  for (const value of values) {
    assert.ok(Buffer.isBuffer(value) || value instanceof Uint8Array, "expected bytes");
    try {
      decoder.decode(value);
    } catch {
      invalid += 1;
    }
  }
  assert.ok(invalid >= values.length * 0.8, `only ${invalid}/${values.length} sequences were invalid UTF-8`);
});

test("the UTF-8 generator produces decodable text including hostile-but-valid shapes", () => {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let combining = false;
  let rtl = false;
  let astral = false;

  for (const value of draw(generators.generateUtf8String, "good-utf8", 400)) {
    assert.equal(typeof value, "string");
    // Valid UTF-8 by construction, but assert it round-trips rather than trusting that.
    decoder.decode(Buffer.from(value, "utf8"));
    if (/[\u0300-\u036f]/.test(value)) combining = true;
    if (/[\u202a-\u202e\u2066-\u2069]/.test(value)) rtl = true;
    if (/[\u{10000}-\u{10ffff}]/u.test(value)) astral = true;
  }

  assert.ok(combining, "no combining marks");
  assert.ok(rtl, "no bidi override characters");
  assert.ok(astral, "no astral-plane characters");
});

test("the header generator emits CRLF injection and hostile name shapes", () => {
  let crlf = false;
  let emptyName = false;
  let hugeValue = false;
  let nonAscii = false;

  for (const value of draw(generators.generateHeaderPair, "headers", 4000)) {
    assert.ok(value && typeof value === "object", "header pair must be an object");
    assert.equal(typeof value.name, "string");
    assert.equal(typeof value.value, "string");
    if (/[\r\n]/.test(value.name) || /[\r\n]/.test(value.value)) crlf = true;
    if (value.name.length === 0) emptyName = true;
    if (value.value.length > 8192) hugeValue = true;
    if (/[^\x20-\x7e]/.test(value.name) || /[^\x20-\x7e]/.test(value.value)) nonAscii = true;
  }

  assert.ok(crlf, "no CRLF-bearing header");
  assert.ok(emptyName, "no empty header name");
  assert.ok(hugeValue, "no oversized header value");
  assert.ok(nonAscii, "no non-ASCII header bytes");
});

test("the SSE generator emits the malformed frame shapes Task 3 needs", () => {
  let doneInString = false;
  let bareCr = false;
  let hugeLine = false;
  let splitUtf8 = false;
  let noTerminator = false;

  for (const value of draw(generators.generateSseStream, "sse", 3000)) {
    assert.ok(Buffer.isBuffer(value) || value instanceof Uint8Array, "SSE stream must be bytes");
    const text = Buffer.from(value).toString("latin1");
    if (/"[^"\n]*\[DONE\][^"\n]*"/.test(text)) doneInString = true;
    if (/\r(?!\n)/.test(text)) bareCr = true;
    if (text.split("\n").some((line) => line.length >= 64 * 1024)) hugeLine = true;
    if (!text.includes("\n\n")) noTerminator = true;
    // A frame cut mid-multibyte-sequence: a lead byte at the very end of the buffer.
    const last = value[value.length - 1];
    if (last !== undefined && last >= 0xc2 && last <= 0xf4) splitUtf8 = true;
  }

  assert.ok(doneInString, "no [DONE] inside a JSON string");
  assert.ok(bareCr, "no bare-CR stream");
  assert.ok(hugeLine, "no 64 KiB line");
  assert.ok(splitUtf8, "no frame split mid-UTF-8-sequence");
  assert.ok(noTerminator, "no unterminated frame");
});

test("the SOCKS5 and CONNECT generators emit handshake-shaped bytes", () => {
  let sawVersion5 = false;
  let sawBadVersion = false;
  let sawTruncated = false;
  for (const value of draw(generators.generateSocks5Handshake, "socks5", 2000)) {
    assert.ok(Buffer.isBuffer(value) || value instanceof Uint8Array, "handshake must be bytes");
    if (value[0] === 0x05) sawVersion5 = true;
    if (value.length > 0 && value[0] !== 0x05) sawBadVersion = true;
    if (value.length <= 2) sawTruncated = true;
  }
  assert.ok(sawVersion5, "no valid SOCKS5 version byte");
  assert.ok(sawBadVersion, "no wrong version byte");
  assert.ok(sawTruncated, "no truncated handshake");

  let sawConnect = false;
  let sawGarbage = false;
  let sawNoHost = false;
  for (const value of draw(generators.generateConnectHandshake, "connect", 2000)) {
    const text = typeof value === "string" ? value : Buffer.from(value).toString("latin1");
    if (text.startsWith("CONNECT ")) sawConnect = true;
    if (!/^[A-Z]+ /.test(text)) sawGarbage = true;
    if (/^CONNECT\s+HTTP/.test(text)) sawNoHost = true;
  }
  assert.ok(sawConnect, "no CONNECT request line");
  assert.ok(sawGarbage, "no non-request-line garbage");
  assert.ok(sawNoHost, "no CONNECT without an authority");
});

test("the SQLite-hostile generator emits statement-breaking and binary shapes", () => {
  let quote = false;
  let semicolon = false;
  let nul = false;
  let pragma = false;
  for (const value of draw(generators.generateSqliteHostileString, "sqlite", 3000)) {
    const text = String(value);
    if (text.includes("'") || text.includes('"')) quote = true;
    if (text.includes(";")) semicolon = true;
    if (text.includes("\u0000")) nul = true;
    if (/pragma|attach|vacuum|sqlite_master/i.test(text)) pragma = true;
  }
  assert.ok(quote, "no quote characters");
  assert.ok(semicolon, "no statement separator");
  assert.ok(nul, "no NUL byte");
  assert.ok(pragma, "no PRAGMA/ATTACH/sqlite_master shape");
});

// ---------------------------------------------------------------------------
// The committed corpus
// ---------------------------------------------------------------------------

function corpusFiles() {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) out.push(path);
    }
  };
  walk(CORPUS_DIR);
  return out;
}

test("the committed corpus is loadable and covers every generator family", () => {
  const loaded = generators.loadCorpus();
  assert.ok(Array.isArray(loaded), "loadCorpus must return an array");
  assert.ok(loaded.length >= 10, `corpus has only ${loaded.length} entries`);

  for (const entry of loaded) {
    assert.equal(typeof entry.name, "string");
    assert.ok(entry.name.length > 0);
    assert.ok(Buffer.isBuffer(entry.bytes), `${entry.name} did not load as bytes`);
    assert.equal(typeof entry.family, "string");
  }

  /*
   * A corpus that covered only one family would leave most boundaries with hand-written
   * cases and no minimised seeds.
   */
  const families = new Set(loaded.map((e) => e.family));
  for (const family of ["json", "url", "identifier", "sse", "header", "socks5", "connect", "sqlite", "utf8"]) {
    assert.ok(families.has(family), `corpus has no ${family} seed`);
  }
});

test("each corpus file is under 64 KiB and the total is under 2 MiB", () => {
  const files = corpusFiles();
  assert.ok(files.length > 0, "the corpus directory is empty");
  let total = 0;
  for (const file of files) {
    const size = statSync(file).size;
    assert.ok(size <= 64 * 1024, `${file} is ${size} bytes, over the 64 KiB per-file bound`);
    total += size;
  }
  assert.ok(total <= 2 * 1024 * 1024, `corpus totals ${total} bytes, over the 2 MiB bound`);
});

test("Task 1's credential scan passes over every corpus file", () => {
  /*
   * Deliberately the *same* function the harness uses, not a copy. Two scanners that can
   * drift from each other is how a secret gets committed.
   */
  for (const file of corpusFiles()) {
    const raw = readFileSync(file);
    const hit = findCredentialShape(raw.toString("latin1")) ?? findCredentialShape(raw.toString("utf8"));
    assert.equal(hit, null, `${file} contains credential-shaped data: ${JSON.stringify(hit)}`);
  }
});

test("the regression corpus directory exists so Task 3 has somewhere to write", () => {
  const dir = join(CORPUS_DIR, "regression");
  assert.ok(statSync(dir).isDirectory(), "scripts/fuzz/corpus/regression/ is missing");
});
