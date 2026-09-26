import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { BbDesktopApi, BbDesktopInfo } from "@bb/desktop-contract";
import { getBbDesktopInfo } from "@/lib/bb-desktop";

interface DesktopUpdateInfo {
  desktopApi: BbDesktopApi | null;
  desktopInfo: BbDesktopInfo | null;
  isDesktop: boolean;
}

// The app updates itself; this link is the fallback when it can't.
export const DESKTOP_DOWNLOAD_URL = "https://www.cloudroom.dev/download";
export const LATEST_DESKTOP_RELEASE_QUERY_KEY = ["desktop", "latest-release"];
const LATEST_DESKTOP_RELEASE_URL = "https://www.cloudroom.dev/download/latest";

// Versions look like "v49" in the app and "49" on the website. "dev" builds never match.
function releaseNumber(version: string | null | undefined): number {
  return Number(/^v?(\d+)$/.exec(version ?? "")?.[1] ?? Number.NaN);
}

async function fetchLatestDesktopVersion(
  signal: AbortSignal,
): Promise<string | null> {
  const response = await fetch(LATEST_DESKTOP_RELEASE_URL, { signal });
  if (!response.ok) {
    throw new Error(`Latest release request failed (${response.status})`);
  }
  const body = (await response.json()) as { version?: string | null };
  return body.version ?? null;
}

export function useDesktopUpdateInfo(): DesktopUpdateInfo {
  const [desktopApi] = useState<BbDesktopApi | null>(() => getBbDesktopInfo());
  const [desktopInfo, setDesktopInfo] = useState<BbDesktopInfo | null>(null);
  const latestQuery = useQuery({
    queryKey: LATEST_DESKTOP_RELEASE_QUERY_KEY,
    queryFn: ({ signal }) => fetchLatestDesktopVersion(signal),
    enabled: desktopApi !== null,
    refetchInterval: 15 * 60 * 1000,
    retry: false,
    staleTime: 15 * 60 * 1000,
  });

  useEffect(() => {
    const api = getBbDesktopInfo();
    if (api === null) {
      return;
    }

    let mounted = true;
    void api
      .getInfo()
      .then((info) => {
        if (mounted) {
          setDesktopInfo(info);
        }
      })
      .catch(() => undefined);
    const unsubscribe = api.onChange((info) => {
      setDesktopInfo(info);
    });

    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  const latest = releaseNumber(latestQuery.data);
  const info =
    desktopInfo !== null && latest > releaseNumber(desktopInfo.version)
      ? { ...desktopInfo, latestVersion: `v${latest}`, updateAvailable: true }
      : desktopInfo;

  return { desktopApi, desktopInfo: info, isDesktop: desktopApi !== null };
}
