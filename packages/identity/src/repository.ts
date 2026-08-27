import type { SqlDatabase } from "@bayz/storage";
import { IdentityError, asIdentityError } from "./errors.js";
import { assertScopes, type ClientScope } from "./scopes.js";

const IDENTITY_ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const MAX_DISPLAY_NAME_LENGTH = 128;
const MAX_ROUTE_LENGTH = 256;
/** Presets are 9A's configuration names; an unknown one is a caller bug. */
const PRESET_NAMES = new Set(["opencode", "hermes", "antigravity", "generic-openai"]);

const AUDIT_ACTIONS = new Set([
  "created",
  "authenticated",
  "rejected",
  "rotated",
  "revoked",
  "updated",
  "deleted",
  "authorized",
  "denied",
]);
const AUDIT_OUTCOMES = new Set(["allowed", "denied", "ok", "failed"]);

/** Keep the audit bounded, reusing the Phase 8 count-retention pattern. */
export const DEFAULT_AUDIT_RETENTION = 1000;

export type IdentityAuditAction =
  | "created"
  | "authenticated"
  | "rejected"
  | "rotated"
  | "revoked"
  | "updated"
  | "deleted"
  | "authorized"
  | "denied";

export type IdentityAuditOutcome = "allowed" | "denied" | "ok" | "failed";

/**
 * What a caller may see about an identity.
 *
 * There is deliberately no key field, no hash, and no fingerprint. A fingerprint
 * would be tempting for a UI but it is a verifier for an offline guessing attack
 * against a 32-byte key, and the display name already gives the operator what they
 * need to tell two identities apart.
 */
export type IdentityView = {
  id: string;
  displayName: string;
  scopes: ClientScope[];
  preset: string | undefined;
  revoked: boolean;
  expiresAt: string | undefined;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | undefined;
};

export type CreateIdentityInput = {
  id: string;
  displayName: string;
  scopes: readonly string[];
  preset?: string;
  expiresAt?: string;
};

export type UpdateIdentityInput = {
  displayName?: string;
  scopes?: readonly string[];
  expiresAt?: string | null;
};

export type IdentityAuditInput = {
  identityId: string;
  action: IdentityAuditAction;
  outcome: IdentityAuditOutcome;
  scope?: string;
  route?: string;
};

export type IdentityAuditRecord = {
  occurredAt: string;
  identityId: string;
  action: string;
  scope: string | undefined;
  route: string | undefined;
  outcome: string;
};

export interface IdentityRepository {
  create(input: CreateIdentityInput): IdentityView;
  get(id: string): IdentityView | undefined;
  require(id: string): IdentityView;
  list(): IdentityView[];
  /**
   * Ids only, with no scope interpretation.
   *
   * The auth path needs this rather than `list()`: one row with a corrupt
   * `scopes_json` makes `list()` throw, and if authentication walked the full list
   * a single tampered row would lock every client out. Iterating ids lets each
   * identity fail closed on its own.
   */
  listIds(): string[];
  update(id: string, patch: UpdateIdentityInput): IdentityView;
  revoke(id: string): IdentityView;
  delete(id: string): boolean;
  /** Whether the identity exists, is not revoked, and has not expired. */
  isUsable(id: string): boolean;
  /** Record a use timestamp without touching anything else. */
  touch(id: string): void;
  audit(input: IdentityAuditInput): void;
  recentAudit(limit?: number): IdentityAuditRecord[];
  auditRetention(): number;
}

export type CreateIdentityRepositoryOptions = {
  now?: () => string;
  auditRetention?: number;
};

/**
 * Identity ids share the alphabet of a scoped-secret segment, exactly as provider
 * ids do: the id becomes part of the physical secret name `client:<id>:key`, so any
 * character that could break out of a scope must be impossible here too. The
 * trailing-dash rule matches `assertProviderId` for the same reason — a name ending
 * in a separator is ambiguous when concatenated. The check runs before any SQL,
 * which is why constraint violations are a backstop rather than control flow.
 */
export function assertIdentityId(id: unknown): string {
  if (
    typeof id !== "string" ||
    !IDENTITY_ID_RE.test(id) ||
    id.includes("..") ||
    id.endsWith("-")
  ) {
    throw new IdentityError("invalid_identity_id", "identity-id");
  }
  return id;
}

function assertDisplayName(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_DISPLAY_NAME_LENGTH
  ) {
    throw new IdentityError("invalid_identity_config", "display-name");
  }
  // Stored verbatim. Escaping at rest would double-escape on render; the dashboard
  // renders it as text, which is where XSS safety belongs.
  return value;
}

/**
 * Validate an ISO-8601 expiry.
 *
 * An unparseable value is refused rather than treated as "no expiry", because that
 * would silently turn a time-limited credential into a permanent one.
 */
function assertExpiry(value: unknown): string {
  // A full ISO-8601 timestamp, not merely something `Date.parse` tolerates.
  // `Date.parse("0")` returns a valid time in 1999 — a bare digit would be accepted
  // as an expiry and silently produce an already-expired credential, or worse, a
  // typo'd year would produce a distant one.
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.test(value)
  ) {
    throw new IdentityError("invalid_identity_config", "expires-at");
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new IdentityError("invalid_identity_config", "expires-at");
  }
  return new Date(parsed).toISOString();
}

function assertPreset(value: unknown): string {
  if (typeof value !== "string" || !PRESET_NAMES.has(value)) {
    throw new IdentityError("invalid_identity_config", "preset");
  }
  return value;
}

function optionalText(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : String(value);
}

export function createIdentityRepository(
  db: SqlDatabase,
  options: CreateIdentityRepositoryOptions = {},
): IdentityRepository {
  const now = options.now ?? (() => new Date().toISOString());
  const auditRetention =
    Number.isInteger(options.auditRetention) && (options.auditRetention ?? 0) > 0
      ? (options.auditRetention as number)
      : DEFAULT_AUDIT_RETENTION;

  /**
   * Rebuild a view from a row, revalidating the scope set.
   *
   * Revalidation on read is the load-bearing part. An attacker with database write
   * access could set `scopes_json` to `["admin"]`; that is a real risk BAYZ cannot
   * prevent, but a *malformed* or unknown scope must not become authority, and a
   * row that cannot be interpreted must fail closed rather than default to
   * something.
   */
  const toView = (row: Record<string, unknown>): IdentityView => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(row.scopes_json));
    } catch {
      throw new IdentityError("invalid_identity_config", "scopes-json-parse");
    }
    let scopes: ClientScope[];
    try {
      scopes = assertScopes(parsed);
    } catch {
      throw new IdentityError("invalid_identity_config", "scopes-json-invalid");
    }
    return {
      id: String(row.id),
      displayName: String(row.display_name),
      scopes,
      preset: optionalText(row.preset),
      revoked: Number(row.revoked) === 1,
      expiresAt: optionalText(row.expires_at),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      lastUsedAt: optionalText(row.last_used_at),
    };
  };

  const findRow = (id: string): Record<string, unknown> | undefined =>
    db.prepare("SELECT * FROM client_identities WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;

  const repository: IdentityRepository = {
    create(input: CreateIdentityInput): IdentityView {
      // Validated before any SQL runs, so an injection-shaped id never reaches the
      // driver even as a bound parameter.
      const id = assertIdentityId(input.id);
      const displayName = assertDisplayName(input.displayName);
      const scopes = assertScopes(input.scopes);
      const preset = input.preset === undefined ? undefined : assertPreset(input.preset);
      const expiresAt =
        input.expiresAt === undefined ? undefined : assertExpiry(input.expiresAt);

      if (findRow(id) !== undefined) {
        throw new IdentityError("identity_already_exists", "create");
      }
      const timestamp = now();
      try {
        db.prepare(
          `INSERT INTO client_identities
             (id, display_name, scopes_json, preset, revoked, expires_at,
              created_at, updated_at, last_used_at)
           VALUES (?, ?, ?, ?, 0, ?, ?, ?, NULL)`,
        ).run(
          id,
          displayName,
          JSON.stringify(scopes),
          preset ?? null,
          expiresAt ?? null,
          timestamp,
          timestamp,
        );
      } catch (error) {
        throw asIdentityError("invalid_identity_config", "create-insert", error);
      }
      return repository.require(id);
    },

    get(id: string): IdentityView | undefined {
      const row = findRow(assertIdentityId(id));
      return row === undefined ? undefined : toView(row);
    },

    require(id: string): IdentityView {
      const view = repository.get(id);
      if (view === undefined) {
        throw new IdentityError("identity_not_found", "require");
      }
      return view;
    },

    list(): IdentityView[] {
      return (
        db
          .prepare("SELECT * FROM client_identities ORDER BY id")
          .all() as Record<string, unknown>[]
      ).map(toView);
    },

    listIds(): string[] {
      return (
        db
          .prepare("SELECT id FROM client_identities ORDER BY id")
          .all() as Record<string, unknown>[]
      ).map((row) => String(row.id));
    },

    update(id: string, patch: UpdateIdentityInput): IdentityView {
      const current = repository.require(id);
      if (current.revoked) {
        // Editing a revoked identity back into usefulness would make revocation
        // reversible by anyone who can reach the update route.
        throw new IdentityError("identity_revoked", "update");
      }

      const displayName =
        patch.displayName === undefined
          ? current.displayName
          : assertDisplayName(patch.displayName);
      const scopes =
        patch.scopes === undefined ? current.scopes : assertScopes(patch.scopes);
      const expiresAt =
        patch.expiresAt === undefined
          ? current.expiresAt
          : patch.expiresAt === null
            ? undefined
            : assertExpiry(patch.expiresAt);

      db.prepare(
        `UPDATE client_identities
            SET display_name = ?, scopes_json = ?, expires_at = ?, updated_at = ?
          WHERE id = ?`,
      ).run(displayName, JSON.stringify(scopes), expiresAt ?? null, now(), current.id);
      return repository.require(current.id);
    },

    revoke(id: string): IdentityView {
      const current = repository.require(id);
      db.prepare(
        "UPDATE client_identities SET revoked = 1, updated_at = ? WHERE id = ?",
      ).run(now(), current.id);
      return repository.require(current.id);
    },

    delete(id: string): boolean {
      const validated = assertIdentityId(id);
      if (findRow(validated) === undefined) {
        return false;
      }
      db.prepare("DELETE FROM client_identities WHERE id = ?").run(validated);
      return true;
    },

    isUsable(id: string): boolean {
      let view: IdentityView | undefined;
      try {
        view = repository.get(id);
      } catch {
        // A corrupt row is not usable. Failing closed here matters because this is
        // the function the auth path calls.
        return false;
      }
      if (view === undefined || view.revoked) {
        return false;
      }
      if (view.expiresAt !== undefined) {
        const expiry = Date.parse(view.expiresAt);
        if (!Number.isFinite(expiry) || expiry <= Date.now()) {
          return false;
        }
      }
      return true;
    },

    touch(id: string): void {
      // Deliberately silent for an unknown id: this runs on every authenticated
      // request, and racing a concurrent delete must not fail the request.
      try {
        db.prepare(
          "UPDATE client_identities SET last_used_at = ? WHERE id = ?",
        ).run(now(), assertIdentityId(id));
      } catch {
        // A touch is observational.
      }
    },

    audit(input: IdentityAuditInput): void {
      const identityId = assertIdentityId(input.identityId);
      if (!AUDIT_ACTIONS.has(input.action)) {
        throw new IdentityError("invalid_identity_config", "audit-action");
      }
      if (!AUDIT_OUTCOMES.has(input.outcome)) {
        throw new IdentityError("invalid_identity_config", "audit-outcome");
      }
      if (input.scope !== undefined && input.scope.length > MAX_ROUTE_LENGTH) {
        throw new IdentityError("invalid_identity_config", "audit-scope");
      }
      if (input.route !== undefined && input.route.length > MAX_ROUTE_LENGTH) {
        // Bounded because an audit row is metadata: an unbounded route string is a
        // channel for arbitrary text into a table that must not hold any.
        throw new IdentityError("invalid_identity_config", "audit-route");
      }
      if (findRow(identityId) === undefined) {
        // A foreign-key violation would surface as an opaque storage error; a named
        // code makes a caller bug visible.
        throw new IdentityError("identity_not_found", "audit");
      }

      db.prepare(
        `INSERT INTO identity_audit (occurred_at, identity_id, action, scope, route, outcome)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        now(),
        identityId,
        input.action,
        input.scope ?? null,
        input.route ?? null,
        input.outcome,
      );

      db.prepare(
        `DELETE FROM identity_audit
          WHERE id NOT IN (
            SELECT id FROM identity_audit ORDER BY id DESC LIMIT ?
          )`,
      ).run(auditRetention);
    },

    recentAudit(limit = 100): IdentityAuditRecord[] {
      const capped = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 500) : 100;
      return (
        db
          .prepare(
            `SELECT occurred_at, identity_id, action, scope, route, outcome
               FROM identity_audit ORDER BY id DESC LIMIT ?`,
          )
          .all(capped) as Record<string, unknown>[]
      ).map((row) => ({
        occurredAt: String(row.occurred_at),
        identityId: String(row.identity_id),
        action: String(row.action),
        scope: optionalText(row.scope),
        route: optionalText(row.route),
        outcome: String(row.outcome),
      }));
    },

    auditRetention(): number {
      return auditRetention;
    },
  };

  return repository;
}
