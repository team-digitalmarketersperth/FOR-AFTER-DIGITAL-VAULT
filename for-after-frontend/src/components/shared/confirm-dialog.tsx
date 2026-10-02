'use client';

import { useState, type ReactNode } from 'react';
import { Spinner } from '@/components/shared/states';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import type { ApiError } from '@/lib/api/errors';

/**
 * The one confirmation pattern for destructive or state-changing actions.
 * Radix handles focus trapping, Escape and returning focus to the trigger.
 * Stays open (showing the safe error) if the action fails.
 */
export function ConfirmDialog({
  trigger,
  title,
  description,
  confirmLabel,
  onConfirm,
  pending,
  error,
  tone = 'danger',
  children,
  confirmDisabled,
  onOpenChange,
}: {
  trigger: ReactNode;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  onConfirm: () => Promise<unknown>;
  pending: boolean;
  error?: ApiError | null;
  tone?: 'danger' | 'default';
  /** Optional form fields (a reason, a confirmation checkbox) between text and buttons. */
  children?: ReactNode;
  confirmDisabled?: boolean;
  /** E.g. to clear the fields when the dialog closes. */
  onOpenChange?: (open: boolean) => void;
}) {
  const [open, setOpenState] = useState(false);
  const setOpen = (next: boolean) => {
    setOpenState(next);
    onOpenChange?.(next);
  };
  return (
    <Dialog open={open} onOpenChange={(next) => !pending && setOpen(next)}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent
        // Tall dialogs (forms) scroll inside the viewport instead of clipping on phones.
        className="max-h-[calc(100dvh-2rem)] gap-6 overflow-y-auto rounded-xl bg-surface p-7 sm:max-w-md"
        showCloseButton={false}
      >
        <DialogHeader className="gap-3">
          <DialogTitle className="text-[28px] leading-tight font-normal">{title}</DialogTitle>
          <DialogDescription className="text-[15px] leading-relaxed text-foreground-muted">
            {description}
          </DialogDescription>
        </DialogHeader>
        {children}
        {error && (
          <p role="alert" className="rounded-md bg-danger/8 px-4 py-3 text-sm text-danger">
            {error.message}
          </p>
        )}
        <DialogFooter className="mx-0 mb-0 flex-col-reverse gap-3 rounded-none border-0 bg-transparent p-0 sm:flex-row">
          <Button variant="outline" disabled={pending} onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            variant={tone === 'danger' ? 'destructive' : 'default'}
            disabled={pending || confirmDisabled}
            onClick={() => onConfirm().then(() => setOpen(false), () => undefined)}
          >
            {pending && <Spinner />}
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
