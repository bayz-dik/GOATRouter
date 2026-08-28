import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "node:crypto";
import { StorageError, asStorageError } from "./errors.js";
import { SCRYPT_PARAMS } from "./key-provider.js";
import type { SecretStorage } from "./secret-repository.js";

/**
 * Format marker.
 *
 * A blob that is not an export must be refused on this rather than on a GCM tag
 * failure: "this file is not a BAYZ export" and "your passphrase is wrong" are
 * different operator problems with different remedies, and collapsing them into one
 * error makes a restore attempt unnecessarily frightening.
 */
export const EXPORT_MAGIC = "BAYZEXP1";
export const EXPORT_FORMAT_VERSION = 1;

const SALT_LENGTH = 16;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const ALGORITHM = "aes-256-gcm";

/** Bound the payload so a hostile blob cannot demand unbounded memory. */
const MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;

const HEADER_LENGTH = EXPORT_MAGIC.length + 1;
const MIN_BLOB_LENGTH = HEADER_LENGTH + SALT_LENGTH + IV_LENGTH + TAG_LENGTH;

export type ImportSecretsOptions = {
  /**
   * Overwrite a secret that already exists under the same name.
   *
   * Defaults to false, and the refusal is atomic. A restore that silently replaced a
   * live credential with an older one would be a data-loss event disguised as a
   * successful backup restore.
   */
  replace?: boolean;
};

export type ImportSecretsResult = {
  imported: number;
};

type PortablePayload = {
  version: number;
  secrets: Array<{ name: string; value: string }>;
};

/**
 * Derive the blob key from a passphrase.
 *
 * The Phase 2 `SCRYPT_PARAMS` are reused deliberately: an export is offline
 * ciphertext an attacker can grind at their leisure, so it needs *at least* the
 * memory-hardness the live root key gets. A cheaper KDF here would make the backup
 * the weakest way into the deployment.
 */
function deriveBlobKey(passphrase: string, salt: Buffer, stage: string): Buffer {
  if (typeof passphrase !== "string" || passphrase.trim().length === 0) {
    // Refused rather than padded or hashed into something usable: an unprotected
    // backup of every credential is worse than no backup.
    throw new StorageError("master_key_invalid", stage);
  }
  try {
    return scryptSync(passphrase, salt, SCRYPT_PARAMS.keyLength, {
      N: SCRYPT_PARAMS.N,
      r: SCRYPT_PARAMS.r,
      p: SCRYPT_PARAMS.p,
      maxmem: SCRYPT_PARAMS.maxmem,
    });
  } catch (error) {
    throw asStorageError("master_key_invalid", stage, error);
  }
}

/**
 * Seal every stored secret under a passphrase-derived key.
 *
 * The exported blob is deliberately **not** root-key-bound: it re-seals plaintext, so
 * it can be restored into a database with a different root key. That is the whole
 * point of a backup, and it is why the passphrase must be strong — the blob is as
 * sensitive as the database it came from.
 *
 * Secret *names* are inside the sealed region alongside their values. A backup whose
 * header leaked `provider:openai:api_key` would tell an attacker exactly what the
 * deployment holds and which credentials are worth targeting.
 *
 * The root key never enters the blob, and no key fingerprint is written either.
 */
export function exportSecrets(storage: SecretStorage, passphrase: string): Uint8Array {
  const salt = randomBytes(SALT_LENGTH);
  const key = deriveBlobKey(passphrase, salt, "export-passphrase");

  try {
    const payload: PortablePayload = {
      version: EXPORT_FORMAT_VERSION,
      // `get` rather than `find`: a corrupt row must fail the export instead of being
      // silently dropped, or the backup would be quietly incomplete.
      secrets: storage.list().map((entry) => ({
        name: entry.name,
        value: storage.get(entry.name),
      })),
    };

    const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
    // Fresh IV per export. A fixed IV under one derived key would leak the XOR of two
    // backups of the same database.
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, key, iv);
    const header = Buffer.concat([
      Buffer.from(EXPORT_MAGIC, "ascii"),
      Buffer.of(EXPORT_FORMAT_VERSION),
    ]);
    // The header is authenticated, so the version cannot be edited to steer a
    // future reader down a different parse without failing the tag.
    cipher.setAAD(header);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();

    return Buffer.concat([header, salt, iv, tag, ciphertext]);
  } catch (error) {
    throw error instanceof StorageError
      ? error
      : asStorageError("storage_unavailable", "export-secrets", error);
  } finally {
    key.fill(0);
  }
}

function parsePayload(plaintext: Buffer): PortablePayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext.toString("utf8"));
  } catch (error) {
    throw asStorageError("secret_corrupt", "export-payload", error);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new StorageError("secret_corrupt", "export-payload");
  }
  const record = parsed as Record<string, unknown>;
  if (record.version !== EXPORT_FORMAT_VERSION) {
    throw new StorageError("secret_corrupt", "export-version");
  }
  if (!Array.isArray(record.secrets)) {
    throw new StorageError("secret_corrupt", "export-payload");
  }
  const secrets = record.secrets.map((entry) => {
    if (typeof entry !== "object" || entry === null) {
      throw new StorageError("secret_corrupt", "export-entry");
    }
    const { name, value } = entry as Record<string, unknown>;
    if (typeof name !== "string" || name.length === 0 || typeof value !== "string") {
      throw new StorageError("secret_corrupt", "export-entry");
    }
    return { name, value };
  });
  return { version: EXPORT_FORMAT_VERSION, secrets };
}

/**
 * Restore secrets from a sealed blob.
 *
 * Fails closed at every step, and does so **before writing anything**: the whole
 * payload is decrypted, parsed, and conflict-checked first, so a bad passphrase or a
 * single name collision cannot leave a half-restored database. Without that, an
 * attacker grinding passphrases would accumulate rows on the way.
 */
export function importSecrets(
  storage: SecretStorage,
  blob: Uint8Array,
  passphrase: string,
  options: ImportSecretsOptions = {},
): ImportSecretsResult {
  const bytes = Buffer.from(blob);
  if (bytes.byteLength < MIN_BLOB_LENGTH) {
    throw new StorageError("secret_corrupt", "export-truncated");
  }
  if (bytes.subarray(0, EXPORT_MAGIC.length).toString("ascii") !== EXPORT_MAGIC) {
    throw new StorageError("secret_corrupt", "export-magic");
  }

  const version = bytes[EXPORT_MAGIC.length]!;
  if (version !== EXPORT_FORMAT_VERSION) {
    // Refused explicitly rather than attempted. An unknown version means a layout
    // this build does not understand, and guessing would either misparse or produce
    // an opaque tag failure.
    throw new StorageError("secret_corrupt", "export-version");
  }

  let offset = HEADER_LENGTH;
  const salt = bytes.subarray(offset, (offset += SALT_LENGTH));
  const iv = bytes.subarray(offset, (offset += IV_LENGTH));
  const tag = bytes.subarray(offset, (offset += TAG_LENGTH));
  const ciphertext = bytes.subarray(offset);
  if (ciphertext.byteLength > MAX_PAYLOAD_BYTES) {
    throw new StorageError("secret_corrupt", "export-too-large");
  }

  const key = deriveBlobKey(passphrase, salt, "import-passphrase");
  let payload: PortablePayload;
  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAAD(bytes.subarray(0, HEADER_LENGTH));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
    payload = parsePayload(plaintext);
  } catch (error) {
    if (error instanceof StorageError) {
      throw error;
    }
    // A wrong passphrase and a tampered blob are indistinguishable at the tag, and
    // both mean the same thing to the caller: this blob cannot be opened with what
    // you supplied. `master_key_invalid` is the honest code — nothing stored is
    // corrupt, the supplied key is simply wrong.
    throw asStorageError("master_key_invalid", "import-open", error);
  } finally {
    key.fill(0);
  }

  const replace = options.replace === true;
  if (!replace) {
    // Every conflict is checked before the first write, so the refusal leaves the
    // target exactly as it was.
    for (const entry of payload.secrets) {
      if (storage.find(entry.name) !== undefined) {
        throw new StorageError("secret_corrupt", "export-name-conflict");
      }
    }
  }

  for (const entry of payload.secrets) {
    // Re-sealed under the target's own root key rather than copied as a foreign
    // envelope, which is what makes a cross-deployment restore work at all.
    storage.put(entry.name, entry.value);
  }
  return { imported: payload.secrets.length };
}
