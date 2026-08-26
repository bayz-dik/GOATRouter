import { RouterError } from "./errors.js";

/**
 * Model ids reach an upstream URL path and every log line, so the alphabet is
 * conservative: vendor-prefixed names (`anthropic/claude-3.5-sonnet`), tag
 * suffixes (`llama3:8b`), and dotted versions are all real, but whitespace,
 * control characters, URL punctuation, and traversal are not.
 */
const MODEL_ID_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._:/-]{0,126}[A-Za-z0-9])?$/;
const MAX_MODEL_LENGTH = 128;

export function isModelId(model: unknown): model is string {
  return (
    typeof model === "string" &&
    model.length > 0 &&
    model.length <= MAX_MODEL_LENGTH &&
    MODEL_ID_RE.test(model) &&
    !model.includes("..") &&
    // `//` and `:/` would let a model name look like a URL. Since the name is
    // appended to a provider base URL, either form could redirect the request
    // away from the endpoint the operator approved.
    !model.includes("//") &&
    !model.includes(":/")
  );
}

export function assertModelId(model: unknown): string {
  if (!isModelId(model)) {
    throw new RouterError("invalid_model", "model-id");
  }
  return model;
}

/**
 * Validate a route pattern: an exact model id, or one with a single trailing `*`.
 *
 * Deliberately not a regex and not a glob. An operator-supplied regex is a
 * denial-of-service surface (catastrophic backtracking), and a general glob adds
 * matching ambiguity for no real use case. A bare `*` is refused because a route
 * that swallows every model is almost never what an operator means, and it would
 * silently shadow every specific binding.
 */
export function assertModelPattern(pattern: unknown): string {
  if (typeof pattern !== "string") {
    throw new RouterError("invalid_route_config", "pattern-type");
  }
  if (pattern.endsWith("*")) {
    const prefix = pattern.slice(0, -1);
    if (prefix.length === 0 || !isModelId(prefix)) {
      throw new RouterError("invalid_route_config", "pattern-prefix");
    }
    return pattern;
  }
  if (!isModelId(pattern)) {
    throw new RouterError("invalid_route_config", "pattern-exact");
  }
  return pattern;
}

/** Match a model against a pattern by literal comparison, never by regex. */
export function matchesModelPattern(pattern: string, model: string): boolean {
  const validPattern = assertModelPattern(pattern);
  const validModel = assertModelId(model);
  return validPattern.endsWith("*")
    ? validModel.startsWith(validPattern.slice(0, -1))
    : validModel === validPattern;
}

/**
 * Rank a pattern so an exact binding always beats a wildcard.
 *
 * The offset guarantees specificity ordering does not depend on name length: a
 * short exact model still outranks a long prefix, which is what an operator
 * expects when they pin one model explicitly.
 */
export function patternSpecificity(pattern: string): number {
  const validPattern = assertModelPattern(pattern);
  return validPattern.endsWith("*")
    ? validPattern.length - 1
    : MAX_MODEL_LENGTH + 1;
}
