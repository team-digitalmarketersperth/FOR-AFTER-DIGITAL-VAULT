import { Lock } from 'lucide-react';
import type { ComponentProps } from 'react';
import { TextAreaField } from '@/components/shared/form-field';

// Private notes to self on a message, memory, story answer or wish: owner-only
// (the API never sends them to Recipients, Trusted Contacts or admins, or
// copies them into a shared message). One label, promise and limit everywhere.
export const PRIVATE_NOTE_MAX = 2000;
const PROMISE = 'Only you can see this.';

/** Quiet, below the content it belongs to; saved with the normal Save. */
export function PrivateNoteField(
  props: Omit<ComponentProps<typeof TextAreaField>, 'label' | 'hint' | 'optional' | 'maxLength'>,
) {
  return (
    <div className="rounded-xl bg-surface-muted p-5 sm:p-6">
      <TextAreaField label="Private note to yourself" optional hint={PROMISE} maxLength={PRIVATE_NOTE_MAX} className="min-h-24" {...props} />
    </div>
  );
}

/** The owner's note on a detail page; nothing when there is none. */
export function PrivateNoteView({ note }: { note: string | null | undefined }) {
  if (!note) return null;
  return (
    <section aria-label="Private note to yourself" className="grid gap-2 rounded-xl bg-surface-muted p-5 sm:p-6">
      <p className="flex items-center gap-2 text-sm font-medium text-foreground-secondary">
        <Lock aria-hidden strokeWidth={1.5} className="size-3.5" />
        Private note to yourself
      </p>
      <p className="whitespace-pre-wrap break-words">{note}</p>
      <p className="text-xs text-foreground-muted">{PROMISE}</p>
    </section>
  );
}
