import { appToast } from "@/components/ui/app-toast";
import { useCloudroomAccount } from "@/hooks/queries/cloudroom-queries";
import { openUrlInExternalBrowser } from "@/lib/url-open-routing";

export const CLOUD_WAITLIST_URL = "https://www.cloudroom.dev/#waitlist";
export const CLOUD_LOCKED_REASON = "Invite-only beta. Join the waitlist.";

export function useCloudLocked(): boolean {
  const status = useCloudroomAccount();
  return status.isSuccess && !status.data.account;
}

export function showCloudWaitlist(): void {
  appToast.message("Cloud is an invite-only beta", {
    description: "Join the waitlist to get access. Already invited? Sign in at the bottom left.",
    action: { label: "Join the waitlist", onClick: () => openUrlInExternalBrowser(CLOUD_WAITLIST_URL) },
  });
}
