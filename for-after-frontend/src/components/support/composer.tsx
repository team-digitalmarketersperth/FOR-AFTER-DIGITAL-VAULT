'use client';

import { useState, type FormEvent } from 'react';
import { FormError, TextAreaField } from '@/components/shared/form-field';
import { Spinner } from '@/components/shared/states';
import { Button } from '@/components/ui/button';
import type { ApiError } from '@/lib/api/errors';
import { TEXT_MAX, type SupportTextInput } from '@/lib/api/support';

/**
 * One plain-text submission. The submission id stays the same for this draft,
 * so a retry after a network error can never post twice; the text is kept on
 * failure and cleared only once the API has saved it.
 */
export function Composer({
  id,
  label,
  hint,
  submitLabel,
  onSubmit,
  pending,
  error,
  placeholder,
  compact,
}: {
  id: string;
  label: string;
  hint: string;
  submitLabel: string;
  onSubmit: (input: SupportTextInput) => Promise<unknown>;
  pending: boolean;
  error: ApiError | null;
  placeholder?: string;
  /** A short box that grows with the text (admin workspace). */
  compact?: boolean;
}) {
  const [body, setBody] = useState('');
  const [clientRequestId, setClientRequestId] = useState(() => crypto.randomUUID());
  const [invalid, setInvalid] = useState<string>();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (pending) return;
    const text = body.trim();
    if (!text) return setInvalid('Write something first.');
    if (text.length > TEXT_MAX) return setInvalid(`Keep it to ${TEXT_MAX.toLocaleString('en-AU')} characters.`);
    setInvalid(undefined);
    try {
      await onSubmit({ clientRequestId, body: text });
      setBody('');
      setClientRequestId(crypto.randomUUID());
    } catch {
      // Shown through `error`; the text and its submission id are kept for a retry.
    }
  };
  return (
    <form onSubmit={submit} noValidate className="grid gap-3">
      <TextAreaField
        id={id}
        label={label}
        hint={hint}
        error={invalid}
        maxLength={TEXT_MAX}
        length={body.length}
        rows={compact ? 3 : 4}
        placeholder={placeholder}
        className={compact ? 'min-h-24' : undefined}
        value={body}
        onChange={(e) => setBody(e.target.value)}
      />
      <FormError error={error} />
      <Button type="submit" disabled={pending} className={compact ? 'w-fit justify-self-end' : 'w-fit'}>
        {pending && <Spinner />}
        {submitLabel}
      </Button>
    </form>
  );
}
