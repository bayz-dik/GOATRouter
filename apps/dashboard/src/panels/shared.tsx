import { useEffect, useState } from "react";
import { ApiError } from "../api/client";

/**
 * Render an API failure using the server's own envelope.
 *
 * The Bayz error classes never interpolate a secret or an upstream body into a
 * message, so showing `code` and `message` verbatim is safe — and far more useful
 * to an operator than a generic string. React escapes both, so a hostile message
 * is displayed as text rather than parsed as markup.
 */
export function PanelError({ error }: { error: unknown }) {
  const code = error instanceof ApiError ? error.code : "unknown_error";
  const message = error instanceof Error ? error.message : "Request failed";
  return (
    <p role="alert" className="bayz-error">
      <code>{code}</code> {message}
    </p>
  );
}

export type AsyncState<T> = {
  value: T | undefined;
  error: unknown;
  loading: boolean;
};

/**
 * Load a value once per `key` change, discarding a late result after unmount.
 *
 * Kept deliberately small: a state library would be a new dependency for behaviour
 * that is a dozen lines, and the panels have no shared cache to justify one.
 */
export function useAsync<T>(load: () => Promise<T>, key: unknown = 0): AsyncState<T> & {
  reload: () => void;
} {
  const [state, setState] = useState<AsyncState<T>>({
    value: undefined,
    error: undefined,
    loading: true,
  });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let active = true;
    setState((current) => ({ ...current, loading: true }));
    void load().then(
      (value) => {
        if (active) {
          setState({ value, error: undefined, loading: false });
        }
      },
      (error: unknown) => {
        if (active) {
          setState({ value: undefined, error, loading: false });
        }
      },
    );
    return () => {
      active = false;
    };
    // `load` is intentionally excluded: panels build it inline, and depending on
    // its identity would reload on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, nonce]);

  return { ...state, reload: () => setNonce((value) => value + 1) };
}
