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

// App-wide notice when the website serves a newer GUI. Dismissal lasts until the next release.
export function DesktopUpdateBanner() {
  const { desktopApi, desktopInfo } = useDesktopUpdateInfo();
  const [dismissed, setDismissed] = useState(() =>
    rawStringLocalStorage.getItem(DISMISSED_VERSION_KEY, ""),
  );
  const version = desktopInfo?.latestVersion ?? desktopInfo?.pendingVersion;
  if (!desktopInfo?.updateAvailable || !version || version === dismissed) {
    return null;
  }

  const dismiss = () => {
    rawStringLocalStorage.setItem(DISMISSED_VERSION_KEY, version);
    setDismissed(version);
  };
  const ready = desktopInfo.updateDownloaded && desktopApi !== null;

  return (
    <div
      role="status"
      data-testid="desktop-update-banner"
      className="flex shrink-0 items-center gap-3 border-b border-primary/30 bg-primary/10 px-4 py-2 text-sm"
    >
      <Icon name="Download" className="size-4 shrink-0 text-primary" />
      <span className="min-w-0 flex-1 truncate">
        <strong>Cloudroom {version} is available.</strong> You have{" "}
        {desktopInfo.version}. {ready ? "Relaunch to finish updating." : "Download it to get the latest fixes."}
      </span>
      <Button
        size="sm"
        onClick={() =>
          ready
            ? void desktopApi?.installUpdate()
            : openUrlInExternalBrowser(DESKTOP_DOWNLOAD_URL)
        }
      >
        {ready ? "Relaunch" : "Download"}
      </Button>
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
