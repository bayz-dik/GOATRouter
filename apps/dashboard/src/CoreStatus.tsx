import { useEffect, useState } from "react";
import type { HealthResponse } from "@bayz/contracts";

export type CoreStatusProps = {
  healthClient: () => Promise<HealthResponse>;
};

/**
 * Unauthenticated liveness indicator.
 *
 * `/api/health` needs no token, so this renders before and independently of the
 * token gate: an operator should be able to tell "the Core is down" apart from
 * "I have not unlocked the session yet".
 */
export function CoreStatus({ healthClient }: CoreStatusProps) {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    let active = true;
    void healthClient().then(
      (value) => active && setHealth(value),
      () => active && setOffline(true),
    );
    return () => {
      active = false;
    };
  }, [healthClient]);

  return (
    <section className="status-panel" aria-live="polite">
      {!health && !offline && <p>Checking Core…</p>}
      {health && (
        <>
          <strong>Core online</strong>
          <span>v{health.version}</span>
        </>
      )}
      {offline && (
        <>
          <strong>Core offline</strong>
          <span>Check the GOAT ROUTER process and try again.</span>
        </>
      )}
    </section>
  );
}
