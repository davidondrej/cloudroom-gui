import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { atom, useAtom, useSetAtom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import { BbLogo } from "@/components/ui/bb-logo";
import { useCloudroomAccount } from "@/hooks/queries/cloudroom-queries";
import { fetchWithAppSurface } from "@/lib/app-surface";
import { MACOS_WINDOW_DRAG_CLASS } from "@/lib/bb-desktop";
import { booleanLocalStorage, createJsonLocalStorage } from "@/lib/browser-storage";
import { copyToClipboardWithToast } from "@/lib/clipboard";

const DELAY = 24 * 60 * 60 * 1000;
const IDLE = 10_000;
const seenAtom = atomWithStorage("cloudroom.invites.explainerSeen", false, booleanLocalStorage, { getOnInit: true });
const startedAtom = atomWithStorage<number | null>("cloudroom.invites.startedAt", null,
  createJsonLocalStorage<number | null>((value): value is number => typeof value === "number"), { getOnInit: true });

const invitesSchema = z.object({
  codes: z.array(z.object({ code: z.string(), used: z.boolean(), url: z.string().optional() })), left: z.number(), created: z.string().nullable(), waiting: z.number().nullable().optional(),
});
type Invites = z.infer<typeof invitesSchema>;
async function invites(method: "GET" | "POST", signal?: AbortSignal) {
  const response = await fetchWithAppSurface("/api/v1/cloudroom/account/invites", {
    method, signal, ...(method === "POST" ? { headers: { "Content-Type": "application/json" }, body: "{}" } : {}),
  });
  const value = await response.json().catch(() => null) as unknown;
  if (!response.ok) throw new Error((value as { message?: string } | null)?.message ?? "Invite codes are unavailable right now.");
  return invitesSchema.parse(value);
}
const format = (code: string) => `${code.slice(0, 4)}-${code.slice(4)}`;
const INVITES_KEY = ["cloudroom-invites"];
const manualAtom = atom(false);
const nothingToShare = (data: Invites) => data.left === 0 && data.codes.every((item) => item.used);

export function InviteOffer() {
  const [seen, setSeen] = useAtom(seenAtom);
  const [startedAt, setStartedAt] = useAtom(startedAtom);
  const signedIn = Boolean(useCloudroomAccount().data?.account);
  useEffect(() => { if (signedIn && startedAt === null) setStartedAt(Date.now()); }, [signedIn, startedAt, setStartedAt]);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 60_000); return () => clearInterval(timer); }, []);
  const due = signedIn && !seen && startedAt !== null && now - startedAt >= DELAY;
  const [manual, setManual] = useAtom(manualAtom);
  const list = useQuery({ queryKey: INVITES_KEY, enabled: due || manual, retry: false, queryFn: ({ signal }) => invites("GET", signal) });
  const [open, setOpen] = useState(false);
  const ready = due && Boolean(list.data) && !open;
  useEffect(() => {
    if (!ready) return;
    let lastKey = Date.now();
    const onKey = () => { lastKey = Date.now(); };
    window.addEventListener("keydown", onKey, true);
    const timer = setInterval(() => { if (Date.now() - lastKey >= IDLE) setOpen(true); }, 2_000);
    return () => { window.removeEventListener("keydown", onKey, true); clearInterval(timer); };
  }, [ready]);
  if (manual && list.data) return <InviteTickets data={list.data} startStep={2} finish={() => setManual(false)} />;
  if (!due || !open || !list.data || nothingToShare(list.data)) return null;
  return <InviteTickets data={list.data} startStep={0} finish={() => setSeen(true)} />;
}

function useInvites() {
  const signedIn = Boolean(useCloudroomAccount().data?.account);
  return useQuery({ queryKey: INVITES_KEY, enabled: signedIn, retry: false, staleTime: 5 * 60_000, queryFn: ({ signal }) => invites("GET", signal) });
}

export function InviteSidebarRow() {
  const list = useInvites();
  const open = useSetAtom(manualAtom);
  if (!list.data || nothingToShare(list.data)) return null;
  const left = list.data.left;
  return (
    <button type="button" onClick={() => open(true)} data-testid="settings-invite"
      className="mb-2 flex h-9 w-full items-center gap-2.5 rounded-md bg-[#bfff00]/30 px-2 text-sm font-semibold text-sidebar-foreground hover:bg-[#bfff00]/45 dark:bg-[#bfff00]/8 dark:hover:bg-[#bfff00]/15">
      <TicketIcon />
      Invite friends
      {left > 0 && left <= 3 && <span className="ml-auto rounded bg-[#bfff00] px-1.5 py-0.5 text-xs font-bold text-[#0e0d0b] ring-1 ring-black/15 dark:ring-0">{left} left</span>}
    </button>
  );
}

export function InviteSettingsCard() {
  const list = useInvites();
  const open = useSetAtom(manualAtom);
  if (!list.data || nothingToShare(list.data)) return null;
  const left = list.data.left;
  return (
    <div data-testid="settings-invite-card" className="flex min-h-13 items-center gap-3 rounded-lg border border-border bg-card py-2 pr-2.5 pl-4">
      <TicketIcon className="text-muted-foreground" />
      <p className="min-w-0 flex-1 text-sm">
        <span className="font-medium text-foreground">Enjoying Cloudroom?</span>{" "}
        <span className="text-muted-foreground">It's invite-only. Share it with up to 3 friends.</span>
      </p>
      {left <= 3 && (
        <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
          <span className="flex gap-0.5">{[0, 1, 2].map((index) => <span key={index} className={cn("size-1.5 rounded-full bg-muted-foreground", index < 3 - left && "opacity-25")} />)}</span>
          {left} left
        </span>
      )}
      <button type="button" onClick={() => open(true)} className="h-8 shrink-0 rounded-md bg-[#bfff00] px-3 text-xs font-semibold text-[#0e0d0b] hover:brightness-95">
        Invite a friend
      </button>
    </div>
  );
}

const INK = "#0e0d0b", LIME = "#bfff00";
const ROOT: CSSProperties = {
  background: `radial-gradient(900px 600px at 76% 52%, rgba(191,255,0,.12), transparent 60%), radial-gradient(700px 500px at 10% 0%, rgba(243,236,219,.06), transparent 60%), ${INK}`,
};

function InviteTickets({ data, startStep, finish }: { data: Invites; startStep: number; finish: () => void }) {
  const [step, setStep] = useState(startStep);
  const [created, setCreated] = useState<Invites["codes"][number] | null>(null);
  const client = useQueryClient();
  const create = useMutation({
    mutationFn: () => invites("POST"),
    onSuccess: (result) => {
      setCreated(result.codes.find((item) => item.code === result.created) ?? result.codes.find((item) => !item.used) ?? null);
      void client.invalidateQueries({ queryKey: INVITES_KEY });
    },
  });
  const ticket = created ?? data.codes.find((item) => !item.used) ?? null;
  const code = ticket?.code ?? null;
  // The link opens the website's invite page (web/app/i/[code]). Older websites send no link, so copy the code.
  const copy = () => {
    if (ticket) void copyToClipboardWithToast(ticket.url ?? format(ticket.code), { successMessage: ticket.url ? "Invite link copied" : "Invite code copied" });
  };
  const usedAny = data.codes.some((item) => item.used);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => { root.current?.focus(); }, []);
  const next = () => setStep((value) => value + 1);
  const waiting = data.waiting ?? null;

  const steps: { title: ReactNode; lede: string; actions: ReactNode; art: ReactNode }[] = [
    {
      title: waiting === null ? <>The line is <em>long</em>.</> : <>{waiting.toLocaleString("en-US")} people<br />joined the <em>waitlist</em>.</>,
      lede: "Your ticket lets a friend skip the waitlist and start using Cloudroom today.",
      actions: <Primary onClick={next}>Continue <Arrow /></Primary>,
      art: (
        <Ticket style={{ left: 90, top: 220, transform: "rotate(-4deg) scale(1.15)" }} number="No." label="WAITLIST" kicker="Cloudroom · waitlist"
          title={waiting === null ? "In line" : `No. ${(waiting + 1).toLocaleString("en-US")}`} sub="Your friend's spot in line" foot="NOT YET" stamp={{ text: "WAIT", ink: true }} />
      ),
    },
    {
      title: <>Three tickets.<br /><em>Yours</em> for life.</>,
      lede: "Each one lets one friend in. No refills.",
      actions: <Primary onClick={next}>Continue <Arrow /></Primary>,
      art: [2, 1, 0].map((index) => {
        const made = data.codes[index];
        return (
          <Ticket key={index} style={TRIO[index]} number={`0${index + 1}`} label={`NO. ${index + 1} OF 3`} title={index === 0 ? <Highlight>Invite</Highlight> : "Invite"}
            sub="Lets one friend in." foot={made && !made.used ? format(made.code) : "••••-••••"}
            stamp={!made ? { text: "UNUSED" } : made.used ? { text: "USED", ink: true } : { text: "READY" }} />
        );
      }),
    },
    {
      title: <>Your {usedAny ? "next" : "first"}<br /><em>ticket</em>.</>,
      lede: "Send it to a friend who builds with agents.",
      actions: code
        ? <>
            <Primary onClick={copy}><CopyIcon />Copy link</Primary>
            <button type="button" onClick={finish} className="h-[50px] border border-[#3a372f] px-6 text-[15px] font-semibold text-[#d8d0bd] transition-transform hover:scale-105 hover:border-[#5a564b]">Done</button>
          </>
        : <>
            <Primary disabled={create.isPending} onClick={() => create.mutate()}>Create my ticket</Primary>
            <button type="button" onClick={finish} className="text-sm text-[#8d8676] underline underline-offset-4 hover:text-[#d8d0bd]">Later</button>
          </>,
      art: (() => {
        const index = code ? data.codes.findIndex((item) => item.code === code) : -1;
        const number = index >= 0 ? index + 1 : data.codes.length + 1;
        return <>
          <Ticket dim style={{ left: 150, top: 110, transform: "rotate(7deg) scale(.9)" }} number="" label="" title="Invite" foot="••••-••••" />
          <Ticket dim style={{ left: 120, top: 170, transform: "rotate(3deg) scale(.95)" }} number="" label="" title="Invite" foot="••••-••••" />
          <Ticket style={{ left: 80, top: 250, transform: "rotate(-4deg) scale(1.2)" }} number={String(number).padStart(2, "0")} label={number <= 3 ? `NO. ${number} OF 3` : `NO. ${number}`}
            title={<Highlight>Invite</Highlight>} sub="One click lets them in." foot={code ? format(code) : "••••-••••"} live={Boolean(code)} stamp={{ text: code ? "READY" : "UNUSED" }} />
        </>;
      })(),
    },
  ];
  const current = steps[step]!;

  return (
    <div ref={root} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Invite friends" style={ROOT}
      className="fixed inset-0 z-50 overflow-hidden text-[#f3ecdb] max-md:h-(--bb-shell-height) max-md:overflow-y-auto outline-none duration-300 animate-in fade-in-0">
      <div className={cn("absolute inset-x-0 top-0 h-10", MACOS_WINDOW_DRAG_CLASS)} />
      <div className="absolute top-[13px] left-1/2 max-md:top-[calc(env(safe-area-inset-top)+10px)] flex -translate-x-1/2 gap-1.5">
        {steps.map((_, index) => <span key={index} className={cn("h-[3px] w-11", index <= step ? "bg-[#bfff00]" : "bg-[#2c2a24]")} />)}
      </div>
      <div className="flex h-full items-center max-md:h-auto max-md:min-h-full max-md:flex-col max-md:justify-center max-md:pt-[calc(env(safe-area-inset-top)+32px)] max-md:pb-[calc(env(safe-area-inset-bottom)+28px)]">
        <div className="w-[44%] shrink-0 pr-8 pl-[8.5%] max-md:w-full max-md:px-7">
          <div className="flex items-center gap-2.5 font-mono text-xs tracking-[0.2em] text-[#8d8676] uppercase">
            <BbLogo className="size-[22px]" />
            Cloudroom · invite-only
          </div>
          <h1 className="mt-7 font-serif text-[64px] max-md:mt-5 max-md:text-[42px] leading-[1.02] font-medium tracking-[-0.03em] [&_em]:text-[#bfff00]">{current.title}</h1>
          <p className="mt-5 max-w-[400px] text-lg text-[#bdb5a2] max-md:mt-3 max-md:text-base">{current.lede}</p>
          <div className="mt-10 flex items-center gap-6 max-md:mt-7">
            {current.actions}
            {step < steps.length - 1 && <span className="font-mono text-xs tracking-[0.16em] text-[#8d8676]">0{step + 1} / 0{steps.length}</span>}
          </div>
          {create.error && <p className="mt-4 text-sm text-[#ff8a7a]">{create.error.message}</p>}
        </div>
        <div className="pointer-events-none flex min-w-0 flex-1 items-center justify-center max-md:order-first max-md:h-[330px] max-md:w-full max-md:flex-none">
          <div className="relative h-[640px] w-[620px] shrink-0 max-[1180px]:scale-[.8] max-[980px]:scale-[.65] max-md:scale-[.55]">{current.art}</div>
        </div>
      </div>
    </div>
  );
}

const TRIO: CSSProperties[] = [
  { left: 50, top: 30, transform: "rotate(-9deg)" },
  { left: 140, top: 210, transform: "rotate(4deg)" },
  { left: 60, top: 390, transform: "rotate(-3deg)" },
];
const NOTCHED = "radial-gradient(circle at 100px 0, transparent 13px, #000 13.5px) top/100% 51% no-repeat, radial-gradient(circle at 100px 100%, transparent 13px, #000 13.5px) bottom/100% 51% no-repeat";
const PAPER: CSSProperties = { backgroundColor: "#f3ecdb", backgroundImage: "repeating-linear-gradient(90deg, transparent 0 22px, rgba(120,100,60,.05) 22px 23px)" };

function Ticket({ style, number, label, kicker = "Cloudroom · admit one", title, sub, foot, live, stamp, dim }: {
  style: CSSProperties; number: string; label: string; kicker?: string; title: ReactNode; sub?: string; foot: string; live?: boolean; stamp?: { text: string; ink?: boolean }; dim?: boolean;
}) {
  return (
    <div className="absolute" style={{ ...style, filter: dim ? "brightness(.3) drop-shadow(0 20px 30px rgba(0,0,0,.5))" : "drop-shadow(0 30px 40px rgba(0,0,0,.55))" }}>
      <div className="flex h-[188px] w-[440px] text-[#1c1a15]" style={{ mask: NOTCHED }}>
        <div className="flex w-[100px] shrink-0 flex-col items-center justify-center gap-2 border-r-2 border-dashed border-[#b9ad8f] bg-[#e9dfc6]">
          <b className="font-serif text-[26px] leading-none font-semibold">{number}</b>
          <span className="rotate-180 font-mono text-[11px] font-semibold tracking-[0.18em] text-[#6f6655] [writing-mode:vertical-rl]">{label}</span>
        </div>
        <div className="relative flex-1 px-6 py-5" style={PAPER}>
          <p className="font-mono text-[10.5px] font-semibold tracking-[0.22em] text-[#7d735f] uppercase">{kicker}</p>
          <p className="mt-3 font-serif text-[40px] leading-none tracking-[-0.02em]">{title}</p>
          {sub && <p className="mt-2 text-[13px] text-[#6f6655]">{sub}</p>}
          <p className={cn("absolute left-6 font-mono font-semibold", live ? "bottom-5 text-2xl tracking-[0.22em] text-[#1c1a15]" : "bottom-[18px] text-[15px] tracking-[0.28em] text-[#a99d82]")}>{foot}</p>
          {stamp && (
            <div className={cn("absolute grid place-items-center rounded-full text-center font-mono font-bold whitespace-pre-line",
              stamp.ink
                ? "top-10 right-6 size-24 -rotate-[18deg] border-[2.5px] border-[#1c1a15]/55 text-[11px] tracking-[0.14em] text-[#1c1a15]/60"
                : "right-5 bottom-4 size-[76px] -rotate-[14deg] border-2 border-[#1c1a15] bg-[#bfff00] text-[10px] leading-tight tracking-[0.12em]")}>
              {stamp.text === "UNUSED" ? "UN\nUSED" : stamp.text}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Highlight({ children }: { children: ReactNode }) {
  return <i style={{ background: `linear-gradient(transparent 60%, ${LIME} 60%, ${LIME} 92%, transparent 92%)` }}>{children}</i>;
}

function Primary({ children, onClick, disabled }: { children: ReactNode; onClick: () => void; disabled?: boolean }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled}
      className="inline-flex h-[50px] items-center gap-2.5 bg-[#bfff00] px-[30px] text-[15.5px] font-bold text-[#0e0d0b] transition-transform hover:brightness-95 enabled:hover:scale-105 disabled:opacity-60">
      {children}
    </button>
  );
}

const Arrow = () => <svg viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 8h10M9 4l4 4-4 4" /></svg>;
const TicketIcon = ({ className = "text-[#0e0d0b] dark:text-[#bfff00]" }: { className?: string }) => <svg viewBox="0 0 24 24" className={cn("size-4 shrink-0", className)} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z" /><path d="M13 5v2M13 11v2M13 17v2" /></svg>;
const CopyIcon = () => <svg viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="5" y="5" width="8.5" height="8.5" /><path d="M2.5 10.5v-8h8" /></svg>;
