'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { Mail, ShieldCheck, Trash2, UserPlus } from 'lucide-react';
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
import {
  MAX_TRUSTED_CONTACTS,
  type InvitationStatus,
  type TrustedContact,
  type TrustedContactInput,
} from '@/lib/api/people';
import { formatDate, fullName } from '@/lib/format';
import { cn } from '@/lib/utils';
import { toNull, trustedContactSchema, type TrustedContactValues } from '@/schemas/vault';

const addButton = (
  <Button asChild>
    <Link href="/trusted-contacts/new">
      <UserPlus aria-hidden strokeWidth={1.5} />
      Add a trusted contact
    </Link>
  </Button>
);

const LIMIT_COPY = `You can nominate up to ${MAX_TRUSTED_CONTACTS} trusted contacts.`;

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
          Being a trusted contact does not give them access to your messages, memories or wishes. If you add an
          email address, we&apos;ll email them an invitation explaining the role. {LIMIT_COPY}
        </p>
      </div>
    </aside>
  );
}

/** Phase 10: the email invitation, in plain words. SMS invitations are deferred. */
export const INVITATION_COPY: Record<InvitationStatus, { label: string; description: string }> = {
  PENDING: {
    label: 'Invitation pending',
    description: 'We’ve emailed an invitation. It’s waiting for their answer.',
  },
  ACCEPTED: { label: 'Invitation accepted', description: 'They’ve accepted the invitation.' },
  DECLINED: {
    label: 'Invitation declined',
    description: 'They declined the invitation. You can send it again, or choose someone else.',
  },
  EXPIRED: {
    label: 'Invitation expired',
    description: 'The invitation expired before they answered. You can send a new one.',
  },
  NOT_SENT: { label: 'Invitation not sent', description: 'No invitation has been sent to this email address yet.' },
  UNAVAILABLE: {
    label: 'No invitation',
    description:
      'Invitations are sent by email, and this contact only has a mobile number. Text-message invitations aren’t available yet, so please let them know yourself, or add an email address.',
  },
};

export function InvitationBadge({ status }: { status: InvitationStatus }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium',
        status === 'ACCEPTED' ? 'bg-success/10 text-success' : 'border border-border bg-surface-muted text-foreground-secondary',
      )}
    >
      {INVITATION_COPY[status].label}
    </span>
  );
}

const canSend = (status: InvitationStatus) => status !== 'ACCEPTED' && status !== 'UNAVAILABLE';

/** Status + send/resend for one contact. The API decides; this only offers what it allows. */
function InvitationPanel({ contact }: { contact: TrustedContact }) {
  const invite = trustedContacts.useInvite(contact.id);
  const { status, sentAt } = contact.invitation;
  return (
    <section
      aria-labelledby="invitation-heading"
      className="mb-8 grid max-w-3xl gap-3 rounded-xl border border-border bg-surface p-6 sm:p-8"
    >
      <div className="flex flex-wrap items-center gap-3">
        <h2 id="invitation-heading" className="text-2xl">
          Invitation
        </h2>
        <InvitationBadge status={status} />
      </div>
      <p className="text-[15px] text-foreground-secondary">
        {INVITATION_COPY[status].description}
        {sentAt && status !== 'ACCEPTED' && <> Sent {formatDate(sentAt)}.</>}
      </p>
      <FormError error={invite.error} />
      {canSend(status) && (
        <div>
          <Button
            variant="outline"
            disabled={invite.isPending}
            onClick={() =>
              invite.mutate(undefined, {
                onSuccess: () => toast.success(`Invitation sent to ${contact.firstName}`),
              })
            }
          >
            {invite.isPending ? <Spinner /> : <Mail aria-hidden strokeWidth={1.5} />}
            {status === 'NOT_SENT' ? 'Send invitation' : 'Resend invitation'}
          </Button>
        </div>
      )}
    </section>
  );
}

export function TrustedContactList() {
  const list = trustedContacts.useList();
  const atLimit = (list.data?.length ?? 0) >= MAX_TRUSTED_CONTACTS;
  return (
    <>
      <PageHeader
        eyebrow="People"
        title={<>Trusted <em>contacts</em></>}
        description="People you trust to let us know when the time comes."
        action={list.data?.length && !atLimit ? addButton : undefined}
      />
      <RoleExplainer />
      <QueryView query={list} loadingLabel="Loading your trusted contacts">
        {(contacts) =>
          contacts.length === 0 ? (
            <EmptyState
              icon={ShieldCheck}
              title="No trusted contacts yet"
              description={`Choose people you trust, such as a partner, a close friend or a family member. ${LIMIT_COPY}`}
              action={addButton}
            />
          ) : (
            <div className="grid gap-6">
              <ul className="grid gap-3 md:grid-cols-2">
                {contacts.map((c) => (
                  <li key={c.id}>
                    <PersonCard
                      person={c}
                      href={`/trusted-contacts/${c.id}/edit`}
                      extra={<InvitationBadge status={c.invitation.status} />}
                    />
                  </li>
                ))}
              </ul>
              {atLimit && (
                <p role="note" className="text-[15px] text-foreground-muted">
                  {LIMIT_COPY} To choose someone else, open a contact and remove them first.
                </p>
              )}
            </div>
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

const addedToast = (c: TrustedContact) =>
  c.invitation.status === 'PENDING'
    ? `${c.firstName} was added and we’ve emailed them an invitation`
    : c.invitation.status === 'NOT_SENT'
      ? `${c.firstName} was added. We couldn’t send the invitation; you can resend it from their page`
      : `${c.firstName} was added`;

export function NewTrustedContact() {
  const router = useRouter();
  const list = trustedContacts.useList();
  const create = trustedContacts.useCreate();
  const back = { href: '/trusted-contacts', label: 'Trusted Contacts' };
  // Reached directly at the limit: explain instead of a form the API would refuse.
  if (!create.isSuccess && (list.data?.length ?? 0) >= MAX_TRUSTED_CONTACTS) {
    return (
      <>
        <PageHeader back={back} title={<>Add a <em>trusted contact</em></>} />
        <EmptyState
          icon={ShieldCheck}
          title="You’ve reached the limit"
          description={`${LIMIT_COPY} To choose someone else, remove one of your current trusted contacts first.`}
          action={
            <Button asChild variant="outline">
              <Link href={back.href}>Back to Trusted Contacts</Link>
            </Button>
          }
        />
      </>
    );
  }
  return (
    <>
      <PageHeader
        back={back}
        title={<>Add a <em>trusted contact</em></>}
        description="A first name and one way to reach them (email or mobile) are needed. With an email, we’ll send them an invitation."
      />
      <TrustedContactForm
        submitLabel="Add trusted contact"
        pending={create.isPending}
        error={create.error}
        onSubmit={(input) =>
          create.mutate(input, {
            onSuccess: (c) => {
              toast.success(addedToast(c));
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
          <InvitationPanel contact={c} />
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
