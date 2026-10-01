'use client';

import { Eye, EyeOff } from 'lucide-react';
import Link from 'next/link';
import { useState, type ComponentProps, type ReactNode } from 'react';
import type { UseFormRegisterReturn } from 'react-hook-form';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { ApiError } from '@/lib/api/errors';
import { cn } from '@/lib/utils';

type TextFieldProps = ComponentProps<typeof Input> & {
  id: string;
  label: string;
  error?: string;
  hint?: string;
  trailing?: ReactNode;
  optional?: boolean;
};

/** Label + input + hint + error, wired together for screen readers. */
export function TextField({
  id,
  label,
  error,
  hint,
  trailing,
  optional,
  className,
  ...inputProps
}: TextFieldProps) {
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  return (
    <div className="grid gap-2">
      <FieldLabel htmlFor={id} label={label} optional={optional} />
      <div className="relative">
        <Input
          id={id}
          aria-invalid={error ? true : undefined}
          aria-describedby={[hintId, errorId].filter(Boolean).join(' ') || undefined}
          className={cn('h-11', trailing && 'pr-11', className)}
          {...inputProps}
        />
        {trailing && (
          <div className="absolute inset-y-0 right-0 flex items-center pr-1.5">
            {trailing}
          </div>
        )}
      </div>
      {hint && (
        <p id={hintId} className="text-sm text-foreground-muted">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className="text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

export function PasswordField(props: Omit<TextFieldProps, 'type' | 'trailing'>) {
  const [visible, setVisible] = useState(false);
  const Icon = visible ? EyeOff : Eye;
  return (
    <TextField
      {...props}
      type={visible ? 'text' : 'password'}
      trailing={
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          aria-label={visible ? 'Hide password' : 'Show password'}
          aria-pressed={visible}
          aria-controls={props.id}
          className="rounded-sm p-2.5 text-foreground-muted outline-none hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
        >
          <Icon aria-hidden className="size-4" />
        </button>
      }
    />
  );
}

/** Form-level error from the API: safe message plus any validation details. */
export function FormError({ error, title }: { error: ApiError | null; title?: string }) {
  if (!error) return null;
  return (
    <Alert variant="destructive">
      {title && <AlertTitle>{title}</AlertTitle>}
      <AlertDescription>
        <p>{error.message}</p>
        {error.details.length > 0 && (
          <ul className="mt-1 list-disc pl-4">
            {error.details.map((detail) => (
              <li key={detail}>{detail}</li>
            ))}
          </ul>
        )}
      </AlertDescription>
    </Alert>
  );
}

function FieldLabel({ htmlFor, label, optional }: { htmlFor: string; label: string; optional?: boolean }) {
  return (
    <Label htmlFor={htmlFor} className="gap-1.5">
      {label}
      {optional && <span className="font-normal text-foreground-muted">(optional)</span>}
    </Label>
  );
}

/**
 * Long-form plain text. The counter appears only near the limit (90%), so
 * writing is not framed as filling in a quota.
 */
export function TextAreaField({
  id,
  label,
  error,
  hint,
  optional,
  maxLength,
  length,
  className,
  ...props
}: ComponentProps<typeof Textarea> & {
  id: string;
  label: string;
  error?: string;
  hint?: string;
  optional?: boolean;
  maxLength: number;
  /** Current length, for the counter (e.g. watch('text').length). */
  length: number;
}) {
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const nearLimit = length >= maxLength * 0.9;
  return (
    <div className="grid gap-2">
      <FieldLabel htmlFor={id} label={label} optional={optional} />
      <Textarea
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={[hintId, errorId].filter(Boolean).join(' ') || undefined}
        className={className}
        {...props}
      />
      <div className="flex justify-between gap-4 text-sm">
        <div className="grid gap-1">
          {hint && (
            <p id={hintId} className="text-foreground-muted">
              {hint}
            </p>
          )}
          {error && (
            <p id={errorId} className="text-danger">
              {error}
            </p>
          )}
        </div>
        {nearLimit && (
          <p aria-live="polite" className={cn('shrink-0 tabular-nums', length > maxLength ? 'text-danger' : 'text-foreground-muted')}>
            {length.toLocaleString('en-AU')} / {maxLength.toLocaleString('en-AU')}
          </p>
        )}
      </div>
    </div>
  );
}

export type Choice = { value: string; label: string; description?: string; icon?: ReactNode };

/**
 * A radio group rendered as cards (content type, release trigger, category).
 * Native radios, so arrow keys, labels and form state all work as usual.
 */
export function ChoiceGroup({
  legend,
  choices,
  registration,
  error,
  className,
}: {
  legend: string;
  choices: Choice[];
  registration: UseFormRegisterReturn;
  error?: string;
  className?: string;
}) {
  return (
    <fieldset className="grid gap-3" aria-invalid={error ? true : undefined}>
      <legend className="mb-3 text-sm font-medium">{legend}</legend>
      <div className={cn('grid gap-3', className)}>
        {choices.map((choice) => (
          <label
            key={choice.value}
            className="flex cursor-pointer items-start gap-3 rounded-lg border border-border bg-surface p-4 transition-colors hover:border-border-strong has-[:checked]:border-primary has-[:checked]:bg-primary-soft has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60"
          >
            <input type="radio" value={choice.value} className="mt-1 size-4 accent-primary" {...registration} />
            <span className="grid gap-1">
              <span className="flex items-center gap-2 font-medium">
                {choice.icon}
                {choice.label}
              </span>
              {choice.description && (
                <span className="text-sm text-foreground-muted">{choice.description}</span>
              )}
            </span>
          </label>
        ))}
      </div>
      {error && <p className="text-sm text-danger">{error}</p>}
    </fieldset>
  );
}

/** Filter chips driven by the URL (?category=…), so filters survive refresh and Back. */
export function FilterChips({
  label,
  chips,
}: {
  label: string;
  chips: { label: string; href: string; active: boolean }[];
}) {
  return (
    <nav aria-label={label} className="-mx-1 mb-8 flex flex-wrap gap-2 px-1">
      {chips.map((chip) => (
        <Link
          key={chip.href}
          href={chip.href}
          scroll={false}
          aria-current={chip.active ? 'true' : undefined}
          className={cn(
            'inline-flex min-h-10 items-center rounded-full border px-4 text-sm outline-none transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
            chip.active
              ? 'border-primary bg-primary text-primary-foreground'
              : 'border-border bg-surface text-foreground-secondary hover:border-border-strong',
          )}
        >
          {chip.label}
        </Link>
      ))}
    </nav>
  );
}
