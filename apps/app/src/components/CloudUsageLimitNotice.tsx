import { useMutation } from "@tanstack/react-query";
import { Button } from "@cloudroom/shared-ui/button";
import { PromptStackCard } from "@/components/promptbox/banner/PromptStackCard";
import { fetchWithAppSurface } from "@/lib/app-surface";

async function askForMoreUsage() {
  const response = await fetchWithAppSurface("/api/v1/cloudroom/account/more-usage", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  const value = await response.json().catch(() => null) as { message?: string } | null;
  if (!response.ok) throw new Error(value?.message ?? `The request for more usage failed (HTTP ${response.status}).`);
}

export function CloudUsageLimitNotice() {
  const ask = useMutation({ mutationFn: askForMoreUsage });
  return (
    <PromptStackCard ariaLabel="Cloud usage limit" className="space-y-2 p-3 text-xs">
      <p className="text-sm font-medium">You hit the limit of Cloud threads.</p>
      <p className="text-muted-foreground">Today's cloud hours are used up. They reset at midnight UTC. Your messages are saved, and Local threads still work.</p>
      {ask.isSuccess
        ? <p role="status" className="text-muted-foreground">Sent. The Cloudroom team will reach out to set up a quick call.</p>
        : <Button type="button" size="sm" disabled={ask.isPending} onClick={() => ask.mutate()}>Ask for more usage</Button>}
      {ask.error && <p role="alert" className="text-destructive">{ask.error.message}</p>}
    </PromptStackCard>
  );
}
