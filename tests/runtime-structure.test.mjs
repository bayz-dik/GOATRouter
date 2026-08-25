import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("root package exposes the complete private runtime gates", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url)));
  assert.deepEqual(pkg.workspaces, ["apps/*", "packages/*"]);
  assert.equal(typeof pkg.scripts["runtime:test"], "string");
  assert.equal(typeof pkg.scripts["runtime:build"], "string");
  assert.equal(
    pkg.scripts["runtime:verify"],
    "npm run runtime:test && npm run runtime:build",
  );
});
