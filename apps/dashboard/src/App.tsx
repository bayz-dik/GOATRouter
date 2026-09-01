import { useEffect, useMemo, useState } from "react";
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

/**
 * Screen chrome shared by every non-Usage screen.
 *
 * The kicker is gone. It sat above each title as a two-word caption — "Upstream
 * configuration" over "Providers.", "Model routing" over "Routes." — restating the title
 * in different words, which is the definition of decorative copy. Titles also lose the
 * trailing period they carried from the reference preview: it was an affectation, and it
 * made every heading read as a sentence fragment.
 *
 * The `id` is load-bearing rather than cosmetic: the panel below adopts this heading as
 * its own accessible name instead of printing the same word a second time. Before this,
 * the Providers screen rendered `<h2>Providers</h2>` twice — once as the screen title and
 * once inside the panel — which is one heading too many by the same rule that removed the
 * kicker, and it made `getByRole("heading", { name: "Providers" })` ambiguous.
 */
function ScreenHeader({ title, id }: { title: string; id: string }) {
  return (
    <div className="screen-header">
      <div>
        <h2 className="screen-title" id={id}>
          {title}
        </h2>
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

  /**
   * Authentication decides the whole render tree, not the contents of one panel.
   *
   * Previously every screen mounted `Shell` and wrapped its *panel* in `TokenGate`, so
   * an unauthenticated visitor got the navigation rail, a screen heading and a liveness
   * line around the token field. The gate worked — no panel data leaked — but the shell
   * was chrome for a session that did not exist yet. Now the login surface is returned
   * before `Shell` is mounted at all.
   */
  const [unlocked, setUnlocked] = useState(() => tokenStore.isSet());
  useEffect(() => tokenStore.subscribe(() => setUnlocked(tokenStore.isSet())), [tokenStore]);

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

  if (!unlocked) {
    return <TokenGate store={tokenStore} />;
  }

  return (
    <Shell screen={screen} onSelect={setScreen} endpoint={endpoint}>
      {screen === "home" && (
        <section className="screen" aria-labelledby="home-title">
          <div className="screen-header">
            <div>
              <h2 className="screen-title" id="home-title">
                Home
              </h2>
            </div>
          </div>
          {/* A real reading from `/api/health`, not a decorative status label. */}
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
        <section className="screen" aria-labelledby="providers-title">
          <ScreenHeader title="Providers" id="providers-title" />
          <TokenGate store={tokenStore}>
            <ProvidersPanel api={api} headingId="providers-title" />
          </TokenGate>
        </section>
      )}

      {screen === "routes" && (
        <section className="screen" aria-labelledby="routes-title">
          <ScreenHeader title="Routes" id="routes-title" />
          <TokenGate store={tokenStore}>
            <RoutesPanel api={api} headingId="routes-title" />
          </TokenGate>
        </section>
      )}

      {screen === "proxies" && (
        <section className="screen" aria-labelledby="proxies-title">
          <ScreenHeader title="Proxies" id="proxies-title" />
          <TokenGate store={tokenStore}>
            <ProxiesPanel api={api} headingId="proxies-title" />
          </TokenGate>
        </section>
      )}

      {screen === "identities" && (
        <section className="screen" aria-labelledby="identities-title">
          <ScreenHeader title="Identities" id="identities-title" />
          <TokenGate store={tokenStore}>
            {/*
              The panel keeps its own `Client identities` heading: it names something
              narrower than the screen does — the client keys, not the screen — so it is a
              real section title rather than the screen's title said twice.
            */}
            <IdentitiesPanel api={api} />
          </TokenGate>
        </section>
      )}

      {screen === "chat" && (
        <section className="screen" aria-labelledby="chat-title">
          <ScreenHeader title="Chat" id="chat-title" />
          <TokenGate store={tokenStore}>
            <ChatPanel api={api} />
          </TokenGate>
        </section>
      )}
    </Shell>
  );
}
