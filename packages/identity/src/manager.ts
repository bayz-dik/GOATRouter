import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { redactSecrets } from "@bayz/security";
import { scopedSecretStorage, type SecretStorage } from "@bayz/storage";
import { IdentityError } from "./errors.js";
import {
  createIdentityRepository,
  type CreateIdentityInput,
  type IdentityAuditRecord,
  type IdentityRepository,
  type IdentityView,
  type UpdateIdentityInput,
} from "./repository.js";

/** 32 bytes of randomness, rendered hex. */
const KEY_BYTES = 32;
const KEY_HEX_LENGTH = KEY_BYTES * 2;
/** The single field name every client key is stored under. */
const KEY_FIELD = "key";
const KEY_SHAPE_RE = /^[0-9a-f]{64}$/;

export type IdentityLogger = (payload: Record<string, unknown>) => void;

export type CreateIdentityManagerOptions = {
  storage: SecretStorage;
  logger?: IdentityLogger;
  now?: () => string;
  auditRetention?: number;
};

export interface IdentityManager {
  /** The key is returned exactly once, at creation, and never again. */
  createIdentity(input: CreateIdentityInput): { identity: IdentityView; key: string };
  get(id: string): IdentityView | undefined;
  list(): IdentityView[];
  update(id: string, patch: UpdateIdentityInput): IdentityView;
  /** Returns the new key exactly once. */
  rotateKey(id: string): { identity: IdentityView; key: string };
  revoke(id: string): IdentityView;
  delete(id: string): boolean;
  /** Resolve a presented key to its identity, or `undefined`. */
  verifyKey(presented: unknown): IdentityView | undefined;
  recentAudit(limit?: number): IdentityAuditRecord[];
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/**
 * Constant-time comparison over fixed-width digests.
 *
 * Both sides are hashed first so the buffers are always 32 bytes: comparing raw
 * keys with `timingSafeEqual` throws on a length mismatch, which would turn length
 * into an oracle and leak through the error path. Same reasoning as
 * `verifyApiToken` in the server.
 */
function keysMatch(expected: string, presented: string): boolean {
  return timingSafeEqual(digest(expected), digest(presented));
}

/**
 * Client identities with key custody.
 *
 * The custody rule is the whole design: a key is generated, stored
 * envelope-encrypted at `client:<id>:key` through the Phase 3 scoped-secret
 * primitive, and returned to the caller exactly once. There is no accessor that
 * returns a stored key — `manager.test.ts` asserts that against the method names
 * and against every returned view — so a compromised management API cannot
 * enumerate client credentials.
 *
 * Reusing `scopedSecretStorage` rather than inventing a mechanism is deliberate: a
 * client key then gets exactly the same custody as a provider credential, including
 * the per-secret DEK and the corruption behaviour.
 */
export function createIdentityManager(
  options: CreateIdentityManagerOptions,
): IdentityManager {
  const { storage } = options;
  const log: IdentityLogger = options.logger ?? (() => {});
  const repository: IdentityRepository = createIdentityRepository(storage.sql, {
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.auditRetention === undefined
      ? {}
      : { auditRetention: options.auditRetention }),
  });

  const keys = (id: string) => scopedSecretStorage(storage, ["client", id]);

  /**
   * Read a key for internal comparison only.
   *
   * Never returned to a caller. A corrupt record propagates rather than being
   * downgraded to "absent", so tampering cannot look like an unconfigured identity.
   */
  const readKeyForComparison = (id: string): string | undefined =>
    keys(id).find(KEY_FIELD);

  const manager: IdentityManager = {
    createIdentity(input: CreateIdentityInput): {
      identity: IdentityView;
      key: string;
    } {
      // The row is written first. If the secret write then failed, a caller would
      // see an error and an identity with no key — which cannot authenticate. The
      // reverse order would leave a working key for an identity that does not
      // exist, which is a credential nobody can see or revoke.
      const identity = repository.create(input);
      const key = randomBytes(KEY_BYTES).toString("hex");
      try {
        keys(identity.id).put(KEY_FIELD, key);
      } catch (error) {
        repository.delete(identity.id);
        throw error;
      }
      repository.audit({
        identityId: identity.id,
        action: "created",
        outcome: "ok",
      });
      log(
        redactSecrets({
          event: "identity_created",
          id: identity.id,
          scopes: identity.scopes.length,
        }),
      );
      return { identity, key };
    },

    get(id: string): IdentityView | undefined {
      return repository.get(id);
    },

    list(): IdentityView[] {
      return repository.list();
    },

    update(id: string, patch: UpdateIdentityInput): IdentityView {
      const identity = repository.update(id, patch);
      repository.audit({ identityId: identity.id, action: "updated", outcome: "ok" });
      log(redactSecrets({ event: "identity_updated", id: identity.id }));
      return identity;
    },

    rotateKey(id: string): { identity: IdentityView; key: string } {
      const identity = repository.require(id);
      if (identity.revoked) {
        // Rotation would hand out a working key for something the operator
        // deliberately switched off.
        throw new IdentityError("identity_revoked", "rotate");
      }
      const key = randomBytes(KEY_BYTES).toString("hex");
      keys(identity.id).put(KEY_FIELD, key);
      repository.audit({ identityId: identity.id, action: "rotated", outcome: "ok" });
      log(redactSecrets({ event: "identity_key_rotated", id: identity.id }));
      return { identity, key };
    },

    revoke(id: string): IdentityView {
      const identity = repository.revoke(id);
      // The secret is deleted as well as the flag being set. The flag alone would be
      // enough for `verifyKey`, but leaving the ciphertext behind serves no purpose
      // and cryptographic erasure of the DEK is the stronger guarantee.
      try {
        keys(identity.id).delete(KEY_FIELD);
      } catch {
        // A corrupt or already-absent key must not block revocation.
      }
      repository.audit({ identityId: identity.id, action: "revoked", outcome: "ok" });
      log(redactSecrets({ event: "identity_revoked", id: identity.id }));
      return identity;
    },

    delete(id: string): boolean {
      const existing = repository.get(id);
      if (existing === undefined) {
        return false;
      }
      // The key goes first: a row removed while its secret survived would leave a
      // credential nobody can see or revoke.
      try {
        keys(existing.id).delete(KEY_FIELD);
      } catch {
        // A corrupt key must not block removing the identity.
      }
      const removed = repository.delete(existing.id);
      if (removed) {
        log(redactSecrets({ event: "identity_deleted", id: existing.id }));
      }
      return removed;
    },

    verifyKey(presented: unknown): IdentityView | undefined {
      // Shape-checked before anything else, so an oversized or malformed value is
      // rejected without hashing it against every identity. A 1 MiB bearer would
      // otherwise cost one SHA-256 per registered client.
      if (
        typeof presented !== "string" ||
        presented.length !== KEY_HEX_LENGTH ||
        !KEY_SHAPE_RE.test(presented)
      ) {
        return undefined;
      }

      for (const identity of repository.list()) {
        // Usability is checked before the comparison so a revoked or expired key
        // cannot match at all, rather than matching and then being filtered.
        if (!repository.isUsable(identity.id)) {
          continue;
        }
        let stored: string | undefined;
        try {
          stored = readKeyForComparison(identity.id);
        } catch {
          // A corrupt key cannot authenticate. Failing closed for this identity
          // rather than for the whole request keeps one damaged row from locking
          // every client out.
          continue;
        }
        if (stored === undefined) {
          continue;
        }
        if (keysMatch(stored, presented)) {
          repository.touch(identity.id);
          repository.audit({
            identityId: identity.id,
            action: "authenticated",
            outcome: "allowed",
          });
          return identity;
        }
      }
      // No audit row: attributing a rejection to an identity would require guessing
      // which one was being targeted, and a wrong guess pollutes that identity's
      // history. The server's auth rate limiter is what throttles guessing.
      return undefined;
    },

    recentAudit(limit?: number): IdentityAuditRecord[] {
      return repository.recentAudit(limit);
    },
  };

  return manager;
}
