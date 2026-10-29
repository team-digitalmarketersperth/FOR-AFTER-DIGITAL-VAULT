'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { ArrowRight, Lock, UserPlus } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useRef, useState, type ReactNode } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { toast } from 'sonner';
import { CONTENT_TYPE_INFO } from '@/components/messages/message-bits';
import { PersonAvatar } from '@/components/people/person-card';
import { AutosaveStatus, RecoveryNotice } from '@/components/shared/draft-recovery';
import { HelpMeWrite } from '@/components/companion/companion';
import { ChoiceGroup, FormError, TextAreaField, TextField } from '@/components/shared/form-field';
import { PageHeader } from '@/components/shared/page-header';
import { PrivateNoteField } from '@/components/shared/private-note';
import { ListSkeleton, QueryView, Spinner } from '@/components/shared/states';
import { Button } from '@/components/ui/button';
import { useDraftEditor } from '@/hooks/use-draft-editor';
import { useUnsavedChanges } from '@/hooks/use-unsaved-changes';
import { messages, recipients } from '@/hooks/use-vault';
import type { ApiError } from '@/lib/api/errors';
import { CONTENT_TYPES, TEXT_CONTENT_MAX, type Message, type MessageInput } from '@/lib/api/messages';
import { fullName } from '@/lib/format';
import { messageSchema, type MessageValues } from '@/schemas/vault';

/** What happens after the draft is created: open it, or open it at its schedule panel. */
type Intent = 'save' | 'schedule';

/** Where this editor's unsaved changes are autosaved (server-side). */
type DraftTarget = { type: 'MESSAGE'; key: string; baseRevision: string } | { type: 'NEW_MESSAGE' };

export function NewMessage() {
  const router = useRouter();
  const create = messages.useCreate();
  // The action in flight. It stays set after success, through navigation, so
  // neither button comes back to life; only a failure releases it.
  const [inFlight, setInFlight] = useState<Intent | null>(null);
  // Synchronous guard: two quick clicks can both pass validation before React re-renders.
  const locked = useRef(false);
  return (
    <>
      <PageHeader
        back={{ href: '/messages', label: 'Messages' }}
        title={<>Write a <em>message</em></>}
        description="It stays a private draft. You can add photos or your voice and choose when it is shared on the next page."
      />
      <MessageForm
        draft={{ type: 'NEW_MESSAGE' }}
        submitLabel="Save draft"
        continueLabel="Continue to schedule"
        pending={inFlight !== null}
        pendingIntent={inFlight}
        error={create.error}
        onSubmit={(input, intent) => {
          if (locked.current) return;
          locked.current = true;
          setInFlight(intent);
          create.mutate(input, {
            onSuccess: (m) => {
              toast.success('Draft saved');
              // Always the id the API returned; the detail page then focuses its schedule panel.
              router.push(intent === 'schedule' ? `/messages/${m.id}?focus=schedule` : `/messages/${m.id}`);
            },
            onError: () => {
              locked.current = false;
              setInFlight(null);
            },
          });
        }}
      />
    </>
  );
}

export function EditMessage({ id }: { id: string }) {
  const router = useRouter();
  const item = messages.useItem(id);
  const update = messages.useUpdate(id);
  return (
    <QueryView
      query={item}
      notFound={{ title: 'We couldn’t find this message', backHref: '/messages', backLabel: 'Back to Messages' }}
    >
      {(m) => (
        <>
          <PageHeader back={{ href: `/messages/${id}`, label: m.title }} title={<>Edit <em>message</em></>} />
          {m.status === 'DRAFT' ? (
            <MessageForm
              initial={m}
              draft={{ type: 'MESSAGE', key: m.id, baseRevision: String(m.version) }}
              submitLabel="Save changes"
              pending={update.isPending}
              error={update.error}
              onSubmit={(input) =>
                update.mutate(input, {
                  onSuccess: () => {
                    toast.success('Changes saved');
                    router.push(`/messages/${id}`);
                  },
                })
              }
            />
          ) : (
            <LockedNotice message={m} />
          )}
        </>
      )}
    </QueryView>
  );
}

/** Never unschedules silently: it explains and points to the explicit action. */
export function LockedNotice({ message: m }: { message: Message }) {
  const scheduled = m.status === 'SCHEDULED';
  return (
    <section role="status" className="flex max-w-2xl gap-4 rounded-xl bg-primary-soft p-6 sm:p-8">
      <Lock aria-hidden strokeWidth={1.5} className="mt-1 size-5 shrink-0 text-primary" />
      <div className="grid gap-3">
        <h2 className="text-2xl">{scheduled ? 'This message is scheduled' : 'This message can no longer be changed'}</h2>
        <p className="text-foreground-secondary">
          {scheduled
            ? 'Scheduled messages are locked so they are shared exactly as you left them. To make changes, unschedule it first: it goes back to being a draft, and nothing in it is deleted.'
            : 'Released messages are kept exactly as they were shared.'}
        </p>
        <div>
          <Button asChild variant={scheduled ? 'default' : 'outline'}>
            <Link href={`/messages/${m.id}`}>{scheduled ? 'Go to the message to unschedule' : 'Back to the message'}</Link>
          </Button>
        </div>
      </div>
    </section>
  );
}

function MessageForm({
  initial,
  draft,
  submitLabel,
  continueLabel,
  pending,
  pendingIntent,
  error,
  onSubmit,
}: {
  initial?: Message;
  draft: DraftTarget;
  submitLabel: string;
  /** Adds a primary "save, then go to scheduling" action beside the save button (new drafts only). */
  continueLabel?: string;
  pending: boolean;
  pendingIntent?: Intent | null;
  error: ApiError | null;
  onSubmit: (input: MessageInput, intent: Intent) => void;
}) {
  // Set by whichever button was activated (Enter in a field activates the first: Save).
  const intent = useRef<Intent>('save');
  const form = useForm<MessageValues>({
    resolver: zodResolver(messageSchema),
    defaultValues: {
      title: initial?.title ?? '',
      contentType: initial?.contentType ?? 'TEXT',
      textContent: initial?.textContent ?? '',
      privateNote: initial?.privateNote ?? '',
      recipientIds: initial?.recipients.map((r) => r.id) ?? [],
    },
  });
  const { errors, isDirty, isSubmitSuccessful, isSubmitting } = form.formState;
  const busy = pending || isSubmitting;
  useUnsavedChanges(isDirty && !isSubmitSuccessful);
  const [title, contentType, text, selected, note] = useWatch({
    control: form.control,
    name: ['title', 'contentType', 'textContent', 'recipientIds', 'privateNote'],
  });
  const wantsText = contentType === 'TEXT' || contentType === 'MIXED';
  // Autosave covers the words only (title, type, text); people and media are saved by Save / uploads.
  const { defaultValues: start } = form.formState;
  const editor = useDraftEditor({
    type: draft.type,
    draftKey: draft.type === 'MESSAGE' ? draft.key : null,
    baseRevision: draft.type === 'MESSAGE' ? draft.baseRevision : 'none',
    saved: { title: start?.title ?? '', contentType: start?.contentType ?? 'TEXT', textContent: start?.textContent ?? '' },
    current: { title, contentType, textContent: text },
    active: !busy && !isSubmitSuccessful,
  });

  const toggle = (id: string) =>
    form.setValue(
      'recipientIds',
      selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id],
      { shouldDirty: true, shouldValidate: form.formState.isSubmitted },
    );

  return (
    <>
    <RecoveryNotice
      editor={editor}
      describe={(p) => ({ title: p.title, text: p.textContent })}
      onRestore={(v) => {
        const opts = { shouldDirty: true, shouldValidate: form.formState.isSubmitted };
        form.setValue('title', v.title, opts);
        form.setValue('contentType', v.contentType as MessageValues['contentType'], opts);
        form.setValue('textContent', v.textContent, opts);
      }}
    />
    <form
      noValidate
      onSubmit={(event) => {
        // Captured at submit time, i.e. which button was activated.
        const next = intent.current;
        return form.handleSubmit(
          (v) =>
            !pending &&
            onSubmit(
              {
                title: v.title.trim(),
                contentType: v.contentType,
                // Kept as written (outer whitespace only); blank means no text.
                textContent: v.textContent.trim() ? v.textContent : null,
                privateNote: v.privateNote.trim() || null,
                recipientIds: v.recipientIds,
                // A new message's save also clears its autosave.
                ...(draft.type === 'NEW_MESSAGE' && editor.draftKey() ? { recoveryDraftKey: editor.draftKey()! } : {}),
              },
              next,
            ),
        )(event);
      }}
      className="grid max-w-3xl gap-10"
    >
      <FormError error={error} />
      <fieldset disabled={pending} className="grid gap-10">
        <Section title="Who is it for?">
          <RecipientChecklist selected={selected} onToggle={toggle} error={errors.recipientIds?.message} />
        </Section>

        <Section title="What kind of message?">
          <ChoiceGroup
            legend="Message type"
            className="sm:grid-cols-2"
            registration={form.register('contentType')}
            choices={CONTENT_TYPES.map((t) => {
              const info = CONTENT_TYPE_INFO[t];
              return {
                value: t,
                label: info.label,
                description: info.description,
                icon: <info.icon aria-hidden strokeWidth={1.5} className="size-4 text-primary" />,
              };
            })}
          />
        </Section>

        <Section title="Your words">
          <TextField id="title" label="Title" placeholder="e.g. For your 18th birthday" error={errors.title?.message} {...form.register('title')} />
          {wantsText || text.trim() ? (
            <div className="grid gap-2">
            {/* Only the message text: never the title, people, private note or files. */}
            <HelpMeWrite
              targetKey={`message:${initial?.id ?? 'new'}:textContent`}
              question={title.trim() || 'Your message'}
              field="Message"
              save={submitLabel}
              read={() => form.getValues('textContent')}
              write={(v) => form.setValue('textContent', v, { shouldDirty: true, shouldValidate: form.formState.isSubmitted })}
              className="justify-self-end"
            />
            <TextAreaField
              id="textContent"
              label="Message"
              optional={contentType === 'MIXED'}
              hint={
                wantsText
                  ? 'Plain text. Take your time; you can come back to a draft.'
                  : `${CONTENT_TYPE_INFO[contentType].label} messages can’t include written text. Clear it, or choose Mixed.`
              }
              maxLength={TEXT_CONTENT_MAX}
              length={text.length}
              error={errors.textContent?.message}
              {...form.register('textContent')}
            />
            </div>
          ) : (
            <p className="text-sm text-foreground-muted">
              You&apos;ll add {contentType === 'PHOTO' ? 'photos' : contentType === 'VIDEO' ? 'your video' : 'your recording'}{' '}
              after saving the draft.
            </p>
          )}
        </Section>

        {/* Not part of the message: never shared, released or autosaved. */}
        <PrivateNoteField
          id="privateNote"
          placeholder="Why did you create this message, or what would you like to remember later?"
          length={note.length}
          error={errors.privateNote?.message}
          {...form.register('privateNote')}
        />
      </fieldset>
      {continueLabel ? (
        // DOM order keeps Save first (the Enter-key default); on phones the primary action sits on top.
        <div className="flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-end">
          <span className="sm:mr-auto">
            <AutosaveStatus editor={editor} />
          </span>
          <Button
            type="submit"
            size="lg"
            variant="outline"
            disabled={busy}
            aria-busy={pendingIntent === 'save' || undefined}
            onClick={() => (intent.current = 'save')}
          >
            {pendingIntent === 'save' && <Spinner />}
            {pendingIntent === 'save' ? 'Saving…' : submitLabel}
          </Button>
          <Button
            type="submit"
            size="lg"
            disabled={busy}
            aria-busy={pendingIntent === 'schedule' || undefined}
            onClick={() => (intent.current = 'schedule')}
          >
            {pendingIntent === 'schedule' && <Spinner />}
            {pendingIntent === 'schedule' ? 'Saving…' : continueLabel}
            {pendingIntent !== 'schedule' && <ArrowRight aria-hidden strokeWidth={1.5} />}
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-4">
          <Button type="submit" size="lg" disabled={busy}>
            {pending && <Spinner />}
            {submitLabel}
          </Button>
          <AutosaveStatus editor={editor} />
        </div>
      )}
    </form>
    </>
  );
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="grid gap-5 rounded-xl border border-border bg-surface p-6 sm:p-8">
      <h2 className="text-2xl">{title}</h2>
      {children}
    </section>
  );
}

/**
 * The People I Love checklist used wherever a Message is written (new/edit
 * message, a message from a memory). Messages always have at least one person.
 */
export function RecipientChecklist({
  selected,
  onToggle,
  error,
}: {
  selected: string[];
  onToggle: (id: string) => void;
  error?: string;
}) {
  const people = recipients.useList();
  return (
    <>
    {people.isPending ? (
      <ListSkeleton rows={2} label="Loading the people you love" />
    ) : people.data?.length ? (
      <div role="group" aria-label="Recipients" aria-describedby={error ? 'recipients-error' : undefined} className="grid gap-3 sm:grid-cols-2">
        {people.data.map((p) => (
          <label
            key={p.id}
            className="flex cursor-pointer items-center gap-3 rounded-lg border border-border bg-surface p-4 transition-colors hover:border-border-strong has-[:checked]:border-primary has-[:checked]:bg-primary-soft has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring"
          >
            <input
              type="checkbox"
              className="size-4 accent-primary"
              checked={selected.includes(p.id)}
              onChange={() => onToggle(p.id)}
            />
            <PersonAvatar person={p} />
            <span className="grid">
              <span className="font-medium">{fullName(p)}</span>
              {p.relationship && <span className="text-sm text-foreground-muted">{p.relationship}</span>}
            </span>
          </label>
        ))}
      </div>
    ) : (
      <div className="flex flex-col items-start gap-3 rounded-lg border border-dashed border-border-strong bg-surface p-6">
        <p className="text-foreground-secondary">
          Messages are written for someone. Add a person to People I Love first.
        </p>
        <Button asChild variant="outline" size="sm">
          <Link href="/people/new">
            <UserPlus aria-hidden strokeWidth={1.5} />
            Add someone you love
          </Link>
        </Button>
      </div>
    )}
    {error && (
      <p id="recipients-error" className="text-sm text-danger">
        {error}
      </p>
    )}
    </>
  );
}
