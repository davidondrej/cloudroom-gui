import { useEffect, useState } from "react";
import { useAtom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import { useMutation, useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { Button } from "@bb/shared-ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@bb/shared-ui/dialog";
import { useCloudroomAccount } from "@/hooks/queries/cloudroom-queries";
import { fetchWithAppSurface } from "@/lib/app-surface";
import { booleanLocalStorage, createJsonLocalStorage } from "@/lib/browser-storage";
import { copyToClipboardWithToast } from "@/lib/clipboard";

const DELAY = 24 * 60 * 60 * 1000;
const seenAtom = atomWithStorage("cloudroom.invites.seen", false, booleanLocalStorage, { getOnInit: true });
const startedAtom = atomWithStorage<number | null>("cloudroom.invites.startedAt", null,
  createJsonLocalStorage<number | null>((value): value is number => typeof value === "number"), { getOnInit: true });

const invitesSchema = z.object({ codes: z.array(z.object({ code: z.string(), used: z.boolean() })), left: z.number(), created: z.string().nullable() });
async function invites(method: "GET" | "POST", signal?: AbortSignal) {
  const response = await fetchWithAppSurface("/api/v1/cloudroom/account/invites", {
    method, signal, ...(method === "POST" ? { headers: { "Content-Type": "application/json" }, body: "{}" } : {}),
  });
  const value = await response.json().catch(() => null) as unknown;
  if (!response.ok) throw new Error((value as { message?: string } | null)?.message ?? "Invite codes are unavailable right now.");
  return invitesSchema.parse(value);
}
const format = (code: string) => `${code.slice(0, 4)}-${code.slice(4)}`;

export function InviteOffer() {
  const [seen, setSeen] = useAtom(seenAtom);
  const [startedAt, setStartedAt] = useAtom(startedAtom);
  const signedIn = Boolean(useCloudroomAccount().data?.account);
  useEffect(() => { if (signedIn && startedAt === null) setStartedAt(Date.now()); }, [signedIn, startedAt, setStartedAt]);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 60_000); return () => clearInterval(timer); }, []);
  const due = signedIn && !seen && startedAt !== null && now - startedAt >= DELAY;
  const list = useQuery({ queryKey: ["cloudroom-invites"], enabled: due, retry: false, queryFn: ({ signal }) => invites("GET", signal) });
  const [code, setCode] = useState<string | null>(null);
  const create = useMutation({ mutationFn: () => invites("POST"), onSuccess: (result) => setCode(result.created ?? result.codes.find((item) => !item.used)?.code ?? null) });
  const unused = list.data?.codes.find((item) => !item.used)?.code ?? null;
  const shown = code ?? unused;
  if (!due || !list.data || (!shown && list.data.left === 0)) return null;
  return (
    <Dialog open onOpenChange={(open) => { if (!open) setSeen(true); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Invite a friend to Cloudroom</DialogTitle>
          <DialogDescription>
            Cloudroom is invite-only. You can invite 3 friends, ever. Each invite is a code that lets one person in. They sign in at cloudroom.dev/login and enter it.
          </DialogDescription>
        </DialogHeader>
        {shown && <code className="select-all self-center rounded-md border px-4 py-2 font-mono text-lg tracking-widest">{format(shown)}</code>}
        {create.error && <p className="text-sm text-destructive">{create.error.message}</p>}
        <DialogFooter>
          <Button variant="ghost" onClick={() => setSeen(true)}>{shown ? "Done" : "Not now"}</Button>
          {shown
            ? <Button onClick={() => void copyToClipboardWithToast(format(shown), { successMessage: "Invite code copied" })}>Copy code</Button>
            : <Button disabled={create.isPending} onClick={() => create.mutate()}>Invite a friend</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
