export type TokenStore = {
  get(): string | undefined;
  isSet(): boolean;
  /** Returns false when the value is unusable, so the caller can show an error. */
  set(value: string): boolean;
  clear(): void;
  subscribe(listener: () => void): () => void;
};

/**
 * Hold the API token in module-scope memory only.
 *
 * Deliberately not `localStorage`, `sessionStorage`, a cookie, or the URL. Any of
 * those is readable by a script that achieves XSS on this origin, which would turn
 * a transient injection into permanent API access. The cost is re-entry after every
 * reload; that is a real inconvenience accepted on purpose.
 */
export function createTokenStore(): TokenStore {
  let token: string | undefined;
  const listeners = new Set<() => void>();

  const notify = (): void => {
    for (const listener of listeners) {
      listener();
    }
  };

  return {
    get: () => token,
    isSet: () => token !== undefined,

    set(value: string): boolean {
      const trimmed = typeof value === "string" ? value.trim() : "";
      if (trimmed.length === 0) {
        return false;
      }
      token = trimmed;
      notify();
      return true;
    },

    clear(): void {
      if (token !== undefined) {
        token = undefined;
        notify();
      }
    },

    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
