import { useState } from "react";
import { Button } from "@bb/shared-ui/button";
import { Icon } from "@bb/shared-ui/icon";
import {
  DESKTOP_DOWNLOAD_URL,
  useDesktopUpdateInfo,
} from "@/hooks/useDesktopUpdateInfo";
import { rawStringLocalStorage } from "@/lib/browser-storage";
import { openUrlInExternalBrowser } from "@/lib/url-open-routing";

const DISMISSED_VERSION_KEY = "cloudroom.update-banner.dismissed-version";

// App-wide notice: Restart once the in-app update is ready; the website link only when the app can't update itself.
export function DesktopUpdateBanner() {
  const { desktopApi, desktopInfo } = useDesktopUpdateInfo();
  const [dismissed, setDismissed] = useState(() =>
    rawStringLocalStorage.getItem(DISMISSED_VERSION_KEY, ""),
  );
  const [restarting, setRestarting] = useState(false);
  const version = desktopInfo?.pendingVersion ?? desktopInfo?.latestVersion;
  const ready = desktopInfo?.updateDownloaded === true && desktopApi !== null;
  const cannotSelfUpdate =
    desktopInfo?.autoUpdateEnabled !== true ||
    desktopInfo.downloadState === "failed";
  if (
    !desktopInfo?.updateAvailable ||
    !version ||
    version === dismissed ||
    (!ready && !cannotSelfUpdate)
  ) {
    return null;
  }

  const dismiss = () => {
    rawStringLocalStorage.setItem(DISMISSED_VERSION_KEY, version);
    setDismissed(version);
  };
  const restart = () => {
    setRestarting(true);
    void desktopApi?.installUpdate().catch(() => setRestarting(false));
  };

  return (
    <div
      role="status"
      data-testid="desktop-update-banner"
      className="flex shrink-0 items-center gap-3 border-b border-primary/30 bg-primary/10 px-4 py-2 text-sm"
    >
      <Icon name="Download" className="size-4 shrink-0 text-primary" />
      <span className="min-w-0 flex-1 truncate">
        {ready ? (
          <>
            <strong>A new version of Cloudroom is ready.</strong> Restart to
            update. Running agents resume automatically.
          </>
        ) : (
          <>
            <strong>Cloudroom {version} is available.</strong> You have{" "}
            {desktopInfo.version}. Download it to get the latest fixes.
          </>
        )}
      </span>
      {ready ? (
        <Button size="sm" disabled={restarting} onClick={restart}>
          {restarting ? "Restarting…" : "Restart to update"}
        </Button>
      ) : (
        <Button
          size="sm"
          onClick={() => openUrlInExternalBrowser(DESKTOP_DOWNLOAD_URL)}
        >
          Download
        </Button>
      )}
      <Button
        size="icon"
        variant="ghost"
        aria-label="Dismiss update notice"
        onClick={dismiss}
      >
        <Icon name="X" className="size-4" />
      </Button>
    </div>
  );
}
