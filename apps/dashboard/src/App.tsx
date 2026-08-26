import { useMemo } from "react";
import type { HealthResponse } from "@bayz/contracts";
import { fetchHealth } from "./api/health";
import { createApiClient, type ApiClient } from "./api/client";
import { createTokenStore, type TokenStore } from "./api/token";
import { TokenGate } from "./api/TokenGate";
import { ChatPanel } from "./panels/ChatPanel";
import { CoreStatus } from "./CoreStatus";
import { FluxCoreSlot } from "./FluxCoreSlot";
import { ProvidersPanel } from "./panels/ProvidersPanel";
import { ProxiesPanel } from "./panels/ProxiesPanel";
import { RoutesPanel } from "./panels/RoutesPanel";
import { StatusPanel } from "./panels/StatusPanel";
import "./styles.css";

/** One store per browser session, held in memory only. */
const defaultTokenStore = createTokenStore();

type AppProps = {
  healthClient?: () => Promise<HealthResponse>;
  tokenStore?: TokenStore;
  apiClient?: ApiClient;
};

export function App({
  healthClient = fetchHealth,
  tokenStore = defaultTokenStore,
  apiClient,
}: AppProps) {
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

  return (
    <main className="bayz-shell">
      <header className="bayz-header">
        <h1>Bayz</h1>
        <span>Runtime / Private</span>
      </header>

      {/*
        Integration boundary for the approved BAYZ Flux Core V2 motion system.
        Intentionally empty: its source is supplied separately and must not be
        approximated here.
      */}
      <FluxCoreSlot />

      <CoreStatus healthClient={healthClient} />

      <TokenGate store={tokenStore}>
        <StatusPanel load={() => api.getStatus()} />
        <ProvidersPanel api={api} />
        <ProxiesPanel api={api} />
        <RoutesPanel api={api} />
        <ChatPanel api={api} />
      </TokenGate>
    </main>
  );
}
