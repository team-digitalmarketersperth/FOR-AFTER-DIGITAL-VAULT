import { describe, expect, it } from 'vitest';
import { browserCountryDefault, mobileForApi, mobileIssue, NO_SAVED_MOBILE, savedToFields } from '@/lib/phone';

// Fictional numbers (libphonenumber's own examples).
describe('phone: saved numbers and edits', () => {
  const au = savedToFields('+61412345678');

  it('opens a saved number on its own country, nationally; no browser state involved', () => {
    expect(au).toEqual({ saved: '+61412345678', country: 'AU', number: '0412 345 678', readable: true });
    expect(savedToFields(null)).toEqual(NO_SAVED_MOBILE);
  });

  it('unchanged country and number: the canonical saved value, never re-parsed', () => {
    expect(mobileIssue('AU', '0412 345 678', au)).toBeNull();
    expect(mobileForApi('AU', ' 0412 345 678 ', au)).toBe('+61412345678');
  });

  it('only the country changed: refused when it would make a different number, never saved silently', () => {
    // "0412 345 678" is also a valid German number: +49 412 345678.
    const issue = mobileIssue('DE', '0412 345 678', au);
    expect(issue).toMatch(/saved as \+61 412 345 678\. With this country it would become \+49 /);
    expect(issue).toMatch(/type the new number in full with its country code/);
    // Switching back is the unchanged value again.
    expect(mobileIssue('AU', '0412 345 678', au)).toBeNull();
    // An intentional new entry (international form) is a different, valid number.
    expect(mobileIssue('DE', '+49 412 345678', au)).toBeNull();
    expect(mobileForApi('DE', '+49 412 345678', au)).toBe('+49412345678');
  });

  it('a country change that keeps the same E.164 (shared +1) is fine', () => {
    const us = savedToFields('+12015550123');
    expect(us.country).toBe('US');
    expect(mobileIssue('CA', us.number, us)).toBeNull();
    expect(mobileForApi('CA', us.number, us)).toBe('+12015550123');
  });

  it('legacy unreadable number: kept exactly as saved while unchanged, re-checked once edited', () => {
    const legacy = savedToFields('+6140000');
    expect(legacy).toEqual({ saved: '+6140000', country: '', number: '+6140000', readable: false });
    expect(mobileIssue('', '+6140000', legacy)).toBeNull();
    expect(mobileForApi('', '+6140000', legacy)).toBe('+6140000');
    expect(mobileIssue('', '+61400001', legacy)).toMatch(/doesn’t look like a valid phone number/);
    // Choosing a country for it counts as a change: it must then be valid.
    expect(mobileIssue('AU', '+6140000', legacy)).toMatch(/Check this number/);
  });

  it('blank clears; a new number without a saved one is validated normally', () => {
    expect(mobileForApi('AU', '  ', au)).toBeNull();
    expect(mobileIssue('AU', '', au)).toBeNull();
    expect(mobileForApi('AU', '0412 345 678', NO_SAVED_MOBILE)).toBe('+61412345678');
    expect(mobileIssue('', '0412 345 678')).toMatch(/Choose the country/);
  });

  it('browser region default: only for a new, untouched number', () => {
    const empty = { country: '', number: '', countryChosen: false };
    expect(browserCountryDefault(null, empty, 'AU')).toBe('AU');
    expect(browserCountryDefault(null, empty, '')).toBeNull();
    expect(browserCountryDefault('+61412345678', empty, 'AU')).toBeNull();
    expect(browserCountryDefault(null, { ...empty, country: 'NZ' }, 'AU')).toBeNull();
    expect(browserCountryDefault(null, { ...empty, number: '021' }, 'AU')).toBeNull();
    expect(browserCountryDefault(null, { ...empty, countryChosen: true }, 'AU')).toBeNull();
  });
});
