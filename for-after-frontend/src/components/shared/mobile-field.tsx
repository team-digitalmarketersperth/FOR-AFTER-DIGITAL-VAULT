'use client';

import type { UseFormRegisterReturn } from 'react-hook-form';
import { CountrySelect } from '@/components/shared/country-select';
import { FieldLabel } from '@/components/shared/form-field';
import { Input } from '@/components/ui/input';

/**
 * Country picker + number, for a person who signs in by SMS (People I Love,
 * Trusted Contacts). Parsing and E.164 conversion live in `@/lib/phone`.
 */
export function MobileField({
  country,
  onCountryChange,
  registration,
  error,
  optional,
  unreadable,
}: {
  country: string;
  onCountryChange: (code: string) => void;
  registration: UseFormRegisterReturn;
  error?: string;
  optional?: boolean;
  /** The saved number couldn't be read and is still shown as saved. */
  unreadable: boolean;
}) {
  const errorId = error ? 'mobile-error' : undefined;
  return (
    <div className="grid content-start gap-2">
      <FieldLabel htmlFor="mobile" label="Mobile" optional={optional} />
      <div className="grid gap-2 min-[400px]:grid-cols-[minmax(0,11rem)_minmax(0,1fr)] sm:grid-cols-1 lg:grid-cols-[minmax(0,11rem)_minmax(0,1fr)]">
        <CountrySelect
          id="mobileCountry"
          label="Country for mobile"
          value={country}
          onChange={onCountryChange}
          invalid={!!error}
          describedBy="mobile-hint"
        />
        <Input
          id="mobile"
          type="tel"
          inputMode="tel"
          autoComplete="off"
          placeholder="Number"
          aria-invalid={error ? true : undefined}
          aria-describedby={['mobile-hint', errorId].filter(Boolean).join(' ')}
          className="h-11"
          {...registration}
        />
      </div>
      <p id="mobile-hint" className="text-sm text-foreground-muted">
        {unreadable
          ? 'We couldn’t work out the country of this saved number. It’s kept as it is; check it and correct it if needed.'
          : 'Type it as you would dial it in that country. We check the format only. They can sign in with a code sent to this number.'}
      </p>
      {error && (
        <p id={errorId} className="text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
