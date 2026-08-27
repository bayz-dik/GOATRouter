import { MODEL_LIMIT_MAX, type ProviderConfig } from "./config.js";
import { classifyModelEconomics, type ModelEconomics } from "./economics.js";
import { ProviderError } from "./errors.js";
import type { ProviderKind } from "./url.js";

/**
 * Model ids are echoed into later routing decisions and log lines, so only a
 * conservative slug alphabet is accepted. An entry that fails is skipped rather
 * than fatal: one malformed row in a long upstream list must not deny the
 * operator the rest of the catalogue.
 */
const MODEL_ID_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._\-/:]{0,126}[A-Za-z0-9])?$/;

export type DiscoveryTarget = {
  kind: ProviderKind;
  baseUrl: string;
  config: ProviderConfig;
};

export function isUsableModelId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 128 &&
    MODEL_ID_RE.test(value) &&
    !value.includes("..")
  );
}

/** Build the discovery URL from an already-normalized base plus a safe path. */
export function discoveryUrl(target: DiscoveryTarget): string {
  return `${target.baseUrl.replace(/\/+$/, "")}${target.config.discoveryPath}`;
}

/**
 * Collapse an untrusted candidate list into a bounded, deduplicated result.
 *
 * The cap is `min(configured, MODEL_LIMIT_MAX)` so a hostile upstream cannot
 * inflate memory or downstream UI regardless of what the operator configured.
 */
export function collectModelIds(
  candidates: readonly unknown[],
  limit: number,
): string[] {
  const cap = Math.min(limit, MODEL_LIMIT_MAX);
  const seen = new Set<string>();
  const models: string[] = [];
  for (const candidate of candidates) {
    if (!isUsableModelId(candidate) || seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    models.push(candidate);
    if (models.length >= cap) {
      break;
    }
  }
  if (models.length === 0) {
    throw new ProviderError("discovery_failed", "no-usable-models");
  }
  return models;
}

/** One discovered model and what it costs, as far as the catalogue proves. */
export type ModelCatalogueEntry = {
  id: string;
  economics: ModelEconomics;
};

/**
 * A candidate paired with the raw entry it came from.
 *
 * The pairing exists so one collector can serve both the id-only and the
 * economics-bearing path. Two collectors would eventually disagree about which models
 * exist, and a disagreement means the UI can offer a model routing cannot reach.
 */
export type ModelCandidate = {
  /** The extracted id, still untrusted. */
  id: unknown;
  /** The raw catalogue entry. Never escapes the classifier. */
  entry: unknown;
};

/**
 * Collapse candidates into a bounded, deduplicated catalogue.
 *
 * Deliberately the *same* filter, cap, and dedupe rule as `collectModelIds`, applied
 * by shared code rather than by two similar loops. First-seen wins on a duplicate,
 * exactly as it does there, or the two paths would report different economics for one
 * id.
 */
export function collectModelCatalogue(
  candidates: readonly ModelCandidate[],
  limit: number,
  classify: (entry: unknown) => ModelEconomics,
): ModelCatalogueEntry[] {
  const cap = Math.min(limit, MODEL_LIMIT_MAX);
  const seen = new Set<string>();
  const entries: ModelCatalogueEntry[] = [];
  for (const candidate of candidates) {
    if (!isUsableModelId(candidate.id) || seen.has(candidate.id)) {
      continue;
    }
    seen.add(candidate.id);
    entries.push({ id: candidate.id, economics: classify(candidate.entry) });
    if (entries.length >= cap) {
      break;
    }
  }
  if (entries.length === 0) {
    throw new ProviderError("discovery_failed", "no-usable-models");
  }
  return entries;
}

/** The classifier bound to one provider's kind and loopback posture. */
export function economicsClassifierFor(target: {
  kind: ProviderKind;
  config: ProviderConfig;
}): (entry: unknown) => ModelEconomics {
  const allowLoopback = target.config.allowLoopback === true;
  return (entry) =>
    classifyModelEconomics({ kind: target.kind, entry, allowLoopback });
}

/** Reject a blank credential the same way as a missing one. */
export function requireCredential(
  credential: string | undefined,
  stage: string,
): string {
  if (typeof credential !== "string" || credential.trim().length === 0) {
    throw new ProviderError("credential_missing", stage);
  }
  return credential;
}
