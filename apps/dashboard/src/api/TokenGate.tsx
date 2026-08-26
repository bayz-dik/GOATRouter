import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import type { TokenStore } from "./token";

export type TokenGateProps = {
  store: TokenStore;
  children: ReactNode;
};

/**
 * Gate the operator surface behind an in-memory token.
 *
 * The entry field is write-only in the same sense as the credential fields: the
 * value is moved into the store and immediately cleared from component state, so
 * it is never re-rendered and never present in the DOM afterwards.
 */
export function TokenGate({ store, children }: TokenGateProps) {
  const [unlocked, setUnlocked] = useState(store.isSet());
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(
    () =>
      store.subscribe(() => {
        const next = store.isSet();
        setUnlocked(next);
        if (!next) {
          // A 401 cleared the token: drop any residual input as well.
          setDraft("");
        }
      }),
    [store],
  );

  const submit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!store.set(draft)) {
        setError("Enter the API token printed by the Bayz Core on first start.");
        return;
      }
      setError(undefined);
      setDraft("");
    },
    [draft, store],
  );

  const lock = useCallback(() => {
    store.clear();
    setDraft("");
  }, [store]);

  if (unlocked) {
    return (
      <>
        <div className="bayz-session">
          <button type="button" onClick={lock}>
            Lock session
          </button>
        </div>
        {children}
      </>
    );
  }

  return (
    <form className="bayz-token-gate" onSubmit={submit}>
      <label htmlFor="bayz-api-token">API token</label>
      <input
        id="bayz-api-token"
        name="bayz-api-token"
        type="password"
        autoComplete="off"
        spellCheck={false}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
      />
      <p className="bayz-token-note">
        The token is held in memory only and is not stored by the browser, so it
        must be entered again after a reload.
      </p>
      {error !== undefined && (
        <p role="alert" className="bayz-error">
          {error}
        </p>
      )}
      <button type="submit">Unlock</button>
    </form>
  );
}
