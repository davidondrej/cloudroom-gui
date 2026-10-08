import { useEffect, useState } from "react";
import { useAtom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { Icon } from "@cloudroom/shared-ui/icon";
import david from "@/assets/david.png";
import { useCloudroomAccount } from "@/hooks/queries/cloudroom-queries";
import { fetchWithAppSurface } from "@/lib/app-surface";
import { createJsonLocalStorage } from "@/lib/browser-storage";
import { openUrlInExternalBrowser } from "@/lib/url-open-routing";

const EVERY = 60 * 60 * 60 * 1000;
const IDLE = 10_000;
const PAPER = "#F3ECDB", INK = "#0e0d0b", LIME = "#BFFF00", MUTED = "#8a8270";
const shownAtom = atomWithStorage<number | null>("cloudroom.onboardingCall.shownAt", null,
  createJsonLocalStorage<number | null>((value): value is number => typeof value === "number"), { getOnInit: true });
const schema = z.object({ due: z.boolean(), url: z.string().optional() });

export function OnboardingCallNudge() {
  const [shownAt, setShownAt] = useAtom(shownAtom);
  const signedIn = Boolean(useCloudroomAccount().data?.account);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 60_000); return () => clearInterval(timer); }, []);
  const time = signedIn && (shownAt === null || now - shownAt >= EVERY);
  const status = useQuery({
    queryKey: ["cloudroom-onboarding-call"], enabled: time, retry: false, staleTime: 60 * 60 * 1000, refetchOnWindowFocus: false,
    queryFn: async ({ signal }) => schema.parse(await (await fetchWithAppSurface("/api/v1/cloudroom/account/onboarding-call", { signal })).json()),
  });
  const url = time && status.data?.due ? status.data.url : undefined;
  useEffect(() => { if (time && status.data?.due === false) setShownAt(Date.now()); }, [time, status.data, setShownAt]);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!url || open) return;
    let lastKey = Date.now();
    const onKey = () => { lastKey = Date.now(); };
    window.addEventListener("keydown", onKey, true);
    const timer = setInterval(() => { if (Date.now() - lastKey >= IDLE) setOpen(true); }, 2_000);
    return () => { window.removeEventListener("keydown", onKey, true); clearInterval(timer); };
  }, [url, open]);
  if (!url || !open) return null;
  const close = () => { setShownAt(Date.now()); setOpen(false); };
  return (
    <div role="dialog" aria-label="Book your onboarding call" className="fixed top-12 right-4 z-50 w-[300px] p-[18px] pb-4 text-[13px] shadow-[0_16px_40px_rgba(0,0,0,.6)]" style={{ background: PAPER, color: INK }}>
      <div className="flex items-start justify-between gap-2">
        <p className="text-xl leading-tight" style={{ fontFamily: "Georgia, serif" }}>
          Hey, it's <span style={{ background: `linear-gradient(transparent 55%, ${LIME} 55%)` }}>David</span>.
        </p>
        <button type="button" aria-label="Close" className="p-0.5" style={{ color: MUTED }} onClick={close}><Icon name="X" className="size-3.5" /></button>
      </div>
      <p className="mt-2.5 leading-relaxed" style={{ color: "#3a362d" }}>Cloudroom is free. All I ask is a 15 min call to hear what you think.</p>
      <div className="mt-4 flex items-center justify-between">
        <button type="button" className="px-3.5 py-2 font-semibold" style={{ background: INK, color: LIME }} onClick={() => { openUrlInExternalBrowser(url); close(); }}>Book a call →</button>
        <img src={david} alt="David" className="size-[30px] rounded-full object-cover" />
      </div>
      <p className="mt-3 text-[11px]" style={{ color: MUTED }}>P.S. This shows until you've been on a call.</p>
    </div>
  );
}
