'use client';

import { ArrowRight, type LucideIcon, Layers, ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import { Panel } from '@/components/admin/admin-ui';
import { PageHeader } from '@/components/shared/page-header';
import { QueryView } from '@/components/shared/states';
import { useAdminDashboard } from '@/hooks/use-admin';
import { cn } from '@/lib/utils';

/**
 * Only the numbers GET /admin/dashboard returns: no charts, trends, revenue or
 * message statistics (none exist in the API). What needs a person comes first.
 */
export function AdminOverview() {
  const dashboard = useAdminDashboard();
  return (
    <>
      <PageHeader eyebrow="Admin Portal" title="Overview" description="What needs attention, then the platform at a glance." />
      <QueryView query={dashboard} loadingLabel="Loading the overview">
        {(d) => {
          const failed = d.queues.failed;
          return (
            <div className="grid gap-10">
              <section aria-labelledby="attention-heading" className="grid gap-4">
                <h2 id="attention-heading" className="eyebrow font-sans">
                  Needs attention
                </h2>
                <div className="grid gap-4 md:grid-cols-2">
                  <AttentionCard
                    icon={ShieldCheck}
                    href="/admin/death-verifications?status=READY_FOR_REVIEW"
                    value={d.deathVerification.readyForReview}
                    label="Death verification cases ready for review"
                    action="Review cases"
                  />
                  <AttentionCard
                    icon={Layers}
                    href="/admin/system/queues"
                    value={failed}
                    label="Failed background jobs"
                    action="Open queues"
                    unavailable="Queue data is unavailable right now."
                  />
                </div>
              </section>

              <div className="grid gap-6 lg:grid-cols-2">
                <Panel title="Accounts">
                  <Stats
                    items={[
                      ['Total', d.users.total, '/admin/users'],
                      ['Active', d.users.active, '/admin/users?status=ACTIVE'],
                      ['Suspended', d.users.suspended, '/admin/users?status=SUSPENDED'],
                      ['Passed', d.users.passed, '/admin/users?status=PASSED'],
                      ['Deleted', d.users.deleted, '/admin/users?status=DELETED'],
                    ]}
                  />
                </Panel>
                <Panel title="Open death verification cases">
                  <Stats
                    items={[
                      ['Pending verification', d.deathVerification.pending, '/admin/death-verifications?status=PENDING_VERIFICATION'],
                      ['Safeguard active', d.deathVerification.safeguardActive, '/admin/death-verifications?status=SAFEGUARD_ACTIVE'],
                      ['Ready for review', d.deathVerification.readyForReview, '/admin/death-verifications?status=READY_FOR_REVIEW'],
                    ]}
                  />
                </Panel>
              </div>
            </div>
          );
        }}
      </QueryView>
    </>
  );
}

function AttentionCard({
  icon: Icon,
  href,
  value,
  label,
  action,
  unavailable,
}: {
  icon: LucideIcon;
  href: string;
  value: number | null;
  label: string;
  action: string;
  unavailable?: string;
}) {
  const urgent = !!value;
  return (
    <Link
      href={href}
      className={cn(
        'group flex flex-col gap-4 rounded-xl border p-6 outline-none transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
        urgent ? 'border-primary/40 bg-primary-soft hover:border-primary' : 'border-border bg-surface hover:border-border-strong',
      )}
    >
      <Icon aria-hidden strokeWidth={1.5} className="size-5 text-primary" />
      <div className="grid gap-1">
        <p className="font-heading text-5xl leading-none tabular-nums">{value ?? '—'}</p>
        <p className="text-[15px] text-foreground-secondary">{label}</p>
        {value === null && unavailable && <p className="text-sm text-warning">{unavailable}</p>}
      </div>
      <span className="mt-auto inline-flex items-center gap-2 text-sm font-medium text-primary">
        {action}
        <ArrowRight aria-hidden strokeWidth={1.5} className="size-4 transition-transform group-hover:translate-x-0.5" />
      </span>
    </Link>
  );
}

function Stats({ items }: { items: [string, number, string][] }) {
  return (
    <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
      {items.map(([label, value, href]) => (
        <li key={label}>
          <Link
            href={href}
            className="flex h-full flex-col gap-2 rounded-lg border border-border p-4 outline-none hover:border-border-strong focus-visible:outline-2 focus-visible:outline-ring"
          >
            <span className="font-heading text-3xl leading-none tabular-nums">{value.toLocaleString('en-AU')}</span>
            <span className="text-sm text-foreground-muted">{label}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
