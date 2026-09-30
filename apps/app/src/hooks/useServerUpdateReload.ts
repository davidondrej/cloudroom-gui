import { useEffect, useRef } from "react";
import { appToast } from "@/components/ui/app-toast";
import { useSystemVersion } from "@/hooks/queries/system-queries";

const TOAST_ID = "server-updated";

/** A window viewing another Mac's server keeps running the build it loaded after that server updates. The
 *  version is refetched on every reconnect (a server update restarts it), so a change offers a reload. */
export function useServerUpdateReload(): void {
  const version = useSystemVersion().data?.desktopVersion;
  const loaded = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!version) return;
    loaded.current ??= version;
    if (version === loaded.current) return;
    appToast.message("Cloudroom was updated", {
      id: TOAST_ID,
      duration: Infinity,
      description: `Reload to use ${version}.`,
      action: { label: "Reload", onClick: () => window.location.reload() },
    });
  }, [version]);
}
