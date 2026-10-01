'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { ShieldCheck, Trash2, UserPlus } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { PersonCard } from '@/components/people/person-card';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { FormError, TextField } from '@/components/shared/form-field';
import { PageHeader } from '@/components/shared/page-header';
import { EmptyState, QueryView, Spinner } from '@/components/shared/states';
import { Button } from '@/components/ui/button';
import { useUnsavedChanges } from '@/hooks/use-unsaved-changes';
import { trustedContacts } from '@/hooks/use-vault';
import type { TrustedContact, TrustedContactInput } from '@/lib/api/people';
import { fullName } from '@/lib/format';
import { toNull, trustedContactSchema, type TrustedContactValues } from '@/schemas/vault';

const addButton = (
  <Button asChild>
    <Link href="/trusted-contacts/new">
      <UserPlus aria-hidden strokeWidth={1.5} />
      Add a trusted contact
    </Link>
  </Button>
);

/** What the role means, matching what the product actually does today. */
function RoleExplainer() {
  return (
    <aside className="mb-10 flex gap-4 rounded-xl bg-primary-soft p-6 sm:p-8">
      <ShieldCheck aria-hidden strokeWidth={1.5} className="mt-1 size-6 shrink-0 text-primary" />
      <div className="grid gap-2 text-[15px] leading-relaxed text-foreground-secondary">
        <p>
          A trusted contact can let For After know if you pass away. A report is never enough on its own:
          our team verifies every report before any message is released.
        </p>
        <p>
          Being a trusted contact does not give them access to your messages, memories or wishes. For After
          doesn&apos;t contact them yet, so let them know you&apos;ve chosen them.
        </p>
      </div>
    </aside>
  );
}

export function TrustedContactList() {
  const list = trustedContacts.useList();
  return (
    <>
      <PageHeader
        eyebrow="People"
        title={<>Trusted <em>contacts</em></>}
        description="People you trust to let us know when the time comes."
        action={list.data?.length ? addButton : undefined}
      />
      <RoleExplainer />
      <QueryView query={list} loadingLabel="Loading your trusted contacts">
        {(contacts) =>
          contacts.length === 0 ? (
            <EmptyState
              icon={ShieldCheck}
              title="No trusted contacts yet"
              description="Choose one or two people you trust, such as a partner, a close friend or a family member."
              action={addButton}
            />
          ) : (
            <ul className="grid gap-3 md:grid-cols-2">
              {contacts.map((c) => (
                <li key={c.id}>
                  <PersonCard person={c} href={`/trusted-contacts/${c.id}/edit`} />
                </li>
              ))}
            </ul>
          )
        }
      </QueryView>
    </>
  );
}

const toValues = (c?: TrustedContact): TrustedContactValues => ({
  firstName: c?.firstName ?? '',
  lastName: c?.lastName ?? '',
  relationship: c?.relationship ?? '',
  email: c?.email ?? '',
  mobile: c?.mobile ?? '',
});

const toInput = (v: TrustedContactValues): TrustedContactInput => ({
  firstName: v.firstName.trim(),
  lastName: toNull(v.lastName),
  relationship: toNull(v.relationship),
  email: toNull(v.email),
  mobile: toNull(v.mobile),
});

export function NewTrustedContact() {
  const router = useRouter();
  const create = trustedContacts.useCreate();
  return (
    <>
      <PageHeader
        back={{ href: '/trusted-contacts', label: 'Trusted Contacts' }}
        title={<>Add a <em>trusted contact</em></>}
        description="A first name and one way to reach them (email or mobile) are needed."
      />
      <TrustedContactForm
        submitLabel="Add trusted contact"
        pending={create.isPending}
        error={create.error}
        onSubmit={(input) =>
          create.mutate(input, {
            onSuccess: (c) => {
              toast.success(`${c.firstName} was added`);
              router.push('/trusted-contacts');
            },
          })
        }
      />
    </>
  );
}

export function EditTrustedContact({ id }: { id: string }) {
  const router = useRouter();
  const item = trustedContacts.useItem(id);
  const update = trustedContacts.useUpdate(id);
  const remove = trustedContacts.useRemove(id);
  return (
    <QueryView
      query={item}
      notFound={{ title: 'We couldn’t find this trusted contact', backHref: '/trusted-contacts', backLabel: 'Back to Trusted Contacts' }}
    >
      {(c) => (
        <>
          <PageHeader
            back={{ href: '/trusted-contacts', label: 'Trusted Contacts' }}
            title={fullName(c)}
            description={c.relationship ?? 'Trusted contact'}
            action={
              <ConfirmDialog
                trigger={
                  <Button variant="ghost">
                    <Trash2 aria-hidden strokeWidth={1.5} />
                    Remove
                  </Button>
                }
                title="Remove this trusted contact?"
                description={`${c.firstName} will no longer be one of your trusted contacts, and won't be able to report on your behalf.`}
                confirmLabel="Remove"
                pending={remove.isPending}
                error={remove.error}
                onConfirm={() =>
                  remove.mutateAsync().then(() => {
                    toast.success(`${c.firstName} was removed`);
                    router.replace('/trusted-contacts');
                  })
                }
              />
            }
          />
          <TrustedContactForm
            initial={c}
            submitLabel="Save changes"
            pending={update.isPending}
            error={update.error}
            onSubmit={(input) =>
              update.mutate(input, {
                onSuccess: () => {
                  toast.success('Changes saved');
                  router.push('/trusted-contacts');
                },
              })
            }
          />
        </>
      )}
    </QueryView>
  );
}

function TrustedContactForm({
  initial,
  submitLabel,
  pending,
  error,
  onSubmit,
}: {
  initial?: TrustedContact;
  submitLabel: string;
  pending: boolean;
  error: Parameters<typeof FormError>[0]['error'];
  onSubmit: (input: TrustedContactInput) => void;
}) {
  const form = useForm<TrustedContactValues>({
    resolver: zodResolver(trustedContactSchema),
    defaultValues: toValues(initial),
  });
  const { errors, isDirty, isSubmitSuccessful } = form.formState;
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
          placeholder="e.g. Sister, Best friend"
          error={errors.relationship?.message}
          {...form.register('relationship')}
        />
        <div className="grid gap-6 sm:grid-cols-2">
          <TextField
            id="email"
            label="Email"
            type="email"
            inputMode="email"
            autoComplete="off"
            hint="Email or mobile: at least one is needed."
            error={errors.email?.message}
            {...form.register('email')}
          />
          <TextField id="mobile" label="Mobile" type="tel" inputMode="tel" autoComplete="off" error={errors.mobile?.message} {...form.register('mobile')} />
        </div>
      </fieldset>
      <div>
        <Button type="submit" disabled={pending}>
          {pending && <Spinner />}
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
