import { useState } from "react";
import { useAtom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import { Button } from "@bb/shared-ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@bb/shared-ui/dialog";
import { useOpenSetup } from "@/components/Onboarding";
import { useCloudroomAccount } from "@/hooks/queries/cloudroom-queries";
import { booleanLocalStorage } from "@/lib/browser-storage";

const seenAtom = atomWithStorage("cloudroom.earlyAccess.seen", false, booleanLocalStorage, { getOnInit: true });

/** One-time offer for signed-out installs from before the cutoff, while the website's window is open (docs/scopes/waitlist.md). */
export function EarlyAccessOffer() {
  const [seen, setSeen] = useAtom(seenAtom);
  const openSetup = useOpenSetup();
  const until = useCloudroomAccount().data?.earlyAccessUntil;
  const [openedAt] = useState(() => Date.now());
  if (seen || !until) return null;
  const hours = Math.max(1, Math.ceil((Date.parse(until) - openedAt) / 3_600_000));
  return (
    <Dialog open onOpenChange={(open) => { if (!open) setSeen(true); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Claim free Cloud access</DialogTitle>
          <DialogDescription>
            You installed Cloudroom early, so you can unlock cloud agents for free. Create your account in the next {hours} {hours === 1 ? "hour" : "hours"}. After that, Cloudroom is invite-only.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setSeen(true)}>Not now</Button>
          <Button onClick={() => { setSeen(true); openSetup(true); }}>Create account</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
