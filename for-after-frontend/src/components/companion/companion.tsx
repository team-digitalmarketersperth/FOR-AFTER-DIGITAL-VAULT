'use client';

import { Sparkles } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Spinner } from '@/components/shared/states';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import {
  ASSISTANT_LIMITS,
  assistantApi,
  boundedHistory,
  type AssistantAction,
  type AssistantPage,
  type AssistantRequest,
  type AssistantTurn,
} from '@/lib/api/assistant';
import { isApiError } from '@/lib/api/errors';

type Help = { q: string; a: string; links?: { href: string; label: string }[] };
type Page = { id: AssistantPage; title: string; help: Help[]; writing: { label: string; action: AssistantAction }[] };

/**
 * What the companion knows about each Customer page: a safe id (the only
 * page detail sent with an AI request), verified quick answers written from
 * the product docs, and the writing actions the backend offers there. The
 * route only picks the entry; no page content is read.
 */
export const PAGES: (Page & { prefix: string })[] = [
  {
    prefix: '/dashboard',
    id: 'dashboard',
    title: 'Dashboard',
    help: [
      {
        q: 'Explain this dashboard',
        a: 'Your dashboard is the start of your private space. “Your For After journey” shows the steps you’ve completed and what’s still to do, and “Preview how it will be shared” shows how a message will look to the person who receives it. Every area is in the menu.',
      },
      {
        q: 'Where should I start?',
        a: 'Most people start by adding the people they love, then writing a first message for one of them. Adding a trusted contact means someone can let us know when the time comes.',
        links: [
          { href: '/people', label: 'People I Love' },
          { href: '/messages', label: 'Messages' },
          { href: '/trusted-contacts', label: 'Trusted Contacts' },
        ],
      },
    ],
    writing: [],
  },
  {
    prefix: '/people',
    id: 'people',
    title: 'People I Love',
    help: [
      {
        q: 'Explain recipient fields',
        a: 'Only a first name is required. An email or mobile number is how they sign in to read what you leave them: we send a one-time code there. A birthday lets you plan birthday messages. The private note is only for you; they never see it.',
      },
      {
        q: 'How do recipients receive messages?',
        a: 'When a message is released (on its date, or after a death has been verified by our team) each person it’s for gets an email saying a message is waiting. They sign in with a one-time code sent to their email or mobile and can read it there. They can’t change anything.',
      },
    ],
    writing: [],
  },
  {
    prefix: '/trusted-contacts',
    id: 'trusted-contacts',
    title: 'Trusted Contacts',
    help: [
      {
        q: 'What does a trusted contact do?',
        a: 'A trusted contact lets us know when you’ve passed away. You can have up to two. They sign in with a one-time code and can report a death; they can’t read your messages, memories, story or wishes. A report alone releases nothing: you’re sent a safety notice, and our team reviews every report.',
      },
      {
        q: 'Explain the invitation process',
        a: 'When you add a trusted contact with an email address, they’re sent an invitation by email. You can resend it, or send it by text message, from this page; only the newest link works. They accept or decline from the link, and you’ll see the status here.',
      },
    ],
    writing: [],
  },
  { prefix: '/messages', id: 'messages', title: 'Messages', help: [], writing: [
      { label: 'Help me start a message', action: 'draft' },
      { label: 'Polish my text', action: 'improve' },
      { label: 'Make it shorter', action: 'shorten' },
    ] },
  {
    prefix: '/memory-vault',
    id: 'memory-vault',
    title: 'Memory Vault',
    help: [],
    writing: [
      { label: 'Help describe a memory', action: 'expand' },
      { label: 'Suggest a caption from details I provide', action: 'caption' },
    ],
  },
  { prefix: '/my-story', id: 'my-story', title: 'My Story', help: [], writing: [
      { label: 'Expand my notes', action: 'expand' },
      { label: 'Ask me a question', action: 'questions' },
      { label: 'Polish my answer', action: 'improve' },
    ] },
  {
    prefix: '/my-wishes',
    id: 'my-wishes',
    title: 'My Wishes',
    help: [],
    writing: [
      { label: 'Help me express a preference', action: 'draft' },
      { label: 'Suggest a question to consider', action: 'questions' },
    ],
  },
  {
    prefix: '/settings',
    id: 'account',
    title: 'Account settings',
    help: [
      {
        q: 'Explain available settings',
        a: 'Account settings has your personal details and security, including your password. Storage shows how much space your files use and lets you remove ones you no longer need, and Activity shows recent activity on your account.',
        links: [
          { href: '/settings', label: 'Account settings' },
          { href: '/settings/storage', label: 'Storage' },
          { href: '/settings/activity', label: 'Activity' },
        ],
      },
    ],
    writing: [],
  },
];

const pageOf = (path: string) => PAGES.find((p) => path === p.prefix || path.startsWith(`${p.prefix}/`));

/**
 * An inline "Help me write" request: which answer, and live access to its
 * editor (read for "include my answer" and conflict checks, write only when
 * the Customer chooses "Use this draft").
 */
export type WritingTarget = { key: string; question: string; read: () => string; write: (text: string) => void };

const Ctx = createContext<{ openFor: (target: WritingTarget) => void; release: (key: string) => void } | null>(null);

export function useCompanion() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useCompanion needs the Customer shell');
  return ctx;
}

type Turn = AssistantTurn & { truncated?: boolean; draft?: { key: string; base: string } };
type Pending = { req: AssistantRequest; label: string; draft?: Turn['draft'] };
/**
 * One context's conversation. `id` changes whenever the context does (page,
 * question, editor gone), so a reply from an earlier context never lands.
 */
type Conv = {
  id: number;
  target: WritingTarget | null;
  turns: Turn[];
  input: string;
  include: boolean;
  pending: boolean;
  error: { message: string; retry: Pending | null } | null;
  notice: string;
};
const fresh = (c: Pick<Conv, 'id'>, target: WritingTarget | null = null): Conv => ({
  id: c.id + 1,
  target,
  turns: [],
  input: '',
  include: false,
  pending: false,
  error: null,
  notice: '',
});
const WRITES: AssistantAction[] = ['draft', 'improve', 'shorten', 'expand'];

function errorText(error: unknown) {
  if (!isApiError(error)) return 'The assistant couldn’t reply. Please try again.';
  if (error.status === 503) return 'The assistant isn’t available right now. The quick answers above still work.';
  if (error.status === 429) return 'The assistant is busy, or you’ve reached the hourly limit. Please try again later.';
  if (error.kind === 'validation') return error.message;
  return 'The assistant couldn’t reply. Please try again.';
}

/**
 * The one For After companion for the Customer shell (mounted once there,
 * keyed by the account, so signing out or switching account drops it and
 * aborts any request). Quick answers are static; AI replies come from
 * POST /assistant/reply (Groq, server-side) only when the Customer sends.
 * Nothing is stored: the conversation lives in this component only.
 */
export function CompanionProvider({ children }: { children: ReactNode }) {
  const path = usePathname();
  const page = pageOf(path);
  const [open, setOpen] = useState(false);
  const [answer, setAnswer] = useState<string | null>(null);
  const [conv, setConv] = useState<Conv>(() => fresh({ id: 0 }));
  const opener = useRef<HTMLElement | null>(null);
  const request = useRef<AbortController | null>(null);

  // A new page is a new context: nothing from the last one carries over.
  const [shownFor, setShownFor] = useState(path);
  if (shownFor !== path) {
    setShownFor(path);
    setAnswer(null);
    setConv(fresh);
  }
  // Leaving a context (or the shell) stops its request.
  useEffect(() => () => request.current?.abort(), [conv.id]);

  // Created once, so editors can depend on it.
  const [value] = useState(() => ({
    openFor: (t: WritingTarget) => {
      setConv((c) => (c.target?.key === t.key ? { ...c, target: t } : fresh(c, t)));
      setOpen(true);
    },
    // The editor this target belongs to is gone (another question): forget its text and replies.
    release: (key: string) => setConv((c) => (c.target?.key === key ? fresh(c) : c)),
  }));

  const send = async ({ req, label, draft }: Pending) => {
    const id = conv.id;
    const controller = new AbortController();
    request.current = controller;
    setConv((c) => ({ ...c, pending: true, error: null, notice: '' }));
    try {
      const { reply, truncated } = await assistantApi.reply(req, controller.signal);
      setConv((c) =>
        c.id !== id
          ? c
          : {
              ...c,
              pending: false,
              input: '',
              turns: [...c.turns, { role: 'user', content: label }, { role: 'assistant', content: reply, truncated, draft }],
            },
      );
    } catch (error) {
      const stopped = controller.signal.aborted;
      setConv((c) =>
        c.id !== id ? c : { ...c, pending: false, error: stopped ? null : { message: errorText(error), retry: { req, label, draft } } },
      );
    }
  };

  const ask = (action: AssistantAction, actionLabel?: string) => {
    if (!page || conv.pending) return;
    const message = conv.input.trim();
    const t = conv.target;
    const source = t && conv.include ? t.read().trim() : '';
    if (action === 'ask' ? !message : !message && !source) {
      setConv((c) => ({ ...c, notice: action === 'ask' ? 'Type your question first.' : 'Type some notes, or include your answer, first.' }));
      return;
    }
    if (source.length > ASSISTANT_LIMITS.source) {
      setConv((c) => ({ ...c, notice: `Your answer is too long to include (over ${ASSISTANT_LIMITS.source.toLocaleString()} characters).` }));
      return;
    }
    const req: AssistantRequest = {
      page: page.id,
      action,
      ...(message && { message }),
      ...(source && { source }),
      ...(t && page.id === 'my-story' && { promptKey: t.key }),
      history: boundedHistory(conv.turns, message.length + source.length),
    };
    const label = [actionLabel ?? message, source && '(with your answer)'].filter(Boolean).join(' ');
    // A draft can go back only into the editor it was written for, and only if that text hasn't changed since.
    const draft = t && WRITES.includes(action) ? { key: t.key, base: t.read() } : undefined;
    void send({ req, label, draft });
  };

  const applyDraft = (turn: Turn) => {
    const t = conv.target;
    if (!turn.draft || t?.key !== turn.draft.key) return;
    if (t.read() !== turn.draft.base) {
      setConv((c) => ({ ...c, notice: 'Your answer has changed since you asked, so the draft wasn’t placed. Copy it instead, or ask again.' }));
      return;
    }
    t.write(turn.content);
    setConv((c) => ({ ...c, notice: 'The draft is in your answer box. It isn’t saved: review it, then choose Save answer.' }));
  };

  const close = (next: boolean) => {
    setOpen(next);
    if (!next) request.current?.abort();
  };

  const help = page?.help ?? [];
  const writing = page?.writing ?? [];
  const t = conv.target;
  return (
    <Ctx.Provider value={value}>
      {children}
      <Sheet open={open} onOpenChange={close}>
        <SheetContent
          side="bottom"
          onOpenAutoFocus={() => {
            opener.current = document.activeElement as HTMLElement | null;
          }}
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            opener.current?.focus();
          }}
          className="max-h-[85dvh] gap-5 overflow-y-auto rounded-t-2xl bg-surface p-6 pb-[max(1.5rem,env(safe-area-inset-bottom))] motion-reduce:animate-none sm:left-auto! sm:right-6! sm:bottom-24! sm:max-h-[calc(100dvh-8rem)] sm:w-[400px] sm:rounded-2xl sm:border sm:border-brand-stone"
        >
          <SheetHeader className="gap-1 p-0">
            <SheetTitle className="flex items-center gap-2 font-heading text-[28px] font-normal">
              <Sparkles aria-hidden strokeWidth={1.5} className="size-5 text-brand-maroon" />
              For After companion
            </SheetTitle>
            <SheetDescription className="text-[15px] text-foreground-muted">A little help, wherever you are.</SheetDescription>
          </SheetHeader>
          <p className="rounded-lg border border-brand-stone px-4 py-3 text-sm text-foreground-secondary">
            Replies are written by AI, through Groq, an external service. Only what you type, and text you choose to include,
            is sent, with the name of this page. Check every reply before you use it.
          </p>

          {page && <p className="eyebrow text-brand-bronze">On this page: {page.title}</p>}

          {help.length > 0 && (
            <section aria-label="Quick answers" className="grid gap-2">
              <p className="text-sm font-semibold">Quick answers (from For After, not AI)</p>
              {help.map((h) => (
                <div key={h.q} className="grid gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    aria-expanded={answer === h.q}
                    className="h-auto min-h-11 justify-start border-brand-stone py-2 text-left whitespace-normal aria-expanded:border-brand-maroon aria-expanded:text-brand-maroon"
                    onClick={() => setAnswer((a) => (a === h.q ? null : h.q))}
                  >
                    {h.q}
                  </Button>
                  {answer === h.q && (
                    <div className="grid gap-2 rounded-lg bg-brand-ivory px-4 py-3 text-sm">
                      <p>{h.a}</p>
                      {h.links && (
                        <ul className="flex flex-wrap gap-x-4 gap-y-1">
                          {h.links.map((l) => (
                            <li key={l.href}>
                              <Link href={l.href} onClick={() => close(false)} className="font-semibold text-brand-maroon underline">
                                {l.label}
                              </Link>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </section>
          )}

          {t && (
            <section aria-label="Writing help for" className="grid gap-2">
              <p className="rounded-lg bg-brand-ivory px-4 py-3 text-sm text-foreground-secondary">
                For: <span className="font-semibold">{t.question}</span>
              </p>
              <label className="flex min-h-11 items-start gap-3 text-sm">
                <input
                  type="checkbox"
                  checked={conv.include}
                  onChange={(e) => setConv((c) => ({ ...c, include: e.target.checked }))}
                  className="mt-0.5 size-5 accent-brand-maroon"
                />
                <span>Include the text in my answer box (it will be sent to Groq)</span>
              </label>
              {conv.include && (
                <blockquote className="max-h-40 overflow-y-auto rounded-lg border border-brand-stone px-4 py-3 text-sm break-words whitespace-pre-wrap">
                  {t.read().trim() ? t.read() : 'Your answer box is empty.'}
                </blockquote>
              )}
              <p className="text-xs text-foreground-muted">
                Your private note, files and linked memories are never included.
              </p>
            </section>
          )}

          {(conv.turns.length > 0 || conv.pending) && (
            <section role="log" aria-label="Conversation" aria-live="polite" className="grid gap-3">
              {conv.turns.map((turn, i) =>
                turn.role === 'user' ? (
                  <p key={i} className="justify-self-end rounded-lg bg-brand-ivory px-4 py-2 text-sm break-words">
                    {turn.content}
                  </p>
                ) : (
                  <div key={i} className="grid gap-2 rounded-lg border border-brand-stone px-4 py-3">
                    <p className="text-xs font-semibold text-brand-bronze">AI reply</p>
                    {/* Plain text only: React escapes it, nothing in a reply is run or linked. */}
                    <p className="text-sm break-words whitespace-pre-wrap">{turn.content}</p>
                    {turn.truncated && <p className="text-xs text-foreground-muted">This reply was cut short.</p>}
                    <div className="flex flex-wrap gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          void navigator.clipboard
                            ?.writeText(turn.content)
                            .then(() => setConv((c) => ({ ...c, notice: 'Copied.' })))
                            .catch(() => setConv((c) => ({ ...c, notice: 'Couldn’t copy. Select the text instead.' })))
                        }
                      >
                        Copy
                      </Button>
                      {turn.draft && turn.draft.key === t?.key && (
                        <Button type="button" size="sm" className="bg-brand-maroon text-white hover:bg-brand-maroon/90" onClick={() => applyDraft(turn)}>
                          Use this draft
                        </Button>
                      )}
                    </div>
                  </div>
                ),
              )}
              {conv.pending && (
                <div className="flex items-center justify-between gap-3 text-sm text-foreground-secondary">
                  <span className="inline-flex items-center gap-2">
                    <Spinner /> Writing a reply…
                  </span>
                  <Button type="button" variant="outline" size="sm" onClick={() => request.current?.abort()}>
                    Stop
                  </Button>
                </div>
              )}
            </section>
          )}

          {conv.error && (
            <div role="alert" className="grid gap-2 rounded-lg border border-danger/40 px-4 py-3 text-sm">
              <p>{conv.error.message}</p>
              {conv.error.retry && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="justify-self-start"
                  onClick={() => conv.error?.retry && void send(conv.error.retry)}
                >
                  Try again
                </Button>
              )}
            </div>
          )}
          <p role="status" className="text-sm text-foreground-secondary empty:hidden">
            {conv.notice}
          </p>

          {page && (
            <form
              className="grid gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                ask('ask');
              }}
            >
              <label htmlFor="companion-input" className="text-sm font-semibold">
                {writing.length ? 'Ask, or add notes to work with' : 'Ask the companion'}
              </label>
              <textarea
                id="companion-input"
                value={conv.input}
                maxLength={ASSISTANT_LIMITS.message}
                rows={3}
                onChange={(e) => setConv((c) => ({ ...c, input: e.target.value }))}
                className="min-h-20 rounded-lg border border-brand-stone bg-surface px-3 py-2 text-[15px] outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring"
              />
              <Button type="submit" disabled={conv.pending} className="justify-self-start bg-brand-maroon text-white hover:bg-brand-maroon/90">
                Send
              </Button>
            </form>
          )}

          {writing.length > 0 && (
            <section aria-label="Writing help" className="grid gap-2">
              <p className="text-sm font-semibold">Writing help</p>
              {writing.map((w) => (
                <Button
                  key={w.label}
                  type="button"
                  variant="outline"
                  disabled={conv.pending}
                  className="h-auto min-h-11 justify-start border-brand-stone py-2 text-left whitespace-normal"
                  onClick={() => ask(w.action, w.label)}
                >
                  {w.label}
                </Button>
              ))}
            </section>
          )}
        </SheetContent>
      </Sheet>
      <button
        type="button"
        aria-label="Open AI companion"
        onClick={() => setOpen(true)}
        className="fixed right-[max(1.5rem,env(safe-area-inset-right))] bottom-[max(1.5rem,env(safe-area-inset-bottom))] z-40 inline-flex size-14 items-center justify-center rounded-full bg-brand-maroon text-white shadow-[0_6px_18px_rgb(99_47_59/0.3)] outline-none hover:bg-brand-maroon/90 focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        <Sparkles aria-hidden strokeWidth={1.5} className="size-6" />
      </button>
    </Ctx.Provider>
  );
}
