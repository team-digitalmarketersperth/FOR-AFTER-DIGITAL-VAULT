// Display helpers. Everything here returns plain strings rendered as text.

const pad = (n: number) => String(n).padStart(2, '0');

/** FUNNY_STORIES → "Funny stories". The API sends enums without labels. */
export const humanize = (value: string) =>
  value.charAt(0) + value.slice(1).toLowerCase().replaceAll('_', ' ');

export const fullName = (p: { firstName: string; lastName: string | null }) =>
  [p.firstName, p.lastName].filter(Boolean).join(' ');

export const initials = (p: { firstName: string; lastName: string | null }) =>
  `${p.firstName.charAt(0)}${p.lastName?.charAt(0) ?? ''}`.toUpperCase();

/** 2026-09-30T02:15:00.000Z → "30 Sep 2026" in the viewer's timezone. */
export const formatDate = (iso: string) =>
  new Intl.DateTimeFormat('en-AU', { day: 'numeric', month: 'short', year: 'numeric' }).format(
    new Date(iso),
  );

/** 2026-09-30T02:15:00.000Z → "September 2026" in the viewer's timezone. */
export const formatMonthYear = (iso: string) =>
  new Intl.DateTimeFormat('en-AU', { month: 'long', year: 'numeric' }).format(new Date(iso));

/** → "Friday 25 December 2026, 9:00 am" in the viewer's timezone. */
export const formatDateTime = (iso: string) =>
  new Intl.DateTimeFormat('en-AU', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(iso));

/**
 * A calendar date ("YYYY-MM-DD", e.g. a birthday) is not an instant: it is
 * formatted from its parts, so no timezone can move it to another day.
 */
export function formatCalendarDate(date: string) {
  const [y, m, d] = date.split('-').map(Number);
  return new Intl.DateTimeFormat('en-AU', { day: 'numeric', month: 'long', year: 'numeric' }).format(
    new Date(y, m - 1, d),
  );
}

/** → "30 Sep 2026, 2:15 pm" in the viewer's timezone (dense admin lists). */
export const formatTimestamp = (iso: string) =>
  new Intl.DateTimeFormat('en-AU', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));

export const timeZoneName = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/**
 * This browser's timezone as people read it, at a given moment (offsets move
 * with daylight saving): "India Standard Time (UTC+5:30)". Falls back to the
 * IANA name when the runtime can't name it.
 */
export function timeZoneLabel(at: Date = new Date()): string {
  const part = (style: 'long' | 'shortOffset') =>
    new Intl.DateTimeFormat('en-AU', { timeZoneName: style })
      .formatToParts(at)
      .find((p) => p.type === 'timeZoneName')?.value;
  const long = part('long');
  const offset = part('shortOffset')?.replace(/^GMT/, 'UTC');
  if (!long || !offset) return timeZoneName();
  return `${long} (${offset === 'UTC' ? 'UTC+0' : offset})`;
}

/**
 * Local date + time inputs ("2026-12-25", "09:00") → an ISO 8601 string with
 * this browser's offset for that moment, e.g. "2026-12-25T09:00:00+08:00".
 * The backend rejects timestamps without an explicit offset.
 */
export function localToOffsetIso(date: string, time: string): string {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  const local = new Date(y, m - 1, d, hh, mm, 0, 0);
  const offset = -local.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  return (
    `${local.getFullYear()}-${pad(local.getMonth() + 1)}-${pad(local.getDate())}` +
    `T${pad(local.getHours())}:${pad(local.getMinutes())}:00` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

/** An instant → the local "YYYY-MM-DD" / "HH:mm" values date/time inputs expect. */
export function isoToLocalInputs(iso: string) {
  const d = new Date(iso);
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
  };
}

export const formatBytes = (bytes: number) =>
  bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
