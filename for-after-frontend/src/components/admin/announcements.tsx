'use client';

import {
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Eye,
  Info,
  Mail,
  Megaphone,
  Plus,
  PlusCircle,
  RefreshCw,
  Send,
  Users,
  type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Badge, DataTable, linkClass, Pager, SelectField } from '@/components/admin/admin-ui';
import { AnnouncementResults, EmailFrame, RUNNING, runLabel, runTone } from '@/components/admin/announcement-results';
import { FormError, TextAreaField, TextField } from '@/components/shared/form-field';
import { PageHeader } from '@/components/shared/page-header';
import { EmptyState, ErrorState, QueryView, Spinner } from '@/components/shared/states';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { useAdminSession } from '@/hooks/use-admin';
import {
  useAnnouncement,
  useAnnouncements,
  useAddPilot,
  useAudienceReview,
  useBroadcastReview,
  useQueueBroadcast,
  usePilot,
  useRemovePilot,
  useRequestTest,
  useSaveAnnouncement,
  useSavedPreview,
  useSetAudience,
  useTestDestination,
  useTestSend,
} from '@/hooks/use-announcements';
import { useUnsavedChanges } from '@/hooks/use-unsaved-changes';
import {
  BODY_MAX,
  CTA_LABEL_MAX,
  DESTINATIONS,
  NAME_MAX,
  SUBJECT_MAX,
  type Announcement,
  type AnnouncementContent,
  type AudienceReview,
  type EligibilityStatus,
  type Destination,
  type TestSend,
  type TestSendStatus,
} from '@/lib/api/announcements';
import type { ApiError } from '@/lib/api/errors';
import { personName } from '@/lib/admin';
import { formatDateTime, formatTimestamp } from '@/lib/format';
import { cn } from '@/lib/utils';

const n = (v: number) => v.toLocaleString('en-AU');
export const ANNOUNCEMENTS = '/admin/announcements';
const TITLE = 'Notification centre';

/** UX only: the API refuses everyone but SUPER_ADMIN (with completed two-factor) on every request. */
function SuperAdminOnly({ children }: { children: ReactNode }) {
  const me = useAdminSession().data;
  if (!me) return null; // AdminGate shows the loader until the session is known
  if (me.role === 'SUPER_ADMIN') return children;
  return (
    <>
      <PageHeader eyebrow="Operations" title={TITLE} />
      <ErrorState title="Access denied" message="The Notification centre is available to super admins only." />
    </>
  );
}

const who = (a: Announcement['createdBy']) => personName(a) ?? a.email;

export function AnnouncementList({ page }: { page: number }) {
  return (
    <SuperAdminOnly>
      <DraftList page={page} />
    </SuperAdminOnly>
  );
}

function DraftList({ page }: { page: number }) {
  const list = useAnnouncements(page);
  return (
    <>
      <PageHeader
        eyebrow="Operations"
        title={TITLE}
        description="Prepare email announcements for your customers."
        action={
          <Button asChild>
            <Link href={`${ANNOUNCEMENTS}/new`}>
              <Plus aria-hidden strokeWidth={1.5} />
              Create announcement
            </Link>
          </Button>
        }
      />
      <QueryView query={list} loadingLabel="Loading announcements">
        {(data) =>
          data.items.length === 0 && page === 1 ? (
            <EmptyState
              icon={Megaphone}
              title="No email announcements yet."
              description="Create a draft to prepare your first announcement."
            />
          ) : (
            <div aria-busy={list.isPlaceholderData || undefined}>
              <DataTable
                caption="Email announcement drafts"
                rows={data.items}
                rowKey={(d) => d.id}
                columns={[
                  { header: 'Draft name', cell: (d) => <span className="font-medium break-words">{d.name}</span> },
                  { header: 'Email subject', cell: (d) => <span className="break-words">{d.subject}</span> },
                  {
                    header: 'Status',
                    cell: (d) => (d.broadcast ? <Badge tone={runTone(d.broadcast.status)}>{runLabel(d.broadcast.status, d.broadcast.issues)}</Badge> : 'Draft'),
                  },
                  { header: 'Last updated', cell: (d) => formatTimestamp(d.updatedAt) },
                  { header: 'Created by', cell: (d) => who(d.createdBy) },
                  {
                    header: 'Actions',
                    cell: (d) => {
                      // A queued announcement opens its progress/results; its content can no longer be edited.
                      const action = !d.broadcast ? 'Edit' : RUNNING.includes(d.broadcast.status) ? 'View progress' : 'View results';
                      return (
                        <Link href={`${ANNOUNCEMENTS}/${d.id}`} className={linkClass} aria-label={`${action} ${d.name}`}>
                          {action}
                        </Link>
                      );
                    },
                  },
                ]}
              />
              <Pager pagination={data.pagination} hrefFor={(p) => `${ANNOUNCEMENTS}?page=${p}`} />
            </div>
          )
        }
      </QueryView>
    </>
  );
}

export function AnnouncementEditor({ id }: { id?: string }) {
  return <SuperAdminOnly>{id ? <EditDraft id={id} /> : <Wizard />}</SuperAdminOnly>;
}

function EditDraft({ id }: { id: string }) {
  const draft = useAnnouncement(id);
  return (
    <QueryView
      query={draft}
      loadingLabel="Loading the draft"
      notFound={{ title: 'Draft not found', backHref: ANNOUNCEMENTS, backLabel: 'Back to Notification centre' }}
    >
      {(d) => <Wizard draft={d} />}
    </QueryView>
  );
}

type Fields = { name: string; subject: string; body: string; ctaLabel: string; ctaDestination: Destination | '' };
const fieldsOf = (d?: Announcement): Fields => ({
  name: d?.name ?? '',
  subject: d?.subject ?? '',
  body: d?.body ?? '',
  ctaLabel: d?.ctaLabel ?? '',
  ctaDestination: d?.ctaDestination ?? '',
});
const contentOf = (f: Fields): AnnouncementContent => ({
  subject: f.subject.trim(),
  body: f.body.trim(),
  ctaLabel: f.ctaLabel.trim() || null,
  ctaDestination: f.ctaDestination || null,
});

type Errors = Partial<Record<keyof Fields, string>>;
function validate(f: Fields) {
  const e: Errors = {};
  const c = contentOf(f);
  if (!f.name.trim()) e.name = 'Enter a draft name.';
  if (!c.subject) e.subject = 'Enter an email subject.';
  if (!c.body) e.body = 'Enter a message.';
  if (c.ctaLabel && !c.ctaDestination) e.ctaDestination = 'Choose where the button goes, or remove the button.';
  if (c.ctaDestination && !c.ctaLabel) e.ctaLabel = 'Enter a button label, or remove the button.';
  return e;
}
// Field order on the page: the first invalid one gets focus.
const FIELD_IDS: [keyof Fields, string][] = [
  ['name', 'announcement-name'],
  ['subject', 'announcement-subject'],
  ['body', 'announcement-body'],
  ['ctaDestination', 'announcement-destination'],
  ['ctaLabel', 'announcement-cta-label'],
];

const STEPS = [
  { key: 'write', label: 'Write' },
  { key: 'preview', label: 'Preview & test' },
  { key: 'audience', label: 'Audience' },
  { key: 'send', label: 'Review & send' },
] as const;
type StepKey = (typeof STEPS)[number]['key'];
const stepIndex = (k: StepKey) => STEPS.findIndex((s) => s.key === k);

/** Only the step name lives in the URL (?step=…): never content, addresses or tokens. */
function stepFromUrl(): StepKey {
  if (typeof window === 'undefined') return 'write';
  const s = new URLSearchParams(window.location.search).get('step');
  return STEPS.find((x) => x.key === s)?.key ?? 'write';
}

const HEADING_ID = 'wizard-step-heading';
const card = 'grid min-w-0 gap-6 rounded-xl border border-border bg-surface p-5 sm:p-7';
const headingClass = 'text-2xl leading-tight outline-none sm:text-[28px]';

/**
 * Notification centre wizard: Write → Preview & test → Audience → Review & send.
 * One form state for every step; only the active step is shown. A step is open
 * only when the steps before it are complete FOR THE CURRENT SAVED VERSION, so a
 * save that changes the version asks for preview, audience and confirmation
 * again. The step URL is a convenience only: every send rule is enforced by the
 * API (version, review token, gate, policy, idempotency).
 */
function Wizard({ draft }: { draft?: Announcement }) {
  const router = useRouter();
  const save = useSaveAnnouncement(draft?.id);
  // The last saved state: what "unsaved changes" compares against.
  const [saved, setSaved] = useState(() => ({ fields: fieldsOf(draft), version: draft?.version }));
  const [f, setF] = useState(saved.fields);
  const [errors, setErrors] = useState<Errors>({});
  const [buttonOpen, setButtonOpen] = useState(false);
  const busy = useRef(false);
  const dirty = JSON.stringify(f) !== JSON.stringify(saved.fields);
  useUnsavedChanges(dirty);
  const id = draft?.id ?? '';
  const version = draft ? saved.version : undefined;

  // Steps passed (the admin chose "Continue") for one saved version.
  const [passed, setPassed] = useState<{ preview?: number; audience?: number }>({});
  const done: Record<StepKey, boolean> = {
    write: !!draft && !dirty,
    preview: false,
    audience: false,
    send: false,
  };
  done.preview = done.write && passed.preview === version;
  done.audience = done.preview && passed.audience === version;
  const reachable = (k: StepKey) => STEPS.slice(0, stepIndex(k)).every((s) => done[s.key]);

  // A step that is not open yet (direct link, refresh, Back into a changed version) falls back to the first unfinished one.
  const clamp = (k: StepKey): StepKey => (reachable(k) ? k : (STEPS.find((s) => !done[s.key])?.key ?? 'write'));
  const clampRef = useRef(clamp);
  useEffect(() => {
    clampRef.current = clamp;
  });
  const [requested, setRequested] = useState<StepKey>(() => clamp(stepFromUrl()));
  const active = clamp(requested);
  // Keep the address honest: the URL names the step shown, so Back/Forward behave as expected.
  useEffect(() => {
    if (draft && stepFromUrl() !== active) window.history.replaceState(null, '', `${window.location.pathname}?step=${active}`);
  }, [draft, active]);
  const focusHeading = useRef(false);
  const go = (k: StepKey) => {
    focusHeading.current = true;
    setRequested(k);
    window.history.pushState(null, '', `${window.location.pathname}?step=${k}`);
  };
  useEffect(() => {
    const back = () => {
      focusHeading.current = true;
      setRequested(clampRef.current(stepFromUrl()));
    };
    window.addEventListener('popstate', back);
    return () => window.removeEventListener('popstate', back);
  }, []);
  useEffect(() => {
    if (!focusHeading.current) return;
    focusHeading.current = false;
    document.getElementById(HEADING_ID)?.focus();
  }, [active]);

  // Shared across steps 2 and 4: the requesting admin's latest test.
  const [testId, setTestId] = useState<string | null>(draft?.latestTest?.id ?? null);
  const test = useTestSend(id, testId, draft?.latestTest);
  // Step 4: once a run exists, the progress view replaces the wizard.
  const [runId, setRunId] = useState<string | null>(draft?.broadcast?.id ?? null);

  const set = (k: keyof Fields) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  const submit = (thenContinue: boolean) => {
    if (busy.current) return;
    const next = validate(f);
    setErrors(next);
    const first = FIELD_IDS.find(([k]) => next[k]);
    if (first) {
      if (next.ctaLabel || next.ctaDestination) setButtonOpen(true);
      setTimeout(() => document.getElementById(first[1])?.focus());
      return;
    }
    // Nothing changed: continuing must not re-save (a save makes a new version and resets the later steps).
    if (thenContinue && draft && !dirty) return go('preview');
    busy.current = true;
    save.mutate(
      { name: f.name.trim(), ...contentOf(f), expectedVersion: saved.version },
      {
        // Advances only after the API confirms the save; the new version is what later steps check.
        onSuccess: (d) => {
          toast.success('Draft saved.');
          setSaved({ fields: fieldsOf(d), version: d.version });
          setF(fieldsOf(d));
          if (!draft) {
            // A new draft stays locked until its edit page opens, so a second click can't create a copy.
            router.replace(`${ANNOUNCEMENTS}/${d.id}${thenContinue ? '?step=preview' : ''}`);
            return;
          }
          busy.current = false;
          if (thenContinue) go('preview');
        },
        // On any error (incl. a 409 conflict) the editor keeps every character typed and stays here.
        onError: () => (busy.current = false),
      },
    );
  };

  const status = save.isPending ? (
    'Saving…'
  ) : dirty ? (
    <span className="flex items-center gap-2">
      <span aria-hidden className="size-2 rounded-full bg-warning" />
      Unsaved changes
    </span>
  ) : draft ? (
    <span className="flex items-center gap-2">
      <Check aria-hidden strokeWidth={1.5} className="size-4 text-success" />
      Draft saved
    </span>
  ) : null;

  if (draft && runId) return <AnnouncementResults id={draft.id} runId={runId} />;

  return (
    <>
      <header className="mb-6 grid gap-2">
        <Link
          href={ANNOUNCEMENTS}
          className="mb-2 inline-flex w-fit items-center gap-2 rounded-sm text-sm text-foreground-muted outline-none hover:text-foreground focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring"
        >
          <ArrowLeft aria-hidden strokeWidth={1.5} className="size-4" />
          {TITLE}
        </Link>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <h1 className="text-[34px] leading-[1.05] break-words sm:text-[42px]">{draft ? 'Edit announcement' : 'Create announcement'}</h1>
          {draft?.status === 'DRAFT' && <Badge tone="open">Draft</Badge>}
        </div>
        <p className="text-lg text-foreground-muted">A thoughtful update, one step at a time.</p>
      </header>

      {(
        <>
          <Stepper active={active} done={done} reachable={reachable} onGo={go} />
          <div className="mt-6">
            {active === 'write' && (
              <WriteStep
                f={f}
                set={set}
                errors={errors}
                buttonOpen={buttonOpen}
                setButtonOpen={setButtonOpen}
                removeButton={() => setF({ ...f, ctaLabel: '', ctaDestination: '' })}
                onSubmit={() => submit(false)}
                saveError={save.error}
              />
            )}
            {active === 'preview' && draft && version !== undefined && (
              <PreviewStep id={id} version={version} content={contentOf(saved.fields)} test={test.data} onTest={setTestId} />
            )}
            {active === 'audience' && draft && version !== undefined && (
              <AudienceStep
                id={id}
                version={version}
                footer={(ready, reason) => (
                  <Footer
                    left={<BackButton onClick={() => go('preview')} />}
                    status={status}
                    reason={reason}
                    reasonId="audience-continue-reason"
                    primary={
                      <Button
                        type="button"
                        disabled={!ready}
                        aria-describedby={reason ? 'audience-continue-reason' : undefined}
                        onClick={() => {
                          setPassed((p) => ({ ...p, audience: version }));
                          go('send');
                        }}
                      >
                        Continue to review
                        <ArrowRight aria-hidden strokeWidth={1.5} />
                      </Button>
                    }
                  />
                )}
              />
            )}
            {active === 'send' && draft && version !== undefined && (
              <SendStep
                id={id}
                version={version}
                name={saved.fields.name}
                test={test.data}
                onEdit={() => go('write')}
                onAudience={() => go('audience')}
                onQueued={setRunId}
                back={<BackButton onClick={() => go('audience')} />}
                status={status}
              />
            )}
          </div>

          {active === 'write' && (
            <Footer
              left={
                <Button asChild variant="ghost">
                  <Link href={ANNOUNCEMENTS}>Cancel</Link>
                </Button>
              }
              status={status}
              secondary={
                <Button type="button" variant="outline" disabled={save.isPending || (!draft && save.isSuccess)} onClick={() => submit(false)}>
                  {save.isPending && <Spinner />}
                  Save draft
                </Button>
              }
              primary={
                <Button type="button" disabled={save.isPending || (!draft && save.isSuccess)} onClick={() => submit(true)}>
                  Save &amp; continue
                  <ArrowRight aria-hidden strokeWidth={1.5} />
                </Button>
              }
            />
          )}
          {active === 'preview' && (
            <Footer
              left={<BackButton onClick={() => go('write')} />}
              status={status}
              primary={
                <Button
                  type="button"
                  onClick={() => {
                    setPassed((p) => ({ ...p, preview: version }));
                    go('audience');
                  }}
                >
                  Continue to audience
                  <ArrowRight aria-hidden strokeWidth={1.5} />
                </Button>
              }
            />
          )}
        </>
      )}
    </>
  );
}

function Stepper({
  active,
  done,
  reachable,
  onGo,
}: {
  active: StepKey;
  done: Record<StepKey, boolean>;
  reachable: (k: StepKey) => boolean;
  onGo: (k: StepKey) => void;
}) {
  const i = stepIndex(active);
  return (
    <nav aria-label="Announcement steps" className="rounded-xl border border-border bg-surface px-4 py-3 sm:px-6 sm:py-4">
      {/* Narrow screens: a compact label instead of four step names. */}
      <div className="grid gap-2 md:hidden">
        <p className="text-sm font-medium text-foreground">
          Step {i + 1} of {STEPS.length} · {STEPS[i]!.label}
        </p>
        <div aria-hidden className="h-1 rounded-full bg-surface-muted">
          <div className="h-1 rounded-full bg-primary" style={{ width: `${((i + 1) / STEPS.length) * 100}%` }} />
        </div>
      </div>
      <ol className="hidden items-center gap-3 md:flex">
        {STEPS.map((s, n) => {
          const isActive = s.key === active;
          const complete = !isActive && done[s.key];
          const marker = (
            <>
              <span
                aria-hidden
                className={cn(
                  'grid size-8 shrink-0 place-items-center rounded-full border text-sm font-medium',
                  isActive ? 'border-primary bg-primary text-primary-foreground' : 'border-foreground-muted/50 text-foreground-secondary',
                )}
              >
                {complete ? <Check strokeWidth={1.75} className="size-4 text-primary" /> : n + 1}
              </span>
              <span className={cn('text-[15px] whitespace-nowrap', isActive ? 'font-semibold text-primary' : 'text-foreground')}>{s.label}</span>
              {complete && <span className="sr-only"> (completed)</span>}
            </>
          );
          return (
            <li key={s.key} className="flex min-w-0 flex-1 items-center gap-3 last:flex-none">
              {!isActive && reachable(s.key) ? (
                <button
                  type="button"
                  onClick={() => onGo(s.key)}
                  className="flex items-center gap-3 rounded-md outline-none hover:underline focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring"
                >
                  {marker}
                </button>
              ) : (
                <span aria-current={isActive ? 'step' : undefined} className="flex items-center gap-3">
                  {marker}
                </span>
              )}
              {n < STEPS.length - 1 && <span aria-hidden className="h-px min-w-4 flex-1 bg-border" />}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function Footer({
  left,
  status,
  secondary,
  primary,
  reason,
  reasonId,
}: {
  left: ReactNode;
  status: ReactNode;
  secondary?: ReactNode;
  primary: ReactNode;
  reason?: string | null;
  reasonId?: string;
}) {
  return (
    <div className="mt-6 flex flex-wrap items-center gap-x-6 gap-y-4 pb-6">
      <div className="flex min-w-0 flex-1 basis-56 items-center gap-4">
        {left}
        {status && (
          <p aria-live="polite" className="border-l border-border pl-4 text-sm text-foreground-secondary">
            {status}
          </p>
        )}
      </div>
      <div className="ml-auto grid justify-items-end gap-2">
        <div className="flex flex-wrap justify-end gap-3">
          {secondary}
          {primary}
        </div>
        {reason && (
          <p id={reasonId} className="max-w-sm text-right text-sm text-foreground-muted">
            {reason}
          </p>
        )}
      </div>
    </div>
  );
}

const BackButton = ({ onClick }: { onClick: () => void }) => (
  <Button type="button" variant="ghost" onClick={onClick}>
    <ArrowLeft aria-hidden strokeWidth={1.5} />
    Back
  </Button>
);

function StepHeading({ title, description, aside }: { title: string; description: string; aside?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="grid gap-1">
        <div className="flex flex-wrap items-center gap-3">
          <h2 id={HEADING_ID} tabIndex={-1} className={headingClass}>
            {title}
          </h2>
        </div>
        <p className="text-foreground-muted">{description}</p>
      </div>
      {aside}
    </div>
  );
}

// ─── Step 1 · Write ─────────────────────────────────────────────────────────

function WriteStep({
  f,
  set,
  errors,
  buttonOpen,
  setButtonOpen,
  removeButton,
  onSubmit,
  saveError,
}: {
  f: Fields;
  set: (k: keyof Fields) => (e: { target: { value: string } }) => void;
  errors: Errors;
  buttonOpen: boolean;
  setButtonOpen: (open: boolean) => void;
  removeButton: () => void;
  onSubmit: () => void;
  saveError: ApiError | null;
}) {
  const hasButton = !!(f.ctaLabel.trim() || f.ctaDestination);
  const destinationError = errors.ctaDestination ? 'announcement-destination-error' : undefined;
  return (
    <form
      id="announcement-form"
      noValidate
      aria-labelledby={HEADING_ID}
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(); // Enter in a field = Save draft (stays on this step)
      }}
      className={cn(card, 'mx-auto w-full max-w-3xl')}
    >
      <StepHeading
        title="Write your announcement"
        description="Start with the message you want to share."
        aside={
          <ul aria-label="Channel" className="flex">
            <Chip icon={Mail} label="Channel">
              Email
            </Chip>
          </ul>
        }
      />
      <TextField
        id="announcement-name"
        label="Internal draft name"
        hint="Only visible to administrators."
        maxLength={NAME_MAX}
        value={f.name}
        onChange={set('name')}
        error={errors.name}
      />
      <TextField id="announcement-subject" label="Email subject" maxLength={SUBJECT_MAX} value={f.subject} onChange={set('subject')} error={errors.subject} />
      <TextAreaField
        id="announcement-body"
        label="Message"
        hint="Plain text. Leave a blank line between paragraphs."
        rows={9}
        maxLength={BODY_MAX}
        length={f.body.length}
        value={f.body}
        onChange={set('body')}
        error={errors.body}
        className="min-h-48 px-4 py-3 leading-relaxed"
      />

      <div className="rounded-lg border border-border">
        <button
          type="button"
          aria-expanded={buttonOpen}
          aria-controls="announcement-button-fields"
          onClick={() => setButtonOpen(!buttonOpen)}
          className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 rounded-lg px-4 py-3 text-left outline-none hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring"
        >
          <PlusCircle aria-hidden strokeWidth={1.5} className="size-5 text-foreground-secondary" />
          <span className="font-medium">{hasButton ? 'Button' : 'Add a button'}</span>
          <span className="text-sm text-foreground-muted">
            {hasButton
              ? `“${f.ctaLabel.trim() || 'No label'}” → ${f.ctaDestination ? DESTINATIONS[f.ctaDestination] : 'no destination'}`
              : 'Optional'}
          </span>
          <ChevronRight aria-hidden strokeWidth={1.5} className={cn('ml-auto size-5 transition-transform motion-reduce:transition-none', buttonOpen && 'rotate-90')} />
        </button>
        {/* Collapsing only hides the fields: their values are kept. "Remove button" is the only way to delete it. */}
        <div id="announcement-button-fields" hidden={!buttonOpen} className="grid gap-4 border-t border-border px-4 py-4">
          <div className="grid gap-4 sm:grid-cols-2 sm:items-start">
            <div className="grid gap-2">
              <SelectField
                id="announcement-destination"
                label="Destination"
                value={f.ctaDestination}
                onChange={set('ctaDestination')}
                aria-invalid={errors.ctaDestination ? true : undefined}
                aria-describedby={destinationError}
                options={[{ value: '', label: 'Choose a page' }, ...Object.entries(DESTINATIONS).map(([value, label]) => ({ value, label }))]}
              />
              {errors.ctaDestination && (
                <p id={destinationError} className="text-sm text-danger">
                  {errors.ctaDestination}
                </p>
              )}
            </div>
            <TextField
              id="announcement-cta-label"
              label="Button label"
              maxLength={CTA_LABEL_MAX}
              value={f.ctaLabel}
              onChange={set('ctaLabel')}
              error={errors.ctaLabel}
            />
          </div>
          {hasButton && (
            <Button type="button" variant="ghost" className="w-fit" onClick={removeButton}>
              Remove button
            </Button>
          )}
        </div>
      </div>

      <FormError error={saveError} />
      <p className="flex items-center gap-3 border-t border-border pt-5 text-sm text-foreground-secondary">
        <Info aria-hidden strokeWidth={1.5} className="size-[18px] shrink-0" />
        Saving a draft does not send an email.
      </p>
    </form>
  );
}

// ─── Step 2 · Preview & test ────────────────────────────────────────────────

function PreviewStep({
  id,
  version,
  content,
  test,
  onTest,
}: {
  id: string;
  version: number;
  content: AnnouncementContent;
  test?: TestSend;
  onTest: (testId: string) => void;
}) {
  // The SAVED version through the real renderer (a render only: nothing is stored or sent).
  const preview = useSavedPreview(id, version, content);
  const p = preview.data;
  return (
    <section aria-labelledby={HEADING_ID} className={card}>
      <StepHeading title="Preview your email" description="Check your message before continuing." aside={<Badge>Not sent</Badge>} />
      {preview.isPending ? (
        <p className="flex items-center gap-2 text-sm text-foreground-muted">
          <Spinner /> Rendering the saved email…
        </p>
      ) : !p ? (
        <FormError error={preview.error} />
      ) : (
        <>
          <dl className="grid gap-2 rounded-lg border border-border px-4 py-3 text-sm sm:grid-cols-2 sm:gap-6">
            <div className="flex min-w-0 flex-wrap gap-x-3">
              <dt className="font-semibold">From:</dt>
              <dd className="min-w-0 break-words">
                {p.from.name} · {p.from.address ?? 'Sender address not configured'}
              </dd>
            </div>
            <div className="flex min-w-0 flex-wrap gap-x-3">
              <dt className="font-semibold">Subject:</dt>
              <dd className="min-w-0 break-words">{p.subject}</dd>
            </div>
          </dl>
          <EmailFrame html={p.html} />
        </>
      )}
      <TestSection id={id} version={version} test={test} onTest={onTest} />
    </section>
  );
}

const TEST_MESSAGE: Record<TestSendStatus, string> = {
  QUEUED: 'Test email queued.',
  PROCESSING: 'Sending the test email…',
  ACCEPTED: 'Your email provider accepted the test email. Check your inbox or spam folder to confirm it arrived.',
  FAILED: 'The test email could not be sent. Your draft is unchanged; you can try again.',
  UNKNOWN: 'We could not confirm whether the provider accepted this email. Check your inbox before sending another test.',
};

/**
 * A test of the SAVED version, to the signed-in super admin's own verified email
 * (the server decides the address; nothing here can change it). Optional, and
 * never a send to customers.
 */
function TestSection({ id, version, test, onTest }: { id: string; version: number; test?: TestSend; onTest: (testId: string) => void }) {
  const destination = useTestDestination(true);
  const request = useRequestTest(id);
  const [open, setOpen] = useState(false);
  // One deliberate test = one operation id: a retry inside the same dialog reuses it.
  const [operation, setOperation] = useState<string | null>(null);
  const email = destination.data?.email;
  const unverified = !!destination.data && !email;
  const openDialog = (next: boolean) => {
    if (request.isPending) return;
    if (next) {
      setOperation(crypto.randomUUID());
      request.reset();
    }
    setOpen(next);
  };
  const send = () => {
    if (request.isPending || !operation) return;
    request.mutate(
      { clientOperationId: operation, expectedVersion: version },
      {
        onSuccess: (t) => {
          onTest(t.id);
          setOpen(false);
        },
      },
    );
  };
  return (
    <div className="flex flex-wrap items-start gap-x-6 gap-y-4 border-t border-border pt-6">
      <Mail aria-hidden strokeWidth={1.5} className="mt-1 size-6 shrink-0 text-foreground-secondary" />
      <div className="grid min-w-0 flex-1 basis-64 gap-1.5">
        <h3 className="text-xl">Send yourself a test</h3>
        <p className="text-sm text-foreground-secondary">A test email goes only to your verified admin email address.</p>
        {unverified && (
          <p id="test-email-reason" className="flex items-center gap-2 text-sm text-foreground-secondary">
            <Info aria-hidden strokeWidth={1.5} className="size-4 shrink-0" />
            Your account email is not verified, so test emails are unavailable.
          </p>
        )}
        {test && (
          <p role="status" className="text-sm text-foreground-secondary">
            <span className="font-medium">
              Latest test ({formatTimestamp(test.createdAt)}
              {test.announcementVersion !== version && `, earlier version ${test.announcementVersion}`}):
            </span>{' '}
            {TEST_MESSAGE[test.status]}
          </p>
        )}
        <p className="text-sm text-foreground-muted">Testing is optional. You can continue without sending a test.</p>
      </div>
      <Dialog open={open} onOpenChange={openDialog}>
        {/* A real trigger (opening runs openDialog, which starts a new operation id), so focus returns here on close. */}
        <DialogTrigger asChild>
          <Button type="button" variant="outline" disabled={!email} aria-describedby={unverified ? 'test-email-reason' : undefined}>
            <Send aria-hidden strokeWidth={1.5} />
            Send test email
          </Button>
        </DialogTrigger>
        <DialogContent className="max-h-[calc(100dvh-2rem)] gap-6 overflow-y-auto rounded-xl bg-surface p-7 sm:max-w-md sm:p-8" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Send a test email?</DialogTitle>
            <DialogDescription>Send the saved version of this announcement to your verified email.</DialogDescription>
          </DialogHeader>
          <p className="grid gap-1 rounded-lg bg-brand-ivory px-4 py-3 text-[15px]">
            <span className="text-xs font-medium tracking-wide text-foreground-muted uppercase">Sends to</span>
            <span className="break-all">{email}</span>
          </p>
          <FormError error={request.error} />
          <DialogFooter className="mx-0 mb-0 flex-col-reverse gap-3 rounded-none border-0 bg-transparent p-0 sm:flex-row">
            <Button type="button" variant="outline" disabled={request.isPending} onClick={() => openDialog(false)}>
              Cancel
            </Button>
            <Button type="button" disabled={request.isPending} onClick={send}>
              {request.isPending && <Spinner />}
              Send test email
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── Step 3 · Audience ──────────────────────────────────────────────────────

const EXCLUSION_LABEL: [keyof AudienceReview['exclusions'], string][] = [
  ['accountUnavailable', 'Account unavailable (suspended, passed away or deleted)'],
  ['emailInvalid', 'Email missing or invalid'],
  ['emailNotVerified', 'Email not verified'],
  ['openDeathReport', 'Open death report (until it is resolved)'],
  ['suppressed', 'Unsubscribed, bounced or complained'],
  ['noConsent', 'Has not opted in to product news'],
];
const STATUS_LABEL: Record<EligibilityStatus, string> = {
  pass: 'Will receive it',
  account_unavailable: 'Account unavailable',
  email_invalid: 'Email missing or invalid',
  email_not_verified: 'Email not verified',
  open_death_report: 'Open death report',
  suppressed: 'Unsubscribed, bounced or complained',
  no_consent: 'Has not opted in to product news',
};
export const PURPOSE_LABEL = 'Optional product news (opt-in only; every email has an unsubscribe link)';

/** Counts only, checked each time this step opens (each check is audited). Nothing is sent or stored. */
function AudienceStep({ id, version, footer }: { id: string; version: number; footer: (ready: boolean, reason: string | null) => ReactNode }) {
  const review = useAudienceReview(id, true);
  const r = review.data;
  const outdated = !!r && r.version !== version;
  const failed = review.isError && (review.error.kind === 'server' || review.error.kind === 'network');
  const reason = review.isFetching
    ? 'Checking the audience…'
    : review.isError
      ? 'The audience check failed. Refresh the review to continue.'
      : outdated
        ? 'This review is for an earlier saved version. Refresh the review to continue.'
        : r && r.eligible === 0
          ? 'No one in this audience can receive it yet (see the reasons above).'
          : null;
  const ready = !!r && !reason;
  return (
    <>
      <section aria-labelledby={HEADING_ID} className={card}>
        <StepHeading title="Review your audience" description="See who can receive this announcement." />
        <AudienceScopePanel id={id} />
        <div className="flex flex-wrap items-center gap-3">
          <ul aria-label="Channel and audience" className="flex flex-wrap gap-2">
            <Chip icon={Mail} label="Channel">
              Email
            </Chip>
            <Chip icon={Users} label="Audience">
              {r?.audience === 'ALL_ELIGIBLE' ? 'All eligible customers' : 'Pilot group'}
            </Chip>
          </ul>
          <Button type="button" variant="outline" className="ml-auto" disabled={review.isFetching} onClick={() => void review.refetch()}>
            {review.isFetching ? <Spinner /> : <RefreshCw aria-hidden strokeWidth={1.5} />}
            Refresh review
          </Button>
        </div>
        <div aria-live="polite" aria-busy={review.isFetching || undefined} className="grid gap-6">
          {review.isPending ? (
            <p className="flex items-center gap-2 text-sm text-foreground-muted">
              <Spinner /> Checking the audience…
            </p>
          ) : failed ? (
            // A failed check is never shown as zero.
            <p role="alert" className="rounded-lg bg-danger/10 px-4 py-3 text-sm text-danger">
              The audience review is unavailable right now. Try “Refresh review” in a moment.
            </p>
          ) : review.isError ? (
            <FormError error={review.error} />
          ) : r ? (
            <>
              {outdated && (
                <p className="rounded-lg bg-warning/10 px-4 py-3 text-sm text-warning">
                  Out of date: the draft was saved again after this review. Refresh the review.
                </p>
              )}
              <dl className="grid gap-3 sm:grid-cols-3">
                <Stat label={r.audience === 'PILOT' ? 'Pilot members checked' : 'Customers checked'} value={n(r.candidates)} />
                <Stat label="Eligible" value={r.eligible === null ? 'Not confirmed' : n(r.eligible)} />
                <Stat label="Excluded" value={n(r.excluded)} />
              </dl>
              <div className="grid gap-3">
                <h3 className="text-xl">Why some customers are excluded</h3>
                <ul className="divide-y divide-border rounded-lg border border-border text-[15px]">
                  {EXCLUSION_LABEL.map(([k, label]) => (
                    <li key={k} className="flex justify-between gap-4 px-4 py-2.5">
                      <span>{label}</span>
                      <span className="tabular-nums">{n(r.exclusions[k])}</span>
                    </li>
                  ))}
                </ul>
                <p className="text-xs text-foreground-muted">Each excluded customer is counted once, under the first reason that applies.</p>
              </div>
              {r.blockers.length > 0 && (
                <div className="grid gap-2 rounded-lg border border-border bg-brand-ivory px-4 py-3">
                  <h3 className="font-sans text-[15px] font-semibold">Eligibility not confirmed</h3>
                  <p className="text-sm text-foreground-secondary">Sending to customers stays unavailable until these are decided:</p>
                  <ul className="list-disc space-y-1 pl-5 text-sm text-foreground-secondary">
                    {r.blockers.map((b) => (
                      <li key={b.code}>{b.message}</li>
                    ))}
                  </ul>
                </div>
              )}
              <p className="flex flex-wrap justify-between gap-x-6 gap-y-1 text-sm text-foreground-secondary">
                <span>Eligibility is checked again before each email is sent.</span>
                <span className="text-foreground-muted">Last checked {formatDateTime(r.checkedAt)}</span>
              </p>
            </>
          ) : null}
          <p className="flex items-start gap-3 rounded-lg bg-brand-ivory px-4 py-3 text-sm">
            <Info aria-hidden strokeWidth={1.5} className="mt-px size-[18px] shrink-0 text-primary" />
            <span className="grid gap-0.5">
              <span className="font-semibold">This is an audience review. No emails have been sent.</span>
              <span className="text-foreground-secondary">Counts can change. If the audience grows before you confirm, you’ll be asked to review it again.</span>
            </span>
          </p>
        </div>
      </section>
      {footer(ready, reason)}
    </>
  );
}

/**
 * Step 7: who the send would reach. Pilot (the safe default) = up to 10 Customer
 * accounts the super admin adds by their exact address; each shows whether it
 * would receive the email and why not. Changing anything re-checks the review.
 */
function AudienceScopePanel({ id }: { id: string }) {
  const pilot = usePilot(id, true);
  const setAudience = useSetAudience(id);
  const add = useAddPilot(id);
  const remove = useRemovePilot(id);
  const [email, setEmail] = useState('');
  const g = pilot.data;
  const busy = setAudience.isPending || add.isPending || remove.isPending;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const value = email.trim();
    if (!value || busy) return;
    add.mutate(value, { onSuccess: () => setEmail('') });
  };
  if (pilot.isPending) {
    return (
      <p className="flex items-center gap-2 text-sm text-foreground-muted">
        <Spinner /> Loading the audience…
      </p>
    );
  }
  if (!g) return <FormError error={pilot.error} />;
  return (
    <div className="grid min-w-0 gap-4 rounded-lg border border-border p-4 sm:p-5">
      <fieldset className="grid min-w-0 gap-3" disabled={busy}>
        <legend className="mb-1 font-semibold">Who should receive it</legend>
        {(
          [
            ['PILOT', 'Pilot group (recommended)', 'Only the customer accounts you add below.'],
            ['ALL_ELIGIBLE', 'All eligible customers', 'Every customer who has opted in and passes every check.'],
          ] as const
        ).map(([value, label, hint]) => (
          <label key={value} className="flex items-start gap-3">
            <input
              type="radio"
              name="audience-scope"
              value={value}
              checked={g.audience === value}
              onChange={() => setAudience.mutate(value)}
              className="mt-1 size-4 shrink-0 accent-primary"
            />
            <span className="grid">
              <span className="font-medium">{label}</span>
              <span className="text-sm text-foreground-muted">{hint}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <FormError error={setAudience.error} />
      {g.audience === 'PILOT' && (
        <div className="grid gap-3 border-t border-border pt-4">
          <h3 className="font-sans text-[15px] font-semibold">
            Pilot group ({g.members.length} of {g.max})
          </h3>
          <form onSubmit={submit} noValidate className="flex flex-wrap items-end gap-3">
            <div className="min-w-0 flex-1 basis-60">
              <TextField
                id="pilot-email"
                label="Add a customer by email"
                type="email"
                autoComplete="off"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                hint="Use a test account you control. Only existing customer accounts can be added."
              />
            </div>
            <Button type="submit" variant="outline" disabled={busy || !email.trim() || g.members.length >= g.max}>
              {add.isPending && <Spinner />}
              Add to pilot
            </Button>
          </form>
          <FormError error={add.error ?? remove.error} />
          {g.members.length === 0 ? (
            <p className="text-sm text-foreground-muted">No one is in the pilot group yet.</p>
          ) : (
            <ul aria-label="Pilot group" className="divide-y divide-border rounded-lg border border-border text-[15px]">
              {g.members.map((m) => (
                <li key={m.userId} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-2.5">
                  <span className="min-w-0 break-all">{m.email}</span>
                  {/* Wraps on narrow screens: the longest status label plus Remove is wider than a phone row. */}
                  <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <Badge tone={m.status === 'pass' ? 'done' : 'warning'}>{STATUS_LABEL[m.status]}</Badge>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      aria-label={`Remove ${m.email} from the pilot group`}
                      onClick={() => remove.mutate(m.userId)}
                    >
                      Remove
                    </Button>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="grid gap-1 rounded-lg border border-border bg-surface-muted/40 px-5 py-4">
      <dt className="text-sm font-medium text-foreground-secondary">{label}</dt>
      <dd className="font-serif text-3xl leading-tight break-words">{value}</dd>
      {note && <dd className="text-sm text-foreground-muted">{note}</dd>}
    </div>
  );
}

// ─── Step 4 · Review & send ─────────────────────────────────────────────────

// The test status of THIS saved version; an older version's test never counts.
const testLabel = (t: TestSend | undefined, version: number) => {
  if (!t || t.announcementVersion !== version) return t ? 'Not sent for this version' : 'Not sent';
  return { QUEUED: 'Queued', PROCESSING: 'Queued', ACCEPTED: 'Accepted by provider', FAILED: 'Failed', UNKNOWN: 'Unknown' }[t.status];
};
// No response, a 5xx or a timeout: the run may exist. Only the same operation id may be retried.
const uncertain = (e: ApiError) => e.kind === 'network' || e.kind === 'server' || e.kind === 'unknown';

/**
 * Opening this step asks the server for a fresh review of the saved version
 * (counts, blockers, the exact email, a short-lived review token). "Queue
 * announcement" needs that token plus the explicit checkbox; the server
 * re-checks everything. An uncertain outcome keeps the same operation id, so a
 * retry returns the run that may already exist instead of sending twice.
 */
function SendStep({
  id,
  version,
  name,
  test,
  onEdit,
  onAudience,
  onQueued,
  back,
  status,
}: {
  id: string;
  version: number;
  name: string;
  test?: TestSend;
  onEdit: () => void;
  onAudience: () => void;
  onQueued: (runId: string) => void;
  back: ReactNode;
  status: ReactNode;
}) {
  const review = useBroadcastReview(id);
  const queue = useQueueBroadcast(id);
  const operation = useRef<string | null>(null);
  const [confirmedToken, setConfirmedToken] = useState<string | null>(null);
  const [showEmail, setShowEmail] = useState(false);
  const { mutate } = review;
  // Opening this step asks for a fresh review (the confirmation starts unchecked).
  useEffect(() => mutate(version), [mutate, version]);
  // "Review again": a fresh review also clears the confirmation; the admin confirms what is on screen now.
  const check = () => {
    setConfirmedToken(null);
    mutate(version);
  };
  // A late answer for another version is ignored.
  const r = review.data?.version === version ? review.data : undefined;
  const token = r?.reviewToken ?? null;
  const confirmed = !!token && confirmedToken === token;

  const send = () => {
    if (!token || !confirmed || queue.isPending) return;
    operation.current ??= crypto.randomUUID();
    queue.mutate(
      { clientOperationId: operation.current, expectedVersion: version, reviewToken: token },
      {
        onSuccess: (run) => {
          toast.success('Announcement queued for customers.');
          onQueued(run.id);
        },
        // A definite refusal (expired review, changed audience, …): the next attempt is a new operation.
        onError: (e) => {
          if (!uncertain(e)) operation.current = null;
        },
      },
    );
  };
  const unsure = queue.isError && uncertain(queue.error);
  const reason = review.isPending
    ? 'Checking the announcement and its audience…'
    : !r
      ? 'The review could not be completed. Choose “Review again”.'
      : !token
        ? 'Sending is not available: see the reasons above.'
        : !confirmed
          ? 'Confirm above to continue.'
          : null;

  return (
    <>
      <section aria-labelledby={HEADING_ID} className={card}>
        <StepHeading title="Review before sending" description="Check the details, then confirm when you’re ready." />
        <div aria-live="polite" aria-busy={review.isPending || undefined} className="grid min-w-0 gap-5">
          {review.isPending ? (
            <p className="flex items-center gap-2 text-sm text-foreground-muted">
              <Spinner /> Checking the announcement and its audience…
            </p>
          ) : !r ? (
            <FormError error={review.error} />
          ) : (
            <>
              <dl className="divide-y divide-border border-b border-border">
                <Row label="Announcement" action={<LinkButton onClick={onEdit}>Edit message</LinkButton>}>
                  {name}
                </Row>
                <Row label="Email subject">{r.subject}</Row>
                <Row label="From">
                  {r.from.name} · {r.from.address ?? 'Sender address not configured'}
                </Row>
                <Row label="Communication purpose">{r.purpose ? PURPOSE_LABEL : 'Not classified'}</Row>
                <Row label="Audience" action={<LinkButton onClick={onAudience}>Review audience</LinkButton>}>
                  <span className="font-medium">
                    {r.audience === 'PILOT' ? 'Pilot group · ' : 'All eligible customers · '}
                    {r.eligible === null ? 'eligible customers not confirmed' : `${n(r.eligible)} eligible customers`}
                  </span>
                  <span className="text-foreground-muted"> · {n(r.excluded)} excluded</span>
                </Row>
                <Row label="Test email">
                  {testLabel(test, version)} <span className="text-foreground-muted">· optional</span>
                </Row>
              </dl>
              <div className="rounded-lg border border-border">
                <button
                  type="button"
                  aria-expanded={showEmail}
                  aria-controls="send-email-preview"
                  onClick={() => setShowEmail(!showEmail)}
                  className="flex w-full items-center gap-3 rounded-lg px-4 py-3 text-left font-medium outline-none hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring"
                >
                  <Eye aria-hidden strokeWidth={1.5} className="size-5" />
                  View email preview
                  <ChevronDown aria-hidden strokeWidth={1.5} className={cn('ml-auto size-5 transition-transform motion-reduce:transition-none', showEmail && 'rotate-180')} />
                </button>
                <div id="send-email-preview" hidden={!showEmail} className="border-t border-border p-4">
                  {showEmail && <EmailFrame html={r.html} />}
                </div>
              </div>
              {r.blockers.length > 0 ? (
                <div className="grid gap-2 rounded-lg border border-border bg-brand-ivory px-4 py-3">
                  <h3 className="font-sans text-[15px] font-semibold">Sending is not available</h3>
                  <ul className="list-disc space-y-1 pl-5 text-sm text-foreground-secondary">
                    {r.blockers.map((b) => (
                      <li key={b.code}>{b.message}</li>
                    ))}
                  </ul>
                </div>
              ) : (
                <p className="flex items-start gap-3 rounded-lg bg-success/10 px-4 py-3 text-sm">
                  <CheckCircle2 aria-hidden strokeWidth={1.5} className="mt-px size-5 shrink-0 text-success" />
                  <span className="grid gap-0.5">
                    <span className="font-semibold">Audience reviewed</span>
                    <span className="text-foreground-secondary">
                      Eligibility is checked again before each email is sent.
                      {r.expiresAt && ` This review is valid until ${formatDateTime(r.expiresAt)}.`}
                    </span>
                  </span>
                </p>
              )}
              <label className={cn('flex items-start gap-3 border-t border-border pt-5', !token && 'opacity-60')}>
                <input
                  type="checkbox"
                  checked={confirmed}
                  disabled={!token || queue.isPending}
                  onChange={(e) => setConfirmedToken(e.target.checked ? token : null)}
                  aria-describedby="send-confirm-hint"
                  className="mt-1 size-4 shrink-0 accent-primary"
                />
                <span className="grid gap-0.5">
                  <span className="font-semibold">I confirm this announcement is ready to be emailed to the eligible customers.</span>
                  <span id="send-confirm-hint" className="text-sm text-foreground-secondary">
                    Queuing starts background processing. Emails already accepted by the provider cannot be recalled.
                  </span>
                </span>
              </label>
            </>
          )}
          {unsure ? (
            <div role="alert" className="grid gap-3 rounded-lg bg-warning/10 px-4 py-3 text-sm">
              <p>
                We could not confirm whether the announcement was queued. Check the status before doing anything else: checking
                uses the same request, so it can never queue the announcement twice.
              </p>
              <Button type="button" variant="outline" className="w-fit" disabled={queue.isPending} onClick={send}>
                {queue.isPending && <Spinner />}
                Check status
              </Button>
            </div>
          ) : (
            <FormError error={queue.error} />
          )}
          {!review.isPending && (queue.isError || !r) && !unsure && (
            <Button type="button" variant="outline" className="w-fit" onClick={() => (queue.reset(), check())}>
              Review again
            </Button>
          )}
        </div>
      </section>
      <Footer
        left={back}
        status={status}
        reason={reason}
        reasonId="send-reason"
        primary={
          <Button type="button" disabled={!!reason || queue.isPending || unsure} aria-describedby={reason ? 'send-reason' : undefined} onClick={send}>
            {queue.isPending ? <Spinner /> : <Send aria-hidden strokeWidth={1.5} />}
            Queue announcement
          </Button>
        }
      />
    </>
  );
}

function Row({ label, action, children }: { label: string; action?: ReactNode; children: ReactNode }) {
  return (
    <div className="grid gap-1 py-3 sm:grid-cols-[12rem_minmax(0,1fr)_auto] sm:items-baseline sm:gap-4">
      <dt className="font-semibold">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
      {action && <dd>{action}</dd>}
    </div>
  );
}

const LinkButton = ({ onClick, children }: { onClick: () => void; children: ReactNode }) => (
  <button type="button" onClick={onClick} className={cn(linkClass, 'text-[15px]')}>
    {children}
  </button>
);

function Chip({ icon: Icon, label, children }: { icon: LucideIcon; label: string; children: ReactNode }) {
  return (
    <li className="inline-flex items-center gap-1.5 rounded-full border border-border bg-primary-soft px-3 py-1 text-sm text-foreground-secondary">
      <Icon aria-hidden strokeWidth={1.5} className="size-4" />
      <span className="sr-only">{label}: </span>
      {children}
    </li>
  );
}
