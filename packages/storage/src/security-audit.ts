import { StorageError, asStorageError } from "./errors.js";
import type { SqlDatabase } from "./sql.js";

/**
 * The deployment-level audit trail.
 *
 * Distinct from `identity_audit`, which records what a *client credential* did.
 * This records what happened to the deployment's own custody — currently root-key
 * rotation. Both are metadata-only, and both are enum-constrained at the schema
 * level so no free-text error string can be smuggled into a table that must not
 * hold any.
 */
export const SECURITY_AUDIT_ACTIONS = Object.freeze(["root_key_rotated"] as const);
export type SecurityAuditAction = (typeof SECURITY_AUDIT_ACTIONS)[number];

export const SECURITY_AUDIT_OUTCOMES = Object.freeze(["ok", "failed"] as const);
export type SecurityAuditOutcome = (typeof SECURITY_AUDIT_OUTCOMES)[number];

/** Keep the trail bounded; a rotation log that grows forever is a slow leak. */
export const DEFAULT_SECURITY_AUDIT_RETENTION = 500;

const MAX_ACTOR_LENGTH = 128;
/** `kek_` plus a 32-character truncated digest, and nothing else may be stored. */
const FINGERPRINT_RE = /^kek_[0-9a-f]{32}$/;

export type SecurityAuditInput = {
  action: SecurityAuditAction;
  /** Principal id, which is a slug by construction — never a credential. */
  actor: string;
  outcome: SecurityAuditOutcome;
  keyId?: string;
  previousKeyId?: string;
  subjectCount: number;
};

export type SecurityAuditRecord = {
  occurredAt: string;
  action: string;
  actor: string;
  outcome: string;
  keyId: string | undefined;
  previousKeyId: string | undefined;
  subjectCount: number;
};

export interface SecurityAuditRepository {
  record(input: SecurityAuditInput): void;
  recent(limit?: number): SecurityAuditRecord[];
  retention(): number;
}

export type CreateSecurityAuditRepositoryOptions = {
  retention?: number;
  now?: () => string;
};

function optionalFingerprint(value: unknown, stage: string): string | null {
  if (value === undefined) {
    return null;
  }
  // Validated rather than stored as given: the whole guarantee of this table is
  // that a caller cannot put key material in it, and a caller that passes a raw
  // 64-hex key by mistake must fail here rather than persist it.
  if (typeof value !== "string" || !FINGERPRINT_RE.test(value)) {
    throw new StorageError("invalid_argument", stage);
  }
  return value;
}

function optionalText(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : String(value);
}

export function createSecurityAuditRepository(
  db: SqlDatabase,
  options: CreateSecurityAuditRepositoryOptions = {},
): SecurityAuditRepository {
  const retention =
    Number.isInteger(options.retention) && (options.retention as number) > 0
      ? (options.retention as number)
      : DEFAULT_SECURITY_AUDIT_RETENTION;
  const now = options.now ?? (() => new Date().toISOString());

  return {
    record(input: SecurityAuditInput): void {
      if (!(SECURITY_AUDIT_ACTIONS as readonly string[]).includes(input.action)) {
        throw new StorageError("invalid_argument", "security-audit-action");
      }
      if (!(SECURITY_AUDIT_OUTCOMES as readonly string[]).includes(input.outcome)) {
        throw new StorageError("invalid_argument", "security-audit-outcome");
      }
      if (
        typeof input.actor !== "string" ||
        input.actor.length === 0 ||
        input.actor.length > MAX_ACTOR_LENGTH
      ) {
        throw new StorageError("invalid_argument", "security-audit-actor");
      }
      if (!Number.isInteger(input.subjectCount) || input.subjectCount < 0) {
        throw new StorageError("invalid_argument", "security-audit-subject-count");
      }
      const keyId = optionalFingerprint(input.keyId, "security-audit-key-id");
      const previousKeyId = optionalFingerprint(
        input.previousKeyId,
        "security-audit-previous-key-id",
      );

      try {
        db.prepare(
          `INSERT INTO security_audit
             (occurred_at, action, actor, outcome, key_id, previous_key_id, subject_count)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          now(),
          input.action,
          input.actor,
          input.outcome,
          keyId,
          previousKeyId,
          input.subjectCount,
        );
        db.prepare(
          `DELETE FROM security_audit
            WHERE id NOT IN (
              SELECT id FROM security_audit ORDER BY id DESC LIMIT ?
            )`,
        ).run(retention);
      } catch (error) {
        throw asStorageError("storage_unavailable", "security-audit-insert", error);
      }
    },

    recent(limit = 100): SecurityAuditRecord[] {
      const capped =
        Number.isInteger(limit) && limit > 0 ? Math.min(limit, 500) : 100;
      return (
        db
          .prepare(
            `SELECT occurred_at, action, actor, outcome, key_id, previous_key_id,
                    subject_count
               FROM security_audit ORDER BY id DESC LIMIT ?`,
          )
          .all(capped) as Record<string, unknown>[]
      ).map((row) => ({
        occurredAt: String(row.occurred_at),
        action: String(row.action),
        actor: String(row.actor),
        outcome: String(row.outcome),
        keyId: optionalText(row.key_id),
        previousKeyId: optionalText(row.previous_key_id),
        subjectCount: Number(row.subject_count),
      }));
    },

    retention(): number {
      return retention;
    },
  };
}
