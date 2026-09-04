import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const { hasRemoteLoadReference } = await import(join(root, "scripts/remote-load.mjs"));

/**
 * Regression coverage for the install-smoke "loads no remote origin" check.
 *
 * The old smoke regex matched bare hostnames anywhere in the bundle, so the
 * dashboard's provider-kind classifier (`/generativelanguage\.googleapis\.com$/`
 * for Gemini) tripped it even though nothing is fetched. These tests pin the
 * distinction: provider-family and placeholder strings stay green, while real
 * load forms (script src, link href, CSS import/url, dynamic import, fetch)
 * are still detected.
 */

test("provider-family classifier strings do not count as remote loads", () => {
  // The exact classifier that caused the false positive, as it appears in the
  // bundled dashboard source (ProvidersPanel.tsx).
  assert.equal(
    hasRemoteLoadReference("[/(^\\.)generativelanguage\\.googleapis\\.com$/, `gemini`]"),
    false,
    "the Gemini provider classifier must not be treated as a remote load",
  );
  assert.equal(hasRemoteLoadReference("googleapis"), false);
  assert.equal(hasRemoteLoadReference("gstatic"), false);
  assert.equal(hasRemoteLoadReference("unpkg"), false);
  assert.equal(hasRemoteLoadReference("cdn.jsdelivr"), false);
});

test("placeholder and help URLs are inert data, not loads", () => {
  assert.equal(hasRemoteLoadReference("https://react.dev/errors/1"), false);
  assert.equal(hasRemoteLoadReference("https://api.example.com/v1"), false);
  assert.equal(hasRemoteLoadReference("https://json-schema.org/draft/2020-12/schema"), false);
});

test("real remote load forms are still detected", () => {
  assert.equal(hasRemoteLoadReference('<script src="https://cdn.example.com/app.js"></script>'), true);
  assert.equal(hasRemoteLoadReference('<link href="https://fonts.example.com/x.css" rel="stylesheet">'), true);
  assert.equal(hasRemoteLoadReference("@import url(https://cdn.example.com/x.css);"), true);
  assert.equal(hasRemoteLoadReference('fetch("https://evil.example.com/api")'), true);
  assert.equal(hasRemoteLoadReference('import("https://evil.example.com/mod.js")'), true);
});

test("the served dashboard bundle contains no remote load reference", () => {
  const assets = readdirSync(join(root, "apps/dashboard/dist/assets"));
  const bundle = assets.find((name) => name.endsWith(".js"));
  assert.ok(bundle, "no dashboard JS bundle found in dist/assets");
  const text = readFileSync(join(root, "apps/dashboard/dist/assets", bundle), "utf8");
  assert.equal(
    hasRemoteLoadReference(text),
    false,
    "the packaged dashboard bundle must not load any remote resource",
  );
});
