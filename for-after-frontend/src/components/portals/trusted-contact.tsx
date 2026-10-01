'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { ChevronRight, FileText, Info, ShieldCheck, Users } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useForm, useWatch } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
import { OtpSignIn, WrongPlaceNote } from '@/components/portals/otp-sign-in';
import { FormError, TextAreaField, TextField } from '@/components/shared/form-field';
import { PageHeader } from '@/components/shared/page-header';
import { EmptyState, ListSkeleton, QueryView, Spinner } from '@/components/shared/states';
import { Button } from '@/components/ui/button';
import { useCaseStatus, useDeathReport, useTrustedAccounts } from '@/hooks/use-portals';
import { useUnsavedChanges } from '@/hooks/use-unsaved-changes';
import { OPEN_CASE_STATUSES, REPORT_NOTE_MAX, type CaseStatus, type TrustedAccount } from '@/lib/api/portals';
import { reporterStatus } from '@/lib/death-verification';
import { formatCalendarDate, formatDate } from '@/lib/format';
import { cn } from '@/lib/utils';

export function TrustedContactSignIn() {
  return (
    <div className="grid gap-8">
      <OtpSignIn
        portal="trusted-contact"
        intro={
          <div className="grid gap-3">
            <p className="eyebrow">Trusted contact access</p>
            <h1 className="text-[40px] leading-[1.05]">
              For <em>trusted contacts</em>
            </h1>
            <p className="text-foreground-muted">
              Someone named you as a trusted contact on For After. Enter your email address and we&apos;ll email you a
              6-digit code, with no password or account needed.
            </p>
          </div>
        }
      />
      <WrongPlaceNote />
    </div>
  );
}

/** Report ≠ verification ≠ release: said plainly, every time it matters. */
export function RoleNote({ name }: { name?: string }) {
  return (
    <aside className="flex gap-4 rounded-xl bg-primary-soft p-6">
      <ShieldCheck aria-hidden strokeWidth={1.5} className="mt-0.5 size-5 shrink-0 text-primary" />
      <p className="text-[15px] leading-relaxed text-foreground-secondary">
        As a trusted contact you can let For After know if {name ?? 'someone who chose you'} has passed away. Your
        report starts a verification process: you don&apos;t confirm the death yourself, and a report never releases any
        messages. Only the For After team can verify a death.
      </p>
    </aside>
  );
}

export function StatusPill({ status }: { status: CaseStatus | null }) {
  const s = reporterStatus(status);
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-3 py-1 text-xs font-medium',
        s.tone === 'open' && 'bg-primary-soft text-primary',
        s.tone === 'closed' && 'border border-border bg-surface-muted text-foreground-secondary',
        s.tone === 'done' && 'bg-success/10 text-success',
      )}
    >
      {s.label}
    </span>
  );
}

export function AccountList() {
  const list = useTrustedAccounts();
  return (
    <>
      <PageHeader title={<>Accounts that <em>trust you</em></>} description="The people who named you as a trusted contact." />
      <div className="mb-8">
        <RoleNote />
      </div>
      <QueryView query={list} loadingLabel="Loading accounts">
        {(accounts) =>
          accounts.length === 0 ? (
            <EmptyState icon={Users} title="There aren't any accounts here right now" />
          ) : (
            <ul className="grid gap-3">
              {accounts.map((a) => (
                <li key={a.trustedContactId}>
                  <Link
                    href={`/trusted-contact/accounts/${a.trustedContactId}`}
                    className="flex items-center gap-4 rounded-lg border border-border bg-surface p-5 outline-none transition-colors hover:border-border-strong focus-visible:outline-2 focus-visible:outline-ring sm:p-6"
                  >
                    <span className="grid min-w-0 flex-1 gap-2">
                      <span className="font-heading text-2xl leading-tight break-words">{a.accountHolder.displayName}</span>
                      <span className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-foreground-muted">
                        {a.relationship && <span>{a.relationship}</span>}
                        <span>{a.hasPreservedContent ? 'Has preserved content' : 'No preserved content yet'}</span>
                        <StatusPill status={a.deathVerificationStatus} />
                      </span>
                    </span>
                    <ChevronRight aria-hidden strokeWidth={1.5} className="size-5 text-foreground-muted" />
                  </Link>
                </li>
              ))}
            </ul>
          )
        }
      </QueryView>
    </>
  );
}

const NOT_FOUND = { title: 'We couldn’t find this account', backHref: '/trusted-contact/accounts', backLabel: 'Back to accounts' };

/** The account from the signed-in contact's own list (there is no per-account GET). */
function useAccount(id: string) {
  const list = useTrustedAccounts();
  const account = list.data?.find((a) => a.trustedContactId === id);
  return { list, account };
}

/** Can this contact file a report now? Mirrors the API; its 409 stays authoritative. */
const canReport = (status: CaseStatus | null, reportedByYou: boolean) =>
  !reportedByYou && (status === null || OPEN_CASE_STATUSES.includes(status));

export function AccountStatus({ id }: { id: string }) {
  const { list, account } = useAccount(id);
  const status = useCaseStatus(id);
  return (
    <QueryView query={status} notFound={NOT_FOUND}>
      {(s) =>
        list.isPending ? (
          <ListSkeleton rows={2} />
        ) : !account ? (
          <EmptyState title={NOT_FOUND.title} action={<Button asChild variant="outline"><Link href={NOT_FOUND.backHref}>{NOT_FOUND.backLabel}</Link></Button>} />
        ) : (
          <>
            <PageHeader
              back={{ href: '/trusted-contact/accounts', label: 'Accounts' }}
              eyebrow={account.relationship ?? 'Trusted contact'}
              title={account.accountHolder.displayName}
            />
            <div className="grid gap-6">
              <section aria-labelledby="case-heading" className="grid gap-4 rounded-xl border border-border bg-surface p-6 sm:p-10">
                <p className="eyebrow">Verification status</p>
                <h2 id="case-heading" className="text-3xl">
                  {reporterStatus(s.status).label}
                </h2>
                <p className="text-foreground-secondary">{reporterStatus(s.status).description}</p>
                <dl className="flex flex-wrap gap-x-8 gap-y-2 text-sm text-foreground-muted">
                  {s.openedAt && (
                    <div className="flex gap-1.5">
                      <dt>Opened</dt>
                      <dd className="text-foreground-secondary">{formatDate(s.openedAt)}</dd>
                    </div>
                  )}
                  {s.reportedByYou && <dd className="text-foreground-secondary">You submitted a report for this account.</dd>}
                </dl>
                {canReport(s.status, s.reportedByYou) ? (
                  <div className="pt-2">
                    <Button asChild>
                      <Link href={`/trusted-contact/accounts/${id}/report`}>
                        <FileText aria-hidden strokeWidth={1.5} />
                        Submit a death report
                      </Link>
                    </Button>
                  </div>
                ) : (
                  !s.reportedByYou && (
                    <p className="text-sm text-foreground-muted">This account isn&apos;t accepting new reports.</p>
                  )
                )}
              </section>
              <RoleNote name={account.accountHolder.displayName} />
            </div>
          </>
        )
      }
    </QueryView>
  );
}

// Latest date allowed in the picker: today in this browser (the API allows
// "today" anywhere on Earth and rejects anything later).
const localToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const reportSchema = z.object({
  reportedDateOfDeath: z
    .string()
    .refine((v) => !v || /^\d{4}-\d{2}-\d{2}$/.test(v), 'Enter a valid date.')
    .refine((v) => !v || v <= localToday(), 'The date can’t be in the future.'),
  note: z.string().max(REPORT_NOTE_MAX, `The note must be ${REPORT_NOTE_MAX.toLocaleString('en-AU')} characters or fewer.`),
  confirmReport: z.boolean().refine((v) => v, 'Please confirm you understand before submitting.'),
});
type ReportValues = z.infer<typeof reportSchema>;

export function ReportForm({ id }: { id: string }) {
  const { list, account } = useAccount(id);
  const status = useCaseStatus(id);
  return (
    <QueryView query={status} notFound={NOT_FOUND}>
      {(s) =>
        list.isPending ? (
          <ListSkeleton rows={2} />
        ) : !account ? (
          <EmptyState title={NOT_FOUND.title} />
        ) : !canReport(s.status, s.reportedByYou) ? (
          <AlreadyHandled id={id} reportedByYou={s.reportedByYou} />
        ) : (
          <ReportFormBody account={account} />
        )
      }
    </QueryView>
  );
}

function AlreadyHandled({ id, reportedByYou, message }: { id: string; reportedByYou: boolean; message?: string }) {
  return (
    <section role="status" className="grid max-w-2xl gap-4 rounded-xl bg-primary-soft p-6 sm:p-8">
      <Info aria-hidden strokeWidth={1.5} className="size-5 text-primary" />
      <h1 className="text-3xl">
        {reportedByYou ? 'You’ve already submitted a report' : 'This account isn’t accepting new reports'}
      </h1>
      {message && <p className="text-foreground-secondary">{message}</p>}
      <div>
        <Button asChild variant="outline">
          <Link href={`/trusted-contact/accounts/${id}`}>See the status</Link>
        </Button>
      </div>
    </section>
  );
}

function ReportFormBody({ account }: { account: TrustedAccount }) {
  const router = useRouter();
  const id = account.trustedContactId;
  const report = useDeathReport(id);
  const form = useForm<ReportValues>({
    resolver: zodResolver(reportSchema),
    defaultValues: { reportedDateOfDeath: '', note: '', confirmReport: false },
  });
  const { errors, isDirty, isSubmitSuccessful } = form.formState;
  const [date, note] = useWatch({ control: form.control, name: ['reportedDateOfDeath', 'note'] });
  useUnsavedChanges(isDirty && !isSubmitSuccessful);

  // A 409 is an expected answer (already reported, or the case closed), not a failure.
  if (report.error?.kind === 'conflict') {
    return <AlreadyHandled id={id} reportedByYou={/already been submitted/i.test(report.error.message)} message={report.error.message} />;
  }

  return (
    <>
      <PageHeader
        back={{ href: `/trusted-contact/accounts/${id}`, label: account.accountHolder.displayName }}
        title={<>Submit a <em>death report</em></>}
        description="Please only submit a report if you believe this person has passed away."
      />
      <form
        noValidate
        onSubmit={form.handleSubmit(
          (v) =>
            !report.isPending &&
            report.mutate(
              {
                // Sent exactly as picked: a calendar date, never a timestamp.
                reportedDateOfDeath: v.reportedDateOfDeath || null,
                note: v.note.trim() ? v.note : null,
                confirmReport: true,
              },
              {
                onSuccess: () => {
                  toast.success('Your report has been submitted for verification');
                  router.push(`/trusted-contact/accounts/${id}`);
                },
              },
            ),
        )}
        className="grid max-w-2xl gap-8 rounded-xl border border-border bg-surface p-6 sm:p-10"
      >
        <FormError error={report.error} />
        <fieldset disabled={report.isPending} className="grid gap-6">
          <TextField
            id="reportedDateOfDeath"
            label="Date of death"
            type="date"
            optional
            max={localToday()}
            hint="If you know it. Leave it blank if you're not sure."
            className="sm:max-w-60"
            error={errors.reportedDateOfDeath?.message}
            {...form.register('reportedDateOfDeath')}
          />
          <TextAreaField
            id="note"
            label="Note for the For After team"
            optional
            hint="Anything that may help the team verify the report. Plain text."
            className="min-h-28"
            maxLength={REPORT_NOTE_MAX}
            length={note.length}
            error={errors.note?.message}
            {...form.register('note')}
          />

          <section aria-label="Summary" className="grid gap-2 rounded-lg bg-surface-muted p-5 text-[15px]">
            <p>
              <span className="text-foreground-muted">Account: </span>
              <span className="font-medium">{account.accountHolder.displayName}</span>
            </p>
            <p>
              <span className="text-foreground-muted">Date of death: </span>
              <span className="font-medium">{date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? formatCalendarDate(date) : 'Not provided'}</span>
            </p>
          </section>

          <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-border p-4 has-[:checked]:border-primary has-[:checked]:bg-primary-soft has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-ring">
            <input
              type="checkbox"
              className="mt-1 size-4 accent-primary"
              aria-invalid={errors.confirmReport ? true : undefined}
              aria-describedby={errors.confirmReport ? 'confirm-error' : undefined}
              {...form.register('confirmReport')}
            />
            <span className="text-[15px] leading-relaxed">
              I understand this submits a report for the For After team to verify. It does not confirm a death or
              release any messages.
            </span>
          </label>
          {errors.confirmReport && (
            <p id="confirm-error" className="-mt-4 text-sm text-danger">
              {errors.confirmReport.message}
            </p>
          )}
        </fieldset>
        <div>
          <Button type="submit" size="lg" disabled={report.isPending}>
            {report.isPending && <Spinner />}
            Submit report
          </Button>
        </div>
      </form>
    </>
  );
}
