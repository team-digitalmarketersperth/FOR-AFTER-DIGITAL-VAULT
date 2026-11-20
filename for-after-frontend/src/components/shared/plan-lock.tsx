'use client';

import { Lock, type LucideIcon } from 'lucide-react';
import Link from 'next/link';
import { useRef, type ComponentProps } from 'react';
import { ProDialog, type DialogAction } from '@/components/shared/trial-cap';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useBilling } from '@/hooks/use-billing';
import type { AccessState } from '@/lib/api/billing';

/**
 * Trial Step 6: no write access (billing on, the API says hasAccess false). Each state keeps its own accurate
 * explanation: only an ended trial says the trial has ended. UX only: the API refuses every gated write itself (402).
 */
type LockCopy = { title: string; description: string; action?: DialogAction };
export const PLAN_LOCK_COPY: Partial<Record<AccessState, LockCopy>> = {
  // Approved copy (Step 6), word for word.
  trial_expired: {
    title: 'Your free trial has ended',
    description: 'Choose a plan to keep creating and editing. You can still view, download and delete your existing content.',
  },
  trial_available: {
    title: 'Start your free trial',
    description: 'Start your free trial or choose a plan to create and edit. You can still view, download and delete anything already here.',
  },
  payment_pending: {
    title: 'Your payment hasn’t been confirmed yet',
    description: 'Creating and editing open once your payment is confirmed. You can still view, download and delete your existing content.',
  },
  // Updated Plans Step 6: paid, but the subscription's price matches no plan we offer; support resolves it.
  plan_unresolved: {
    title: 'We’re checking your plan',
    description: 'We received your subscription but couldn’t match it to a plan yet. Creating and editing open once it’s sorted; please contact support. You can still view, download and delete your existing content.',
    // Never "View plans": buying again would open a second subscription.
    action: { label: 'Contact support', href: '/support/new' },
  },
  access_ended: {
    title: 'Your plan has ended',
    description: 'Choose a plan to keep creating and editing. You can still view, download and delete your existing content.',
  },
};
const FALLBACK: LockCopy = {
  title: 'Your plan needs attention',
  description: 'Creating and editing need an active plan. You can still view, download and delete your existing content.',
};
export const planLockCopy = (state: AccessState | undefined) => (state && PLAN_LOCK_COPY[state]) || FALLBACK;

/**
 * Whether creating and editing are locked, from the API's own answer (GET /billing). Paid states (even with old trial
 * dates), billing off and grandfathered accounts have access: never locked. Unknown (loading or unreadable) is not
 * locked here; the shell says the plan couldn't be read and the API still refuses (402).
 */
export function usePlanLock() {
  const billing = useBilling(false);
  const d = billing.data;
  const locked = !!d && d.enabled && !d.hasAccess;
  return { locked, state: d?.state, copy: planLockCopy(d?.state), billing };
}

/** A create/edit control while locked: its own label, opening the shared plan dialog. Changes nothing. */
export function PlanLockedButton({
  label,
  icon: Icon = Lock,
  ...props
}: { label: string; icon?: LucideIcon } & Omit<ComponentProps<typeof Button>, 'children'>) {
  const { copy } = usePlanLock();
  return (
    <ProDialog
      trigger={
        <Button type="button" variant="outline" {...props}>
          <Icon aria-hidden strokeWidth={1.5} />
          {label}
        </Button>
      }
      {...copy}
    />
  );
}

/**
 * The same plan dialog, opened by the page (a blocked link, or opening a message). Focus returns to whatever had it
 * before, since there is no Radix trigger to return to.
 */
export function UpgradeDialog({
  open,
  onOpenChange,
  closeLabel = 'Close',
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  closeLabel?: string;
}) {
  const { copy } = usePlanLock();
  const opener = useRef<HTMLElement | null>(null);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="gap-6 rounded-xl bg-surface p-7 sm:max-w-md"
        showCloseButton={false}
        onOpenAutoFocus={() => {
          opener.current = document.activeElement as HTMLElement | null;
        }}
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          opener.current?.focus();
        }}
      >
        <DialogHeader className="gap-3">
          <DialogTitle className="text-[28px] leading-tight font-normal">{copy.title}</DialogTitle>
          <DialogDescription className="text-[15px] leading-relaxed text-foreground-muted">{copy.description}</DialogDescription>
        </DialogHeader>
        <DialogFooter className="mx-0 mb-0 flex-col-reverse gap-3 rounded-none border-0 bg-transparent p-0 sm:flex-row">
          <DialogClose asChild>
            <Button type="button" variant="outline">
              {closeLabel}
            </Button>
          </DialogClose>
          <Button asChild>
            <Link href={copy.action?.href ?? '/settings/plan'}>{copy.action?.label ?? 'View plans'}</Link>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
