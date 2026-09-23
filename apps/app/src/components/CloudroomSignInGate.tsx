import { useId, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@bb/shared-ui/button";
import { PersistentResponsiveDrawerShell } from "@bb/shared-ui/responsive-overlay";
import { useCloudroomAccount } from "@/hooks/queries/cloudroom-queries";
import { sdk } from "@/lib/sdk";
import { openUrlInExternalBrowser } from "@/lib/url-open-routing";
import { CodexConnectionPanel, CursorConnectionPanel } from "./CodexConnectionPanel";

export function CloudroomSignInGate() {
  const status = useCloudroomAccount();
  const queryClient = useQueryClient();
  const titleId = useId();
  const descriptionId = useId();
  const [signInUrl, setSignInUrl] = useState<string | null>(null);
  const action = useMutation({
    mutationFn: async (kind: "sign-in" | "cancel") => {
      if (kind === "cancel") {
        await sdk.cloudroom.cancel();
        setSignInUrl(null);
      } else {
        const { url } = await sdk.cloudroom.signIn();
        setSignInUrl(url);
        openUrlInExternalBrowser(url);
      }
    },
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: ["cloudroom-account"] }),
  });

  const error = action.error?.message ?? status.data?.signInError;
  const signingIn = status.data?.signingIn;
  if (status.isPending) return null;
  if (status.data?.account) return <><CodexConnectionPanel /><CursorConnectionPanel /></>;

  return (
    <PersistentResponsiveDrawerShell
      open
      onOpenChange={() => {}}
      closeOnBackdropClick={false}
      labelledBy={titleId}
      describedBy={descriptionId}
      backdropClassName="bg-black/25 backdrop-blur-xs"
      contentClassName="inset-0 m-auto h-fit w-[calc(100%-2rem)] max-w-sm overflow-y-auto rounded-xl p-8 shadow-2xl [&>[data-persistent-drawer-handle]]:hidden"
    >
      <div className="space-y-6 text-center">
        <div className="space-y-2">
          <h1 id={titleId} className="text-xl font-semibold tracking-tight">
            Welcome to Cloudroom
          </h1>
          <p id={descriptionId} className="text-sm text-muted-foreground">
            Sign in to start using the app.
          </p>
        </div>
        {status.isError ? (
          <div className="space-y-3">
            <p role="alert" className="text-sm text-destructive">
              Could not check your account. Try again, or restart Cloudroom.
            </p>
            <Button
              variant="outline"
              disabled={status.isFetching}
              onClick={() => void status.refetch()}
            >
              Try again
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            {signingIn ? (
              <>
                <p role="status" className="text-sm text-muted-foreground">
                  Finish signing in on the Cloudroom website, then return here.
                  The app will unlock automatically.
                </p>
                {signInUrl && (
                  <Button
                    className="w-full"
                    onClick={() => openUrlInExternalBrowser(signInUrl)}
                  >
                    Open browser again
                  </Button>
                )}
                <Button
                  variant="ghost"
                  className="w-full"
                  disabled={action.isPending}
                  onClick={() => action.mutate("cancel")}
                >
                  Cancel sign-in
                </Button>
              </>
            ) : (
              <Button
                className="w-full"
                disabled={action.isPending}
                onClick={() => action.mutate("sign-in")}
              >
                {action.isPending ? "Opening browser…" : "Sign in to Cloudroom"}
              </Button>
            )}
            <p className="text-xs text-muted-foreground">
              Opens cloudroom.dev in your default browser.
            </p>
          </div>
        )}
      </div>
    </PersistentResponsiveDrawerShell>
  );
}
