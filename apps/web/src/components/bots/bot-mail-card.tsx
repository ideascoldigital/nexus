"use client";

// An email a bot drafted, as a card you can edit before it goes out (spec 31).
// Send / Save as draft hand the final text back to the bot, which does it from
// Gmail in its own browser; the card then follows that run: sending → sent.

import { useLayoutEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Check, ChevronDown, Loader2, Mail, X } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useToast } from "@/hooks/use-toast";
import { mailRun, validAddresses, type MailDraft, type MailMode, type MailState } from "@/lib/bot-mail";
import { cn } from "@/lib/utils";
import { actOnBotMail, type BotRun } from "@/services/bots";

type Props = {
  botId: string;
  runId: string;
  index: number;
  draft: MailDraft;
  state: MailState[string] | undefined;
  /** The run that sends this card, once you pressed Send (from the feed). */
  sendRun: BotRun | undefined;
  onChange: () => void;
};

export function MailCard({ botId, runId, index, draft, state, sendRun, onChange }: Props) {
  const { toast } = useToast();
  const [mail, setMail] = useState<MailDraft>(draft);
  const act = useMutation({
    mutationFn: (action: MailMode | "discard") =>
      actOnBotMail(botId, runId, { index, action, ...(action === "discard" ? {} : { mail }) }),
    onSuccess: onChange,
    onError: (err) =>
      toast({
        title: "Could not do that",
        description: err instanceof Error ? err.message : undefined,
        variant: "destructive",
      }),
  });

  if (state?.status === "discarded") {
    return (
      <p className="flex items-center gap-1.5 px-1 text-[12px] text-muted-foreground">
        <X className="h-3 w-3" />
        Discarded the email “{draft.subject || draft.to}”
      </p>
    );
  }

  // Sent (or being sent): what actually went out, read-only, with its progress.
  // A send that failed or was stopped opens the card again so you can retry.
  const sent = state?.status === "sent" ? state : null;
  // Sent by Nexus through the Gmail connector: done, as it went out.
  const delivered = state?.status === "delivered" ? state : null;
  const failed = sent && (sendRun?.status === "error" || sendRun?.status === "canceled");
  const locked = Boolean((sent && !failed) || delivered);
  const shown = delivered ? delivered.mail : locked && sendRun ? (mailRun(sendRun.prompt)?.mail ?? mail) : mail;

  const toOk = validAddresses(mail.to, { required: true });
  const ccOk = validAddresses(mail.cc);
  const canSend = toOk && ccOk && validAddresses(mail.bcc) && Boolean(mail.subject.trim() || mail.body.trim());
  const busy = act.isPending;

  return (
    <div className="w-full max-w-[560px] rounded-2xl bg-card px-4 pt-3.5 pb-3">
      <div className="flex items-center gap-2 pb-3 text-[12px] text-muted-foreground">
        <Mail className="h-3.5 w-3.5" />
        Mail
      </div>

      {locked ? (
        <p className="pb-2 text-[14px] font-semibold">{shown.subject || "(no subject)"}</p>
      ) : (
        <input
          value={mail.subject}
          onChange={(e) => setMail({ ...mail, subject: e.target.value })}
          placeholder="Subject"
          aria-label="Subject"
          className="w-full bg-transparent pb-2 text-[14px] font-semibold outline-none placeholder:text-muted-foreground"
        />
      )}

      <div className="divide-y divide-border/70 text-[13px]">
        {shown.from && <Row label="From" value={shown.from} locked />}
        <Row
          label="To"
          value={shown.to}
          locked={locked}
          invalid={!locked && !toOk}
          onChange={(to) => setMail({ ...mail, to })}
        />
        {(!locked || shown.cc) && (
          <Row
            label="Cc"
            value={shown.cc ?? ""}
            placeholder="name@example.com"
            locked={locked}
            invalid={!locked && !ccOk}
            onChange={(cc) => setMail({ ...mail, cc })}
          />
        )}
        {shown.bcc && (
          <Row label="Bcc" value={shown.bcc} locked={locked} onChange={(bcc) => setMail({ ...mail, bcc })} />
        )}
      </div>

      <div className="border-t border-border/70 pt-3">
        {locked ? (
          <p className="text-[13.5px] leading-relaxed whitespace-pre-wrap">{shown.body}</p>
        ) : (
          <Body value={mail.body} onChange={(body) => setMail({ ...mail, body })} />
        )}
      </div>

      <div className="flex items-center justify-end gap-3 pt-3">
        {locked ? (
          delivered ? (
            <span className="flex items-center gap-1.5 text-[12.5px] text-muted-foreground">
              <Check className="h-3.5 w-3.5" />
              {delivered.mode === "send" ? `Sent from ${delivered.mail.from}` : `Saved to Drafts in ${delivered.mail.from}`}
            </span>
          ) : (
            <SendStatus mode={sent!.mode} run={sendRun} />
          )
        ) : (
          <>
            {failed && (
              <span className="mr-auto text-[12px] text-destructive">
                {sent!.mode === "send" ? "It didn't go out." : "It wasn't saved."} Try again?
              </span>
            )}
            {!failed && (
              <button
                type="button"
                disabled={busy}
                onClick={() => act.mutate("discard")}
                className="text-[13px] text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
              >
                Discard
              </button>
            )}
            <div className="flex h-9 items-stretch overflow-hidden rounded-full bg-foreground text-background">
              <button
                type="button"
                disabled={!canSend || busy}
                onClick={() => act.mutate("send")}
                className="flex items-center gap-1.5 pr-2.5 pl-4 text-[13px] font-medium transition-opacity hover:opacity-85 disabled:opacity-50"
              >
                {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                Send
              </button>
              <DropdownMenu>
                <DropdownMenuTrigger
                  disabled={!canSend || busy}
                  aria-label="More send options"
                  className="flex items-center border-l border-background/15 pr-3 pl-2 transition-opacity hover:opacity-85 disabled:opacity-50"
                >
                  <ChevronDown className="h-3.5 w-3.5" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-44">
                  <DropdownMenuItem onClick={() => act.mutate("draft")}>Save as draft in Gmail</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Row({
  label,
  value,
  placeholder,
  locked,
  invalid,
  onChange,
}: {
  label: string;
  value: string;
  placeholder?: string;
  locked?: boolean;
  invalid?: boolean;
  onChange?: (v: string) => void;
}) {
  return (
    <label className="flex items-center gap-3 py-2.5">
      <span className="w-10 shrink-0 text-muted-foreground">{label}</span>
      {locked || !onChange ? (
        <span className="min-w-0 flex-1 truncate">{value}</span>
      ) : (
        <input
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          className={cn(
            "min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground/70",
            invalid && value && "text-destructive",
          )}
        />
      )}
    </label>
  );
}

/** The body grows with its text, so the whole email reads without a scrollbar. */
function Body({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);
  return (
    <textarea
      ref={ref}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      aria-label="Body"
      rows={4}
      className="block w-full resize-none overflow-hidden bg-transparent text-[13.5px] leading-relaxed outline-none"
    />
  );
}

function SendStatus({ mode, run }: { mode: MailMode; run: BotRun | undefined }) {
  if (!run || run.status === "queued" || run.status === "running") {
    return (
      <span className="flex items-center gap-1.5 text-[12.5px] text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        {mode === "send" ? "Sending from Gmail…" : "Saving to Drafts…"}
      </span>
    );
  }
  if (run.needsInput) {
    return <span className="text-[12.5px] text-muted-foreground">Waiting for you — see below</span>;
  }
  return (
    <span className="flex items-center gap-1.5 text-[12.5px] text-muted-foreground">
      <Check className="h-3.5 w-3.5" />
      {mode === "send" ? "Sent" : "Saved to Drafts"}
    </span>
  );
}
