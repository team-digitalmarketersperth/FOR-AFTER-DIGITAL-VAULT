'use client';

import {
  ArrowRight,
  Check,
  CheckCircle2,
  Circle,
  Clock,
  FileText,
  Headset,
  LockKeyhole,
  MessageCircle,
  MessageCircleReply,
  MessagesSquare,
  Plus,
  UserRound,
  type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent, type ReactNode } from 'react';
import { Badge } from '@/components/admin/admin-ui';
import { Pager } from '@/components/shared/list-controls';
import { FormError, TextAreaField, TextField } from '@/components/shared/form-field';
import { PageHeader } from '@/components/shared/page-header';
import { EmptyState, QueryView, Spinner } from '@/components/shared/states';
import { SelectField } from '@/components/shared/list-controls';
import { CopyButton } from '@/components/shared/copy-button';
import { Composer } from '@/components/support/composer';
import { Button } from '@/components/ui/button';
import { useCurrentUser } from '@/hooks/use-auth';
import { useCreateSupportRequest, useSupportFollowUp, useSupportRequest, useSupportRequests } from '@/hooks/use-support';
import {
  DESCRIPTION_MIN,
  SUBJECT_MAX,
  SUBJECT_MIN,
  SUPPORT_CATEGORIES,
  TEXT_MAX,
  type SupportCategory,
  type SupportMessage,
  type SupportRequest,
  type SupportStatus,
  type SupportSummary,
} from '@/lib/api/support';
import { shortId } from '@/lib/admin';
import { formatDate, formatDateTime, formatTimestamp, initials, timeZoneLabel } from '@/lib/format';
import { PRIVACY_HINT, SUPPORT_CATEGORY_LABEL, SUPPORT_STATUS } from '@/lib/support';
import { cn } from '@/lib/utils';

const BASE = '/support';

const STATUS_ICON: Record<SupportStatus, LucideIcon> = {
  OPEN: Circle,
  IN_PROGRESS: Clock,
  WAITING_FOR_CUSTOMER: MessageCircleReply,
  RESOLVED: CheckCircle2,
};

/** Status as icon + words (never colour alone); the admin inbox uses its own wording. */
export const StatusBadge = ({ status, admin }: { status: SupportStatus; admin?: boolean }) => {
  const Icon = STATUS_ICON[status];
  return (
    <Badge tone={SUPPORT_STATUS[status].tone} className="gap-1.5">
      <Icon aria-hidden strokeWidth={1.75} className="size-3.5" />
      {admin ? SUPPORT_STATUS[status].admin : SUPPORT_STATUS[status].label}
    </Badge>
  );
};

/** "31 Oct 2026" with the exact instant for assistive tech and hover. */
const ShortDate = ({ iso }: { iso: string }) => (
  <time dateTime={iso} title={formatDateTime(iso)}>
    {formatDate(iso)}
  </time>
);

const newRequest = (label: string) => (
  <Button asChild>
    <Link href={`${BASE}/new`}>
      <Plus aria-hidden strokeWidth={1.75} />
      {label}
    </Link>
  </Button>
);

/** One request: a single link (the subject) stretched over the card, so nothing nests. */
function RequestCard({ r }: { r: SupportSummary }) {
  return (
    <li className="relative grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 rounded-xl border border-border bg-surface p-5 shadow-soft transition-colors hover:border-border-strong has-[a:focus-visible]:outline-2 has-[a:focus-visible]:outline-offset-2 has-[a:focus-visible]:outline-ring motion-reduce:transition-none sm:p-6">
      <span className="row-span-2 grid size-10 place-items-center rounded-full bg-primary-soft text-primary">
        <MessageCircle aria-hidden strokeWidth={1.5} className="size-5" />
      </span>
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <h3 className="min-w-0 text-[17px] leading-snug font-medium break-words">
          <Link href={`${BASE}/${r.id}`} className="outline-none after:absolute after:inset-0 after:rounded-xl">
            {r.subject}
          </Link>
        </h3>
        <StatusBadge status={r.status} />
      </div>
      <div className="col-start-2 grid gap-1 text-sm text-foreground-muted">
        <p>{SUPPORT_CATEGORY_LABEL[r.category]}</p>
        <p>
          Sent <ShortDate iso={r.createdAt} /> · Updated <ShortDate iso={r.lastPublicActivityAt} />
        </p>
        <p aria-hidden className="mt-1 inline-flex items-center gap-1.5 justify-self-end font-medium text-primary">
          View request
          <ArrowRight strokeWidth={1.5} className="size-4" />
        </p>
      </div>
    </li>
  );
}

/** Supplementary, after the list on small screens. Reads nothing from the account. */
function Guidance() {
  return (
    <aside aria-labelledby="support-guidance" className="grid content-start gap-3 rounded-xl border border-border bg-brand-ivory p-6">
      <h2 id="support-guidance" className="font-heading text-2xl">
        How can we help?
      </h2>
      <p className="text-[15px] text-foreground-secondary">Tell us what you were trying to do and what happened.</p>
      <ul className="grid list-disc gap-1.5 pl-5 text-[15px] text-foreground-secondary">
        <li>Choose the closest category.</li>
        <li>Describe the issue clearly.</li>
        <li>Return here to read and reply.</li>
      </ul>
      <p className="flex items-start gap-2 text-sm text-foreground-muted">
        <LockKeyhole aria-hidden strokeWidth={1.5} className="mt-0.5 size-4 shrink-0" />
        Please don’t include passwords or verification codes.
      </p>
    </aside>
  );
}

/** The Customer's own requests, newest public activity first (server-paginated). */
export function SupportList({ page }: { page: number }) {
  const query = useSupportRequests(page);
  return (
    <div className="max-w-5xl">
      <PageHeader
        eyebrow="Help & support"
        title="A little help, when you need it."
        description="Ask the For After team a question and find your replies here."
        action={newRequest('New request')}
      />
      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_17rem] lg:items-start">
        <section aria-labelledby="your-requests" className="grid min-w-0 gap-4">
          <h2 id="your-requests" className="flex items-baseline gap-2 font-heading text-2xl">
            Your requests
            {query.data && query.data.pagination.total > 0 && (
              <span className="font-sans text-sm text-foreground-muted">({query.data.pagination.total})</span>
            )}
          </h2>
          <QueryView query={query} loadingLabel="Loading your support requests">
            {({ items, pagination }) =>
              items.length === 0 ? (
                <EmptyState
                  icon={MessageCircle}
                  heading="h3"
                  title="We’re here to help."
                  description="Create a request whenever you need a hand."
                  action={newRequest('Create a request')}
                />
              ) : (
                <div aria-busy={query.isPlaceholderData || undefined} className="grid gap-3">
                  <ul className="grid gap-3">
                    {items.map((r) => (
                      <RequestCard key={r.id} r={r} />
                    ))}
                  </ul>
                  <Pager pagination={pagination} hrefFor={(p) => `${BASE}?page=${p}`} />
                </div>
              )
            }
          </QueryView>
        </section>
        <Guidance />
      </div>
    </div>
  );
}

type Draft = { subject: string; category: SupportCategory | ''; description: string };

/** Success only once the API confirmed the request; text is kept on any failure. */
export function NewSupportRequest() {
  const router = useRouter();
  const create = useCreateSupportRequest();
  const [draft, setDraft] = useState<Draft>({ subject: '', category: '', description: '' });
  // One id per draft: a retry after a lost response returns the same request.
  const [clientRequestId] = useState(() => crypto.randomUUID());
  const [errors, setErrors] = useState<Partial<Record<keyof Draft, string>>>({});
  const set = (k: keyof Draft) => (e: { target: { value: string } }) => setDraft({ ...draft, [k]: e.target.value });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (create.isPending) return;
    const subject = draft.subject.trim();
    const description = draft.description.trim();
    const next: typeof errors = {};
    if (subject.length < SUBJECT_MIN) next.subject = `Enter a subject (at least ${SUBJECT_MIN} characters).`;
    if (subject.length > SUBJECT_MAX) next.subject = `Keep the subject to ${SUBJECT_MAX} characters.`;
    if (!draft.category) next.category = 'Choose a category.';
    if (description.length < DESCRIPTION_MIN) next.description = `Describe the issue (at least ${DESCRIPTION_MIN} characters).`;
    if (description.length > TEXT_MAX) next.description = `Keep it to ${TEXT_MAX.toLocaleString('en-AU')} characters.`;
    setErrors(next);
    if (Object.keys(next).length || !draft.category) return;
    create.mutate(
      { clientRequestId, subject, category: draft.category, description },
      { onSuccess: (request) => router.push(`${BASE}/${request.id}`) },
    );
  };
  return (
    <>
      <PageHeader
        back={{ href: BASE, label: 'Help & support' }}
        eyebrow="Help & support"
        title="New support request"
        description={PRIVACY_HINT}
      />
      <form onSubmit={submit} noValidate aria-label="New support request" className="grid max-w-2xl gap-5">
        <TextField id="subject" label="Subject" maxLength={SUBJECT_MAX} value={draft.subject} onChange={set('subject')} error={errors.subject} />
        <SelectField
          id="category"
          label="Category"
          value={draft.category}
          onChange={set('category')}
          options={[{ value: '', label: 'Choose a category' }, ...SUPPORT_CATEGORIES.map((c) => ({ value: c, label: SUPPORT_CATEGORY_LABEL[c] }))]}
        />
        {errors.category && <p className="-mt-3 text-sm text-danger">{errors.category}</p>}
        <TextAreaField
          id="description"
          label="Description"
          hint="Plain text. No attachments."
          rows={8}
          maxLength={TEXT_MAX}
          length={draft.description.length}
          value={draft.description}
          onChange={set('description')}
          error={errors.description}
        />
        <FormError error={create.error} title="Your request wasn’t sent" />
        <Button type="submit" disabled={create.isPending} className="w-fit">
          {create.isPending && <Spinner />}
          Send request
        </Button>
      </form>
    </>
  );
}

const NOT_FOUND = { title: 'We couldn’t find this support request', backHref: BASE, backLabel: 'All support requests' };
const card = 'grid content-start gap-4 rounded-xl border border-border bg-surface p-5 shadow-soft sm:p-6';
// Long words and links wrap instead of widening the page.
const textBody = 'text-[15px] leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]';

/** One public entry. "You" shows your own initials (already in your session); support shows a headset. */
function Entry({ m, mine, last }: { m: Pick<SupportMessage, 'authorRole' | 'body' | 'createdAt'>; mine: string | null; last: boolean }) {
  const team = m.authorRole === 'ADMIN';
  return (
    <li className="relative grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 pb-5">
      {/* The thread line between markers. */}
      {!last && <span aria-hidden className="absolute top-12 bottom-1 left-5 border-l border-dashed border-border-strong" />}
      <span
        aria-hidden
        className={cn(
          'row-span-2 grid size-10 place-items-center rounded-full font-heading text-base',
          team ? 'bg-primary text-primary-foreground' : 'bg-primary-soft text-primary',
        )}
      >
        {team ? <Headset strokeWidth={1.5} className="size-5" /> : (mine ?? <UserRound strokeWidth={1.5} className="size-5" />)}
      </span>
      <p className="flex flex-wrap items-baseline gap-x-2 text-sm">
        <span className="font-medium text-foreground">{team ? 'For After support' : 'You'}</span>
        <time dateTime={m.createdAt} title={formatDateTime(m.createdAt)} className="text-foreground-muted">
          {formatTimestamp(m.createdAt)}
        </time>
      </p>
      <p className={cn('rounded-lg px-4 py-3', textBody, team ? 'bg-primary-soft' : 'bg-surface-muted')}>{m.body}</p>
    </li>
  );
}

export function SupportDetail({ id }: { id: string }) {
  const query = useSupportRequest(id);
  return (
    <QueryView query={query} notFound={NOT_FOUND} loadingLabel="Loading support request">
      {(r) => <Detail r={r} />}
    </QueryView>
  );
}

function Detail({ r }: { r: SupportRequest }) {
  const followUp = useSupportFollowUp(r.id);
  const me = useCurrentUser().data;
  const mine = me ? initials({ firstName: me.firstName, lastName: me.lastName }) : null;
  const tz = timeZoneLabel(new Date(r.lastPublicActivityAt));
  // The description is the first entry of the thread, then every public message in order.
  const thread = [{ authorRole: 'CUSTOMER' as const, body: r.description, createdAt: r.createdAt }, ...r.messages];
  return (
    <>
      <PageHeader
        back={{ href: BASE, label: 'All support requests' }}
        eyebrow="Help & support"
        title={<span className="[overflow-wrap:anywhere]">{r.subject}</span>}
        description="Your conversation with the For After team."
        action={<StatusBadge status={r.status} />}
      />
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <section aria-labelledby="conversation" className={card}>
          <div className="flex items-start gap-3 border-b border-border pb-4">
            <MessagesSquare aria-hidden strokeWidth={1.5} className="mt-1 size-6 shrink-0 text-primary" />
            <div className="grid gap-0.5">
              <h2 id="conversation" className="font-heading text-2xl leading-tight">
                Conversation
              </h2>
              <p className="text-sm text-foreground-muted">Only you and the For After support team can see this request.</p>
            </div>
          </div>
          <ol className="grid">
            {thread.map((m, i) => (
              <Entry key={'id' in m ? m.id : 'description'} m={m} mine={mine} last={i === thread.length - 1} />
            ))}
          </ol>
          <div className="border-t border-border pt-4">
            {r.status === 'RESOLVED' ? (
              <div className="flex flex-wrap items-start gap-4 rounded-lg bg-success/10 p-4 sm:p-5">
                <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-full bg-success text-white">
                  <Check strokeWidth={2} className="size-5" />
                </span>
                <div className="grid min-w-48 flex-1 gap-1">
                  <h3 className="font-heading text-xl leading-tight">This request is resolved</h3>
                  <p className="text-sm text-foreground-secondary">
                    You can still read this conversation. For another question, create a new request.
                  </p>
                </div>
                <Button asChild variant="outline" size="sm">
                  <Link href={`${BASE}/new`}>
                    Create a new request
                    <ArrowRight aria-hidden strokeWidth={1.5} />
                  </Link>
                </Button>
              </div>
            ) : (
              <Composer
                id="follow-up"
                label="Add a follow-up"
                hint={PRIVACY_HINT}
                placeholder="Write your reply…"
                submitLabel="Send follow-up"
                compact
                onSubmit={(input) => followUp.mutateAsync(input)}
                pending={followUp.isPending}
                error={followUp.error}
              />
            )}
          </div>
        </section>
        <div className="grid min-w-0 gap-6">
          <section aria-labelledby="request-details" className={card}>
            <h2 id="request-details" className="flex items-center gap-2 font-heading text-2xl leading-tight">
              <FileText aria-hidden strokeWidth={1.5} className="size-5 text-primary" />
              Request details
            </h2>
            <dl className="grid divide-y divide-border">
              {(
                [
                  ['Status', <StatusBadge key="s" status={r.status} />],
                  ['Category', SUPPORT_CATEGORY_LABEL[r.category]],
                  [
                    'Reference',
                    <div key="r" className="flex flex-wrap items-start justify-between gap-2">
                      <details className="min-w-0">
                        <summary className="cursor-pointer rounded-sm font-mono text-sm outline-none focus-visible:outline-2 focus-visible:outline-ring">
                          <span aria-hidden>{shortId(r.id)}</span>
                          <span className="sr-only">Show the full reference</span>
                        </summary>
                        <code className="mt-1 block font-mono text-xs break-all text-foreground-secondary">{r.id}</code>
                      </details>
                      <CopyButton value={r.id} label="Copy" />
                    </div>,
                  ],
                  ['Sent', formatTimestamp(r.createdAt)],
                  // Your messages and support replies both move this; internal notes never do.
                  ['Last public activity', formatTimestamp(r.lastPublicActivityAt)],
                ] as [string, ReactNode][]
              ).map(([label, value]) => (
                <div key={label} className="grid gap-1 py-3 first:pt-0">
                  <dt className="text-xs font-medium tracking-[0.08em] text-foreground-muted uppercase">{label}</dt>
                  <dd className="text-[15px] text-foreground">{value}</dd>
                </div>
              ))}
            </dl>
            <p className="text-sm text-foreground-muted">Times shown in {tz}.</p>
          </section>
          <aside aria-labelledby="support-reassurance" className="flex gap-3 rounded-xl border border-border bg-brand-ivory p-5 sm:p-6">
            <Headset aria-hidden strokeWidth={1.5} className="mt-1 size-6 shrink-0 text-primary" />
            <div className="grid gap-1">
              <h2 id="support-reassurance" className="font-heading text-xl leading-tight">
                A little help, when you need it.
              </h2>
              <p className="text-sm text-foreground-secondary">
                Your requests and replies stay together here, so you can return whenever you need.
              </p>
            </div>
          </aside>
        </div>
      </div>
    </>
  );
}
