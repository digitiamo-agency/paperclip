import { useQuery } from "@tanstack/react-query";
import { aiRoutingModel, type AiConnectionBinding, type AiProviderRouting } from "@paperclipai/shared";
import { aiConnectionsApi } from "@/api/ai-connections";
import { agentsApi } from "@/api/agents";
import { queryKeys } from "@/lib/queryKeys";

export function useConnectionModels(
  companyId: string | null | undefined,
  binding: AiConnectionBinding | undefined,
  harness: string,
) {
  const accounts = useQuery({
    queryKey: ["ai-connections", companyId],
    queryFn: () => aiConnectionsApi.list(companyId!),
    enabled: Boolean(companyId && binding),
  });
  const connection = accounts.data?.connections.find((c) =>
    binding?.mode === "responsible_user"
      ? c.provider === binding.provider && c.isDefault && c.ownerUserId === accounts.data?.currentUserId && c.ownership === "personal"
      : c.id === binding?.connectionId && c.grantId === binding?.grantId,
  );
  const routing = connection?.routing;
  const openRouter = routing?.kind === "openrouter" || (!routing && binding?.provider === "openrouter");
  const endpointRouting = routing?.kind === "gateway" || routing?.kind === "local";
  // OpenRouter reuses the public catalog when the connection has no allowlist.
  // Gateway/local connections always load live from the connection's
  // OpenAI-compatible `/models` using vaulted credentials; the stored allowlist
  // is only a fallback while loading or if the live catalog fails.
  const discoverOpenRouter = openRouter && !routing?.models.length;
  const discoverEndpoint = Boolean(connection && endpointRouting);
  const catalog = useQuery({
    queryKey: queryKeys.agents.adapterModels(companyId ?? "none", "opencode_local", null, "openrouter"),
    queryFn: () => agentsApi.adapterModels(companyId!, "opencode_local", { provider: "openrouter" }),
    enabled: Boolean(companyId && discoverOpenRouter),
    staleTime: 60_000,
    retry: false,
  });
  const endpointCatalog = useQuery({
    queryKey: ["ai-connections", companyId, connection?.id, connection?.grantId, "models"],
    queryFn: () => aiConnectionsApi.listModels(companyId!, connection!.id, connection!.grantId),
    enabled: Boolean(companyId && discoverEndpoint),
    staleTime: 60_000,
    retry: false,
  });
  const effectiveRouting: AiProviderRouting | undefined = routing ?? (openRouter
    ? { kind: "openrouter", protocol: "chat", auth: "bearer", models: [] }
    : undefined);
  const storedModels = routing?.models ?? [];
  const modelOptions = discoverOpenRouter
    ? (catalog.data ?? []).map((m) => ({ ...m, id: harness === "opencode_local" ? m.id : m.id.replace(/^openrouter\//, "") }))
    : discoverEndpoint
      ? (endpointCatalog.data?.models ?? storedModels)
      : storedModels;
  const discovering = discoverOpenRouter || discoverEndpoint;
  const activeCatalog = discoverOpenRouter ? catalog : endpointCatalog;
  return effectiveRouting
    ? {
        models: modelOptions.map((m) => ({
          id: aiRoutingModel(effectiveRouting, harness, m.id),
          label: m.label ?? m.id,
        })),
        isLoading: discovering && activeCatalog.isLoading && modelOptions.length === 0,
        error: discovering && modelOptions.length === 0 ? activeCatalog.error : null,
        refreshing: discovering && activeCatalog.isFetching,
        refreshModels: discovering ? async () => { await activeCatalog.refetch(); } : undefined,
        resolveModel: (model: string) =>
          aiRoutingModel(effectiveRouting, harness, model),
      }
    : undefined;
}
