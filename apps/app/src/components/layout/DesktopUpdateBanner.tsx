import { useEffect, useState } from "react";
import { isBusyThread } from "@bb/client-core";
import type { ThreadListEntry } from "@bb/domain";
import { Button } from "@bb/shared-ui/button";
import { Icon } from "@bb/shared-ui/icon";
import {
  DESKTOP_DOWNLOAD_URL,
  useDesktopUpdateInfo,
} from "@/hooks/useDesktopUpdateInfo";
import { useSidebarNavigationThreadSelection } from "@/hooks/queries/sidebar-navigation-query";
import { rawStringLocalStorage } from "@/lib/browser-storage";
import { openUrlInExternalBrowser } from "@/lib/url-open-routing";

const DISMISSED_VERSION_KEY = "cloudroom.update-banner.dismissed-version";
const DISMISSED_AT_KEY = "cloudroom.update-banner.dismissed-at";
const REMIND_AFTER_MS = 8 * 60 * 60 * 1000;
const HEIGHT_VAR = "--bb-update-banner-height";

// Window-pinned controls (e.g. the home right-panel toggle) read this to sit below the banner.
function publishBannerHeight(element: HTMLDivElement | null) {
  if (!element) return;
  const style = document.documentElement.style;
  style.setProperty(HEIGHT_VAR, `${element.offsetHeight}px`);
  return () => {
    style.removeProperty(HEIGHT_VAR);
  };
}

const selectAnyThreadBusy = (threads: ThreadListEntry[]) =>
  threads.some(isBusyThread);

function readDismissal() {
  return {
    version: rawStringLocalStorage.getItem(DISMISSED_VERSION_KEY, ""),
    at: Number(rawStringLocalStorage.getItem(DISMISSED_AT_KEY, "0")),
  };
}

// A closed banner returns after REMIND_AFTER_MS once no agent is working; the minute poll survives Mac sleep.
function useDismissal(version: string | null | undefined) {
  const [dismissal, setDismissal] = useState(readDismissal);
  const [now, setNow] = useState(Date.now);
  const agentsIdle =
    useSidebarNavigationThreadSelection(selectAnyThreadBusy).data === false;
  const hidden = Boolean(version) && version === dismissal.version;
  const remindDue = hidden && now >= dismissal.at + REMIND_AFTER_MS;

  useEffect(() => {
    if (!hidden || remindDue) return;
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, [hidden, remindDue]);

  useEffect(() => {
    if (!remindDue || !agentsIdle) return;
    rawStringLocalStorage.removeItem(DISMISSED_VERSION_KEY);
    rawStringLocalStorage.removeItem(DISMISSED_AT_KEY);
    setDismissal({ version: "", at: 0 });
  }, [remindDue, agentsIdle]);

  const dismiss = (dismissedVersion: string) => {
    const at = Date.now();
    rawStringLocalStorage.setItem(DISMISSED_VERSION_KEY, dismissedVersion);
    rawStringLocalStorage.setItem(DISMISSED_AT_KEY, String(at));
    setDismissal({ version: dismissedVersion, at });
    setNow(at);
  };
  return { hidden, dismiss };
}

// App-wide notice: Restart once the in-app update is ready; the website link only when the app can't update itself.
export function DesktopUpdateBanner() {
  const { desktopApi, desktopInfo } = useDesktopUpdateInfo();
  const [restarting, setRestarting] = useState(false);
  const version = desktopInfo?.pendingVersion ?? desktopInfo?.latestVersion;
  const dismissal = useDismissal(version);
  const ready = desktopInfo?.updateDownloaded === true && desktopApi !== null;
  const cannotSelfUpdate =
    desktopInfo?.autoUpdateEnabled !== true ||
    desktopInfo.downloadState === "failed";
  if (
    !desktopInfo?.updateAvailable ||
    !version ||
    dismissal.hidden ||
    (!ready && !cannotSelfUpdate)
  ) {
    return null;
  }

  const dismiss = () => dismissal.dismiss(version);
  const restart = () => {
    setRestarting(true);
    void desktopApi?.installUpdate().catch(() => setRestarting(false));
  };

  return (
    <div
      ref={publishBannerHeight}
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
