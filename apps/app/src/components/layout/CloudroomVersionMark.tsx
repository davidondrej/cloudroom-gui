import { useState } from "react";
import { cn } from "@bb/shared-ui/lib/utils";
import { useSystemVersion } from "@/hooks/queries/system-queries";
import { CHROME_ROW_CLASS, getBbDesktopInfo } from "@/lib/bb-desktop";

export function CloudroomVersionMark() {
  const app = getBbDesktopInfo()?.version;
  const live = useSystemVersion().data?.desktopVersion;
  const [server, setServer] = useState<string>();
  if (live && server === undefined) setServer(live);
  if (app === undefined || app.length === 0) {
    return null;
  }

  return (
    <div className="pointer-events-none fixed right-2 bottom-1 z-[48] select-none text-[9px] leading-none text-neutral-500">
      {server && server !== app ? `server ${server} · app ${app}` : app}
    </div>
  );
}

export function CompactHeaderVersionMark() {
  const version = useSystemVersion().data?.desktopVersion;
  if (version === undefined || version.length === 0) {
    return null;
  }

  return (
    <div
      className={cn(
        CHROME_ROW_CLASS,
        "pointer-events-none fixed inset-x-0 top-[env(safe-area-inset-top)] z-10 justify-center select-none text-[10px] leading-none text-muted-foreground/60",
      )}
    >
      {version}
    </div>
  );
}
