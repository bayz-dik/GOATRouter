import { useCallback, useState } from "react";
import {
  CLIENT_PRESET_NAMES,
  CLIENT_SCOPE_NAMES,
  PRESET_SCOPES,
  type ClientPresetName,
  type ClientScopeName,
  type CreateIdentityBody,
  type IdentityView,
  type IdentityWithKey,
} from "../api/types";
import { PanelError, useAsync } from "./shared";

/** Only the calls this panel needs, so a test can supply a narrow stub. */
export type IdentitiesApi = {
  listIdentities(): Promise<IdentityView[]>;
  createIdentity(body: CreateIdentityBody): Promise<IdentityWithKey>;
  updateIdentity(id: string, body: { scopes?: string[] }): Promise<IdentityView>;
  revokeIdentity(id: string): Promise<void>;
  rotateIdentityKey(id: string): Promise<IdentityWithKey>;
};

const DEFAULT_PRESET: ClientPresetName = "opencode";

export function IdentitiesPanel({ api }: { api: IdentitiesApi }) {
  const { value, error, loading, reload } = useAsync(() => api.listIdentities());
  const [actionError, setActionError] = useState<unknown>(undefined);
  /**
   * The one key currently being shown.
   *
   * Held in component state and dropped on acknowledgement, so it exists in the DOM
   * for exactly as long as the operator is looking at it. Nothing writes it to
   * storage — the dashboard has no persistence at all, which the smoke script
   * enforces against the built bundle.
   */
  const [revealed, setRevealed] = useState<{ id: string; key: string } | undefined>(
    undefined,
  );
  const [confirming, setConfirming] = useState<string | undefined>(undefined);
  const [preset, setPreset] = useState<ClientPresetName>(DEFAULT_PRESET);
  const [scopes, setScopes] = useState<ClientScopeName[]>([
    ...PRESET_SCOPES[DEFAULT_PRESET],
  ]);
  const [form, setForm] = useState({ id: "", displayName: "" });

  const run = useCallback(
    async (action: () => Promise<unknown>) => {
      setActionError(undefined);
      try {
        await action();
        reload();
      } catch (failure) {
        setActionError(failure);
      }
    },
    [reload],
  );

  const identities = value ?? [];
  const grantsAdmin = scopes.includes("admin");

  return (
    <section className="bayz-panel" aria-labelledby="identities-heading">
      <h2 id="identities-heading">Client identities</h2>

      {actionError !== undefined && <PanelError error={actionError} />}
      {error !== undefined && <PanelError error={error} />}
      {loading && <p>Loading identities…</p>}

      {revealed !== undefined && (
        <div className="bayz-reveal" data-testid="new-key-block">
          <p data-testid="new-key-notice">
            This key is shown only once. Store it now — there is no way to retrieve it
            again, and the only remedy is to rotate the key.
          </p>
          {/* Selectable text rather than a copy button: `navigator.clipboard` is
              unavailable over plain HTTP in most browsers, so a copy button on a
              loopback dashboard would silently do nothing. */}
          <code data-testid="new-key">{revealed.key}</code>
          <button type="button" onClick={() => setRevealed(undefined)}>
            I have stored it
          </button>
        </div>
      )}

      <ul className="bayz-list">
        {identities.map((identity) => (
          <li key={identity.id} className="bayz-list-item">
            <div>
              <strong>{identity.id}</strong>
              <span>{identity.displayName}</span>
              <span data-testid={`scopes-${identity.id}`}>
                {identity.scopes.join(", ")}
              </span>
              <span data-testid={`state-${identity.id}`}>
                {identity.revoked ? "Revoked" : "Active"}
              </span>
              <span data-testid={`last-used-${identity.id}`}>
                {/* "Never" rather than a placeholder date: showing a fabricated
                    timestamp for an unused identity would be a lie an operator
                    might act on. */}
                {identity.lastUsedAt === undefined
                  ? "Never used"
                  : `Last used ${identity.lastUsedAt}`}
              </span>
              {identity.preset !== undefined && <span>{identity.preset}</span>}
            </div>

            {!identity.revoked && (
              <div className="bayz-actions">
                <button
                  type="button"
                  onClick={() =>
                    void run(async () => {
                      const result = await api.rotateIdentityKey(identity.id);
                      setRevealed({ id: identity.id, key: result.key });
                    })
                  }
                >
                  Rotate key for {identity.id}
                </button>
                {confirming === identity.id ? (
                  <span data-testid={`confirm-revoke-${identity.id}`}>
                    <button
                      type="button"
                      onClick={() =>
                        void run(async () => {
                          await api.revokeIdentity(identity.id);
                          setConfirming(undefined);
                        })
                      }
                    >
                      Confirm revoke {identity.id}
                    </button>
                    <button type="button" onClick={() => setConfirming(undefined)}>
                      Cancel revoke {identity.id}
                    </button>
                  </span>
                ) : (
                  <button type="button" onClick={() => setConfirming(identity.id)}>
                    Revoke {identity.id}
                  </button>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>

      <form
        className="bayz-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (scopes.length === 0) {
            // Refused in the UI rather than sent: the server would reject an empty
            // scope set anyway, and a local message is the faster answer.
            setActionError(new Error("Select at least one scope before creating."));
            return;
          }
          void run(async () => {
            const result = await api.createIdentity({
              id: form.id,
              displayName: form.displayName,
              scopes: [...scopes],
              preset,
            });
            setRevealed({ id: result.identity.id, key: result.key });
            setForm({ id: "", displayName: "" });
          });
        }}
      >
        <label htmlFor="identity-id">Identity id</label>
        <input
          id="identity-id"
          value={form.id}
          onChange={(event) => setForm({ ...form, id: event.target.value })}
        />

        <label htmlFor="identity-name">Display name</label>
        <input
          id="identity-name"
          value={form.displayName}
          onChange={(event) => setForm({ ...form, displayName: event.target.value })}
        />

        <label htmlFor="identity-preset">Preset</label>
        <select
          id="identity-preset"
          value={preset}
          onChange={(event) => {
            const next = event.target.value as ClientPresetName;
            setPreset(next);
            // Seeds, does not constrain: the checkboxes stay editable afterwards.
            setScopes([...PRESET_SCOPES[next]]);
          }}
        >
          {CLIENT_PRESET_NAMES.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>

        <fieldset>
          <legend>Scopes</legend>
          {CLIENT_SCOPE_NAMES.map((scope) => (
            <span key={scope}>
              <input
                id={`scope-${scope}`}
                type="checkbox"
                checked={scopes.includes(scope)}
                onChange={(event) =>
                  setScopes((current) =>
                    event.target.checked
                      ? [...current, scope].filter(
                          (entry, index, all) => all.indexOf(entry) === index,
                        )
                      : current.filter((entry) => entry !== scope),
                  )
                }
              />
              <label htmlFor={`scope-${scope}`}>{scope}</label>
            </span>
          ))}
        </fieldset>

        {grantsAdmin && (
          <p data-testid="admin-warning" role="status">
            admin grants every scope at once, including creating and revoking other
            identities. Grant it only to a credential you control directly.
          </p>
        )}

        <button type="submit">Create identity</button>
      </form>
    </section>
  );
}
