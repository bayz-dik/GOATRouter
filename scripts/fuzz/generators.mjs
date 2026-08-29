/**
 * Input-shape generators and corpus loader — Phase 9I Task 2.
 *
 * Every generator here obeys one contract: **pure given an rng.** No clock, no module-level
 * mutable state, no `Math.random()`. That is the property that makes a crash found at
 * iteration 3,812 of a Task 3 run replayable from the seed alone; without it the fuzzers
 * would find defects nobody could reproduce.
 *
 * The shapes are not decorative. Each one exists because some BAYZ boundary has a documented
 * rule about it:
 *
 *   - `__proto__` / `constructor` / `prototype` keys → prototype pollution, guarded since 9G.
 *   - Alternate loopback encodings (`2130706433`, `0177.0.0.1`, `0x7f.0.0.1`) → 9D Task 1's
 *     egress policy refuses them precisely because they resolve to 127.0.0.1 while looking
 *     like ordinary hosts.
 *   - `169.254.169.254`, `metadata.google.internal` → 9F's SSRF/metadata protection.
 *   - `[DONE]` inside a JSON string, bare `\r`, 64 KiB lines → 9B Task 1's SSE framing.
 *   - Homoglyphs and traversal in identifiers → route/provider id validation.
 *   - NUL bytes and `PRAGMA`/`ATTACH` shapes → the SQLite boundary.
 *
 * Nothing here may emit credential-shaped data: Task 3 writes failing inputs to a committed
 * regression corpus, so a generator producing `sk-…` would put that string in git history.
 * The generators are therefore built from explicitly benign literals, and
 * `tests/fuzz-generators.test.mjs` scans 300 draws of every generator with the harness's own
 * `findCredentialShape` to keep it that way.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CORPUS_DIR = join(HERE, "corpus");

// ---------------------------------------------------------------------------
// JSON values
// ---------------------------------------------------------------------------

const POLLUTION_KEYS = ["__proto__", "constructor", "prototype", "toString", "valueOf"];

const AWKWARD_STRINGS = [
  "NaN",
  "Infinity",
  "-Infinity",
  "undefined",
  "null",
  "\u0000",
  "a\u0000b",
  "\ud800", // lone high surrogate
  "\udfff", // lone low surrogate
  "\ud800\ud800",
  "\u202egnirts desrever",
  "\ufeff",
  "\u0085",
  "",
  " ",
  "\t\n\r",
  "0",
  "false",
  "[]",
  "{}",
  '{"a":1}',
  "1e400",
  "-0",
  "\\u0000",
  "%00",
  "\u001b[31mred\u001b[0m",
];

const AWKWARD_NUMBERS = [0, -0, 1, -1, 0.1, -0.1, 1e-323, 1.7976931348623157e308, 2 ** 53, -(2 ** 53), 2 ** 31, -(2 ** 31)];

/** A deeply nested chain of `depth` levels, alternating object and array. */
function nestedChain(depth) {
  let value = { leaf: true };
  for (let i = 0; i < depth; i += 1) value = i % 2 === 0 ? [value] : { n: value };
  return value;
}

export function generateJsonValue(rng) {
  const kind = rng.int(0, 13);

  switch (kind) {
    case 0:
      return rng.pick(AWKWARD_NUMBERS);
    case 1:
      return rng.pick(AWKWARD_STRINGS);
    case 2:
      return rng.pick([true, false, null]);
    case 3: {
      // Prototype-pollution shapes, at the top level and nested.
      const key = rng.pick(POLLUTION_KEYS);
      const payload = rng.bool() ? { polluted: true } : rng.pick(AWKWARD_STRINGS);
      return rng.bool() ? { [key]: payload } : { outer: { [key]: payload } };
    }
    case 4:
      // Depth at and beyond the plan's 64: MAX_PARAMETERS_DEPTH is 16, so both sides of the
      // bound are covered.
      return nestedChain(rng.int(60, 70));
    case 5: {
      // Arrays of 10,000 — the plan's figure. Filled with a small repeated value so the
      // encoded form stays well under the 1 MiB input cap.
      const length = rng.pick([10_000, 10_001, 9_999]);
      return Array.from({ length }, (_v, i) => (i % 2 === 0 ? 0 : rng.bool() ? null : 1));
    }
    case 6:
      // "1e400" as a *string* rather than a number: JSON.parse turns the bare token into
      // Infinity, which JSON.stringify then writes as null, so the string form is the only
      // way to carry the shape through a round-trip.
      return { value: "1e400", also: "1e+400", neg: "-1e400" };
    case 7: {
      const width = rng.int(1, 12);
      const out = {};
      for (let i = 0; i < width; i += 1) out[`k${i}`] = generateJsonValue(rng);
      return out;
    }
    case 8: {
      const length = rng.int(0, 8);
      return Array.from({ length }, () => generateJsonValue(rng));
    }
    case 9:
      // An OpenAI-shaped body with one hostile field, which is the realistic attack: a
      // request that looks ordinary except in one place.
      return {
        model: rng.pick(["probe-model", "", "\u0000", "a".repeat(200)]),
        messages: [{ role: rng.pick(["user", "system", "tool", "", "root"]), content: rng.pick(AWKWARD_STRINGS) }],
        [rng.pick(POLLUTION_KEYS)]: rng.bool() ? { polluted: true } : 1,
      };
    case 10:
      return { "": rng.pick(AWKWARD_STRINGS), " ": 1, "\u0000": 2 };
    case 11: {
      // Duplicate-key text, which only survives as a raw string: an object literal collapses
      // it before any boundary sees it.
      return { raw: '{"a":1,"a":2}' };
    }
    case 12:
      return { deep: nestedChain(rng.int(1, 20)), wide: Array.from({ length: rng.int(0, 50) }, () => 0) };
    default:
      return { n: rng.int(-1000, 1000), s: rng.pick(AWKWARD_STRINGS) };
  }
}

// ---------------------------------------------------------------------------
// UTF-8 and invalid UTF-8
// ---------------------------------------------------------------------------

const COMBINING = ["\u0300", "\u0301", "\u0327", "\u036f"];
const BIDI = ["\u202a", "\u202b", "\u202c", "\u202d", "\u202e", "\u2066", "\u2069"];
const ASTRAL = ["\u{1f600}", "\u{1f4a9}", "\u{10000}", "\u{10ffff}"];
const SCRIPTS = ["ascii", "日本語", "العربية", "русский", "ελληνικά", "עברית", "ไทย"];

export function generateUtf8String(rng) {
  const parts = [];
  const count = rng.int(1, 8);
  for (let i = 0; i < count; i += 1) {
    switch (rng.int(0, 5)) {
      case 0:
        parts.push(rng.pick(SCRIPTS));
        break;
      case 1:
        parts.push(`e${rng.pick(COMBINING)}`);
        break;
      case 2:
        parts.push(rng.pick(BIDI));
        break;
      case 3:
        parts.push(rng.pick(ASTRAL));
        break;
      case 4:
        parts.push("\u200b\u200c\u200d"); // zero-width, invisible in any log
        break;
      default:
        parts.push(String.fromCharCode(rng.int(0x20, 0x7e)));
        break;
    }
  }
  // Guarantee the three properties the test asserts across a run rather than hoping the
  // random walk covers them: without this, coverage would depend on the draw count.
  if (rng.bool()) parts.push(`a${rng.pick(COMBINING)}`);
  if (rng.bool()) parts.push(rng.pick(BIDI));
  if (rng.bool()) parts.push(rng.pick(ASTRAL));
  return parts.join("");
}

export function generateInvalidUtf8Bytes(rng) {
  const shapes = [
    () => Buffer.from([0xc3]), // truncated 2-byte lead
    () => Buffer.from([0xe2, 0x82]), // truncated 3-byte
    () => Buffer.from([0xf0, 0x9f, 0x98]), // truncated 4-byte
    () => Buffer.from([0x80]), // lone continuation
    () => Buffer.from([0xbf, 0xbf, 0xbf]),
    () => Buffer.from([0xc0, 0x80]), // overlong NUL
    () => Buffer.from([0xe0, 0x80, 0x80]),
    () => Buffer.from([0xf5, 0x80, 0x80, 0x80]), // beyond U+10FFFF
    () => Buffer.from([0xff, 0xfe]),
    () => Buffer.from([0xed, 0xa0, 0x80]), // surrogate half encoded
    () => Buffer.concat([Buffer.from("ok", "utf8"), Buffer.from([0xc3]), Buffer.from("tail", "utf8")]),
  ];
  const base = rng.pick(shapes)();
  if (rng.bool()) return base;
  // Sometimes pad with a valid prefix so the decoder fails partway rather than immediately.
  return Buffer.concat([Buffer.from("prefix-", "utf8"), base]);
}

// ---------------------------------------------------------------------------
// Headers
// ---------------------------------------------------------------------------

const HEADER_NAMES = [
  "authorization",
  "content-type",
  "x-request-id",
  "",
  " ",
  "x bad name",
  "x-bad\r\nname",
  "x-bad\nname",
  "x-bad:name",
  "x-\u0000name",
  "x-ünïcödé",
  "a".repeat(300),
  "content-length",
  "transfer-encoding",
  "host",
];

export function generateHeaderPair(rng) {
  const name = rng.pick(HEADER_NAMES);
  let value;
  switch (rng.int(0, 8)) {
    case 0:
      value = "";
      break;
    case 1:
      value = " ".repeat(rng.int(1, 10_000));
      break;
    case 2:
      // Header splitting: a CRLF here would let a caller forge a second header.
      value = `ok\r\nx-injected: yes`;
      break;
    case 3:
      value = "ok\nx-injected: yes";
      break;
    case 4:
      value = "x".repeat(rng.int(8193, 12_000)); // over the 8 KiB shape the test asserts
      break;
    case 5:
      value = "\u0000\u0001\u001f";
      break;
    case 6:
      value = generateUtf8String(rng);
      break;
    case 7:
      value = "chunked, identity";
      break;
    default:
      value = `v${rng.int(0, 9999)}`;
      break;
  }
  return { name, value };
}

// ---------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------

/**
 * Hosts that must be refused by the egress policy, in the encodings that historically slip
 * past naive string checks.
 */
const BLOCKED_HOSTS = [
  "127.0.0.1",
  "localhost",
  "2130706433", // 127.0.0.1 as a 32-bit integer
  "0177.0.0.1", // octal
  "0x7f.0.0.1", // hex
  "0x7f000001",
  "127.1",
  "127.0.0.1.nip.io",
  "[::1]",
  "[::ffff:127.0.0.1]",
  "0.0.0.0",
  "169.254.169.254", // cloud metadata
  "metadata.google.internal",
  "10.0.0.1",
  "10.255.255.254",
  "192.168.100.53",
  "172.16.0.1",
  "100.64.0.1", // carrier-grade NAT
  "[fe80::1]",
  "[fd00::1]",
];

const ODD_SCHEMES = ["file:", "gopher:", "ftp:", "data:", "javascript:", "ws:", "jar:"];

export function generateUrl(rng) {
  switch (rng.int(0, 9)) {
    case 0:
      return `http://${rng.pick(BLOCKED_HOSTS)}:${rng.int(1, 65535)}/v1/chat/completions`;
    case 1:
      return `https://${rng.pick(BLOCKED_HOSTS)}/v1/models`;
    case 2: {
      // Userinfo: the classic "the host is not what you think" shape.
      const host = rng.pick(BLOCKED_HOSTS);
      const decoy = rng.pick(["example.com", "api.openai.com", "provider.test"]);
      return rng.bool() ? `http://${decoy}@${host}/v1` : `http://user:pass@${host}/v1`;
    }
    case 3: {
      const scheme = rng.pick(ODD_SCHEMES);
      return scheme === "data:" ? "data:text/plain,hello" : `${scheme}//${rng.pick(BLOCKED_HOSTS)}/etc/passwd`;
    }
    case 4:
      return `http://example.com/${rng.pick(["..", "../..", "%2e%2e%2f", "%252e%252e"])}/v1`;
    case 5:
      return `http://example.com:${rng.pick(["0", "65536", "99999", "-1", "abc", ""])}/v1`;
    case 6:
      return rng.pick(["", " ", "http://", "http:///v1", "://example.com", "http://[", "http://a b/v1", "\u0000"]);
    case 7:
      return `http://example.com/v1?${"q=".repeat(rng.int(1, 500))}`;
    case 8:
      return `http://${generateUtf8String(rng)}.example.com/v1`;
    default:
      return `http://provider-${rng.int(0, 99)}.test:${rng.int(1024, 65535)}/v1`;
  }
}

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

const SQL_SHAPES = [
  "'; DROP TABLE identities; --",
  "' OR 1=1 --",
  '" OR "1"="1',
  "1; DELETE FROM providers",
  "') UNION SELECT * FROM sqlite_master --",
  "admin'--",
  "\\'; --",
];

const TRAVERSAL_SHAPES = [
  "../etc/passwd",
  "..\\windows\\system32",
  "%2e%2e%2fetc%2fpasswd",
  "....//....//etc/passwd",
  "/absolute/path",
  "a/../../b",
];

// Cyrillic а е о р с and Greek ο — visually ASCII, distinct code points.
const HOMOGLYPH_SHAPES = ["\u0430dmin", "prob\u0435-model", "r\u043eute", "\u03bfpenai", "\u0410BC", "\u0415"];

export function generateIdentifier(rng) {
  switch (rng.int(0, 9)) {
    case 0:
      return rng.pick(SQL_SHAPES);
    case 1:
      return rng.pick(TRAVERSAL_SHAPES);
    case 2:
      return rng.pick(HOMOGLYPH_SHAPES);
    case 3:
      return "a".repeat(rng.int(129, 400)); // past the documented identifier bound
    case 4:
      return rng.pick(["", " ", "-", "_", ".", "..", "-leading", "trailing-", "a b", "\t"]);
    case 5:
      return rng.pick(POLLUTION_KEYS);
    case 6:
      return `id-${rng.int(0, 9999)}\u0000suffix`;
    case 7:
      return generateUtf8String(rng);
    case 8:
      return rng.pick(["ROUTE", "Route", "rOuTe", "route "]); // case and whitespace variants
    default:
      return `id-${rng.int(0, 9999)}`;
  }
}

// ---------------------------------------------------------------------------
// SSE streams
// ---------------------------------------------------------------------------

export function generateSseStream(rng) {
  const chunks = [];
  const push = (text) => chunks.push(Buffer.from(text, "utf8"));

  switch (rng.int(0, 10)) {
    case 0:
      // [DONE] inside a JSON string: a naive scanner terminates the stream early here.
      push('data: {"choices":[{"delta":{"content":"the literal [DONE] token"}}]}\n\n');
      break;
    case 1:
      // Bare CR only: not a valid SSE line terminator.
      push(`data: partial\rdata: more\r`);
      break;
    case 2:
      push(`data: ${"x".repeat(64 * 1024 + 16)}\n\n`);
      break;
    case 3: {
      // Split mid-multibyte: the buffer ends on a UTF-8 lead byte.
      const head = Buffer.from('data: {"content":"', "utf8");
      chunks.push(Buffer.concat([head, Buffer.from([0xe2, 0x82])]));
      break;
    }
    case 4:
      push("data: no terminator");
      break;
    case 5:
      push(`data: {"a":1}\n`); // single newline: frame not complete
      break;
    case 6:
      push(":comment only\n\n");
      break;
    case 7:
      push("event: message\nid: 1\nretry: 100\ndata: {}\n\n");
      break;
    case 8:
      push("\n\n\n\n");
      break;
    case 9: {
      const frames = rng.int(1, 6);
      for (let i = 0; i < frames; i += 1) push(`data: {"i":${i}}\n\n`);
      push("data: [DONE]\n\n");
      break;
    }
    default:
      push(`data: ${JSON.stringify(generateJsonValue(rng)).slice(0, 4000)}\n\n`);
      break;
  }

  if (rng.bool()) {
    // Trail a UTF-8 lead byte so the mid-sequence split shape appears often enough for a
    // target to exercise it.
    chunks.push(Buffer.from([rng.pick([0xc2, 0xe2, 0xf0, 0xf4])]));
  }
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------------------
// Proxy handshakes
// ---------------------------------------------------------------------------

export function generateSocks5Handshake(rng) {
  switch (rng.int(0, 8)) {
    case 0:
      return Buffer.from([0x05, 0x01, 0x00]); // no auth
    case 1:
      return Buffer.from([0x05, 0x01, 0x02]); // username/password, RFC 1929
    case 2:
      return Buffer.from([0x05, 0xff, ...new Array(255).fill(0x00)]); // 255 methods
    case 3:
      return Buffer.from([0x04, 0x01, 0x00]); // SOCKS4 version
    case 4:
      return Buffer.from([0x00]);
    case 5:
      return Buffer.from([0x05]); // truncated: length announced, nothing follows
    case 6:
      return Buffer.from([0x05, 0x00]); // zero methods
    case 7:
      return Buffer.concat([Buffer.from([0x05, 0x01, 0x02]), rng.bytes(rng.int(1, 64))]);
    default:
      return rng.bytes(rng.int(1, 32));
  }
}

export function generateConnectHandshake(rng) {
  switch (rng.int(0, 8)) {
    case 0:
      return "CONNECT provider.test:443 HTTP/1.1\r\nHost: provider.test:443\r\n\r\n";
    case 1:
      return "CONNECT HTTP/1.1\r\n\r\n"; // no authority
    case 2:
      return `CONNECT ${rng.pick(BLOCKED_HOSTS)}:443 HTTP/1.1\r\n\r\n`;
    case 3:
      return "GET http://provider.test/ HTTP/1.1\r\n\r\n"; // wrong method for a tunnel
    case 4:
      return "CONNECT provider.test:443 HTTP/1.1\r\nProxy-Authorization: Basic \r\n\r\n";
    case 5:
      return `CONNECT ${"a".repeat(rng.int(200, 3000))}:443 HTTP/1.1\r\n\r\n`;
    case 6:
      return "\u0000\u0001garbage";
    case 7:
      return "connect provider.test:443 http/1.1\r\n\r\n"; // lowercase
    default:
      return `CONNECT provider-${rng.int(0, 99)}.test:${rng.int(1, 65535)} HTTP/1.1\r\n\r\n`;
  }
}

// ---------------------------------------------------------------------------
// SQLite-hostile strings
// ---------------------------------------------------------------------------

export function generateSqliteHostileString(rng) {
  switch (rng.int(0, 8)) {
    case 0:
      return rng.pick(SQL_SHAPES);
    case 1:
      return rng.pick(["PRAGMA journal_mode=DELETE", "pragma user_version=99", "ATTACH DATABASE ':memory:' AS x", "VACUUM"]);
    case 2:
      return "SELECT * FROM sqlite_master";
    case 3:
      return `value\u0000truncated`;
    case 4:
      return "x".repeat(rng.int(1, 4000));
    case 5:
      return rng.pick(['"quoted"', "'single'", "`backtick`", "[bracket]", "$param", "?1", ":named"]);
    case 6:
      return generateUtf8String(rng);
    case 7:
      return rng.pick(["", " ", "\n", ";", ";;", "--", "/*", "*/"]);
    default:
      return `row-${rng.int(0, 9999)}`;
  }
}

// ---------------------------------------------------------------------------
// Registry and corpus
// ---------------------------------------------------------------------------

/** Every generator, so `scripts/fuzz-run.mjs` can enumerate rather than hardcode. */
export const GENERATORS = Object.freeze([
  { name: "generateJsonValue", family: "json", generate: generateJsonValue },
  { name: "generateUtf8String", family: "utf8", generate: generateUtf8String },
  { name: "generateInvalidUtf8Bytes", family: "utf8", generate: generateInvalidUtf8Bytes },
  { name: "generateHeaderPair", family: "header", generate: generateHeaderPair },
  { name: "generateUrl", family: "url", generate: generateUrl },
  { name: "generateIdentifier", family: "identifier", generate: generateIdentifier },
  { name: "generateSseStream", family: "sse", generate: generateSseStream },
  { name: "generateSocks5Handshake", family: "socks5", generate: generateSocks5Handshake },
  { name: "generateConnectHandshake", family: "connect", generate: generateConnectHandshake },
  { name: "generateSqliteHostileString", family: "sqlite", generate: generateSqliteHostileString },
]);

/**
 * Family for a corpus path. The directory name is the family, which keeps the mapping
 * visible in the tree rather than in a lookup table that can drift from the files.
 */
function familyOf(path) {
  const rel = relative(CORPUS_DIR, path);
  const first = rel.split(/[/\\]/)[0];
  return first === rel ? "misc" : first;
}

/** Load every committed corpus file as `{ name, family, bytes }`. */
export function loadCorpus(dir = CORPUS_DIR) {
  const out = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (!entry.isFile()) continue;
      if (entry.name === "README.md") continue;
      const size = statSync(path).size;
      if (size === 0) continue; // .gitkeep and friends carry no case
      out.push({ name: relative(CORPUS_DIR, path), family: familyOf(path), bytes: readFileSync(path) });
    }
  };
  walk(dir);
  return out;
}

export { CORPUS_DIR };
