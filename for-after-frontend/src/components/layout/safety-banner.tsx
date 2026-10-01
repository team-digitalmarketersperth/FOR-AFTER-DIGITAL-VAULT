'use client';

import { ShieldAlert } from 'lucide-react';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { Button } from '@/components/ui/button';
import { useConfirmAlive, useCustomerDeathVerification } from '@/hooks/use-portals';
import { formatDateTime } from '@/lib/format';

/**
 * Shown to the account holder only while a death report about them is open
 * (the API's canConfirmAlive). It shows only what that API returns: the status
 * and, if set, when the safeguard period ends. Never who reported or any note.
 */
export function SafetyBanner() {
  const status = useCustomerDeathVerification();
  const confirm = useConfirmAlive();
  const s = status.data;
  if (!s?.canConfirmAlive) return null;

  return (
    <section
      role="region"
      aria-labelledby="safety-heading"
      className="mb-10 grid gap-5 rounded-xl border-l-4 border-primary bg-primary-soft p-6 sm:p-8"
    >
      <div className="flex gap-4">
        <ShieldAlert aria-hidden strokeWidth={1.5} className="mt-1 size-6 shrink-0 text-primary" />
        <div className="grid gap-3">
          <h2 id="safety-heading" className="text-[28px] leading-tight">
            We&apos;ve received a report about your account
          </h2>
          <p className="max-w-2xl text-[15px] leading-relaxed text-foreground-secondary">
            One of your trusted contacts has told us you may have passed away. If you&apos;re reading this, please let
            us know. Your account stays open while the report is checked, and messages set for after your passing are
            only released if the For After team verifies it.
          </p>
          {s.safeguardEndsAt && (
            <p className="text-[15px] font-medium">
              If we don&apos;t hear from you by {formatDateTime(s.safeguardEndsAt)}, the report will be reviewed by our team.
            </p>
          )}
        </div>
      </div>
      <div className="sm:pl-10">
        <ConfirmDialog
          tone="default"
          trigger={<Button>I&apos;m still alive</Button>}
          title="Confirm that you're still alive?"
          description="This closes the report about your account. Your messages stay exactly as they are, and nothing is released because of this report."
          confirmLabel="Yes, close the report"
          pending={confirm.isPending}
          error={confirm.error}
          onConfirm={() =>
            confirm.mutateAsync().then(() => toast.success('Thank you. The report has been closed.'))
          }
        />
      </div>
    </section>
  );
}
