import { useEffect } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Button } from "@bb/shared-ui/button";
import { Icon } from "@bb/shared-ui/icon";
import { SidebarMenuItem } from "@/components/ui/sidebar";
import { appToast } from "@/components/ui/app-toast";
import { useCloudroomAccount } from "@/hooks/queries/cloudroom-queries";
import { getSettingsRoutePath } from "@/lib/route-paths";
import { sdk } from "@/lib/sdk";
import { openUrlInExternalBrowser } from "@/lib/url-open-routing";

export function CloudroomSignInButton() {
  const status = useCloudroomAccount();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const action = useMutation({
    mutationFn: async () => {
      if (status.data?.signingIn) await sdk.cloudroom.cancel();
      else {
        const { url } = await sdk.cloudroom.signIn();
        openUrlInExternalBrowser(url);
      }
    },
    onSuccess: () => {
      return queryClient.invalidateQueries({ queryKey: ["cloudroom-account"] });
    },
    onError: (error) => appToast.error(error.message),
  });
  const signInError = status.data?.signInError;
  const accountId = status.data?.account?.id;
  useEffect(() => { if (signInError) appToast.error(signInError); }, [signInError]);
  useEffect(() => { void queryClient.invalidateQueries({ queryKey: ["cloudroom-connection"] }); }, [queryClient, accountId]);
  const checking = status.isPending;
  const label = checking || status.data?.account ? "Account" : status.data?.signingIn ? "Cancel sign-in" : "Sign in";
  return <SidebarMenuItem className="min-w-0" data-footer-item="cloudroom-account">
    <Button variant="ghost" size="sm" className="h-8 px-2 text-xs text-muted-foreground hover:text-sidebar-foreground [&_[data-icon-root]]:size-3" aria-description={checking ? "Checking your account" : status.data?.account?.email ?? "Sign in to Cloudroom"} disabled={action.isPending || checking} onClick={() => {
      if (status.data?.account) void navigate(getSettingsRoutePath("machines"));
      else action.mutate();
    }}>{action.isPending ? "Connecting…" : label}{checking && <Icon name="Loading" className="animate-spin" aria-hidden />}</Button>
  </SidebarMenuItem>;
}
