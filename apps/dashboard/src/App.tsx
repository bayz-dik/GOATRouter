import { useEffect, useState } from "react";
import type { HealthResponse } from "@bayz/contracts";
import { fetchHealth } from "./api/health";
import "./styles.css";

type AppProps = {
  healthClient?: () => Promise<HealthResponse>;
};

export function App({ healthClient = fetchHealth }: AppProps) {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    let active = true;
    void healthClient().then(
      (value) => active && setHealth(value),
      () => active && setOffline(true),
    );
    return () => { active = false; };
  }, [healthClient]);

  return (
    <main className="bayz-shell">
      <header className="bayz-header">
        <h1>Bayz</h1>
        <span>Foundation / Private</span>
      </header>
      <section className="status-panel" aria-live="polite">
        {!health && !offline && <p>Checking Core…</p>}
        {health && <><strong>Core online</strong><span>v{health.version}</span></>}
        {offline && <><strong>Core offline</strong><span>Check the Bayz process and try again.</span></>}
      </section>
      <nav aria-label="Planned Bayz modules">
        {[
          "Providers", "Proxies", "Combos", "Routes", "CLI Tools", "Usage",
        ].map((label) => <span className="planned-module" key={label}>{label} / Planned</span>)}
      </nav>
    </main>
  );
}
