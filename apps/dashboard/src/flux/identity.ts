import type { FluxProvider } from "./types";

/**
 * Provider identity for the constellation.
 *
 * Every field here is display-safe by construction. Nothing derives from a
 * credential, a password, a token, or any secret-store value, and the short id is
 * computed from the provider id alone — a test pins that by changing every other
 * field and asserting the short id is unchanged.
 */

/**
 * Local icon table.
 *
 * Icons are referenced by key and drawn from local definitions only. A
 * provider-supplied SVG, URL, or data URI is never rendered: that would turn
 * provider metadata into an injection surface and a remote dependency at once.
 */
export const ICON_KEYS = [
  "openrouter",
  "gemini",
  "codex",
  "tabitoken",
  "openai",
  "anthropic",
  "custom",
  "generic",
] as const;

export type FluxIconKey = (typeof ICON_KEYS)[number];

const ICON_SET = new Set<string>(ICON_KEYS);

/** Display cap for a compact label; identity survives via the short id. */
const COMPACT_LABEL_MAX = 24;

export type ProviderIdentity = {
  id: string;
  displayName: string;
  /** Always a known local key; never provider-controlled markup. */
  iconKey: FluxIconKey;
  /** Two-letter monochrome fallback mark. */
  initials: string;
  /** Stable, non-secret, human-readable disambiguator. */
  shortId: string;
  /** True when another provider shares this display name. */
  requiresShortId: boolean;
  /** Display name, suffixed with the short id only when ambiguous. */
  uniqueLabel: string;
  /** Length-capped label for dense zoom levels. */
  compactLabel: string;
};

/**
 * FNV-1a over the provider id.
 *
 * A hash rather than a slice so two ids sharing a prefix still differ, and
 * deterministic so the same provider always shows the same badge across reloads
 * and across machines.
 */
export function shortId(id: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < id.length; index += 1) {
    hash ^= id.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `PVD-${(hash & 0xffff).toString(16).toUpperCase().padStart(4, "0")}`;
}

/**
 * Two-letter mark from a display name.
 *
 * Non-alphanumeric characters are dropped rather than escaped, so a name made
 * entirely of punctuation or markup still yields a readable mark instead of
 * leaking its shape into the badge.
 */
export function initialsOf(displayName: string): string {
  const words = displayName
    .split(/[^A-Za-z0-9]+/)
    .filter((word) => word.length > 0);
  if (words.length === 0) {
    return "PV";
  }
  if (words.length === 1) {
    return words[0]!.slice(0, 2).toUpperCase().padEnd(2, "V");
  }
  return (words[0]![0]! + words[1]![0]!).toUpperCase();
}

function resolveIconKey(provider: FluxProvider): FluxIconKey {
  const key = provider.iconKey;
  if (typeof key === "string" && ICON_SET.has(key)) {
    return key as FluxIconKey;
  }
  // Anything unrecognized — including a URL, a data URI, or embedded markup —
  // collapses to the generic mark and never reaches the DOM as a source.
  return "generic";
}

export function providerIdentity(
  provider: FluxProvider,
  all: readonly FluxProvider[],
): ProviderIdentity {
  const displayName = provider.displayName;
  const badge = shortId(provider.id);
  const duplicates = all.filter(
    (candidate) => candidate.displayName === displayName,
  ).length;
  const requiresShortId = duplicates > 1;

  const uniqueLabel = requiresShortId ? `${displayName} — ${badge}` : displayName;
  const compactLabel =
    uniqueLabel.length > COMPACT_LABEL_MAX
      ? `${uniqueLabel.slice(0, COMPACT_LABEL_MAX - 1)}…`
      : uniqueLabel;

  return {
    id: provider.id,
    displayName,
    iconKey: resolveIconKey(provider),
    initials: initialsOf(displayName),
    shortId: badge,
    requiresShortId,
    uniqueLabel,
    compactLabel,
  };
}
