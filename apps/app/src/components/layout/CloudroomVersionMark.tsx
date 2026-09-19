import { getBbDesktopInfo } from "@/lib/bb-desktop";

export function CloudroomVersionMark() {
  const version = getBbDesktopInfo()?.version;
  if (version === undefined || version.length === 0) {
    return null;
  }

  return (
    <div className="pointer-events-none fixed right-2 bottom-1 z-[48] select-none text-[9px] leading-none text-neutral-500">
      {version}
    </div>
  );
}
