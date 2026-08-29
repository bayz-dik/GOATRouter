/**
 * One-shot writer for the committed Phase 9I fuzz corpus.
 *
 * Kept in the repository rather than run ad hoc so the corpus can be regenerated and
 * reviewed: each case is a hand-written minimised input tied to a documented BAYZ rule, not
 * a random dump. Task 3 adds discovered cases under `corpus/regression/`.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CORPUS = join(dirname(fileURLToPath(import.meta.url)), "corpus");

/** family/name -> bytes */
const CASES = new Map();

function put(family, name, value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  if (bytes.length > 64 * 1024) throw new Error(`${family}/${name} is ${bytes.length} bytes, over the 64 KiB bound`);
  CASES.set(`${family}/${name}`, bytes);
}

// --- json: prototype pollution, depth, width, awkward scalars ---------------
put("json", "proto-key.json", '{"__proto__":{"polluted":true}}');
put("json", "constructor-key.json", '{"constructor":{"prototype":{"polluted":true}}}');
put("json", "nested-proto.json", '{"messages":[{"role":"user","content":"hi","__proto__":{"x":1}}]}');
put("json", "duplicate-keys.json", '{"model":"a","model":"b"}');
put("json", "deep-64.json", (() => {
  let s = '{"leaf":true}';
  for (let i = 0; i < 64; i += 1) s = i % 2 === 0 ? `[${s}]` : `{"n":${s}}`;
  return s;
})());
put("json", "wide-10000.json", `[${new Array(10_000).fill("0").join(",")}]`);
put("json", "numeric-edges.json", '{"a":1e400,"b":-0,"c":1e-323,"d":9007199254740993}');
put("json", "nan-strings.json", '{"a":"NaN","b":"Infinity","c":"-Infinity","d":"undefined"}');
put("json", "empty-keys.json", '{"":1," ":2,"\\u0000":3}');
put("json", "lone-surrogate.json", '{"s":"\\ud800"}');
put("json", "nul-in-string.json", '{"s":"a\\u0000b"}');
put("json", "not-json.json", "{model: 'probe', }");
put("json", "bare-scalar.json", "42");
put("json", "bare-string.json", '"just a string"');
put("json", "empty.json", "");

// --- url: the encodings 9D/9F refuse ---------------------------------------
put("url", "loopback-decimal.txt", "http://2130706433:20128/v1/chat/completions");
put("url", "loopback-octal.txt", "http://0177.0.0.1:20128/v1");
put("url", "loopback-hex.txt", "http://0x7f.0.0.1:20128/v1");
put("url", "loopback-short.txt", "http://127.1/v1");
put("url", "loopback-ipv6.txt", "http://[::ffff:127.0.0.1]/v1");
put("url", "metadata-aws.txt", "http://169.254.169.254/latest/meta-data/");
put("url", "metadata-gcp.txt", "http://metadata.google.internal/computeMetadata/v1/");
put("url", "link-local-v6.txt", "http://[fe80::1]/v1");
put("url", "private-10.txt", "http://10.0.0.1/v1");
put("url", "private-172.txt", "http://172.16.0.1/v1");
put("url", "cgnat.txt", "http://100.64.0.1/v1");
put("url", "userinfo-decoy.txt", "http://api.openai.com@127.0.0.1/v1");
put("url", "scheme-file.txt", "file://127.0.0.1/etc/passwd");
put("url", "scheme-gopher.txt", "gopher://127.0.0.1:70/1");
put("url", "port-overflow.txt", "http://example.com:65536/v1");
put("url", "dns-rebind.txt", "http://127.0.0.1.nip.io/v1");

// --- identifier: SQL, traversal, homoglyph, bounds -------------------------
put("identifier", "sql-drop.txt", "'; DROP TABLE identities; --");
put("identifier", "sql-or-true.txt", "' OR 1=1 --");
put("identifier", "sql-union.txt", "') UNION SELECT * FROM sqlite_master --");
put("identifier", "traversal-posix.txt", "../etc/passwd");
put("identifier", "traversal-encoded.txt", "%2e%2e%2fetc%2fpasswd");
put("identifier", "homoglyph-cyrillic.txt", "prob\u0435-model");
put("identifier", "homoglyph-greek.txt", "\u03bfpenai");
put("identifier", "proto-key.txt", "__proto__");
put("identifier", "overlong.txt", "a".repeat(400));
put("identifier", "empty.txt", "");
put("identifier", "whitespace.txt", " \t\n ");
put("identifier", "nul-suffix.txt", "route\u0000suffix");

// --- sse: 9B framing ------------------------------------------------------
put("sse", "done-inside-string.txt", 'data: {"choices":[{"delta":{"content":"a literal [DONE] token"}}]}\n\n');
put("sse", "bare-cr.txt", "data: partial\rdata: more\r");
put("sse", "unterminated.txt", "data: no terminator");
put("sse", "single-newline.txt", 'data: {"a":1}\n');
put("sse", "comment-only.txt", ":comment\n\n");
put("sse", "blank-frames.txt", "\n\n\n\n");
put("sse", "split-utf8.bin", Buffer.concat([Buffer.from('data: {"content":"', "utf8"), Buffer.from([0xe2, 0x82])]));
put("sse", "long-line.txt", `data: ${"x".repeat(64 * 1000)}\n\n`);
put("sse", "full-fields.txt", "event: message\nid: 1\nretry: 100\ndata: {}\n\ndata: [DONE]\n\n");

// --- header: splitting and bounds -----------------------------------------
put("header", "crlf-injection.txt", "x-test: ok\r\nx-injected: yes");
put("header", "lf-injection.txt", "x-test: ok\nx-injected: yes");
put("header", "empty-name.txt", ": value");
put("header", "colon-in-name.txt", "x-bad:name: value");
put("header", "nul-in-name.txt", "x-\u0000name: value");
put("header", "spaces-value.txt", `authorization: ${" ".repeat(10_000)}`);
put("header", "overlong-value.txt", `x-big: ${"x".repeat(12_000)}`);
put("header", "duplicate-content-length.txt", "content-length: 10\r\ncontent-length: 20");
put("header", "conflicting-transfer.txt", "transfer-encoding: chunked\r\ncontent-length: 5");

// --- socks5 / connect: proxy handshakes -----------------------------------
put("socks5", "no-auth.bin", Buffer.from([0x05, 0x01, 0x00]));
put("socks5", "userpass.bin", Buffer.from([0x05, 0x01, 0x02]));
put("socks5", "wrong-version.bin", Buffer.from([0x04, 0x01, 0x00]));
put("socks5", "truncated.bin", Buffer.from([0x05]));
put("socks5", "zero-methods.bin", Buffer.from([0x05, 0x00]));
put("socks5", "max-methods.bin", Buffer.from([0x05, 0xff, ...new Array(255).fill(0x00)]));
put("connect", "valid.txt", "CONNECT provider.test:443 HTTP/1.1\r\nHost: provider.test:443\r\n\r\n");
put("connect", "no-authority.txt", "CONNECT HTTP/1.1\r\n\r\n");
put("connect", "loopback-target.txt", "CONNECT 127.0.0.1:20128 HTTP/1.1\r\n\r\n");
put("connect", "empty-basic.txt", "CONNECT provider.test:443 HTTP/1.1\r\nProxy-Authorization: Basic \r\n\r\n");
put("connect", "wrong-method.txt", "GET http://provider.test/ HTTP/1.1\r\n\r\n");
put("connect", "overlong-authority.txt", `CONNECT ${"a".repeat(3000)}:443 HTTP/1.1\r\n\r\n`);

// --- sqlite ---------------------------------------------------------------
put("sqlite", "pragma-journal.txt", "PRAGMA journal_mode=DELETE");
put("sqlite", "pragma-user-version.txt", "pragma user_version=99");
put("sqlite", "attach.txt", "ATTACH DATABASE ':memory:' AS x");
put("sqlite", "master-select.txt", "SELECT * FROM sqlite_master");
put("sqlite", "nul-truncate.txt", "value\u0000truncated");
put("sqlite", "quotes.txt", "\"quoted\" 'single' `backtick` [bracket]");
put("sqlite", "params.txt", "$param ?1 :named");
put("sqlite", "comment-open.txt", "/* unterminated");

// --- utf8 -----------------------------------------------------------------
put("utf8", "combining.txt", "e\u0301a\u0300o\u036f");
put("utf8", "bidi-override.txt", "\u202egnirts desrever\u202c");
put("utf8", "zero-width.txt", "a\u200b\u200c\u200db");
put("utf8", "astral.txt", "\u{1f600}\u{10ffff}");
put("utf8", "bom.txt", "\ufeffleading bom");
put("utf8", "scripts.txt", "日本語 العربية русский ελληνικά עברית ไทย");
put("utf8", "truncated-2byte.bin", Buffer.from([0xc3]));
put("utf8", "truncated-3byte.bin", Buffer.from([0xe2, 0x82]));
put("utf8", "lone-continuation.bin", Buffer.from([0x80]));
put("utf8", "overlong-nul.bin", Buffer.from([0xc0, 0x80]));
put("utf8", "surrogate-encoded.bin", Buffer.from([0xed, 0xa0, 0x80]));
put("utf8", "beyond-max.bin", Buffer.from([0xf5, 0x80, 0x80, 0x80]));

let total = 0;
for (const [rel, bytes] of CASES) {
  const path = join(CORPUS, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
  total += bytes.length;
}

mkdirSync(join(CORPUS, "regression"), { recursive: true });

if (total > 2 * 1024 * 1024) throw new Error(`corpus totals ${total} bytes, over the 2 MiB bound`);
process.stdout.write(`wrote ${CASES.size} corpus files, ${total} bytes total\n`);
