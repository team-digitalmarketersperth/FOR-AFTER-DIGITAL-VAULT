'use client';

import { AlertTriangle, CheckCircle2, Clock, CreditCard, Info } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { Badge } from '@/components/admin/admin-ui';
import { FormError } from '@/components/shared/form-field';
import { PageHeader } from '@/components/shared/page-header';
import { QueryView, Spinner } from '@/components/shared/states';
import { Button } from '@/components/ui/button';
import { useBilling, useBillingRedirect, useStartTrial } from '@/hooks/use-billing';
import type { BillingStatus } from '@/lib/api/billing';
import { ACCESS_LABEL, ACCESS_TONE, PLAN_LABEL, planLabel } from '@/lib/billing';
import { formatDateTime, timeZoneLabel } from '@/lib/format';

const PAID = ['paid_active', 'cancellation_scheduled', 'payment_issue'];
const CONFIRM_TRIES = 10; // ~30 s of checks after returning from checkout, then a Refresh button

// Ignores a second click before the first request has even re-rendered the button.
function useOnce() {
  const busy = useRef(false);
  return (run: (done: () => void) => void) => {
    if (busy.current) return;
    busy.current = true;
    run(() => (busy.current = false));
  };
}

const when = (iso: string) => `${formatDateTime(iso)} (${timeZoneLabel(new Date(iso))})`;

const Note = ({ tone, children }: { tone: 'info' | 'warning' | 'done'; children: React.ReactNode }) => {
  const Icon = tone === 'warning' ? AlertTriangle : tone === 'done' ? CheckCircle2 : Info;
  const cls = tone === 'warning' ? 'bg-warning/10 text-warning' : tone === 'done' ? 'bg-success/10 text-success' : 'bg-primary-soft text-foreground-secondary';
  return (
    <p role="status" className={`flex items-start gap-2 rounded-lg px-4 py-3 text-[15px] ${cls}`}>
      <Icon aria-hidden strokeWidth={1.5} className="mt-0.5 size-4 shrink-0" />
      <span>{children}</span>
    </p>
  );
};

/**
 * Settings → Plan. Shows the server's state only. After checkout it waits for
 * the verified webhook (bounded checks), never assuming success from the URL.
 */
export function PlanPage({ checkout }: { checkout?: 'success' | 'cancelled' }) {
  const [tries, setTries] = useState(0);
  const confirming = checkout === 'success' && tries < CONFIRM_TRIES;
  const query = useBilling(false);
  const paid = !!query.data && PAID.includes(query.data.state);
  // Bounded re-checks while the webhook may still be on its way.
  useEffect(() => {
    if (!confirming || paid) return;
    const t = setTimeout(() => {
      setTries((n) => n + 1);
      void query.refetch();
    }, 3000);
    return () => clearTimeout(t);
  }, [confirming, paid, tries, query]);
  return (
    <>
      <PageHeader
        back={{ href: '/settings', label: 'Account settings' }}
        eyebrow="Account"
        title="Your plan"
        description="Your free trial or subscription, and what it gives you access to."
      />
      <QueryView query={query} loadingLabel="Loading your plan">
        {(b) => (
          <div className="grid max-w-3xl gap-6">
            {checkout === 'success' &&
              (paid ? (
                <Note tone="done">Your subscription is confirmed.</Note>
              ) : confirming ? (
                <Note tone="info">
                  <span className="inline-flex items-center gap-2">
                    <Spinner /> Confirming your subscription. This usually takes a few seconds.
                  </span>
                </Note>
              ) : (
                <div className="grid gap-2">
                  <Note tone="warning">We haven’t received confirmation yet. If you completed payment, check again in a moment.</Note>
                  <Button variant="outline" className="w-fit" onClick={() => void query.refetch()} disabled={query.isFetching}>
                    {query.isFetching && <Spinner />}
                    Refresh
                  </Button>
                </div>
              ))}
            {checkout === 'cancelled' && !paid && <Note tone="info">Checkout was cancelled. Nothing was charged.</Note>}
            <Current b={b} />
            <Choose b={b} />
          </div>
        )}
      </QueryView>
    </>
  );
}

function Current({ b }: { b: BillingStatus }) {
  const trial = useStartTrial();
  const portal = useBillingRedirect('portal');
  const once = useOnce();
  return (
    <section aria-labelledby="current-plan" className="grid gap-4 rounded-xl border border-border bg-surface p-6 shadow-soft">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="current-plan" className="font-heading text-2xl">
          Current plan
        </h2>
        <Badge tone={ACCESS_TONE[b.state]}>{ACCESS_LABEL[b.state]}</Badge>
      </div>
      {!b.enabled ? (
        <p className="text-[15px] text-foreground-secondary">Plans and free trials aren’t available yet. Your account keeps its current access.</p>
      ) : b.state === 'no_billing_record' ? (
        <p className="text-[15px] text-foreground-secondary">Your account isn’t on a plan and keeps its current access.</p>
      ) : b.state === 'trial_available' ? (
        <div className="grid gap-3">
          <p className="text-[15px] text-foreground-secondary">
            Start a free 7-day trial. No card is needed, and nothing is charged when it ends.
          </p>
          <FormError error={trial.error} />
          <Button className="w-fit" disabled={trial.isPending} onClick={() => once((done) => trial.mutate(undefined, { onSettled: done }))}>
            {trial.isPending && <Spinner />}
            Start free trial
          </Button>
        </div>
      ) : (
        <dl className="grid gap-3 text-[15px]">
          {b.trial && (
            <div className="grid gap-0.5">
              <dt className="text-sm text-foreground-muted">Free trial</dt>
              <dd>
                {when(b.trial.startedAt)} to {when(b.trial.endsAt)}
              </dd>
            </div>
          )}
          {b.subscription && (
            <>
              <div className="grid gap-0.5">
                <dt className="text-sm text-foreground-muted">Subscription</dt>
                <dd>{planLabel(b.subscription.plan)}</dd>
              </div>
              {b.subscription.currentPeriodEnd && PAID.includes(b.state) && (
                <div className="grid gap-0.5">
                  <dt className="text-sm text-foreground-muted">
                    {b.subscription.cancelAtPeriodEnd ? 'Access ends' : b.state === 'payment_issue' ? 'Paid until' : 'Renews'}
                  </dt>
                  <dd>{when(b.subscription.currentPeriodEnd)}</dd>
                </div>
              )}
            </>
          )}
        </dl>
      )}
      {b.state === 'payment_issue' && <Note tone="warning">Your last payment didn’t go through. Update your payment details to keep your plan.</Note>}
      {b.state === 'payment_pending' && <Note tone="warning">Your payment hasn’t been confirmed yet.</Note>}
      {b.state === 'cancellation_scheduled' && <Note tone="info">Your plan won’t renew. You keep full access until the date above.</Note>}
      {b.enforced && !b.hasAccess && (
        <Note tone="warning">
          Choose a plan to keep adding and changing your messages, memories, story and wishes. You can still read everything you’ve
          saved, and nothing is deleted or released early.
        </Note>
      )}
      {b.canManageSubscription && (
        <div className="grid gap-2">
          <FormError error={portal.error} />
          <Button variant="outline" className="w-fit" disabled={portal.isPending} onClick={() => once((done) => portal.mutate(undefined, { onSettled: done }))}>
            {portal.isPending ? <Spinner /> : <CreditCard aria-hidden strokeWidth={1.5} />}
            Manage subscription
          </Button>
        </div>
      )}
    </section>
  );
}

function Choose({ b }: { b: BillingStatus }) {
  const checkout = useBillingRedirect('checkout');
  const once = useOnce();
  if (!b.enabled || PAID.includes(b.state) || b.plans.length === 0) return null;
  return (
    <section aria-labelledby="choose-plan" className="grid gap-4 rounded-xl border border-border bg-brand-ivory p-6">
      <h2 id="choose-plan" className="font-heading text-2xl">
        Choose a plan
      </h2>
      <p className="text-[15px] text-foreground-secondary">The price is shown on the secure checkout page before you pay.</p>
      <FormError error={checkout.error} />
      <div className="flex flex-wrap gap-3">
        {b.plans.map((p) => (
          <Button key={p} disabled={checkout.isPending} onClick={() => once((done) => checkout.mutate(p, { onSettled: done }))}>
            {checkout.isPending && checkout.variables === p ? <Spinner /> : <Clock aria-hidden strokeWidth={1.5} />}
            {PLAN_LABEL[p]} plan
          </Button>
        ))}
      </div>
    </section>
  );
}

/** Account settings: a compact link to the plan page (only once billing is switched on). */
export function PlanSummary() {
  const query = useBilling(false);
  if (!query.data?.enabled) return null;
  return (
    <section aria-labelledby="plan-heading" className="mt-16 border-t border-border pt-12 lg:mt-20 lg:pt-14">
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-border bg-surface p-6">
        <div className="grid gap-1">
          <h2 id="plan-heading" className="text-[32px] leading-tight">
            Plan
          </h2>
          <Badge tone={ACCESS_TONE[query.data.state]}>{ACCESS_LABEL[query.data.state]}</Badge>
        </div>
        <Button asChild variant="outline">
          <Link href="/settings/plan">View your plan</Link>
        </Button>
      </div>
    </section>
  );
}
