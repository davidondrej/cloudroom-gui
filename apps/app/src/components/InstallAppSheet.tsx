import { useEffect, useState, useSyncExternalStore } from "react";
import { useAtom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import { Button } from "@cloudroom/shared-ui/button";
import { useMediaQuery } from "@cloudroom/shared-ui/hooks/use-media-query";
import { BbLogo } from "@/components/ui/bb-logo";
import { getAppSurface } from "@/lib/app-surface";
import { booleanLocalStorage } from "@/lib/browser-storage";

const dismissedAtom = atomWithStorage("cloudroom.installApp.dismissed", false, booleanLocalStorage, { getOnInit: true });

type InstallPromptEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: "accepted" | "dismissed" }> };

let installPrompt: InstallPromptEvent | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());
if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    installPrompt = event as InstallPromptEvent;
    notify();
  });
  window.addEventListener("appinstalled", () => { installPrompt = null; notify(); });
}
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const useInstallPrompt = () => useSyncExternalStore(subscribe, () => installPrompt, () => null);

function phonePlatform(): "ios" | "android" | null {
  if (typeof navigator === "undefined") return null;
  const agent = navigator.userAgent;
  if (/iPhone|iPod/.test(agent) || (/iPad|Macintosh/.test(agent) && navigator.maxTouchPoints > 1)) return "ios";
  if (/Android/.test(agent)) return "android";
  return null;
}

export function InstallAppSheet() {
  const [dismissed, setDismissed] = useAtom(dismissedAtom);
  const installed = useMediaQuery("(display-mode: standalone)") || (navigator as { standalone?: boolean }).standalone === true;
  const prompt = useInstallPrompt();
  const [platform] = useState(phonePlatform);
  const [visible, setVisible] = useState(false);
  const eligible = platform !== null && !installed && !dismissed && getAppSurface() === "web";
  useEffect(() => {
    if (!eligible) return;
    const timer = setTimeout(() => setVisible(true), 1_200);
    return () => clearTimeout(timer);
  }, [eligible]);
  if (!eligible || !visible) return null;

  const close = () => setDismissed(true);
  const install = async () => {
    if (prompt === null) return;
    await prompt.prompt();
    const { outcome } = await prompt.userChoice;
    installPrompt = null;
    notify();
    if (outcome === "accepted") close();
  };
  const steps = platform === "ios"
    ? [<>Tap <b>Share</b> <ShareIcon /> in the browser bar.</>, <>Scroll down and tap <b>Add to Home Screen</b>.</>, <>Tap <b>Add</b>.</>]
    : [<>Tap the browser menu <MenuIcon />.</>, <>Tap <b>Install app</b> or <b>Add to Home screen</b>.</>, <>Tap <b>Install</b>.</>];

  return (
    <div role="dialog" aria-modal="true" aria-label="Add Cloudroom to your home screen" data-testid="install-app-sheet"
      className="fixed inset-0 z-50 flex items-end bg-black/40 duration-200 animate-in fade-in-0" onClick={close}>
      <div onClick={(event) => event.stopPropagation()}
        className="w-full rounded-t-xl border-t bg-background px-5 pt-5 pb-[calc(env(safe-area-inset-bottom)+20px)] duration-300 animate-in slide-in-from-bottom">
        <div className="flex items-center gap-3">
          <BbLogo className="size-10 shrink-0" />
          <div>
            <h2 className="text-base font-semibold">Add Cloudroom to your home screen</h2>
            <p className="text-sm text-muted-foreground">It opens full screen, like a normal app.</p>
          </div>
        </div>
        {prompt === null ? (
          <ol className="mt-5 space-y-3 text-sm">
            {steps.map((step, index) => (
              <li key={index} className="flex items-center gap-3">
                <span className="grid size-6 shrink-0 place-items-center rounded-full bg-muted text-xs font-semibold">{index + 1}</span>
                <span>{step}</span>
              </li>
            ))}
          </ol>
        ) : null}
        <div className="mt-6 flex gap-2">
          <Button variant="outline" className="h-11 flex-1" onClick={close}>Not now</Button>
          {prompt !== null ? <Button className="h-11 flex-1" onClick={() => void install()}>Install</Button> : <Button className="h-11 flex-1" onClick={close}>Done</Button>}
        </div>
      </div>
    </div>
  );
}

const ShareIcon = () => (
  <svg viewBox="0 0 24 24" className="inline size-4 -translate-y-px align-middle" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 3v12M8 7l4-4 4 4" /><path d="M6 11H5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-1" />
  </svg>
);

const MenuIcon = () => (
  <svg viewBox="0 0 24 24" className="inline size-4 -translate-y-px align-middle" fill="currentColor" aria-hidden="true">
    <circle cx="12" cy="5" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="12" cy="19" r="2" />
  </svg>
);
