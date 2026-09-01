import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import type { TokenStore } from "./token";

export type TokenGateProps = {
  store: TokenStore;
  children?: ReactNode;
};

/**
 * The login surface, and the gate around the operator surface.
 *
 * While locked this renders **only** what completes the login action: the approved
 * GOAT ROUTER lockup, the token label, the input, the Unlock button, and a validation
 * message when one actually applies. No status line, no version, no navigation, no
 * explanation of how the token is stored — none of it helps an operator log in, and a
 * sentence that does not help is noise on the one screen that must be unambiguous.
 *
 * `App` does not mount the dashboard shell until this reports unlocked, so the rail,
 * the screen headings and the liveness check cannot appear before authentication.
 *
 * The entry field stays write-only in the same sense as the credential fields: the
 * value is moved into the store and immediately cleared from component state, so it is
 * never re-rendered and never present in the DOM afterwards.
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
          setError(undefined);
        }
      }),
    [store],
  );

  const submit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!store.set(draft)) {
        // A real validation failure, stated as the fact it is. The store refuses an
        // empty or whitespace-only value, which is the only thing knowable here — the
        // Core decides whether a well-formed token is *correct*, and a 401 from it
        // clears the store and returns to this screen.
        setError("Invalid token");
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
    <main className="goat-login">
      <div className="goat-login-inner">
        {/*
          The complete approved lockup as one unit — character, halo, separator and
          wordmark in their delivered relationship. `object-fit: contain` and a width
          clamp only; nothing crops it, nothing scales either half independently, and no
          breakpoint recomposes it.

          `alt` carries the product name because this is the only element on the screen
          that names it, and `App` has not mounted the shell heading yet.
        */}
        <img
          className="goat-login-lockup"
          src="/brand/goat-router-lockup.png"
          alt="GOAT ROUTER"
          width={1672}
          height={941}
          decoding="async"
          fetchPriority="high"
        />

        <form className="goat-login-form" onSubmit={submit}>
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
          {error !== undefined && (
            <p role="alert" className="goat-login-error">
              {error}
            </p>
          )}
          <button type="submit">Unlock</button>
        </form>
      </div>
    </main>
  );
}
