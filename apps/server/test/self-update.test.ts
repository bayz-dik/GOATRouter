import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  compareVersions,
  isNewer,
  checksumFor,
  fetchLatestRelease,
  fetchReleaseForVersion,
} from "../src/self-update.js";

/** Read the bound port from a listening HTTP server. */
function portOf(server: Server): number {
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("server not listening on a numeric port");
  }
  return address.port;
}

/**
 * Release-based update logic — Phase: release update.
 *
 * The pure logic (semver, checksum parsing, release-feed parsing) is exercised
 * here against a real local HTTP server so no external network is needed and the
 * exact release shape is controlled. The install/rollback path is exercised by
 * the pack/install smokes against the real artifact.
 */

test("semver comparison is numeric, not lexical", () => {
  assert.equal(compareVersions("0.1.9", "0.1.10"), -1);
  assert.equal(compareVersions("0.1.10", "0.2.0"), -1);
  assert.equal(compareVersions("0.9.0", "1.0.0"), -1);
  assert.equal(compareVersions("1.2.3", "1.2.3"), 0);
  assert.equal(compareVersions("0.2.0", "0.1.10"), 1);
  assert.equal(compareVersions("v0.1.0", "0.1.0"), 0);
});

test("prerelease versions are never treated as newer stable", () => {
  assert.equal(compareVersions("0.1.0-alpha", "0.1.0"), -1);
  assert.equal(compareVersions("0.1.0", "0.1.0-alpha"), 1);
  assert.equal(isNewer("0.1.0-alpha", "0.1.0"), false);
  assert.equal(isNewer("0.1.0", "0.1.0-alpha"), true);
});

test("isNewer only reports strictly newer versions", () => {
  assert.equal(isNewer("0.1.10", "0.1.9"), true);
  assert.equal(isNewer("0.1.9", "0.1.10"), false);
  assert.equal(isNewer("0.1.0", "0.1.0"), false);
});

test("checksumFor parses the SHA256SUMS format", () => {
  const text = [
    "1a3cb5672486ca0dd7a73265fd01ca73d5abfb533266cb82257539bbc7df28c8  bayz-router-0.1.0.tgz",
    "",
    "0000000000000000000000000000000000000000000000000000000000000000  other.tgz",
  ].join("\n");
  assert.equal(
    checksumFor(text, "bayz-router-0.1.0.tgz"),
    "1a3cb5672486ca0dd7a73265fd01ca73d5abfb533266cb82257539bbc7df28c8",
  );
  assert.equal(checksumFor(text, "missing.tgz"), undefined);
});

test("fetchLatestRelease picks the newest stable release and its assets", async () => {
  const server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify([
        {
          tag_name: "v0.2.0",
          draft: false,
          prerelease: false,
          assets: [
            { name: "bayz-router-0.2.0.tgz" },
            { name: "SHA256SUMS.txt" },
          ],
        },
        {
          tag_name: "v0.1.0",
          draft: false,
          prerelease: false,
          assets: [
            { name: "bayz-router-0.1.0.tgz" },
            { name: "SHA256SUMS.txt" },
          ],
        },
      ]),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = portOf(server);
  try {
    const release = await fetchLatestRelease({
      apiBase: `http://127.0.0.1:${port}`,
      downloadBase: `http://127.0.0.1:${port}/download`,
    });
    assert.equal(release.version, "0.2.0");
    assert.equal(release.artifactName, "bayz-router-0.2.0.tgz");
    assert.equal(release.downloadUrl, `http://127.0.0.1:${port}/download/v0.2.0/bayz-router-0.2.0.tgz`);
    assert.equal(release.checksumUrl, `http://127.0.0.1:${port}/download/v0.2.0/SHA256SUMS.txt`);
  } finally {
    server.close();
  }
});

test("fetchLatestRelease skips drafts and prereleases", async () => {
  const server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify([
        {
          tag_name: "v0.3.0-rc.1",
          draft: false,
          prerelease: true,
          assets: [{ name: "bayz-router-0.3.0-rc.1.tgz" }, { name: "SHA256SUMS.txt" }],
        },
        {
          tag_name: "v0.2.0",
          draft: false,
          prerelease: false,
          assets: [{ name: "bayz-router-0.2.0.tgz" }, { name: "SHA256SUMS.txt" }],
        },
      ]),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = portOf(server);
  try {
    const release = await fetchLatestRelease({ apiBase: `http://127.0.0.1:${port}` });
    assert.equal(release.version, "0.2.0");
  } finally {
    server.close();
  }
});

test("fetchReleaseForVersion returns the exact version's assets", async () => {
  const server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        tag_name: "v0.1.0",
        assets: [{ name: "bayz-router-0.1.0.tgz" }, { name: "SHA256SUMS.txt" }],
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = portOf(server);
  try {
    const release = await fetchReleaseForVersion("0.1.0", {
      apiBase: `http://127.0.0.1:${port}`,
      downloadBase: `http://127.0.0.1:${port}/download`,
    });
    assert.equal(release.version, "0.1.0");
    assert.equal(release.downloadUrl, `http://127.0.0.1:${port}/download/v0.1.0/bayz-router-0.1.0.tgz`);
  } finally {
    server.close();
  }
});

test("a release missing its checksum asset is refused", async () => {
  const server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify([
        {
          tag_name: "v0.2.0",
          draft: false,
          prerelease: false,
          assets: [{ name: "bayz-router-0.2.0.tgz" }],
        },
      ]),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = portOf(server);
  try {
    await assert.rejects(
      fetchLatestRelease({ apiBase: `http://127.0.0.1:${port}` }),
      /missing its artifact or checksum asset/,
    );
  } finally {
    server.close();
  }
});
