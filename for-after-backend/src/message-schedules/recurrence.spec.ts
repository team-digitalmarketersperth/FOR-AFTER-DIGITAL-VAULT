import {
  annualOccurrence,
  isIanaZone,
  isValidMonthDay,
  localDateTime,
  nextAnnualOccurrence,
} from './recurrence.js';
import {
  firstOccurrence,
  nextOccurrence,
} from '../message-release/recipient-occurrences.js';

const iso = (d: Date) => d.toISOString();

describe('recurrence (calendar, never +365 days)', () => {
  it.each([
    [2028, '2028-02-29T01:00:00.000Z'],
    [2029, '2029-02-28T01:00:00.000Z'],
    [2030, '2030-02-28T01:00:00.000Z'],
    [2032, '2032-02-29T01:00:00.000Z'],
  ])('29 Feb in %i (Perth 09:00)', (year, expected) => {
    expect(iso(annualOccurrence(year, 2, 29, '09:00', 'Australia/Perth'))).toBe(
      expected,
    );
  });

  it('uses each zone’s own offset (DST included)', () => {
    // Sydney: +11 in January (DST), +10 in July.
    expect(
      iso(annualOccurrence(2027, 1, 15, '09:00', 'Australia/Sydney')),
    ).toBe('2027-01-14T22:00:00.000Z');
    expect(
      iso(annualOccurrence(2027, 7, 15, '09:00', 'Australia/Sydney')),
    ).toBe('2027-07-14T23:00:00.000Z');
    // New York: -4 in July, -5 in January. Kolkata: +05:30, no DST.
    expect(iso(annualOccurrence(2027, 7, 4, '09:00', 'America/New_York'))).toBe(
      '2027-07-04T13:00:00.000Z',
    );
    expect(iso(annualOccurrence(2027, 1, 4, '09:00', 'America/New_York'))).toBe(
      '2027-01-04T14:00:00.000Z',
    );
    expect(iso(annualOccurrence(2027, 3, 1, '09:00', 'Asia/Kolkata'))).toBe(
      '2027-03-01T03:30:00.000Z',
    );
  });

  it('a local time skipped by DST moves forward instead of failing', () => {
    // New York 2027-03-14 02:30 does not exist (clocks jump 02:00 → 03:00).
    const d = annualOccurrence(2027, 3, 14, '02:30', 'America/New_York');
    expect(iso(d)).toBe('2027-03-14T07:30:00.000Z'); // 03:30 EDT
  });

  it('next occurrence: this year if still ahead, else next year', () => {
    const after = new Date('2026-06-01T00:00:00Z');
    expect(
      nextAnnualOccurrence(7, 24, '09:00', 'Australia/Perth', after, 2025),
    ).toEqual({ year: 2026, dueAt: new Date('2026-07-24T01:00:00Z') });
    expect(
      nextAnnualOccurrence(3, 10, '09:00', 'Australia/Perth', after, 2025),
    ).toEqual({ year: 2027, dueAt: new Date('2027-03-10T01:00:00Z') });
  });

  it('next occurrence after a 29 Feb release is calendar based', () => {
    const released = annualOccurrence(2028, 2, 29, '09:00', 'Australia/Perth');
    const next = nextAnnualOccurrence(
      2,
      29,
      '09:00',
      'Australia/Perth',
      released,
      2029,
    );
    expect(next.year).toBe(2029);
    expect(iso(next.dueAt)).toBe('2029-02-28T01:00:00.000Z');
    // Not +365 days: across a leap day, 2027-03-01 + 365 d is 2028-02-29.
    const march = annualOccurrence(2027, 3, 1, '09:00', 'Australia/Perth');
    const nextMarch = nextAnnualOccurrence(
      3,
      1,
      '09:00',
      'Australia/Perth',
      march,
      2028,
    ).dueAt;
    expect(iso(nextMarch)).toBe('2028-03-01T01:00:00.000Z');
    expect(nextMarch.getTime()).not.toBe(march.getTime() + 365 * 86_400_000);
  });

  it('zone and month/day validation', () => {
    expect(isIanaZone('Australia/Perth')).toBe(true);
    expect(isIanaZone('America/New_York')).toBe(true);
    expect(isIanaZone('UTC')).toBe(false); // not a place; explicit zones only
    expect(isIanaZone('+08:00')).toBe(false);
    expect(isIanaZone('Mars/Olympus')).toBe(false);
    expect(isValidMonthDay(2, 29)).toBe(true);
    expect(isValidMonthDay(2, 30)).toBe(false);
    expect(isValidMonthDay(4, 31)).toBe(false);
  });

  it('local date + time → UTC', () => {
    expect(
      iso(localDateTime(new Date('2027-06-01'), '18:30', 'Asia/Kolkata')),
    ).toBe('2027-06-01T13:00:00.000Z');
  });
});

describe('per-Recipient occurrences', () => {
  const tz = { timezone: 'Australia/Perth', localTime: '09:00' };
  const birthday = (s: string) => new Date(`${s}T00:00:00Z`); // @db.Date
  const now = new Date('2026-06-01T00:00:00Z');

  it('BIRTHDAY: each Recipient resolves to their own date', () => {
    const s = {
      triggerType: 'BIRTHDAY' as const,
      ...tz,
      annualMonth: null,
      annualDay: null,
    };
    expect(firstOccurrence(s, birthday('1990-03-10'), null, now)).toEqual({
      year: 2027,
      dueAt: new Date('2027-03-10T01:00:00Z'),
    });
    expect(firstOccurrence(s, birthday('2001-07-24'), null, now)).toEqual({
      year: 2026,
      dueAt: new Date('2026-07-24T01:00:00Z'),
    });
    expect(firstOccurrence(s, null, null, now)).toBeNull();
  });

  it('BIRTHDAY today, release time still ahead → today', () => {
    const s = {
      triggerType: 'BIRTHDAY' as const,
      ...tz,
      annualMonth: null,
      annualDay: null,
    };
    // 2026-06-01T00:00Z is 08:00 in Perth.
    expect(firstOccurrence(s, birthday('1980-06-01'), null, now)?.year).toBe(
      2026,
    );
  });

  it('ANNIVERSARY: past this year → next year; then yearly', () => {
    const s = {
      triggerType: 'ANNIVERSARY' as const,
      ...tz,
      annualMonth: 1,
      annualDay: 5,
    };
    const first = firstOccurrence(s, null, null, now)!;
    expect(first).toEqual({
      year: 2027,
      dueAt: new Date('2027-01-05T01:00:00Z'),
    });
    expect(nextOccurrence(s, null, null, first.dueAt, first.year + 1)).toEqual({
      year: 2028,
      dueAt: new Date('2028-01-05T01:00:00Z'),
    });
  });

  it('ANNUAL_AFTER_DEATH: first anniversary one calendar year after the death', () => {
    const s = {
      triggerType: 'ANNUAL_AFTER_DEATH' as const,
      ...tz,
      annualMonth: null,
      annualDay: null,
    };
    // Died 2028-02-29 10:00 Perth (02:00Z); verified a week later.
    const died = new Date('2028-02-29T02:00:00Z');
    const verified = new Date('2028-03-07T00:00:00Z');
    const first = firstOccurrence(s, null, died, verified)!;
    expect(first).toEqual({
      year: 2029,
      dueAt: new Date('2029-02-28T01:00:00Z'),
    });
    const second = nextOccurrence(s, null, died, first.dueAt, first.year + 1)!;
    expect(second).toEqual({
      year: 2030,
      dueAt: new Date('2030-02-28T01:00:00Z'),
    });
    expect(nextOccurrence(s, null, died, second.dueAt, 2031)?.dueAt).toEqual(
      new Date('2031-02-28T01:00:00Z'),
    );
    expect(nextOccurrence(s, null, died, second.dueAt, 2032)?.dueAt).toEqual(
      new Date('2032-02-29T01:00:00Z'),
    );
  });

  it('ANNUAL_AFTER_DEATH anchors on the local death date, not the UTC one', () => {
    const s = {
      triggerType: 'ANNUAL_AFTER_DEATH' as const,
      ...tz,
      annualMonth: null,
      annualDay: null,
    };
    // 2027-05-01T20:00Z is 2027-05-02 04:00 in Perth.
    const died = new Date('2027-05-01T20:00:00Z');
    expect(firstOccurrence(s, null, died, died)?.dueAt).toEqual(
      new Date('2028-05-02T01:00:00Z'),
    );
  });

  it('ANNUAL_AFTER_DEATH without a verified death resolves to nothing', () => {
    const s = {
      triggerType: 'ANNUAL_AFTER_DEATH' as const,
      ...tz,
      annualMonth: null,
      annualDay: null,
    };
    expect(firstOccurrence(s, null, null, now)).toBeNull();
  });

  it('missed years are skipped, never released in a burst', () => {
    const s = {
      triggerType: 'ANNIVERSARY' as const,
      ...tz,
      annualMonth: 1,
      annualDay: 5,
    };
    // Released the 2027 one very late (server down until mid 2029).
    const lateNow = new Date('2029-06-01T00:00:00Z');
    expect(nextOccurrence(s, null, null, lateNow, 2028)?.year).toBe(2030);
  });
});
