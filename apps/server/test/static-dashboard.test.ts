import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildApp } from "../src/app.js";

test("serves the dashboard and keeps API 404 responses as JSON", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bayz-dashboard-"));
  await writeFile(join(root, "index.html"), "<h1>Bayz Runtime</h1>");
  const app = buildApp({ logger: false, dashboardRoot: root });
  t.after(() => app.close());

  const page = await app.inject({ method: "GET", url: "/" });
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /Bayz Runtime/);

  const api = await app.inject({ method: "GET", url: "/api/missing" });
  assert.equal(api.statusCode, 404);
  assert.match(api.headers["content-type"] ?? "", /^application\/json/);
});
