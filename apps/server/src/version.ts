import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The built-from and running package version.
 *
 * Loaded from the package manifest that actually ships with this module, so a
 * single source of truth produces `bayz --version` (the CLI bin's embedded
 * literal), the release artifact name, and `/api/health` alike. Reading the
 * manifest at import time — rather than embedding a build-time constant — keeps
 * the same code correct for a repository checkout, a `tsx` workspace run, and
 * a packed artifact, all of which carry `package.json` beside the code.
 *
 * The relative URL resolves against this module's own location in every
 * context: `../package.json` is `apps/server/package.json` in a `tsx`/source
 * run and `<pkg>/package.json` in the packed `dist/` artifact.
 */
function readVersion(): string {
  const manifestUrl = new URL("../package.json", import.meta.url);
  const manifest = JSON.parse(
    readFileSync(fileURLToPath(manifestUrl), "utf8"),
  ) as { version: string };
  const version = manifest.version;
  if (typeof version !== "string" || version.trim() === "") {
    throw new Error("package.json does not declare a usable version");
  }
  return version;
}

/** The package version this server was built from and is currently running. */
export const VERSION = readVersion();
