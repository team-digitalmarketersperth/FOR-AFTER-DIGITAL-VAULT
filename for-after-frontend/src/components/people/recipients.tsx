'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { AlertCircle, ChevronLeft, ChevronRight, Heart, ImagePlus, Pencil, Trash2, UserPlus } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { toast } from 'sonner';
import { FilePick, UploadProgress } from '@/components/media/media-manager';
import { PersonAvatar, PersonCard } from '@/components/people/person-card';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { FormError, TextAreaField, TextField } from '@/components/shared/form-field';
import { PageHeader } from '@/components/shared/page-header';
import { EmptyState, QueryView, Spinner } from '@/components/shared/states';
import { Button } from '@/components/ui/button';
import { useRemoveMedia, useUpload } from '@/hooks/use-media';
import { useUnsavedChanges } from '@/hooks/use-unsaved-changes';
import { recipients } from '@/hooks/use-vault';
import type { MediaScope } from '@/lib/api/media';
import type { Recipient, RecipientInput } from '@/lib/api/people';
import { queryKeys } from '@/lib/query/query-client';
import { formatCalendarDate, fullName } from '@/lib/format';
import { recipientSchema, toNull, type RecipientValues } from '@/schemas/vault';

const addButton = (
  <Button asChild>
    <Link href="/people/new">
      <UserPlus aria-hidden strokeWidth={1.5} />
      Add someone you love
    </Link>
  </Button>
);

export function RecipientList() {
  const [page, setPage] = useState(1);
  const list = recipients.usePage(page);
  const pages = list.data?.pagination.pages ?? 1;
  // Removing the last person on the last page: step back instead of showing an
  // empty page while earlier pages still have people (a guarded update during
  // render, React's pattern for state derived from new data).
  if (list.data && !list.isPlaceholderData && page > Math.max(pages, 1)) setPage(Math.max(pages, 1));
  return (
    <>
      <PageHeader
        eyebrow="People"
        title={<>People <em>I love</em></>}
        description="The people your messages and memories are for."
        action={list.data?.pagination.total ? addButton : undefined}
      />
      <QueryView query={list} loadingLabel="Loading the people you love">
        {({ items: people, pagination }) =>
          pagination.total === 0 ? (
            <EmptyState
              icon={Heart}
              title="No one added yet"
              description="Add the people you'd like to leave something for. You can choose who receives each message later."
              action={addButton}
            />
          ) : (
            <>
              <ul className="grid gap-3 md:grid-cols-2">
                {people.map((p) => (
                  <li key={p.id}>
                    <PersonCard
                      person={p}
                      href={`/people/${p.id}`}
                      photo={{ recipientId: p.id, photoId: p.photoId }}
                      extra={p.birthday ? <span>Birthday {formatCalendarDate(p.birthday)}</span> : undefined}
                    />
                  </li>
                ))}
              </ul>
              {pagination.pages > 1 && (
                <Pager
                  page={pagination.page}
                  pages={pagination.pages}
                  total={pagination.total}
                  loading={list.isPlaceholderData}
                  onPage={setPage}
                />
              )}
            </>
          )
        }
      </QueryView>
    </>
  );
}

/** Understated Previous / Next for People I Love (25 per page). */
function Pager({
  page,
  pages,
  total,
  loading,
  onPage,
}: {
  page: number;
  pages: number;
  total: number;
  loading: boolean;
  onPage: (page: number) => void;
}) {
  return (
    <nav aria-label="People I Love pages" className="mt-8 flex items-center justify-between gap-4 border-t border-border pt-6">
      <Button variant="ghost" size="sm" disabled={page <= 1 || loading} onClick={() => onPage(page - 1)}>
        <ChevronLeft aria-hidden strokeWidth={1.5} />
        Previous
      </Button>
      <p className="text-sm text-foreground-muted" aria-live="polite">
        {loading ? <Spinner className="size-4" /> : `Page ${page} of ${pages} · ${total} people`}
      </p>
      <Button variant="ghost" size="sm" disabled={page >= pages || loading} onClick={() => onPage(page + 1)}>
        Next
        <ChevronRight aria-hidden strokeWidth={1.5} />
      </Button>
    </nav>
  );
}

/**
 * Phase 09: the optional private photo. Upload → verify → it becomes the photo
 * (the old one stays until then); change and remove. Reuses the media uploader
 * (direct PUT to private storage, progress, cancel, retry).
 */
function RecipientPhotoEditor({ recipient }: { recipient: Recipient }) {
  const qc = useQueryClient();
  const scope = useMemo<MediaScope>(() => ({ kind: 'recipients', id: recipient.id }), [recipient.id]);
  const { state, upload, cancel, reset } = useUpload(scope);
  const remove = useRemoveMedia(scope);
  const [lastFile, setLastFile] = useState<File | null>(null);
  const busy = state.phase === 'uploading' || state.phase === 'confirming';
  // The detail, every list page and the picker carry photoId.
  const refresh = () => qc.invalidateQueries({ queryKey: queryKeys.recipients });

  const start = async (file: File) => {
    setLastFile(file);
    const hadPhoto = !!recipient.photoId;
    const photo = await upload('PHOTO', file);
    if (!photo) return;
    await refresh();
    toast.success(hadPhoto ? 'Photo changed' : 'Photo added');
  };

  return (
    <div className="flex flex-col items-center gap-3 sm:w-44 sm:shrink-0">
      <PersonAvatar person={recipient} size="lg" photo={{ recipientId: recipient.id, photoId: recipient.photoId }} />
      {busy ? (
        <UploadProgress state={state} onCancel={cancel} />
      ) : (
        <div className="flex flex-col items-center gap-1">
          <FilePick
            kind="PHOTO"
            label={recipient.photoId ? 'Change photo' : 'Add a photo'}
            icon={<ImagePlus aria-hidden strokeWidth={1.5} />}
            onPick={(_, file) => void start(file)}
          />
          {recipient.photoId && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={remove.isPending}
              onClick={() =>
                remove.mutate(recipient.photoId!, {
                  onSuccess: () => {
                    void refresh();
                    toast.success('Photo removed');
                  },
                })
              }
            >
              {remove.isPending && <Spinner />}
              Remove photo
            </Button>
          )}
        </div>
      )}
      {state.phase === 'failed' && (
        <div role="alert" className="grid w-full gap-2 rounded-md bg-danger/8 px-3 py-2 text-sm text-danger">
          <span className="flex items-start gap-2">
            <AlertCircle aria-hidden className="mt-0.5 size-4 shrink-0" />
            {state.message}
          </span>
          <span className="flex gap-2">
            {lastFile && (
              <Button type="button" size="sm" variant="outline" onClick={() => void start(lastFile)}>
                Try again
              </Button>
            )}
            <Button type="button" size="sm" variant="ghost" onClick={reset}>
              Dismiss
            </Button>
          </span>
        </div>
      )}
      <FormError error={remove.error} />
      <p className="text-center text-xs text-foreground-muted">Private: only you see this photo.</p>
    </div>
  );
}

const NOT_FOUND = { title: 'We couldn’t find this person', backHref: '/people', backLabel: 'Back to People I Love' };

export function RecipientDetail({ id }: { id: string }) {
  const router = useRouter();
  const item = recipients.useItem(id);
  const remove = recipients.useRemove(id);
  return (
    <QueryView query={item} notFound={NOT_FOUND}>
      {(p) => (
        <>
          <PageHeader
            back={{ href: '/people', label: 'People I Love' }}
            title={fullName(p)}
            description={p.relationship ?? undefined}
            action={
              <div className="flex flex-wrap gap-3">
                <Button asChild variant="outline">
                  <Link href={`/people/${p.id}/edit`}>
                    <Pencil aria-hidden strokeWidth={1.5} />
                    Edit
                  </Link>
                </Button>
                <ConfirmDialog
                  trigger={
                    <Button variant="ghost">
                      <Trash2 aria-hidden strokeWidth={1.5} />
                      Remove
                    </Button>
                  }
                  title="Remove this person?"
                  description={`${p.firstName} will no longer appear in People I Love or be available to choose for new messages.`}
                  confirmLabel="Remove"
                  pending={remove.isPending}
                  error={remove.error}
                  onConfirm={() =>
                    remove.mutateAsync().then(() => {
                      toast.success(`${p.firstName} was removed`);
                      router.replace('/people');
                    })
                  }
                />
              </div>
            }
          />
          <section className="flex flex-col gap-8 rounded-xl border border-border bg-surface p-6 sm:flex-row sm:p-10">
            <RecipientPhotoEditor recipient={p} />
            <dl className="grid flex-1 gap-6 sm:grid-cols-2">
              <Detail label="Email" value={p.email} />
              <Detail label="Mobile" value={p.mobile} />
              <Detail label="Birthday" value={p.birthday && formatCalendarDate(p.birthday)} />
              <Detail label="Relationship" value={p.relationship} />
              <div className="sm:col-span-2">
                <Detail label="Private note" value={p.privateNote} multiline />
                <p className="mt-2 text-xs text-foreground-muted">Only you can see this note.</p>
              </div>
            </dl>
          </section>
        </>
      )}
    </QueryView>
  );
}

export function Detail({ label, value, multiline }: { label: string; value: string | null | undefined; multiline?: boolean }) {
  return (
    <div className="grid gap-1">
      <dt className="eyebrow">{label}</dt>
      <dd className={multiline ? 'whitespace-pre-wrap break-words' : 'break-words'}>
        {value || <span className="text-foreground-muted">Not added</span>}
      </dd>
    </div>
  );
}

const toValues = (p?: Recipient): RecipientValues => ({
  firstName: p?.firstName ?? '',
  lastName: p?.lastName ?? '',
  relationship: p?.relationship ?? '',
  email: p?.email ?? '',
  mobile: p?.mobile ?? '',
  birthday: p?.birthday ?? '',
  privateNote: p?.privateNote ?? '',
});

const toInput = (v: RecipientValues): RecipientInput => ({
  firstName: v.firstName.trim(),
  lastName: toNull(v.lastName),
  relationship: toNull(v.relationship),
  email: toNull(v.email),
  mobile: toNull(v.mobile),
  birthday: v.birthday || null,
  privateNote: v.privateNote.trim() ? v.privateNote : null,
});

export function NewRecipient() {
  const router = useRouter();
  const create = recipients.useCreate();
  return (
    <>
      <PageHeader
        back={{ href: '/people', label: 'People I Love' }}
        title={<>Add someone <em>you love</em></>}
        description="Only a first name is needed. Everything else can be added later."
      />
      <RecipientForm
        submitLabel="Add person"
        pending={create.isPending}
        error={create.error}
        onSubmit={(input) =>
          create.mutate(input, {
            onSuccess: (p) => {
              toast.success(`${p.firstName} was added`);
              router.push(`/people/${p.id}`);
            },
          })
        }
      />
    </>
  );
}

export function EditRecipient({ id }: { id: string }) {
  const router = useRouter();
  const item = recipients.useItem(id);
  const update = recipients.useUpdate(id);
  return (
    <QueryView query={item} notFound={NOT_FOUND}>
      {(p) => (
        <>
          <PageHeader back={{ href: `/people/${id}`, label: fullName(p) }} title={<>Edit <em>{p.firstName}</em></>} />
          <RecipientForm
            initial={p}
            submitLabel="Save changes"
            pending={update.isPending}
            error={update.error}
            onSubmit={(input) =>
              update.mutate(input, {
                onSuccess: () => {
                  toast.success('Changes saved');
                  router.push(`/people/${id}`);
                },
              })
            }
          />
        </>
      )}
    </QueryView>
  );
}

function RecipientForm({
  initial,
  submitLabel,
  pending,
  error,
  onSubmit,
}: {
  initial?: Recipient;
  submitLabel: string;
  pending: boolean;
  error: Parameters<typeof FormError>[0]['error'];
  onSubmit: (input: RecipientInput) => void;
}) {
  const form = useForm<RecipientValues>({ resolver: zodResolver(recipientSchema), defaultValues: toValues(initial) });
  const { errors, isDirty, isSubmitSuccessful } = form.formState;
  const privateNote = useWatch({ control: form.control, name: 'privateNote' });
  useUnsavedChanges(isDirty && !isSubmitSuccessful);
  return (
    <form
      noValidate
      onSubmit={form.handleSubmit((v) => !pending && onSubmit(toInput(v)))}
      className="grid max-w-3xl gap-8 rounded-xl border border-border bg-surface p-6 sm:p-10"
    >
      <FormError error={error} />
      <fieldset disabled={pending} className="grid gap-6">
        <div className="grid gap-6 sm:grid-cols-2">
          <TextField id="firstName" label="First name" autoComplete="off" error={errors.firstName?.message} {...form.register('firstName')} />
          <TextField id="lastName" label="Last name" optional autoComplete="off" error={errors.lastName?.message} {...form.register('lastName')} />
        </div>
        <TextField
          id="relationship"
          label="Relationship"
          optional
          placeholder="e.g. Daughter, Partner, Oldest friend"
          error={errors.relationship?.message}
          {...form.register('relationship')}
        />
        <div className="grid gap-6 sm:grid-cols-2">
          <TextField id="email" label="Email" type="email" inputMode="email" optional autoComplete="off" error={errors.email?.message} {...form.register('email')} />
          <TextField id="mobile" label="Mobile" type="tel" inputMode="tel" optional autoComplete="off" error={errors.mobile?.message} {...form.register('mobile')} />
        </div>
        <TextField id="birthday" label="Birthday" type="date" optional className="sm:max-w-60" error={errors.birthday?.message} {...form.register('birthday')} />
        <TextAreaField
          id="privateNote"
          label="Private note"
          optional
          hint="Only you can see this."
          className="min-h-28"
          maxLength={2000}
          length={privateNote.length}
          error={errors.privateNote?.message}
          {...form.register('privateNote')}
        />
      </fieldset>
      <div className="flex flex-wrap gap-3">
        <Button type="submit" disabled={pending}>
          {pending && <Spinner />}
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
