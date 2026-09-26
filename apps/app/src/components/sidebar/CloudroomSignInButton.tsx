import { useEffect } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Button } from "@bb/shared-ui/button";
import { Icon } from "@bb/shared-ui/icon";
import { Tooltip, TooltipContent, TooltipTrigger } from "@bb/shared-ui/tooltip";
import { cn } from "@bb/shared-ui/lib/utils";
import { SidebarMenuItem } from "@/components/ui/sidebar";
import { appToast } from "@/components/ui/app-toast";
import { useCloudroomAccount, useSetMacAccess } from "@/hooks/queries/cloudroom-queries";
import { getSettingsRoutePath } from "@/lib/route-paths";
import { sdk } from "@/lib/sdk";
import { openUrlInExternalBrowser } from "@/lib/url-open-routing";

const FOOTER_ICON_BUTTON_CLASS = "relative size-8 p-0 text-muted-foreground hover:text-sidebar-foreground [&_[data-icon-root]]:size-4";

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
  const macAccess = useSetMacAccess();
  const macAccessOn = macAccess.isPending ? macAccess.variables : status.data?.macAccess === true;
  const toggleMacAccess = () => macAccess.mutate(!macAccessOn, {
    onSuccess: () => appToast.success(macAccessOn ? "Cloud agents can no longer access this computer" : "Cloud agents can now access this computer"),
    onError: (error) => appToast.error(error.message),
  });
  const account = status.data?.account;
  const signingIn = status.data?.signingIn === true;
  const label = checking || account ? "Account" : signingIn ? "Cancel sign-in" : "Sign in";
  const tooltip = account ? `Account (${account.email})` : signingIn ? "Cancel sign-in" : checking ? "Checking your account" : "Sign in to Cloudroom";
  return <>
    <SidebarMenuItem data-footer-item="cloudroom-account">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" className={FOOTER_ICON_BUTTON_CLASS} aria-label={label} disabled={action.isPending || checking} onClick={() => {
            if (account) void navigate(getSettingsRoutePath("machines"));
            else action.mutate();
          }}>
            {checking || signingIn || action.isPending ? <Icon name="Loading" className="animate-spin" aria-hidden /> : <Icon name="UserRound" aria-hidden />}
            {!checking && !account && !signingIn && <span className="absolute right-1.5 top-1.5 size-1.5 rounded-full bg-destructive" aria-hidden />}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top">{tooltip}</TooltipContent>
      </Tooltip>
    </SidebarMenuItem>
    {account && <SidebarMenuItem>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" className={cn(FOOTER_ICON_BUTTON_CLASS, !macAccessOn && "text-muted-foreground/40")} aria-label="Let cloud agents access this computer" aria-pressed={macAccessOn} disabled={macAccess.isPending} onClick={toggleMacAccess}>
            <Icon name="DataTransfer" aria-hidden />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top">{macAccessOn ? "Cloud agents can access this computer. Click to turn off." : "Cloud agents can't access this computer. Click to turn on."}</TooltipContent>
      </Tooltip>
    </SidebarMenuItem>}
  </>;
}
