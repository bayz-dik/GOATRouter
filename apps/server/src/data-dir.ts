import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

/**
 * The single source of truth for where BAYZ keeps its data — Phase 9J Task 3.
 *
 * Before this file, `apps/server/src/config.ts` inlined `${homedir()}/.bayz`. That is one hardcoded
 * POSIX-flavoured path rather than a platform resolver: it happens to work on Windows, because
 * `homedir()` returns the profile directory, and it ignores `%LOCALAPPDATA%` and `$XDG_DATA_HOME`
 * entirely. `tests/portability.test.mjs` now asserts this is the only file in the repository that
 * asks the operating system where home is, so a second resolver cannot appear and drift.
 *
 * **The compatibility decision, stated rather than discovered later.** `~/.bayz` remains the default
 * on every platform. Changing it would orphan every existing install's database, and an operator
 * whose providers and encrypted credentials silently vanished after an upgrade would rightly call
 * that data loss — the DEKs live in that directory, so an abandoned database is not recoverable by
 * copying files around. The platform-appropriate paths are therefore a *fallback chain read in
 * order*: an existing `~/.bayz` always wins, and a platform path is used only when no `~/.bayz`
 * exists at all.
 *
 * Nothing here reads `process.platform`, `homedir()` at call time, or `process.env`. Every input is
 * injected, because a resolver that read the real ones would have exactly one testable branch — this
 * device's — and the Windows and macOS paths would ship having never been executed.
 */

/** Why the resolver chose the path it chose. Reported so an operator can see it in the log. */
export type DataDirReason =
  /** `BAYZ_DATA_DIR` was set. Wins over everything, including an existing directory. */
  | "BAYZ_DATA_DIR"
  /** A `~/.bayz` directory already exists. The backward-compatibility branch. */
  | "existing"
  /** No `~/.bayz`; the platform's conventional application-data path was used. */
  | "platform-default"
  /** No `~/.bayz` and the platform path was unavailable; fell back to `~/.bayz`. */
  | "home-default";

export type ResolvedDataDir = {
  readonly path: string;
  readonly reason: DataDirReason;
};

export type ResolveDataDirOptions = {
  readonly platform: string;
  readonly home: string;
  readonly env: Record<string, string | undefined>;
  /** Base for making a relative `BAYZ_DATA_DIR` absolute. Injected for the same reason as the rest. */
  readonly cwd?: string;
};

/** The legacy default, and still the default. */
export const LEGACY_DIRNAME = ".bayz";

/** The directory name used under a platform application-data root, where `.bayz` would look odd. */
const PLATFORM_DIRNAME = "bayz";

/**
 * Resolve the data directory from an injected platform, home directory, and environment.
 *
 * Order, and it is the order that matters:
 *
 * 1. `BAYZ_DATA_DIR`, made absolute. An empty or whitespace-only value is **refused**, not treated
 *    as absent — `BAYZ_DATA_DIR=` in a shell profile or a container spec is a mistake, and silently
 *    falling back would put the database somewhere the operator did not choose and then work
 *    perfectly, which is the hardest kind of misconfiguration to notice.
 * 2. An existing `~/.bayz`.
 * 3. The platform default: `%LOCALAPPDATA%\bayz` on Windows, `~/Library/Application Support/bayz` on
 *    macOS, `$XDG_DATA_HOME/bayz` or `~/.local/share/bayz` elsewhere.
 * 4. `~/.bayz`, when the platform default is unavailable — a Windows service account with no
 *    `%LOCALAPPDATA%`, for instance. Falling back keeps the daemon startable rather than failing on
 *    a missing variable.
 */
export function resolveDataDir(options: ResolveDataDirOptions): ResolvedDataDir {
  const { platform, home, env, cwd } = options;

  const override = env.BAYZ_DATA_DIR;
  if (override !== undefined) {
    if (override.trim().length === 0) {
      throw new Error("BAYZ_DATA_DIR is set but empty; unset it to use the default data directory");
    }
    const base = cwd ?? process.cwd();
    return {
      path: isAbsolute(override) ? override : resolve(base, override),
      reason: "BAYZ_DATA_DIR",
    };
  }

  /*
   * The backward-compatibility branch, and the load-bearing one.
   *
   * Checked before any platform path on every platform, including Windows and macOS. If either
   * preferred its own convention, that platform's existing installs would start from an empty
   * database with their credentials unreadable.
   */
  const legacy = join(home, LEGACY_DIRNAME);
  if (existsSync(legacy)) {
    return { path: legacy, reason: "existing" };
  }

  const platformPath = platformDefault(platform, home, env);
  if (platformPath !== undefined) {
    return { path: platformPath, reason: "platform-default" };
  }

  return { path: legacy, reason: "home-default" };
}

function platformDefault(
  platform: string,
  home: string,
  env: Record<string, string | undefined>,
): string | undefined {
  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA;
    if (localAppData === undefined || localAppData.trim().length === 0) {
      return undefined;
    }
    /*
     * Joined with a backslash explicitly rather than through `path.join`.
     *
     * `join` uses the separator of the *running* platform, so resolving a Windows path on this Linux
     * device would produce `C:\Users\x\AppData\Local/bayz`. That works on Windows in practice, but a
     * path that reads as half-POSIX in a log and in a test assertion is a path nobody can compare, so
     * the Windows branch builds a Windows path regardless of where it runs.
     */
    return `${localAppData.replace(/[\\/]+$/, "")}\\${PLATFORM_DIRNAME}`;
  }

  if (platform === "darwin") {
    return join(home, "Library", "Application Support", PLATFORM_DIRNAME);
  }

  /*
   * Everything else follows the XDG base directory specification, which is also correct for
   * Termux/Android: Android reports `linux` from `process.platform` and Termux sets no variable
   * worth branching on, so the primary platform deliberately takes the ordinary path. Nothing about
   * it is then untested elsewhere.
   *
   * A relative `XDG_DATA_HOME` must be treated as unset, per the specification. Honouring one would
   * place the database relative to the current working directory, so the daemon would find a
   * different database depending on where it was started from.
   */
  const xdg = env.XDG_DATA_HOME;
  if (xdg !== undefined && xdg.trim().length > 0 && isAbsolute(xdg)) {
    return join(xdg, PLATFORM_DIRNAME);
  }
  return join(home, ".local", "share", PLATFORM_DIRNAME);
}

/**
 * Resolve using this process's real platform, home directory, and environment.
 *
 * The one place the real values are read. Kept separate from `resolveDataDir` so the branch logic
 * stays fully injectable, and so this function is the only thing a test has to avoid calling.
 */
export function resolveRuntimeDataDir(
  env: Record<string, string | undefined> = process.env,
): ResolvedDataDir {
  return resolveDataDir({ platform: process.platform, home: homedir(), env });
}
