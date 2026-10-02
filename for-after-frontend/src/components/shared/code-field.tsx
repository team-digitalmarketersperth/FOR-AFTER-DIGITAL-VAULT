'use client';

import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

/**
 * One 6-digit field (not six boxes): paste, autofill, password managers and
 * screen readers just work. Used by the portal email codes and admin TOTP.
 * The value is never stored or pre-filled; callers clear it after each try.
 */
export function CodeField({
  value,
  onChange,
  error,
  disabled,
  id = 'code',
  label = '6-digit code',
  autoFocus = true,
}: {
  value: string;
  onChange: (digits: string) => void;
  /** Field-level message (e.g. "Enter the 6 digits…"); API errors stay form-level. */
  error?: string;
  disabled?: boolean;
  id?: string;
  label?: string;
  autoFocus?: boolean;
}) {
  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        name={id}
        inputMode="numeric"
        autoComplete="one-time-code"
        // No maxLength: it would cut a pasted "123 456" before the spaces are
        // stripped. onChange keeps the first 6 digits instead.
        pattern="\d{6}"
        autoFocus={autoFocus}
        value={value}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
        disabled={disabled}
        // Digits only, so "123 456" or "123-456" pastes cleanly.
        onChange={(e) => onChange(e.target.value.replace(/\D/g, '').slice(0, 6))}
        className="h-14 text-center font-mono text-2xl tracking-[0.5em]"
      />
      {error && (
        <p id={`${id}-error`} className="text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
