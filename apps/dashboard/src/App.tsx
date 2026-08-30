import { useMemo, useState } from "react";
import type { HealthResponse } from "@bayz/contracts";
import { fetchHealth } from "./api/health";
import { createApiClient, type ApiClient } from "./api/client";
import { createTokenStore, type TokenStore } from "./api/token";
import { TokenGate } from "./api/TokenGate";
import { ChatPanel } from "./panels/ChatPanel";
import { CoreStatus } from "./CoreStatus";
import { IdentitiesPanel } from "./panels/IdentitiesPanel";
import { ProvidersPanel } from "./panels/ProvidersPanel";
import { ProxiesPanel } from "./panels/ProxiesPanel";
import { RoutesPanel } from "./panels/RoutesPanel";
import { StatusPanel } from "./panels/StatusPanel";
import { Shell, type ScreenId } from "./Shell";
import { UsageScreen } from "./usage/UsageScreen";
import "./styles.css";

/** One store per browser session, held in memory only. */
const defaultTokenStore = createTokenStore();

type AppProps = {
  healthClient?: () => Promise<HealthResponse>;
  tokenStore?: TokenStore;
  apiClient?: ApiClient;
  /** Starting screen. Exists so a test can mount one screen directly. */
  initialScreen?: ScreenId;
};

/** Screen chrome shared by every non-Usage screen, matching the approved header block. */
function ScreenHeader({ kicker, title }: { kicker: string; title: string }) {
  return (
    <div className="screen-header">
      <div>
        <p className="kicker">{kicker}</p>
        <h2 className="screen-title">{title}</h2>
      </div>
    </div>
  );
}

export function App({
  healthClient = fetchHealth,
  tokenStore = defaultTokenStore,
  apiClient,
  initialScreen = "home",
}: AppProps) {
  const [screen, setScreen] = useState<ScreenId>(initialScreen);

  const api = useMemo(
    () =>
      apiClient ??
      createApiClient({
        token: () => tokenStore.get(),
        // A rejected token returns the operator to the gate instead of leaving
        // every panel silently failing.
        onUnauthorized: () => tokenStore.clear(),
      }),
    [apiClient, tokenStore],
  );

  /**
   * The endpoint printed in the navigation rail.
   *
   * Read from the page's own origin rather than hardcoded: the dashboard is served by
   * the Core it talks to, so the browser already knows the answer, and a baked-in
   * `localhost:20128` would be wrong for an operator who moved the port.
   */
  const endpoint = useMemo(() => {
    if (typeof location === "undefined") {
      return "/v1";
    }
    return `${location.host}/v1`;
  }, []);

  return (
    <Shell screen={screen} onSelect={setScreen} endpoint={endpoint}>
      {screen === "home" && (
        <section className="screen" aria-labelledby="home-title">
          <div className="screen-header">
            <div>
              <p className="kicker">Local router</p>
              <h2 className="screen-title" id="home-title">
                Home.
              </h2>
            </div>
          </div>
          {/* Unauthenticated liveness: it must render before, and independently of, the gate. */}
          <CoreStatus healthClient={healthClient} />
          <TokenGate store={tokenStore}>
            <StatusPanel load={() => api.getStatus()} />
          </TokenGate>
        </section>
      )}

      {screen === "usage" && (
        <TokenGate store={tokenStore}>
          <UsageScreen api={api} />
        </TokenGate>
      )}

      {screen === "providers" && (
        <section className="screen">
          <ScreenHeader kicker="Upstream configuration" title="Providers." />
          <TokenGate store={tokenStore}>
            <ProvidersPanel api={api} />
          </TokenGate>
        </section>
      )}

      {screen === "routes" && (
        <section className="screen">
          <ScreenHeader kicker="Model routing" title="Routes." />
          <TokenGate store={tokenStore}>
            <RoutesPanel api={api} />
          </TokenGate>
        </section>
      )}

      {screen === "proxies" && (
        <section className="screen">
          <ScreenHeader kicker="Egress" title="Proxies." />
          <TokenGate store={tokenStore}>
            <ProxiesPanel api={api} />
          </TokenGate>
        </section>
      )}

      {screen === "identities" && (
        <section className="screen">
          <ScreenHeader kicker="Client access" title="Identities." />
          <TokenGate store={tokenStore}>
            <IdentitiesPanel api={api} />
          </TokenGate>
        </section>
      )}

      {screen === "chat" && (
        <section className="screen">
          <ScreenHeader kicker="Verification" title="Chat." />
          <TokenGate store={tokenStore}>
            <ChatPanel api={api} />
          </TokenGate>
        </section>
      )}
    </Shell>
  );
}
