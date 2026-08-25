import { HealthSchema, type HealthResponse } from "@bayz/contracts";

export async function fetchHealth(
  fetcher: typeof fetch = fetch,
): Promise<HealthResponse> {
  const response = await fetcher("/api/health", {
    headers: { accept: "application/json" },
  });
  if (!response.ok) throw new Error(`Health request failed: ${response.status}`);
  return HealthSchema.parse(await response.json());
}
