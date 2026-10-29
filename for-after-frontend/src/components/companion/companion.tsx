'use client';

import { ArrowRight, Copy, Send, Settings, Sparkles, X } from 'lucide-react';
import { usePathname } from 'next/navigation';
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { NAV_GROUPS } from '@/components/layout/nav';
import { Spinner } from '@/components/shared/states';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
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

type Page = { id: AssistantPage; title: string; suggestions: string[]; writing: { label: string; action: AssistantAction }[] };

/**
 * What the companion knows about each Customer page: a safe id (the only page
 * detail sent with an AI request), up to three suggested questions (shortcuts
 * that are sent like typed ones: never stored answers) and the writing actions
 * the backend offers there. The route only picks the entry; no page content is read.
 */
export const PAGES: (Page & { prefix: string })[] = [
  {
    prefix: '/dashboard',
    id: 'dashboard',
    title: 'Dashboard',
    suggestions: ['Where should I start?', 'Help me understand my dashboard.', 'How do I write my first message?'],
    writing: [],
  },
  {
    prefix: '/people',
    id: 'people',
    title: 'People I Love',
    suggestions: ['What do the details for a person mean?', 'How will the people I love receive messages?'],
    writing: [],
  },
  {
    prefix: '/trusted-contacts',
    id: 'trusted-contacts',
    title: 'Trusted Contacts',
    suggestions: ['What does a trusted contact do?', 'How do invitations work?'],
    writing: [],
  },
  {
    prefix: '/messages',
    id: 'messages',
    title: 'Messages',
    suggestions: ['How do I write my first message?', 'When will my messages be shared?'],
    writing: [
      { label: 'Help me start a message', action: 'draft' },
      { label: 'Polish my text', action: 'improve' },
      { label: 'Make it shorter', action: 'shorten' },
    ],
  },
  {
    prefix: '/memory-vault',
    id: 'memory-vault',
    title: 'Memory Vault',
    suggestions: ['What can I keep in the Memory Vault?', 'Can I link a memory to My Story?'],
    writing: [
      { label: 'Help describe a memory', action: 'expand' },
      { label: 'Suggest a caption from details I provide', action: 'caption' },
    ],
  },
  {
    prefix: '/my-story',
    id: 'my-story',
    title: 'My Story',
    suggestions: ['How does My Story work?', 'How do I save my answer?'],
    writing: [
      { label: 'Expand my notes', action: 'expand' },
      { label: 'Ask me a question', action: 'questions' },
      { label: 'Polish my answer', action: 'improve' },
    ],
  },
  {
    prefix: '/my-wishes',
    id: 'my-wishes',
    title: 'My Wishes',
    suggestions: ['What is My Wishes for?', 'Is My Wishes a legal document?'],
    writing: [
      { label: 'Help me express a preference', action: 'draft' },
      { label: 'Suggest a question to consider', action: 'questions' },
    ],
  },
  {
    prefix: '/settings',
    id: 'account',
    title: 'Account settings',
    suggestions: ['What can I change in my settings?', 'How do I free up storage?'],
    writing: [],
  },
];

const pageOf = (path: string) => PAGES.find((p) => path === p.prefix || path.startsWith(`${p.prefix}/`));
// The section chip reuses the menu's icons; Account settings is not in the menu.
const NAV_ICONS = new Map(NAV_GROUPS.flatMap((g) => g.items).map((i) => [i.href, i.icon]));

/** The companion's mark beside its replies. */
function Avatar() {
  return (
    <span aria-hidden className="inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-brand-maroon text-white">
      <Sparkles strokeWidth={1.5} className="size-4" />
    </span>
  );
}

/**
 * An inline "Help me write" request: which editor field (`key` names the
 * entity and field; `question`, `field` and `save` are what the Customer
 * sees), and live access to it: read for "include my text" and conflict
 * checks, write only when the Customer chooses "Use this draft".
 */
export type WritingTarget = {
  key: string;
  question: string;
  field: string;
  save: string;
  read: () => string;
  write: (text: string) => void;
};

const Ctx = createContext<{ openFor: (target: WritingTarget) => void; release: (key: string) => void } | null>(null);

/**
 * The "Help me write" button for one editor field. Leaving the field (or the
 * page) takes its text out of the companion. Outside the Customer shell
 * (isolated tests) there is no companion, so no button.
 */
export function HelpMeWrite({
  targetKey,
  className,
  ...rest
}: Omit<WritingTarget, 'key'> & { targetKey: string; className?: string }) {
  const target = { key: targetKey, ...rest };
  const ctx = useContext(Ctx);
  const release = ctx?.release;
  useEffect(() => () => release?.(target.key), [release, target.key]);
  if (!ctx) return null;
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={() => ctx.openFor(target)}
      className={cn('border-brand-maroon text-brand-maroon', className)}
    >
      <Sparkles aria-hidden strokeWidth={1.5} />
      Help me write
    </Button>
  );
}

type Turn = AssistantTurn & { truncated?: boolean; draft?: { key: string; base: string }; open?: AssistantPage };
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
  /** The included text exactly as previewed (null: not included). */
  source: string | null;
  pending: boolean;
  error: { message: string; retry: Pending | null } | null;
  notice: string;
};
const fresh = (c: Pick<Conv, 'id'>, target: WritingTarget | null = null): Conv => ({
  id: c.id + 1,
  target,
  turns: [],
  input: '',
  source: null,
  pending: false,
  error: null,
  notice: '',
});
// Requests whose reply may come back as editor text (the server decides whether it is).
const WRITES: AssistantAction[] = ['ask', 'draft', 'improve', 'shorten', 'expand'];

// UI states, never answers: no provider names, codes or raw errors.
function errorText(error: unknown) {
  if (isApiError(error) && error.status === 503) return 'The AI companion is unavailable right now. Please try again later.';
  if (isApiError(error) && error.status === 429) return 'The AI companion is busy, or you’ve reached the hourly limit. Please try again later.';
  if (isApiError(error) && error.kind === 'validation') return error.message;
  return 'The AI companion is temporarily unavailable. Please try again.';
}

/**
 * The one For After companion for the Customer shell (mounted once there,
 * keyed by the account, so signing out or switching account drops it and
 * aborts any request). Every reply comes from POST /assistant/reply (an
 * external AI service, server-side), only when the Customer sends a message
 * or picks a suggestion. Nothing is stored: the conversation lives here only.
 */
export function CompanionProvider({ children }: { children: ReactNode }) {
  const path = usePathname();
  const page = pageOf(path);
  const [open, setOpen] = useState(false);
  const [conv, setConv] = useState<Conv>(() => fresh({ id: 0 }));
  const opener = useRef<HTMLElement | null>(null);
  const request = useRef<AbortController | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);

  // A new page is a new context: nothing from the last one carries over.
  const [shownFor, setShownFor] = useState(path);
  if (shownFor !== path) {
    setShownFor(path);
    setConv(fresh);
  }
  // Leaving a context (or the shell) stops its request.
  useEffect(() => () => request.current?.abort(), [conv.id]);
  useEffect(() => {
    const el = scroller.current;
    if (el && nearBottom.current) el.scrollTop = el.scrollHeight;
  }, [conv.turns.length, conv.pending, conv.error]);

  // Created once, so editors can depend on it.
  const [value] = useState(() => ({
    openFor: (t: WritingTarget) => {
      setConv((c) => (c.target?.key === t.key ? { ...c, target: t } : fresh(c, t)));
      setOpen(true);
    },
    // The editor this target belongs to is gone (another question): forget its text and replies.
    release: (key: string) => setConv((c) => (c.target?.key === key ? fresh(c) : c)),
  }));

  // `first`: show the question as the Customer's turn now (a retry reuses it, so it never repeats).
  const send = async ({ req, label, draft }: Pending, first?: { clearInput: boolean }) => {
    const id = conv.id;
    const controller = new AbortController();
    request.current = controller;
    setConv((c) => ({
      ...c,
      pending: true,
      error: null,
      notice: '',
      ...(first && { turns: [...c.turns, { role: 'user' as const, content: label }] }),
      ...(first?.clearInput && { input: '' }),
    }));
    try {
      const res = await assistantApi.reply(req, controller.signal);
      // "Use this draft" only when the server marked the reply as editor text; a section link only if it is ours.
      const open = PAGES.some((p) => p.id === res.open) ? res.open : undefined;
      setConv((c) =>
        c.id !== id
          ? c
          : {
              ...c,
              pending: false,
              turns: [
                ...c.turns,
                { role: 'assistant', content: res.reply, truncated: res.truncated, draft: res.draft ? draft : undefined, open },
              ],
            },
      );
    } catch (error) {
      const stopped = controller.signal.aborted;
      setConv((c) =>
        c.id !== id ? c : { ...c, pending: false, error: stopped ? null : { message: errorText(error), retry: { req, label, draft } } },
      );
    }
  };

  // `suggestion`: a suggested question, sent exactly like a typed one (the typed text is left alone).
  const ask = (action: AssistantAction, actionLabel?: string, suggestion?: string) => {
    if (!page || conv.pending) return;
    const message = (suggestion ?? conv.input).trim();
    const t = conv.target;
    // What is sent is exactly what the preview shows: if the text changed since, show the new text first.
    if (t && conv.source !== null && t.read() !== conv.source) {
      const now = t.read();
      setConv((c) => ({ ...c, source: now, notice: 'Your text has changed, so the preview is updated. Check it, then send again.' }));
      return;
    }
    const source = conv.source?.trim() ?? '';
    if (action === 'ask' ? !message : !message && !source) {
      setConv((c) => ({ ...c, notice: action === 'ask' ? 'Type your question first.' : 'Type some notes, or include your text, first.' }));
      return;
    }
    if (source.length > ASSISTANT_LIMITS.source) {
      setConv((c) => ({ ...c, notice: `Your text is too long to include (over ${ASSISTANT_LIMITS.source.toLocaleString()} characters).` }));
      return;
    }
    const req: AssistantRequest = {
      page: page.id,
      action,
      ...(message && { message }),
      ...(source && { source }),
      ...(t && page.id === 'my-story' && { promptKey: t.key }),
      // Earlier turns of this context only: the current message goes once, as the last turn.
      history: boundedHistory(conv.turns, message.length + source.length),
    };
    const label = [actionLabel ?? message, source && '(with your text)'].filter(Boolean).join(' ');
    // A draft can go back only into the editor it was written for, and only if that text hasn't changed since.
    const draft = t && WRITES.includes(action) ? { key: t.key, base: t.read() } : undefined;
    void send({ req, label, draft }, { clearInput: !suggestion });
  };

  const applyDraft = (turn: Turn) => {
    const t = conv.target;
    if (!turn.draft || t?.key !== turn.draft.key) return;
    if (t.read() !== turn.draft.base) {
      setConv((c) => ({ ...c, notice: `“${t.field}” has changed since you asked, so the draft wasn’t placed. Copy it instead, or ask again.` }));
      return;
    }
    t.write(turn.content);
    setConv((c) => ({ ...c, notice: `The draft is in “${t.field}”. It isn’t saved: review it, then choose ${t.save}.` }));
  };

  const close = (next: boolean) => {
    setOpen(next);
    if (!next) request.current?.abort();
  };

  const writing = page?.writing ?? [];
  const PageIcon = (page && NAV_ICONS.get(page.prefix)) ?? Settings;
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
          showCloseButton={false}
          className="max-h-[85dvh] gap-0 overflow-hidden rounded-t-[22px] border-brand-stone bg-surface shadow-[0_18px_48px_rgb(99_47_59/0.16)] motion-reduce:animate-none sm:left-auto! sm:right-6! sm:bottom-24! sm:max-h-[calc(100dvh-8rem)] sm:w-[min(440px,calc(100vw-3rem))] sm:rounded-[22px] sm:border"
        >
          <SheetHeader className="shrink-0 flex-row items-center gap-3 border-b border-brand-stone px-5 py-4 sm:px-6">
            <span aria-hidden className="inline-flex size-11 shrink-0 items-center justify-center rounded-full bg-brand-maroon text-white">
              <Sparkles strokeWidth={1.5} className="size-5" />
            </span>
            <div className="grid min-w-0 flex-1 gap-0.5">
              <SheetTitle className="font-heading text-2xl leading-tight font-normal text-brand-maroon">For After AI companion</SheetTitle>
              <SheetDescription className="text-sm text-foreground-muted">A little guidance, at your pace.</SheetDescription>
            </div>
            <SheetClose asChild>
              <Button type="button" variant="ghost" size="icon" aria-label="Close" className="size-11 shrink-0 rounded-full text-foreground-secondary">
                <X aria-hidden strokeWidth={1.5} className="size-5" />
              </Button>
            </SheetClose>
          </SheetHeader>
          <div
            ref={scroller}
            onScroll={(e) => {
              const el = e.currentTarget;
              nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
            }}
            className="companion-scroll grid min-h-0 flex-1 grid-cols-1 content-start gap-5 overflow-y-auto px-5 py-4 sm:px-6"
          >
            {page && (
              <p className="inline-flex items-center gap-2 justify-self-start rounded-full bg-brand-ivory px-3.5 py-1.5 text-sm text-foreground-secondary">
                <PageIcon aria-hidden strokeWidth={1.5} className="size-4" />
                <span className="sr-only">Current section: </span>
                {page.title}
              </p>
            )}

            {t && (
              <section aria-label="Writing help for" className="grid gap-2">
                <p className="rounded-xl bg-brand-ivory px-4 py-3 text-sm text-foreground-secondary">
                  For: <span className="font-semibold">{t.question}</span>
                </p>
                <label className="flex min-h-11 items-start gap-3 text-sm">
                  <input
                    type="checkbox"
                    checked={conv.source !== null}
                    onChange={(e) => {
                      const now = e.target.checked ? t.read() : null;
                      setConv((c) => ({ ...c, source: now }));
                    }}
                    className="mt-0.5 size-5 accent-brand-maroon"
                  />
                  <span>Include the text in “{t.field}” (it will be sent to the AI service)</span>
                </label>
                {conv.source !== null && (
                  <blockquote
                    aria-label="Text that will be included"
                    className="companion-scroll max-h-40 overflow-y-auto rounded-xl border border-brand-stone px-4 py-3 text-sm break-words whitespace-pre-wrap"
                  >
                    {conv.source.trim() ? conv.source : `“${t.field}” is empty.`}
                  </blockquote>
                )}
                <p className="text-xs text-foreground-muted">Your private note, other fields, files and linked memories are never included.</p>
              </section>
            )}

            {conv.turns.length === 0 && !conv.pending && page && (
              <section aria-labelledby="companion-start" className="grid gap-3">
                <h3 id="companion-start" className="font-heading text-2xl">
                  What would you like help with?
                </h3>
                {page.suggestions.length > 0 && (
                  <ul aria-label="Suggested questions" className="grid gap-2">
                    {page.suggestions.slice(0, 3).map((q) => (
                      <li key={q}>
                        <Button
                          type="button"
                          variant="outline"
                          className="h-auto min-h-11 w-full justify-start rounded-xl border-brand-stone py-2 text-left whitespace-normal"
                          onClick={() => ask('ask', undefined, q)}
                        >
                          {q}
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            )}

            {(conv.turns.length > 0 || conv.pending) && (
              <section role="log" aria-label="Conversation" aria-live="polite" className="grid gap-4">
                {conv.turns.map((turn, i) =>
                  turn.role === 'user' ? (
                    <div key={i} className="ml-10 grid justify-items-end">
                      <p className="sr-only">You:</p>
                      <p className="max-w-full rounded-2xl rounded-br-md bg-brand-maroon px-4 py-2.5 text-[15px] leading-relaxed text-white wrap-anywhere whitespace-pre-wrap">
                        {turn.content}
                      </p>
                    </div>
                  ) : (
                    <div key={i} className="mr-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2">
                      <Avatar />
                      <div className="grid min-w-0 grid-cols-1 gap-2">
                        <span className="sr-only">AI companion</span>
                        {/* Plain text only: React escapes it, nothing in a reply is run or linked. */}
                        <p className="justify-self-start rounded-2xl rounded-tl-md bg-brand-ivory px-4 py-3 text-[15px] leading-relaxed wrap-anywhere whitespace-pre-wrap">
                          {turn.content}
                        </p>
                        {turn.truncated && <p className="text-xs text-foreground-muted">This reply was cut short.</p>}
                        <div className="flex flex-wrap items-center gap-2">
                          {turn.open && turn.open !== page?.id && (
                            // A full page load on purpose: the page's own "leave with unsaved changes?" check still runs.
                            <Button asChild variant="outline" className="h-11 rounded-full border-brand-maroon px-4 text-brand-maroon">
                              <a href={PAGES.find((p) => p.id === turn.open)!.prefix}>
                                Open {PAGES.find((p) => p.id === turn.open)!.title}
                                <ArrowRight aria-hidden strokeWidth={1.5} />
                              </a>
                            </Button>
                          )}
                          {turn.draft && turn.draft.key === t?.key && (
                            <Button type="button" className="h-11 rounded-full bg-brand-maroon px-4 text-white hover:bg-brand-maroon/90" onClick={() => applyDraft(turn)}>
                              Use this draft
                            </Button>
                          )}
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            aria-label="Copy"
                            className="size-11 rounded-full text-foreground-muted"
                            onClick={() =>
                              void navigator.clipboard
                                ?.writeText(turn.content)
                                .then(() => setConv((c) => ({ ...c, notice: 'Copied.' })))
                                .catch(() => setConv((c) => ({ ...c, notice: 'Couldn’t copy. Select the text instead.' })))
                            }
                          >
                            <Copy aria-hidden strokeWidth={1.5} className="size-[18px]" />
                          </Button>
                        </div>
                      </div>
                    </div>
                  ),
                )}
                {conv.pending && (
                  <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-3">
                    <Avatar />
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="inline-flex items-center gap-2 rounded-2xl rounded-tl-md bg-brand-ivory px-4 py-3 text-sm text-foreground-secondary">
                        <Spinner className="motion-reduce:animate-none" /> Thinking…
                      </span>
                      <Button type="button" variant="outline" className="h-11 rounded-full border-brand-stone" onClick={() => request.current?.abort()}>
                        Stop
                      </Button>
                    </div>
                  </div>
                )}
              </section>
            )}

            {conv.error && (
              <div role="alert" className="grid gap-2 rounded-xl border border-danger/40 px-4 py-3 text-sm">
                <p>{conv.error.message}</p>
                {conv.error.retry && (
                  <Button
                    type="button"
                    variant="outline"
                    className="h-11 justify-self-start rounded-full border-brand-stone"
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

            {writing.length > 0 && (
              <section aria-label="Writing help" className="grid gap-2">
                <p className="text-sm font-semibold">Help with your writing</p>
                <div className="flex flex-wrap gap-2">
                  {writing.map((w) => (
                    <Button
                      key={w.label}
                      type="button"
                      variant="outline"
                      disabled={conv.pending}
                      className="h-auto min-h-11 rounded-full border-brand-stone px-4 py-2 text-left whitespace-normal"
                      onClick={() => ask(w.action, w.label)}
                    >
                      {w.label}
                    </Button>
                  ))}
                </div>
              </section>
            )}
          </div>

          {page && (
            <form
              className="grid shrink-0 grid-cols-1 gap-2 border-t border-brand-stone px-5 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-6"
              onSubmit={(e) => {
                e.preventDefault();
                ask('ask');
              }}
            >
              <label htmlFor="companion-input" className="sr-only">
                Message the AI companion
              </label>
              <div className="flex items-end gap-2 rounded-2xl border border-brand-stone bg-brand-ivory p-2 pl-4 focus-within:outline-2 focus-within:outline-solid focus-within:outline-ring">
                <textarea
                  id="companion-input"
                  value={conv.input}
                  maxLength={ASSISTANT_LIMITS.message}
                  rows={2}
                  placeholder="Ask a question or share a thought…"
                  aria-describedby="companion-privacy"
                  onChange={(e) => setConv((c) => ({ ...c, input: e.target.value }))}
                  // Grows with the text up to a limit, then scrolls inside itself.
                  className="companion-scroll field-sizing-content max-h-36 min-h-12 min-w-0 flex-1 resize-none bg-transparent py-1.5 text-[15px] leading-relaxed outline-none placeholder:text-foreground-muted"
                />
                <Button
                  type="submit"
                  size="icon"
                  aria-label="Send"
                  aria-disabled={conv.pending}
                  className="size-11 shrink-0 rounded-full bg-brand-maroon text-white hover:bg-brand-maroon/90 aria-disabled:opacity-50"
                >
                  <Send aria-hidden strokeWidth={1.5} className="size-5" />
                </Button>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-x-3 text-xs text-foreground-muted">
                <p id="companion-privacy">AI suggestions · You choose what to share</p>
                <details className="group open:basis-full">
                  <summary className="inline-flex min-h-11 cursor-pointer list-none items-center rounded-sm underline underline-offset-2 outline-none group-open:min-h-8 focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
                    Privacy
                  </summary>
                  <p className="companion-scroll max-h-[25dvh] overflow-y-auto pb-1">
                    Only your messages and text you choose to include are sent to an external AI service. Replies are
                    written by AI from Groq, an external service that For After uses. With each request we send your
                    message, any text you chose to include, the name of this page and earlier messages from this
                    conversation. For After doesn’t save the conversation: it’s cleared when you move to another page or
                    sign out. AI can be wrong, so check every reply before you use it.
                  </p>
                </details>
              </div>
            </form>
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
