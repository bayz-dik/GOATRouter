import type { RuntimeStatus } from "../api/types";
import { PanelError, useAsync } from "./shared";

export type StatusPanelProps = {
  load: () => Promise<RuntimeStatus>;
};

/**
 * Read-only runtime summary.
 *
 * Only the fields this panel knows about are read from the response, so an
 * unexpected key — including one that looks like a secret — cannot reach the DOM
 * even if a future API version or a compromised Core returned it.
 */
export function StatusPanel({ load }: StatusPanelProps) {
  const { value, error, loading } = useAsync(load);

  if (error !== undefined) {
    return (
      <section className="bayz-panel" aria-labelledby="status-heading">
        <h2 id="status-heading">Runtime</h2>
        <PanelError error={error} />
      </section>
    );
  }

  if (loading || value === undefined) {
    return (
      <section className="bayz-panel" aria-labelledby="status-heading">
        <h2 id="status-heading">Runtime</h2>
        <p>Loading runtime status…</p>
      </section>
    );
  }

  return (
    <section className="bayz-panel" aria-labelledby="status-heading">
      <h2 id="status-heading">Runtime</h2>
      <dl className="bayz-facts">
        <dt>Schema version</dt>
        <dd>{value.schemaVersion}</dd>
        <dt>Journal mode</dt>
        <dd>{value.journalMode}</dd>
        <dt>Driver</dt>
        <dd>{value.driver}</dd>
        <dt>Key provider</dt>
        <dd>{value.keyProvider}</dd>
        <dt>Key fingerprint</dt>
        {/* A one-way fingerprint, not key material. */}
        <dd>{value.keyId}</dd>
      </dl>
      <ul className="bayz-counts">
        <li data-testid="count-providers">Providers: {value.counts.providers}</li>
        <li data-testid="count-proxies">Proxies: {value.counts.proxies}</li>
        <li data-testid="count-routes">Routes: {value.counts.routes}</li>
      </ul>
    </section>
  );
}
