import { DateTime, Info } from 'luxon';

// "HH:mm", 24-hour local wall time.
export const LOCAL_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** A real IANA zone name (e.g. Australia/Perth); fixed offsets are refused. */
export const isIanaZone = (zone: string) =>
  zone.includes('/') && Info.isValidIANAZone(zone);

/** Calendar check for an annual month/day: 29 Feb is allowed, 30 Feb is not. */
export const isValidMonthDay = (month: number, day: number) =>
  DateTime.utc(2028, month, day).isValid; // 2028 is a leap year

/**
 * The UTC instant of month/day at localTime in `zone` for one calendar year.
 * 29 Feb falls on 28 Feb in non-leap years. Calendar arithmetic only (never
 * "+365 days"); a local time skipped by a DST change moves forward (luxon).
 */
export const annualOccurrence = (
  year: number,
  month: number,
  day: number,
  localTime: string,
  zone: string,
): Date => {
  const [hour, minute] = localTime.split(':').map(Number);
  const leap = DateTime.utc(year, 2, 29).isValid;
  const d = month === 2 && day === 29 && !leap ? 28 : day;
  return DateTime.fromObject(
    { year, month, day: d, hour, minute },
    { zone },
  ).toJSDate();
};

/**
 * The first yearly occurrence from `fromYear` on that is strictly after
 * `after`. Returns its year and UTC instant.
 */
export const nextAnnualOccurrence = (
  month: number,
  day: number,
  localTime: string,
  zone: string,
  after: Date,
  fromYear: number,
): { year: number; dueAt: Date } => {
  for (let year = fromYear; ; year++) {
    const dueAt = annualOccurrence(year, month, day, localTime, zone);
    if (dueAt > after) return { year, dueAt };
  }
};

/** Calendar parts of a date in `zone` (local year, month, day). */
export const localParts = (at: Date, zone: string) => {
  const d = DateTime.fromJSDate(at, { zone });
  return { year: d.year, month: d.month, day: d.day };
};

/** A @db.Date column (UTC midnight) as month/day. */
export const dateOnlyParts = (date: Date) => ({
  year: date.getUTCFullYear(),
  month: date.getUTCMonth() + 1,
  day: date.getUTCDate(),
});

/** One local date + time in `zone` → UTC (CUSTOM_EVENT). */
export const localDateTime = (
  date: Date,
  localTime: string,
  zone: string,
): Date => {
  const { year, month, day } = dateOnlyParts(date);
  const [hour, minute] = localTime.split(':').map(Number);
  return DateTime.fromObject(
    { year, month, day, hour, minute },
    { zone },
  ).toJSDate();
};
