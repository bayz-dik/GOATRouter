import assert from "node:assert/strict";
import test from "node:test";
import { StorageError, asStorageError } from "../src/index.js";

test("StorageError carries a stable code and optional stage", () => {
  const error = new StorageError("storage_unavailable", "open-database");
  assert.ok(error instanceof Error);
  assert.ok(error instanceof StorageError);
  assert.equal(error.code, "storage_unavailable");
  assert.equal(error.stage, "open-database");
  assert.equal(error.name, "StorageError");
});

test("StorageError message never embeds caller-supplied detail", () => {
  const error = new StorageError("secret_corrupt");
  assert.equal(error.stage, undefined);
  assert.ok(error.message.length > 0);
  assert.match(error.message, /secret_corrupt/);
});

test("asStorageError wraps an unknown throw without leaking its message", () => {
  const raw = new Error("unable to open database file /home/user/.bayz/bayz.db");
  const wrapped = asStorageError("storage_unavailable", "open-database", raw);

  assert.ok(wrapped instanceof StorageError);
  assert.equal(wrapped.code, "storage_unavailable");
  assert.equal(wrapped.stage, "open-database");
  assert.doesNotMatch(wrapped.message, /unable to open database file/);
  assert.doesNotMatch(wrapped.message, /\.bayz/);
});

test("asStorageError does not attach the original error as cause", () => {
  const raw = new Error("sqlite internals with /absolute/path");
  const wrapped = asStorageError("secret_corrupt", "open-secret", raw);

  assert.equal(wrapped.cause, undefined);
  assert.doesNotMatch(JSON.stringify({ ...wrapped }), /absolute\/path/);
});

test("asStorageError passes through an existing StorageError unchanged", () => {
  const original = new StorageError("secret_not_found", "get-secret");
  const wrapped = asStorageError("storage_unavailable", "other-stage", original);
  assert.equal(wrapped, original);
  assert.equal(wrapped.code, "secret_not_found");
});

test("asStorageError tolerates non-Error throws", () => {
  const wrapped = asStorageError("storage_unavailable", "weird", "a string");
  assert.ok(wrapped instanceof StorageError);
  assert.doesNotMatch(wrapped.message, /a string/);
});
