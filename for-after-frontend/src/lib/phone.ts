import {
  getCountries,
  getCountryCallingCode,
  parsePhoneNumberFromString,
  type CountryCode,
} from 'libphonenumber-js';

// Country-aware phone handling for the People I Love form. Storage stays E.164
// (the API's IsE164Mobile); we check the format only, never that the number
// is a mobile, in service or theirs.

export type Country = { code: CountryCode; name: string; dial: string };

const regionNames = new Intl.DisplayNames(['en'], { type: 'region' });

/** Every country libphonenumber knows, by English name. Several share a code (+1, +7, +44…). */
export const COUNTRIES: Country[] = getCountries()
  .map((code) => ({ code, name: regionNames.of(code) ?? code, dial: `+${getCountryCallingCode(code)}` }))
  .sort((a, b) => a.name.localeCompare(b.name, 'en'));

const byCode = new Map<string, Country>(COUNTRIES.map((c) => [c.code, c]));
export const findCountry = (code: string) => byCode.get(code);
/** "Australia (+61)". */
export const countryLabel = (c: Country) => `${c.name} (${c.dial})`;

// Digits, spaces, + ( ) . - only, so prose or an extension is never trimmed away.
const PHONE_CHARS = /^\+?[\d\s().-]+$/;

/**
 * Typed number + chosen country → E.164, or null if it isn't a valid number.
 * A leading 0 is read as that country's trunk prefix (0412… in AU → +61412…);
 * a number typed with its own "+code" is read as international.
 */
export function toE164(country: string, number: string): string | null {
  const text = number.trim();
  if (!PHONE_CHARS.test(text)) return null;
  const phone = parsePhoneNumberFromString(text, findCountry(country)?.code);
  return phone?.isValid() && !phone.ext ? phone.number : null;
}

/** A saved number as it opens in the form; `saved` is the canonical value the API holds. */
export type SavedMobile = { saved: string | null; country: string; number: string; readable: boolean };
export const NO_SAVED_MOBILE: SavedMobile = { saved: null, country: '', number: '', readable: true };

/** Neither the country nor the number was changed since the form opened. */
const unchanged = (country: string, number: string, initial: SavedMobile) =>
  initial.saved !== null && country === initial.country && number.trim() === initial.number.trim();

const international = (e164: string) => parsePhoneNumberFromString(e164)?.formatInternational() ?? e164;

/**
 * Form fields → what the API stores: unchanged fields → the saved value exactly as saved (also a legacy one that
 * can't be read), blank → null, else E.164 (validated first by mobileIssue).
 */
export function mobileForApi(country: string, number: string, initial: SavedMobile): string | null {
  if (unchanged(country, number, initial)) return initial.saved;
  const text = number.trim();
  return text ? toE164(country, text) : null;
}

/**
 * Why the number can't be saved, or null. Unchanged fields always pass. Changing only the country of a saved number
 * is refused when it would turn that number into a different one: the person must enter the new number on purpose.
 */
export function mobileIssue(country: string, number: string, initial: SavedMobile = NO_SAVED_MOBILE): string | null {
  const text = number.trim();
  if (!text || unchanged(country, number, initial)) return null;
  const e164 = toE164(country, text);
  if (e164 && initial.saved !== null && text === initial.number.trim() && e164 !== initial.saved) {
    return `This number is saved as ${international(initial.saved)}. With this country it would become ${international(e164)}. Switch the country back to keep it, or type the new number in full with its country code.`;
  }
  if (e164) return null;
  const c = findCountry(country);
  return text.startsWith('+')
    ? 'Check this number: it doesn’t look like a valid phone number.'
    : c
      ? `Check this number: it doesn’t look like a valid number for ${c.name}.`
      : 'Choose the country for this number, or start it with + and the country code.';
}

/**
 * A saved number → form fields. A valid one opens on its own country (for a
 * shared code like +1, the country its area code belongs to), shown nationally.
 * Anything else stays exactly as saved for the person to check and correct,
 * with no country chosen. Deterministic (no browser state), so SSR matches.
 */
export function savedToFields(saved: string | null): SavedMobile {
  if (!saved) return NO_SAVED_MOBILE;
  const phone = parsePhoneNumberFromString(saved);
  return phone?.isValid() && phone.country
    ? { saved, country: phone.country, number: phone.formatNational(), readable: true }
    : { saved, country: '', number: saved, readable: false };
}

/** The region the browser states explicitly (en-AU → AU); never inferred from the language alone. Client only. */
export function browserCountry(): string {
  if (typeof navigator === 'undefined') return '';
  for (const tag of navigator.languages ?? [navigator.language]) {
    try {
      const region = new Intl.Locale(tag).region;
      if (region && byCode.has(region)) return region;
    } catch {
      // An unparsable tag: try the next one.
    }
  }
  return '';
}

/**
 * The browser's region as the default country for a new number, applied after mount: only when there is no saved
 * number and the person has not chosen a country or typed a number yet. Null = leave the fields alone.
 */
export function browserCountryDefault(
  saved: string | null,
  fields: { country: string; number: string; countryChosen: boolean },
  region = browserCountry(),
): string | null {
  if (saved !== null || fields.country || fields.number.trim() || fields.countryChosen) return null;
  return region || null;
}
