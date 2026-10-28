import type { ActivityItem, ActivityType } from '@/lib/api/activity';

// Calm, short copy for each change, and where it lives (if it still exists).
const COPY: Record<ActivityType, string> = {
  PERSON_ADDED: 'Person added',
  PERSON_UPDATED: 'Person updated',
  PERSON_REMOVED: 'Person removed',
  TRUSTED_CONTACT_ADDED: 'Trusted Contact added',
  TRUSTED_CONTACT_UPDATED: 'Trusted Contact changed',
  TRUSTED_CONTACT_REMOVED: 'Trusted Contact removed',
  MESSAGE_CREATED: 'Message created',
  MESSAGE_UPDATED: 'Message updated',
  MESSAGE_DELETED: 'Message removed',
  MESSAGE_SCHEDULED: 'Message scheduled',
  MESSAGE_RESCHEDULED: 'Schedule changed',
  MESSAGE_UNSCHEDULED: 'Message timing removed',
  MEMORY_ADDED: 'Memory added',
  MEMORY_UPDATED: 'Memory updated',
  MEMORY_DELETED: 'Memory removed',
  STORY_RESPONSE_ADDED: 'Story answer added',
  STORY_RESPONSE_UPDATED: 'Story answer updated',
  STORY_RESPONSE_DELETED: 'Story answer removed',
  WISH_RESPONSE_ADDED: 'Wish added',
  WISH_RESPONSE_UPDATED: 'Wishes updated',
  WISH_RESPONSE_DELETED: 'Wish removed',
  PROFILE_UPDATED: 'Account details updated',
  EMAIL_CHANGED: 'Email address changed',
};

export const activityLabel = (type: ActivityType) => COPY[type] ?? 'Change made';

/** Existing routes only; null (plain text) once the item is gone. */
export function activityHref({ type, target }: ActivityItem): string | null {
  if (type === 'PROFILE_UPDATED' || type === 'EMAIL_CHANGED') return '/settings';
  if (!target) return null;
  if (type.startsWith('PERSON_')) return `/people/${target}`;
  if (type.startsWith('TRUSTED_CONTACT_')) return '/trusted-contacts';
  if (type.startsWith('MESSAGE_')) return `/messages/${target}`;
  if (type.startsWith('MEMORY_')) return `/memory-vault/${target}`;
  if (type.startsWith('STORY_')) return `/my-story/${encodeURIComponent(target)}`;
  if (type.startsWith('WISH_')) return `/my-wishes/${encodeURIComponent(target)}`;
  return null;
}

const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
const daysAgo = (iso: string, now: Date) => {
  const a = new Date(iso);
  const start = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  return Math.round((start(now) - start(a)) / 86_400_000);
};

/** Dashboard: "Today", "Yesterday", "12 Oct" (with the year only if not this year). */
export function shortDay(iso: string, now = new Date()) {
  const ago = daysAgo(iso, now);
  if (ago === 0) return 'Today';
  if (ago === 1) return 'Yesterday';
  const d = new Date(iso);
  return new Intl.DateTimeFormat('en-AU', {
    day: 'numeric',
    month: 'short',
    ...(d.getFullYear() !== now.getFullYear() && { year: 'numeric' }),
  }).format(d);
}

/** Full history group heading: "Today", "Yesterday", "10 October 2026". */
export function longDay(iso: string, now = new Date()) {
  const ago = daysAgo(iso, now);
  if (ago === 0) return 'Today';
  if (ago === 1) return 'Yesterday';
  return new Intl.DateTimeFormat('en-AU', { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(iso));
}

/** "2:42 pm" in the viewer's timezone. */
export const timeOfDay = (iso: string) =>
  new Intl.DateTimeFormat('en-AU', { hour: 'numeric', minute: '2-digit' }).format(new Date(iso));

/** Consecutive items grouped by the viewer's calendar day (input is newest first). */
export function groupByDay(items: ActivityItem[]) {
  const groups: { key: string; first: string; items: ActivityItem[] }[] = [];
  for (const item of items) {
    const key = dayKey(new Date(item.createdAt));
    const last = groups.at(-1);
    if (last?.key === key) last.items.push(item);
    else groups.push({ key, first: item.createdAt, items: [item] });
  }
  return groups;
}
