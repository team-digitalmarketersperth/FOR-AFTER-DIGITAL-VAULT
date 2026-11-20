"use client";

import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  CreditCard,
  ExternalLink,
  Info,
  Lock,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Badge } from "@/components/admin/admin-ui";
import { FormError } from "@/components/shared/form-field";
import { PageHeader } from "@/components/shared/page-header";
import { QueryView, Spinner } from "@/components/shared/states";
import { Button } from "@/components/ui/button";
import {
  useBilling,
  useBillingRedirect,
  useStartTrial,
} from "@/hooks/use-billing";
import { useStorageUsage } from "@/hooks/use-media";
import { assistantApi, type AssistantUsage } from "@/lib/api/assistant";
import type {
  BillingStatus,
  CheckoutOption,
  PaidTier,
  PlanKey,
} from "@/lib/api/billing";
import type { ApiError } from "@/lib/api/errors";
import {
  ACCESS_LABEL,
  ACCESS_TONE,
  planLabel,
  TIER_LABEL,
} from "@/lib/billing";
import {
  decimalLimit,
  formatBytes,
} from "@/lib/format";
import { plansUrl } from "@/lib/env";
import { queryKeys } from "@/lib/query/query-client";
import { cn } from "@/lib/utils";

const PAID = ["paid_active", "cancellation_scheduled", "payment_issue"];
// Updated Plans Step 7: states that already hold a subscription. No second one is offered from here (tier switching and
// proration aren't built; the API also refuses a second Checkout).
const HOLDS_SUBSCRIPTION = [...PAID, "payment_pending", "plan_unresolved"];
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

// Step 7 refinement 2: one concise instant, e.g. "26 Nov 2026, 12:41 pm (UTC+5:30)", in the viewer's timezone with its
// offset (unambiguous, never a long zone name repeated per date).
const when = (iso: string) => {
  const parts = new Intl.DateTimeFormat("en-AU", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "shortOffset",
  }).formatToParts(new Date(iso));
  const zone = parts.find((p) => p.type === "timeZoneName")?.value ?? "";
  const text = parts
    .filter((p) => p.type !== "timeZoneName")
    .map((p) => p.value)
    .join("")
    .trim();
  const offset = zone.replace(/^GMT/, "UTC");
  return `${text} (${offset === "UTC" ? "UTC+0" : offset})`;
};
const utcDay = (iso: string) =>
  new Date(iso).toLocaleDateString("en-AU", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });

const Note = ({
  tone,
  children,
}: {
  tone: "info" | "warning" | "done";
  children: ReactNode;
}) => {
  const Icon =
    tone === "warning" ? AlertTriangle : tone === "done" ? CheckCircle2 : Info;
  const cls =
    tone === "warning"
      ? "bg-warning/10 text-warning"
      : tone === "done"
        ? "bg-success/10 text-success"
        : "bg-primary-soft text-foreground-secondary";
  return (
    <p
      role="status"
      className={`flex items-start gap-2 rounded-lg px-4 py-3 text-[15px] ${cls}`}
    >
      <Icon aria-hidden strokeWidth={1.5} className="mt-0.5 size-4 shrink-0" />
      <span>{children}</span>
    </p>
  );
};

const Section = ({
  id,
  title,
  description,
  children,
}: {
  id: string;
  title: string;
  description?: string;
  children: ReactNode;
}) => (
  <section aria-labelledby={id} className="grid gap-5">
    <div className="grid gap-1">
      <h2 id={id} className="font-heading text-[28px] leading-tight">
        {title}
      </h2>
      {description && (
        <p className="max-w-2xl text-[15px] text-foreground-muted">
          {description}
        </p>
      )}
    </div>
    {children}
  </section>
);

/**
 * Settings → Plan (Updated Plans Step 7–8): the account summary, what it is using, and its management actions
 * (buying is on /settings/plan/choose; pricing lives on the marketing site). Shows the server’s state only. After
 * checkout it waits for the verified webhook (bounded checks), never assuming success from the URL.
 */
export function PlanPage({ checkout }: { checkout?: "success" | "cancelled" }) {
  const [tries, setTries] = useState(0);
  const confirming = checkout === "success" && tries < CONFIRM_TRIES;
  const query = useBilling(false);
  const paid = !!query.data && PAID.includes(query.data.state);
  // Step 6: an unresolved subscription has arrived too (its own note explains it), so stop checking.
  const unresolved = query.data?.state === "plan_unresolved";
  // Bounded re-checks while the webhook may still be on its way.
  useEffect(() => {
    if (!confirming || paid || unresolved) return;
    const t = setTimeout(() => {
      setTries((n) => n + 1);
      void query.refetch();
    }, 3000);
    return () => clearTimeout(t);
  }, [confirming, paid, unresolved, tries, query]);
  return (
    <>
      <PageHeader
        back={{ href: "/settings", label: "Account settings" }}
        eyebrow="Account"
        title="Your plan"
        description="Your plan, what you’re using, and how to manage it."
      />
      <QueryView query={query} loadingLabel="Loading your plan">
        {(b) => (
          <div className="grid max-w-5xl gap-12">
            {checkout === "success" &&
              !unresolved &&
              (paid ? (
                <Note tone="done">Your subscription is confirmed.</Note>
              ) : confirming ? (
                <Note tone="info">
                  <span className="inline-flex items-center gap-2">
                    <Spinner /> Confirming your subscription. This usually takes
                    a few seconds.
                  </span>
                </Note>
              ) : (
                <div className="grid gap-2">
                  <Note tone="warning">
                    We haven’t received confirmation yet. If you completed
                    payment, check again in a moment.
                  </Note>
                  <Button
                    variant="outline"
                    className="w-fit"
                    onClick={() => void query.refetch()}
                    disabled={query.isFetching}
                  >
                    {query.isFetching && <Spinner />}
                    Refresh
                  </Button>
                </div>
              ))}
            {checkout === "cancelled" && !paid && (
              <Note tone="info">
                Checkout was cancelled. Nothing was charged.
              </Note>
            )}
            <Current b={b} />
            <Usage b={b} />
          </div>
        )}
      </QueryView>
    </>
  );
}

// ─── A. Current account ──────────────────────────────────────────────────────────────────────────────────────────

/** The plan's name, from the tier the server says is in force (a stored tier never shows while it isn't). */
function planName(b: BillingStatus): { name: string; detail?: string } {
  const tier = b.productTier?.tier;
  if (!b.enabled || b.state === "no_billing_record")
    return { name: "Your current access" };
  if (tier === "FREE_TRIAL") return { name: "Free Trial" };
  if (tier === "PREMIUM" || tier === "COMPLETE") {
    const interval = b.productTier?.interval;
    return {
      name: TIER_LABEL[tier],
      detail:
        interval === "annual"
          ? "Billed annually"
          : interval === "monthly"
            ? "Billed monthly"
            : undefined,
    };
  }
  if (b.state === "trial_available") return { name: "No plan yet" };
  if (b.state === "trial_expired")
    return { name: "Free Trial", detail: "Ended" };
  // Legacy/unmapped, pending, ended and unresolved subscriptions: the existing wording, never a tier.
  return {
    name: "Subscription",
    detail:
      b.subscription?.plan && b.state !== "plan_unresolved"
        ? planLabel(b.subscription.plan)
        : undefined,
  };
}

function Current({ b }: { b: BillingStatus }) {
  const trial = useStartTrial();
  const portal = useBillingRedirect("portal");
  const once = useOnce();
  const { name, detail } = planName(b);
  return (
    <section
      aria-labelledby="current-plan"
      className="grid gap-5 rounded-xl border border-border bg-surface p-6 shadow-soft sm:p-8"
    >
      <h2 id="current-plan" className="sr-only">
        Current plan
      </h2>
      <dl className="grid gap-5 sm:grid-cols-2">
        <div className="grid gap-1">
          <dt className="text-sm text-foreground-muted">Plan</dt>
          <dd className="font-heading text-[28px] leading-tight">
            {name}
            {detail && (
              <span className="mt-1 block font-sans text-[15px] text-foreground-secondary">
                {detail}
              </span>
            )}
          </dd>
        </div>
        <div className="grid content-start gap-1">
          <dt className="text-sm text-foreground-muted">Access</dt>
          <dd>
            <Badge tone={ACCESS_TONE[b.state]}>{ACCESS_LABEL[b.state]}</Badge>
          </dd>
        </div>
        {b.trial &&
          (b.state === "trial_active" || b.state === "trial_expired") && (
            <div className="grid gap-0.5">
              <dt className="text-sm text-foreground-muted">
                {b.state === "trial_active" ? "Trial ends" : "Trial ended"}
              </dt>
              <dd className="text-[15px]">{when(b.trial.endsAt)}</dd>
            </div>
          )}
        {b.subscription?.currentPeriodEnd && PAID.includes(b.state) && (
          <div className="grid gap-0.5">
            <dt className="text-sm text-foreground-muted">
              {b.subscription.cancelAtPeriodEnd
                ? "Access ends"
                : b.state === "payment_issue"
                  ? "Paid until"
                  : "Renews"}
            </dt>
            <dd className="text-[15px]">
              {when(b.subscription.currentPeriodEnd)}
            </dd>
          </div>
        )}
      </dl>
      {!b.enabled ? (
        <p className="text-[15px] text-foreground-secondary">
          Plans and free trials aren’t available yet. Your account keeps its
          current access.
        </p>
      ) : b.state === "no_billing_record" ? (
        <p className="text-[15px] text-foreground-secondary">
          Your account isn’t on a plan and keeps its current access.
        </p>
      ) : b.state === "trial_available" && b.trialEligible ? (
        <div className="grid gap-3">
          <p className="text-[15px] text-foreground-secondary">
            Start a free 7-day trial. No card is needed, and nothing is charged
            when it ends.
          </p>
          <FormError error={trial.error} />
          <Button
            className="w-fit"
            disabled={trial.isPending}
            onClick={() =>
              once((done) => trial.mutate(undefined, { onSettled: done }))
            }
          >
            {trial.isPending && <Spinner />}
            Start free trial
          </Button>
        </div>
      ) : null}
      {b.state === "payment_issue" && (
        <Note tone="warning">
          Your last payment didn’t go through. Update your payment details to
          keep your plan.
        </Note>
      )}
      {b.state === "payment_pending" && (
        <Note tone="warning">Your payment hasn’t been confirmed yet.</Note>
      )}
      {b.state === "plan_unresolved" && (
        <Note tone="warning">
          We received your subscription but couldn’t match it to one of our
          plans, so creating and editing are paused until it’s sorted. Nothing
          you saved is affected.{" "}
          <Link href="/support/new" className="underline underline-offset-2">
            Contact support
          </Link>{" "}
          and we’ll put it right.
        </Note>
      )}
      {b.state === "cancellation_scheduled" && (
        <Note tone="info">
          Your plan won’t renew. You keep full access until the date above.
        </Note>
      )}
      {b.enforced && !b.hasAccess && b.state !== "plan_unresolved" && (
        <Note tone="warning">
          Choose a plan to keep adding and changing your messages, memories,
          story and wishes. You can still read everything you’ve saved, and
          nothing is deleted or released early.
          {purchase(b).tiers.length > 0 && (
            <>
              {" "}
              <Link
                href={CHOOSE_PLAN_HREF}
                className="font-medium underline underline-offset-2"
              >
                View plans
              </Link>
            </>
          )}
        </Note>
      )}
      <PlanActions b={b} />
      {b.canManageSubscription && (
        <div className="grid gap-2">
          <FormError error={portal.error} />
          <Button
            variant="outline"
            className="w-fit"
            disabled={portal.isPending}
            onClick={() =>
              once((done) => portal.mutate(undefined, { onSettled: done }))
            }
          >
            {portal.isPending ? (
              <Spinner />
            ) : (
              <CreditCard aria-hidden strokeWidth={1.5} />
            )}
            Manage billing
          </Button>
          <p className="text-sm text-foreground-muted">
            Opens Stripe’s secure billing page for this subscription.
          </p>
        </div>
      )}
    </section>
  );
}

// ─── B. Usage ────────────────────────────────────────────────────────────────────────────────────────────────────

type MeterProps = {
  label: string;
  /** The facts as text; always shown, so an over-limit value is never hidden by the capped bar. */
  value?: ReactNode;
  used?: number;
  max?: number | null;
  valueText?: string;
  note?: ReactNode;
  status?: "ready" | "loading" | "error";
  onRetry?: () => void;
};

/** One usage row: label, the facts in words, and (with a limit) a compact bar capped visually at 100%. */
function Meter({
  label,
  value,
  used,
  max,
  valueText,
  note,
  status = "ready",
  onRetry,
}: MeterProps) {
  const labelId = useId();
  const hasBar =
    status === "ready" &&
    used !== undefined &&
    typeof max === "number" &&
    max > 0;
  const over = hasBar && used! > max!;
  const pct = hasBar ? Math.min(100, (used! / max!) * 100) : 0;
  return (
    <li className="grid content-start gap-2 rounded-lg border border-border bg-surface p-5">
      <p id={labelId} className="text-sm font-medium text-foreground-secondary">
        {label}
      </p>
      {status === "loading" ? (
        <p role="status" className="text-[15px] text-foreground-muted">
          Loading…
        </p>
      ) : status === "error" ? (
        <div
          role="status"
          className="flex flex-wrap items-center gap-2 text-[15px] text-foreground-muted"
        >
          Not available right now.
          {onRetry && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={onRetry}
              aria-label={`Try loading ${label.toLowerCase()} again`}
            >
              Try again
            </Button>
          )}
        </div>
      ) : (
        <>
          <p className="text-[17px]">{value}</p>
          {hasBar && (
            <div
              role="progressbar"
              aria-labelledby={labelId}
              aria-valuemin={0}
              aria-valuemax={max!}
              aria-valuenow={Math.min(used!, max!)}
              aria-valuetext={valueText}
              className="h-1.5 overflow-hidden rounded-full bg-brand-lilac-grey"
            >
              <div
                className={cn(
                  "h-full rounded-full",
                  over || pct >= 100 ? "bg-warning" : "bg-primary",
                )}
                style={{ width: `${pct}%` }}
              />
            </div>
          )}
          {over && (
            <p className="text-sm text-warning">
              Above this allowance. Everything you’ve saved stays as it is;
              adding more is paused until you’re below it.
            </p>
          )}
          {note && <p className="text-sm text-foreground-muted">{note}</p>}
        </>
      )}
    </li>
  );
}

const queryStatus = (q: { isPending: boolean; isError: boolean }) =>
  q.isPending ? "loading" : q.isError ? "error" : "ready";

/** Every number here is the account's own, from the API (GET /billing, /users/me/storage, /assistant/usage). */
function Usage({ b }: { b: BillingStatus }) {
  const storage = useStorageUsage();
  const ai = useQuery<AssistantUsage, ApiError>({
    queryKey: queryKeys.assistantUsage,
    queryFn: ({ signal }) => assistantApi.usage(signal),
    staleTime: 0,
  });
  const people = b.people;
  const trialQuestions = b.trialCaps?.questions ?? null;
  const trialMemories = b.trialCaps?.memories ?? null;
  return (
    <Section
      id="usage"
      title="What you’re using"
      description="Anything above an allowance is kept; you can still view, download and remove it."
    >
      <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {(() => {
          const u = storage.data;
          const used = u ? u.usedBytes + u.reservedBytes : undefined;
          const text = u
            ? `${formatBytes(used!, decimalLimit(u.limitBytes))} of ${formatBytes(u.limitBytes, decimalLimit(u.limitBytes))} used`
            : "";
          return (
            <Meter
              label="Storage"
              status={queryStatus(storage)}
              onRetry={() => void storage.refetch()}
              value={text}
              valueText={text}
              used={used}
              max={u?.limitBytes}
              note="Shared across your whole account. Storage doesn’t reset each month."
            />
          );
        })()}
        {people ? (
          <Meter
            label="People I Love"
            value={
              people.recipients.limit === null
                ? `${people.recipients.used} added`
                : `${people.recipients.used} of ${people.recipients.limit}`
            }
            valueText={
              people.recipients.limit === null
                ? undefined
                : `${people.recipients.used} of ${people.recipients.limit} people`
            }
            used={people.recipients.used}
            max={people.recipients.limit}
            note={
              people.recipients.limit === null
                ? // No count limit, but no write access either (ended, pending, unresolved): say what adding needs.
                  b.enabled && b.enforced && !b.hasAccess
                  ? "Adding people needs an active plan. Everyone here stays as they are."
                  : "Your account has no set limit on people."
                : undefined
            }
          />
        ) : (
          <Meter label="People I Love" status="error" />
        )}
        {people ? (
          <Meter
            label="Trusted contacts"
            value={`${people.trustedContacts.used} of ${people.trustedContacts.limit}`}
            valueText={`${people.trustedContacts.used} of ${people.trustedContacts.limit} trusted contacts`}
            used={people.trustedContacts.used}
            max={people.trustedContacts.limit}
            note={
              people.trustedContacts.limitSource === "maximum"
                ? "Up to two on every plan."
                : undefined
            }
          />
        ) : (
          <Meter label="Trusted contacts" status="error" />
        )}
        <Meter
          label="AI writing help"
          status={queryStatus(ai)}
          onRetry={() => void ai.refetch()}
          {...aiMeter(ai.data)}
        />
        {trialQuestions !== null && b.questionsAnswered !== undefined && (
          <Meter
            label="Questions answered (free trial)"
            value={`${b.questionsAnswered} of ${trialQuestions}`}
            valueText={`${b.questionsAnswered} of ${trialQuestions} questions answered`}
            used={b.questionsAnswered}
            max={trialQuestions}
            note="My Story and My Wishes together."
          />
        )}
        {trialMemories !== null && b.memoriesSaved !== undefined && (
          <Meter
            label="Memory Vault (free trial)"
            value={`${b.memoriesSaved} of ${trialMemories}`}
            valueText={`${b.memoriesSaved} of ${trialMemories} memories saved`}
            used={b.memoriesSaved}
            max={trialMemories}
            note="One written memory during the trial."
          />
        )}
      </ul>
    </Section>
  );
}

function aiMeter(u: AssistantUsage | undefined): Partial<MeterProps> {
  if (!u) return {};
  if (!u.metered) {
    // Never "unlimited": unmetered accounts keep the existing hourly limits.
    return {
      value:
        u.reason === "no_access"
          ? "Available again with an active plan"
          : "Not counted on your account",
    };
  }
  const text = `${u.used} of ${u.allowance} replies used`;
  return {
    value: text,
    valueText: text,
    used: u.used,
    max: u.allowance,
    note:
      u.kind === "trial"
        ? "For your whole free trial."
        : `Resets on ${utcDay(u.resetsAt ?? u.periodEndsAt)} (UTC). Annual plans reset monthly too.`,
  };
}

// ─── C. Buying a plan ────────────────────────────────────────────────────────────────────────────────────────────
// Step 8: Settings → Plan only manages the account; buying lives on its own authenticated route (/settings/plan/choose).
// Pricing and feature comparison belong on the marketing site (NEXT_PUBLIC_PLANS_URL, external, optional).

export const CHOOSE_PLAN_HREF = "/settings/plan/choose";
const PAID_TIERS: PaidTier[] = ["PREMIUM", "COMPLETE"];
const INTERVALS: PlanKey[] = ["monthly", "annual"];
const INTERVAL_LABEL: Record<PlanKey, string> = {
  monthly: "Monthly",
  annual: "Annual",
};

/** What this account may do about buying, from the server's state only. */
function purchase(b: BillingStatus) {
  const options = b.checkoutOptions ?? [];
  // No second subscription and no tier switching (not built); the API also refuses a second Checkout.
  const holds = HOLDS_SUBSCRIPTION.includes(b.state);
  const tiers =
    b.enabled && !holds
      ? PAID_TIERS.filter((t) => options.some((o) => o.tier === t))
      : [];
  // Step 6: nothing can be bought (Stripe or prices not configured) and no access: say so plainly.
  const cantBuy = b.enabled && !b.hasAccess && !holds && options.length === 0;
  return { options, holds, tiers, cantBuy };
}

const CantBuy = () => (
  <Note tone="info">
    Plans can’t be bought online just yet. Your saved content is unaffected: you
    can still view, download and delete it.{" "}
    <Link href="/support/new" className="underline underline-offset-2">
      Contact support
    </Link>{" "}
    if you need help.
  </Note>
);

/**
 * Settings → Plan, inside the summary: the internal way to the purchase route and, when configured, one small external
 * "Compare plans" link. Only for accounts that can buy now: never for subscribers (no tier switching) or unresolved
 * accounts (support first). A locked account's notice already says "View plans", so it gets no second button.
 */
function PlanActions({ b }: { b: BillingStatus }) {
  const { tiers, cantBuy } = purchase(b);
  if (cantBuy) return <CantBuy />;
  if (!tiers.length) return null;
  const locked = b.enforced && !b.hasAccess;
  // A plain marketing URL: nothing about the account is ever added to it.
  const url = plansUrl();
  if (locked && !url) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
      {!locked && (
        <Button asChild className="w-fit">
          <Link href={CHOOSE_PLAN_HREF}>Choose a plan</Link>
        </Button>
      )}
      {url && (
        <a
          href={url}
          className="inline-flex items-center gap-1 text-[15px] font-medium text-primary underline underline-offset-2"
        >
          Compare plans
          <ExternalLink aria-hidden strokeWidth={1.5} className="size-4" />
        </a>
      )}
    </div>
  );
}

/** /settings/plan/choose: the app's one authenticated Checkout entry, offering only what Stripe is configured to sell. */
export function ChoosePlanPage() {
  const query = useBilling(false);
  return (
    <>
      <PageHeader
        back={{ href: "/settings/plan", label: "Your plan" }}
        eyebrow="Account"
        title="Choose a plan"
        description="Prices are shown on Stripe’s secure checkout page before you pay."
      />
      <QueryView query={query} loadingLabel="Loading plans">
        {(b) => (
          <div className="grid max-w-5xl gap-8">
            <ChooseBody b={b} />
          </div>
        )}
      </QueryView>
    </>
  );
}

function ChooseBody({ b }: { b: BillingStatus }) {
  const checkout = useBillingRedirect("checkout");
  const { options, holds, tiers, cantBuy } = purchase(b);
  const url = b.enabled ? plansUrl() : null;
  if (!b.enabled)
    return (
      <Note tone="info">
        Plans aren’t available yet. Your account keeps its current access.
      </Note>
    );
  // Step 6: an unresolved subscription is sorted by support, never by buying again.
  if (b.state === "plan_unresolved")
    return (
      <Note tone="warning">
        We received your subscription but couldn’t match it to one of our plans.{" "}
        <Link href="/support/new" className="underline underline-offset-2">
          Contact support
        </Link>{" "}
        and we’ll put it right.
      </Note>
    );
  if (holds)
    return (
      <Note tone="info">
        You already have a subscription, so there’s nothing to buy here.
        Changing plans isn’t available online yet.{" "}
        <Link href="/support/new" className="underline underline-offset-2">
          Contact support
        </Link>{" "}
        if you’d like to talk about it.
      </Note>
    );
  if (cantBuy) return <CantBuy />;
  if (!tiers.length)
    return <Note tone="info">Plans can’t be bought online just yet.</Note>;
  return (
    <>
      <FormError error={checkout.error} />
      <ul className="grid gap-5 sm:grid-cols-2">
        {tiers.map((tier) => (
          <li
            key={tier}
            className="grid content-start gap-4 rounded-xl border border-border bg-surface p-6"
          >
            <h2 className="font-heading text-[26px] leading-tight">
              {TIER_LABEL[tier]}
            </h2>
            <TierCheckout tier={tier} options={options} checkout={checkout} />
          </li>
        ))}
      </ul>
      {url && (
        <p className="text-[15px] text-foreground-secondary">
          Want to see what each plan includes?{" "}
          <a
            href={url}
            className="inline-flex items-center gap-1 font-medium text-primary underline underline-offset-2"
          >
            Compare plans on our website
            <ExternalLink aria-hidden strokeWidth={1.5} className="size-4" />
          </a>
        </p>
      )}
    </>
  );
}

/** Interval choice (configured intervals only) and the Checkout button for one tier that is on sale. */
function TierCheckout({
  tier,
  options,
  checkout,
}: {
  tier: PaidTier;
  options: CheckoutOption[];
  checkout: ReturnType<typeof useBillingRedirect>;
}) {
  const offered = INTERVALS.filter((i) =>
    options.some((o) => o.tier === tier && o.interval === i),
  );
  const [picked, setPicked] = useState<PlanKey | null>(offered[0] ?? null);
  const once = useOnce();
  const name = useId();
  const chosen = picked && offered.includes(picked) ? picked : offered[0]!;
  const pending = checkout.isPending && checkout.variables?.tier === tier;
  return (
    <div className="grid gap-3">
      <fieldset className="grid gap-2">
        <legend className="mb-1 text-sm font-medium text-foreground-secondary">
          Billing
        </legend>
        <div className="flex flex-wrap gap-2">
          {INTERVALS.map((i) => {
            const available = offered.includes(i);
            return (
              <label
                key={i}
                className={cn(
                  "flex min-h-11 items-center gap-2 rounded-full border px-4 text-[15px] has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring",
                  !available
                    ? "cursor-not-allowed border-border text-foreground-muted"
                    : chosen === i
                      ? "cursor-pointer border-primary bg-primary-soft"
                      : "cursor-pointer border-border-strong",
                )}
              >
                <input
                  type="radio"
                  name={name}
                  value={i}
                  checked={available && chosen === i}
                  disabled={!available}
                  onChange={() => setPicked(i)}
                  className="size-4 accent-primary"
                />
                {INTERVAL_LABEL[i]}
                {!available && (
                  <span className="text-xs">(not available yet)</span>
                )}
              </label>
            );
          })}
        </div>
      </fieldset>
      <Button
        className="w-full sm:w-fit"
        disabled={checkout.isPending}
        onClick={() =>
          once((done) =>
            checkout.mutate({ tier, interval: chosen }, { onSettled: done }),
          )
        }
      >
        {pending ? <Spinner /> : <Lock aria-hidden strokeWidth={1.5} />}
        Continue to secure checkout
      </Button>
      <p className="text-xs text-foreground-muted">
        {TIER_LABEL[tier]}, billed {chosen === "annual" ? "annually" : "monthly"}.
        Your plan starts once payment is confirmed.
      </p>
    </div>
  );
}

/** Account settings: a compact link to the plan page (only once billing is switched on). */
export function PlanSummary() {
  const query = useBilling(false);
  if (!query.data?.enabled) return null;
  return (
    <section
      aria-labelledby="plan-heading"
      className="mt-16 border-t border-border pt-12 lg:mt-20 lg:pt-14"
    >
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-border bg-surface p-6">
        <div className="grid gap-1">
          <h2 id="plan-heading" className="text-[32px] leading-tight">
            Plan
          </h2>
          <Badge tone={ACCESS_TONE[query.data.state]}>
            {ACCESS_LABEL[query.data.state]}
          </Badge>
        </div>
        <Button asChild variant="outline">
          <Link href="/settings/plan">View your plan</Link>
        </Button>
      </div>
    </section>
  );
}
