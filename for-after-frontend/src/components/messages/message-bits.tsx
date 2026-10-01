import { AudioLines, Image as ImageIcon, Layers, PenLine, type LucideIcon } from 'lucide-react';
import type { ContentType, Message, MessageStatus, Schedule } from '@/lib/api/messages';
import { formatDateTime, timeZoneName } from '@/lib/format';
import { cn } from '@/lib/utils';

export const CONTENT_TYPE_INFO: Record<ContentType, { label: string; description: string; icon: LucideIcon }> = {
  TEXT: { label: 'Written', description: 'A letter or note in your own words.', icon: PenLine },
  PHOTO: { label: 'Photos', description: 'One or more photos, without text.', icon: ImageIcon },
  AUDIO: { label: 'Voice', description: 'Your voice: a recording or audio file.', icon: AudioLines },
  MIXED: { label: 'Mixed', description: 'Any two or more of words, photos and voice.', icon: Layers },
};

const STATUS: Record<MessageStatus, { label: string; className: string }> = {
  DRAFT: { label: 'Draft', className: 'border-border-strong/60 bg-surface-muted text-foreground-secondary' },
  SCHEDULED: { label: 'Scheduled', className: 'border-transparent bg-primary-soft text-primary' },
  RELEASED: { label: 'Released', className: 'border-transparent bg-success/10 text-success' },
  CANCELLED: { label: 'Cancelled', className: 'border-border bg-surface-muted text-foreground-muted' },
};

export function StatusBadge({ status }: { status: MessageStatus }) {
  const s = STATUS[status];
  return (
    <span className={cn('inline-flex items-center rounded-full border px-3 py-1 text-xs font-medium', s.className)}>
      {s.label}
    </span>
  );
}

/** "For Sofia", "For Sofia and Tom", "For Sofia and 2 others". */
export function recipientSummary(recipients: Message['recipients']) {
  if (recipients.length === 0) return 'No one chosen yet';
  const [first, ...rest] = recipients.map((r) => r.firstName);
  if (rest.length === 0) return `For ${first}`;
  if (rest.length === 1) return `For ${first} and ${rest[0]}`;
  return `For ${first} and ${rest.length} others`;
}

/** Plain-language schedule. Death triggers only ever follow a verified death. */
export function describeSchedule(s: Schedule) {
  switch (s.triggerType) {
    case 'FIXED_DATE':
      return s.scheduledFor
        ? `On ${formatDateTime(s.scheduledFor)} (${timeZoneName()} time)`
        : 'On a date you chose';
    case 'ON_DEATH':
      return 'After your death has been verified by the For After team';
    case 'AFTER_DEATH':
      return `${s.afterDeathDays} ${s.afterDeathDays === 1 ? 'day' : 'days'} after the verified date of death`;
  }
}
