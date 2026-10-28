import type { ConditionalDelivery, UpcomingDelivery } from '@/lib/api/delivery-timeline';

// Display rules for the delivery timeline. Dates are formatted in the
// schedule's own zone (the engine's stored instant never moves a day).

const viewerZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const dayStamp = (at: Date, zone: string) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);

/** "to Mum", "to Mum and Sarah", "to Mum, Sarah + 2 more"; "" with nobody. */
export function toRecipients(names: string[]) {
  if (!names.length) return '';
  if (names.length === 1) return `to ${names[0]}`;
  if (names.length === 2) return `to ${names[0]} and ${names[1]}`;
  return `to ${names.slice(0, 2).join(', ')} + ${names.length - 2} more`;
}

/** "Now", "Today", "Tomorrow", "24 Dec 2026" (in the schedule's zone). */
export function whenLabel(e: Pick<UpcomingDelivery, 'dueAt' | 'timezone'>, now = new Date()) {
  if (!e.dueAt) return 'Now';
  const zone = e.timezone ?? viewerZone();
  const at = new Date(e.dueAt);
  const day = dayStamp(at, zone);
  if (day === dayStamp(now, zone)) return 'Today';
  if (day === dayStamp(new Date(now.getTime() + 86_400_000), zone)) return 'Tomorrow';
  return new Intl.DateTimeFormat('en-AU', { timeZone: zone, day: 'numeric', month: 'short', year: 'numeric' }).format(at);
}

/** Short dashboard form: "24 Dec" (the year only when it isn't this year). */
export function shortWhen(e: Pick<UpcomingDelivery, 'dueAt' | 'timezone'>, now = new Date()) {
  const label = whenLabel(e, now);
  if (!e.dueAt || label === 'Today' || label === 'Tomorrow') return label;
  const zone = e.timezone ?? viewerZone();
  const at = new Date(e.dueAt);
  const sameYear = dayStamp(at, zone).slice(0, 4) === dayStamp(now, zone).slice(0, 4);
  return new Intl.DateTimeFormat('en-AU', { timeZone: zone, day: 'numeric', month: 'short', ...(!sameYear && { year: 'numeric' }) }).format(at);
}

const CITY = (zone: string) => zone.split('/').at(-1)!.replaceAll('_', ' ');

/** The quiet second line: what kind of timing, at what local time. */
export function upcomingDetail(e: UpcomingDelivery) {
  if (!e.dueAt) return 'As soon as possible';
  const zone = e.timezone ?? viewerZone();
  const time = new Intl.DateTimeFormat('en-AU', { timeZone: zone, hour: 'numeric', minute: '2-digit' }).format(new Date(e.dueAt));
  const at = e.timezone && e.timezone !== viewerZone() ? `${time} ${CITY(e.timezone)} time` : time;
  const kind = {
    NOW: '',
    FIXED_DATE: '',
    BIRTHDAY: 'Birthday',
    ANNIVERSARY: 'Anniversary',
    CUSTOM_EVENT: e.eventLabel ?? 'A date you chose',
    ON_DEATH: 'After my passing',
    AFTER_DEATH: 'After my passing',
    ANNUAL_AFTER_DEATH: 'Remembrance',
  }[e.triggerType];
  return [kind, at, e.repeatsAnnually ? 'repeats every year' : ''].filter(Boolean).join(' · ');
}

/** No date exists before a verified death: say what will happen, never when. */
export function conditionalLabel(e: Pick<ConditionalDelivery, 'triggerType' | 'afterDeathDays'>) {
  if (e.triggerType === 'AFTER_DEATH') {
    const d = e.afterDeathDays ?? 0;
    return d === 0 ? 'After my passing' : `${d} ${d === 1 ? 'day' : 'days'} after my passing`;
  }
  if (e.triggerType === 'ANNUAL_AFTER_DEATH') return 'Every year after my passing';
  return 'After my passing';
}
