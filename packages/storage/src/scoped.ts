import { StorageError } from "./errors.js";
import type { SecretRecordMetadata, SecretStorage } from "./secret-repository.js";

const SEGMENT_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const FIELD_RE = /^[a-z0-9][a-z0-9._-]{0,62}$/;

export interface ScopedSecretView {
  readonly physicalPrefix: string;
  put(field: string, plaintext: string): void;
  get(field: string): string;
  find(field: string): string | undefined;
  list(): SecretRecordMetadata[];
  delete(field: string): boolean;
}

function assertSegment(segment: unknown): void {
  if (
    typeof segment !== "string" ||
    !SEGMENT_RE.test(segment) ||
    segment.includes("..")
  ) {
    throw new StorageError("invalid_argument", "scope-segment");
  }
}

function assertField(field: unknown): void {
  if (
    typeof field !== "string" ||
    !FIELD_RE.test(field) ||
    field.includes("..")
  ) {
    throw new StorageError("invalid_argument", "field");
  }
}

export function scopedSecretStorage(
  storage: SecretStorage,
  scope: string | readonly string[],
): ScopedSecretView {
  const segments =
    typeof scope === "string"
      ? [scope]
      : Array.from(scope as readonly unknown[]);
  if (segments.length === 0) {
    throw new StorageError("invalid_argument", "scope-empty");
  }
  segments.forEach(assertSegment);
  const prefix = `${segments.join(":")}:`;

  const physical = (field: string): string => {
    assertField(field);
    return `${prefix}${field}`;
  };

  return {
    physicalPrefix: prefix,
    put(field, plaintext) {
      storage.put(physical(field), plaintext);
    },
    get(field) {
      return storage.get(physical(field));
    },
    find(field) {
      return storage.find(physical(field));
    },
    list() {
      return storage
        .list()
        .filter((meta) => meta.name.startsWith(prefix))
        .map((meta) => ({ ...meta, name: meta.name.slice(prefix.length) }));
    },
    delete(field) {
      return storage.delete(physical(field));
    },
  };
}
