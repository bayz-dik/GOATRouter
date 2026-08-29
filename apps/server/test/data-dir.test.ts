import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveDataDir } from "../src/data-dir.js";

/**
 * Data directory resolution — 9J Task 3.
 *
 * Every branch is reachable because `resolveDataDir` takes the platform, home directory, and
 * environment as arguments rather than reading `process.platform`, `homedir()`, or `process.env`. A
 * resolver that read the real ones would have exactly one testable branch — this machine's — and the
 * Windows and macOS paths would ship unexecuted.
 *
 * The single most important assertion in this file is that an **existing `~/.bayz` always wins**. An
 * operator who upgrades and finds their providers, routes, and encrypted credentials gone because the
 * default moved would be right to call that data loss.
 */

/** A home directory that exists on disk, for the "does ~/.bayz exist" branch. */
function fixtureHome({ withBayz = false } = {}) {
  const home = mkdtempSync(join(tmpdir(), "bayz-home-"));
  if (withBayz) mkdirSync(join(home, ".bayz"), { recursive: true });
  return home;
}

test("BAYZ_DATA_DIR wins over everything", () => {
  const home = fixtureHome({ withBayz: true });
  const explicit = mkdtempSync(join(tmpdir(), "bayz-explicit-"));

  for (const platform of ["linux", "win32", "darwin", "android"]) {
    const resolved = resolveDataDir({
      platform,
      home,
      env: { BAYZ_DATA_DIR: explicit, LOCALAPPDATA: "C:\\Users\\x\\AppData\\Local", XDG_DATA_HOME: "/xdg" },
    });
    assert.equal(resolved.path, explicit, `explicit BAYZ_DATA_DIR ignored on ${platform}`);
    assert.equal(resolved.reason, "BAYZ_DATA_DIR", "the resolver does not report the override as the reason");
  }
});

test("an existing ~/.bayz wins over any platform default", () => {
  /*
   * **The backward-compatibility guard.**
   *
   * Every platform branch is exercised with an existing `~/.bayz` present. If any of them preferred
   * its platform path, that platform's existing installs would silently start from an empty database
   * — providers gone, routes gone, credentials unreadable because the DEKs live in the old file.
   */
  const home = fixtureHome({ withBayz: true });

  for (const platform of ["linux", "win32", "darwin", "android", "freebsd"]) {
    const resolved = resolveDataDir({
      platform,
      home,
      env: { LOCALAPPDATA: "C:\\Users\\x\\AppData\\Local", XDG_DATA_HOME: "/xdg" },
    });
    assert.equal(
      resolved.path,
      join(home, ".bayz"),
      `on ${platform} an existing ~/.bayz was abandoned for ${resolved.path} — this is data loss for every existing install`,
    );
    assert.equal(resolved.reason, "existing", "the resolver does not report that it found an existing directory");
  }
});

test("with no existing ~/.bayz, Windows yields %LOCALAPPDATA%/bayz", () => {
  const home = fixtureHome();
  const resolved = resolveDataDir({
    platform: "win32",
    home,
    env: { LOCALAPPDATA: "C:\\Users\\x\\AppData\\Local" },
  });
  assert.equal(resolved.path, "C:\\Users\\x\\AppData\\Local\\bayz");
  assert.equal(resolved.reason, "platform-default");
});

test("Windows without LOCALAPPDATA falls back to the home default", () => {
  /*
   * `%LOCALAPPDATA%` is normally set, but a service account or a stripped environment may not have
   * it. Falling back to `~/.bayz` keeps the daemon startable rather than failing on a missing
   * variable — the same path every other platform would use.
   */
  const home = fixtureHome();
  const resolved = resolveDataDir({ platform: "win32", home, env: {} });
  assert.equal(resolved.path, join(home, ".bayz"));
  assert.equal(resolved.reason, "home-default");
});

test("with no existing ~/.bayz, macOS yields ~/Library/Application Support/bayz", () => {
  const home = fixtureHome();
  const resolved = resolveDataDir({ platform: "darwin", home, env: {} });
  assert.equal(resolved.path, join(home, "Library", "Application Support", "bayz"));
  assert.equal(resolved.reason, "platform-default");
});

test("with no existing ~/.bayz, other platforms yield XDG_DATA_HOME/bayz", () => {
  const home = fixtureHome();
  const resolved = resolveDataDir({ platform: "linux", home, env: { XDG_DATA_HOME: "/xdg/data" } });
  assert.equal(resolved.path, join("/xdg/data", "bayz"));
  assert.equal(resolved.reason, "platform-default");
});

test("with no XDG_DATA_HOME, other platforms yield ~/.local/share/bayz", () => {
  const home = fixtureHome();
  const resolved = resolveDataDir({ platform: "linux", home, env: {} });
  assert.equal(resolved.path, join(home, ".local", "share", "bayz"));
  assert.equal(resolved.reason, "platform-default");
});

test("a relative XDG_DATA_HOME is ignored, per the XDG specification", () => {
  /*
   * The spec says a relative `XDG_DATA_HOME` must be treated as unset. Honouring one would put the
   * database somewhere relative to the current working directory, so the daemon would find a
   * different database depending on where it was started from — a genuinely confusing failure.
   */
  const home = fixtureHome();
  const resolved = resolveDataDir({ platform: "linux", home, env: { XDG_DATA_HOME: "relative/data" } });
  assert.equal(resolved.path, join(home, ".local", "share", "bayz"));
});

test("Termux/Android resolves like any other POSIX platform", () => {
  /*
   * Android reports `linux` from `process.platform`, and Termux sets no special variable worth
   * branching on. The primary platform deliberately takes the ordinary path rather than a special
   * case, so nothing about it is untested elsewhere.
   */
  const home = fixtureHome();
  const resolved = resolveDataDir({ platform: "linux", home, env: { PREFIX: "/data/data/com.termux/files/usr" } });
  assert.equal(resolved.path, join(home, ".local", "share", "bayz"));
});

test("a relative BAYZ_DATA_DIR is resolved to absolute", () => {
  const home = fixtureHome();
  const resolved = resolveDataDir({ platform: "linux", home, env: { BAYZ_DATA_DIR: "relative/bayz" }, cwd: "/work" });
  assert.equal(resolved.path, join("/work", "relative", "bayz"));
  assert.ok(resolved.path.startsWith("/"), "a relative override was not made absolute");
});

test("an empty-string BAYZ_DATA_DIR is refused rather than treated as absent", () => {
  /*
   * `BAYZ_DATA_DIR=` in a shell profile or a container spec is a mistake, not a request for the
   * default. Silently falling back would put the database somewhere the operator did not choose and
   * then work perfectly, which is the hardest kind of misconfiguration to notice.
   */
  const home = fixtureHome();
  for (const value of ["", "   ", "\t"]) {
    assert.throws(
      () => resolveDataDir({ platform: "linux", home, env: { BAYZ_DATA_DIR: value } }),
      /BAYZ_DATA_DIR/,
      `an empty BAYZ_DATA_DIR (${JSON.stringify(value)}) was accepted`,
    );
  }
});

test("the resolver reports its choice as metadata, never a secret", () => {
  const home = fixtureHome({ withBayz: true });
  const resolved = resolveDataDir({ platform: "linux", home, env: {} });
  /*
   * The plan requires the resolver to log which path it chose so an operator can see it. The shape
   * is `{ path, reason }` — a path and an enum, no environment dump, since a naive "log the env I
   * used" would put `BAYZ_MASTER_KEY` in a log file.
   */
  assert.deepEqual(Object.keys(resolved).sort(), ["path", "reason"]);
  assert.ok(["BAYZ_DATA_DIR", "existing", "platform-default", "home-default"].includes(resolved.reason));
});

test("the resolver never reads the real platform, home, or environment", () => {
  /*
   * Enforced by behaviour, not by reading the source: the same call with a fabricated platform must
   * return that platform's answer regardless of where this test is running. If the resolver consulted
   * `process.platform`, every branch below would return the Linux answer on this device.
   */
  const home = fixtureHome();
  const windows = resolveDataDir({ platform: "win32", home, env: { LOCALAPPDATA: "C:\\AppData" } });
  const macos = resolveDataDir({ platform: "darwin", home, env: {} });
  assert.equal(windows.path, "C:\\AppData\\bayz");
  assert.equal(macos.path, join(home, "Library", "Application Support", "bayz"));
  assert.notEqual(windows.path, macos.path, "the resolver ignored the injected platform");
});
