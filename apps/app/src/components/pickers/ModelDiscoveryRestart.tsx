import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { SystemProvidersQuery } from "@bb/server-contract";
import { Button } from "@bb/shared-ui/button";
import { Icon } from "@bb/shared-ui/icon";
import { systemExecutionOptionsQueryKey } from "@/hooks/queries/query-keys";
import {
  modelCatalogCacheKey,
  writeCachedModelCatalog,
} from "@/lib/model-catalog-cache";
import { sdk } from "@/lib/sdk";
import { formatModelLoadErrorText } from "./model-load-error-message";

export function ModelDiscoveryRestart({
  providerId,
  providerLabel,
  routing,
}: {
  providerId: string;
  providerLabel: string;
  routing?: SystemProvidersQuery;
}) {
  const queryClient = useQueryClient();
  const identity = {
    providerId,
    environmentId: routing?.environmentId ?? null,
    hostId: routing?.hostId ?? null,
  };
  const restart = useMutation({
    mutationFn: async () => {
      const queryKey = systemExecutionOptionsQueryKey(identity);
      await queryClient.cancelQueries({ queryKey, exact: true });
      const result = await sdk.providers.restartModelDiscovery({
        providerId,
        ...(routing?.environmentId
          ? { environmentId: routing.environmentId }
          : routing?.hostId
            ? { hostId: routing.hostId }
            : {}),
      });
      queryClient.setQueryData(queryKey, result);
      if (result.modelLoadError) {
        throw new Error(
          formatModelLoadErrorText({
            error: result.modelLoadError,
            providerLabel,
          }),
        );
      }
      if (result.models.length === 0) {
        throw new Error(`${providerLabel} still returned no models.`);
      }
      writeCachedModelCatalog(modelCatalogCacheKey(identity), {
        models: result.models,
        selectedOnlyModels: result.selectedOnlyModels,
      });
    },
  });

  return (
    <div className="space-y-2 px-2 py-3 text-xs">
      <p className="text-muted-foreground">
        Could not load {providerLabel} models.
      </p>
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="w-full"
        disabled={restart.isPending}
        onClick={() => restart.mutate()}
      >
        <Icon
          name={restart.isPending ? "Spinner" : "RotateCcw"}
          className={restart.isPending ? "size-3.5 animate-spin" : "size-3.5"}
        />
        {restart.isPending
          ? `Restarting ${providerLabel}…`
          : `Restart ${providerLabel}`}
      </Button>
      {restart.isError ? (
        <p role="alert" className="text-destructive-text">
          {restart.error.message}
        </p>
      ) : null}
    </div>
  );
}
