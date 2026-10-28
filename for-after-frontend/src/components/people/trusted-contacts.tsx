'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import {
  Check,
  ChevronDown,
  CircleAlert,
  Clock,
  Mail,
  MessageSquareText,
  ShieldCheck,
  Trash2,
  UserPlus,
  type LucideIcon,
} from 'lucide-react';
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
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { useUnsavedChanges } from '@/hooks/use-unsaved-changes';
import { trustedContacts } from '@/hooks/use-vault';
import {
  type InvitationChannel,
  MAX_TRUSTED_CONTACTS,
  type ReadinessStatus,
  type TrustedContact,
  type TrustedContactInput,
  type TrustedContactReadiness,
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
          Being a trusted contact does not give them access to your messages, memories or wishes. We&apos;ll send
          them an invitation explaining the role, by email or by SMS, whichever you choose. {LIMIT_COPY}
        </p>
      </div>
    </aside>
  );
}

/**
 * Trusted Contact readiness (setup health), as the API derives it. Ready means
 * they accepted the invitation sent to their current email or mobile; it says nothing
 * about reports or verification. Icon + words, never colour alone.
 */
const STATUS: Record<ReadinessStatus, { label: string; icon: LucideIcon; tone: string }> = {
  READY: { label: 'Ready', icon: Check, tone: 'text-primary' },
  INVITATION_PENDING: { label: 'Invitation pending', icon: Clock, tone: 'text-foreground-secondary' },
  INVITATION_EXPIRED: { label: 'Invitation expired', icon: CircleAlert, tone: 'text-warning' },
  ACTION_NEEDED: { label: 'Needs attention', icon: CircleAlert, tone: 'text-warning' },
};
const REASON_LABEL = { NOT_SENT: 'Invitation not sent', DECLINED: 'Invitation declined' };
const CHANNEL_WORD: Record<InvitationChannel, string> = { EMAIL: 'email', SMS: 'SMS' };

const statusLabel = (r: TrustedContactReadiness) => (r.reason ? REASON_LABEL[r.reason] : STATUS[r.status].label);

/** One calm sentence: what is done, or what would help. Names the channel, never the address. */
export function readinessDetail(r: TrustedContactReadiness, channel?: InvitationChannel | null): string {
  const by = channel ? ` by ${CHANNEL_WORD[channel]}` : '';
  switch (r.reason ?? r.status) {
    case 'READY':
      return r.invitationAcceptedAt ? `Setup complete. Invitation accepted ${formatDate(r.invitationAcceptedAt)}.` : 'Setup complete.';
    case 'INVITATION_PENDING':
      return `Waiting for them to accept your invitation${r.invitationSentAt ? `, sent${by} on ${formatDate(r.invitationSentAt)}` : ''}.`;
    case 'INVITATION_EXPIRED':
      return 'The invitation expired before they answered. Send a fresh invitation to continue.';
    case 'DECLINED':
      return 'They declined the invitation. You can invite them again, or choose someone else.';
    default:
      return 'No invitation has reached them yet.';
  }
}

export function ReadinessLabel({ readiness }: { readiness: TrustedContactReadiness }) {
  const { icon: Icon, tone } = STATUS[readiness.status];
  return (
    <span className={cn('inline-flex items-center gap-1.5 font-medium', tone)}>
      <Icon aria-hidden strokeWidth={1.75} className="size-4" />
      {statusLabel(readiness)}
    </span>
  );
}

const CHANNEL_ICON: Record<InvitationChannel, LucideIcon> = { EMAIL: Mail, SMS: MessageSquareText };

/**
 * Send / resend through the existing endpoint (the API keeps its rate limits and
 * refuses once accepted). The Customer picks the channel: only the ones this
 * contact has an address for are offered, and with both a quiet menu asks.
 */
function InviteButton({ contact }: { contact: TrustedContact }) {
  const invite = trustedContacts.useInvite(contact.id);
  const { status, reason } = contact.readiness;
  if (status === 'READY') return null;
  const channels: InvitationChannel[] = [];
  if (contact.email) channels.push('EMAIL');
  if (contact.mobile) channels.push('SMS');
  const base =
    status === 'INVITATION_PENDING' ? 'Resend invitation' : reason === 'NOT_SENT' ? 'Send invitation' : 'Send a new invitation';
  const send = (channel: InvitationChannel) =>
    invite.mutate(channel, {
      onSuccess: () => toast.success(`Invitation sent to ${contact.firstName} by ${CHANNEL_WORD[channel]}`),
    });
  const only = channels.length === 1 ? channels[0] : null;
  const Icon = only ? CHANNEL_ICON[only] : Mail;
  return (
    <span className="grid justify-items-start gap-1">
      {only ? (
        <Button variant="outline" size="sm" disabled={invite.isPending} onClick={() => send(only)}>
          {invite.isPending ? <Spinner /> : <Icon aria-hidden strokeWidth={1.5} />}
          {only === 'SMS' ? `${base} by SMS` : base}
        </Button>
      ) : (
        <DropdownMenu>
          <DropdownMenuTrigger asChild disabled={invite.isPending}>
            <Button variant="outline" size="sm">
              {invite.isPending ? <Spinner /> : <Icon aria-hidden strokeWidth={1.5} />}
              {base}
              <ChevronDown aria-hidden strokeWidth={1.5} className="text-foreground-muted" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="w-auto min-w-44 rounded-xl p-1.5 shadow-soft ring-border">
            {channels.map((channel) => {
              const ItemIcon = CHANNEL_ICON[channel];
              return (
                <DropdownMenuItem
                  key={channel}
                  onSelect={() => send(channel)}
                  className="min-h-10 gap-2.5 rounded-md px-3 text-[15px] text-foreground-secondary"
                >
                  <ItemIcon aria-hidden strokeWidth={1.5} className="size-[18px]" />
                  Send by {CHANNEL_WORD[channel]}
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {invite.error && (
        <span role="alert" className="text-sm text-danger">
          {invite.error.message}
        </span>
      )}
    </span>
  );
}

/** Status + send/resend on the contact's own page. The API decides; this only offers what it allows. */
function InvitationPanel({ contact }: { contact: TrustedContact }) {
  return (
    <section
      aria-labelledby="invitation-heading"
      className="mb-8 grid max-w-3xl gap-3 rounded-xl border border-border bg-surface p-6 sm:p-8"
    >
      <div className="flex flex-wrap items-center gap-3">
        <h2 id="invitation-heading" className="text-2xl">
          Setup
        </h2>
        <ReadinessLabel readiness={contact.readiness} />
      </div>
      <p className="text-[15px] text-foreground-secondary">{readinessDetail(contact.readiness, contact.invitation.channel)}</p>
      <div>
        <InviteButton contact={contact} />
      </div>
    </section>
  );
}

/** One line above the cards; one contact is a complete setup too. */
function ReadinessSummary({ contacts }: { contacts: TrustedContact[] }) {
  const ready = contacts.filter((c) => c.readiness.status === 'READY').length;
  const n = contacts.length;
  const text =
    ready === n
      ? n === 1
        ? 'Your trusted contact is ready.'
        : 'Both trusted contacts are ready.'
      : ready
        ? `${ready} of ${n} trusted contacts ready. One needs attention.`
        : n === 1
          ? 'Your trusted contact isn’t ready yet.'
          : 'Neither trusted contact is ready yet.';
  return (
    <section aria-labelledby="readiness-heading" className="grid gap-1">
      <h2 id="readiness-heading" className="text-2xl">
        Trusted Contact readiness
      </h2>
      <p className="text-[15px] text-foreground-secondary">
        {text} Ready means they accepted your invitation, so they can sign in and help when needed.
      </p>
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
              <ReadinessSummary contacts={contacts} />
              <ul className="grid gap-4 md:grid-cols-2">
                {contacts.map((c) => (
                  <li key={c.id} aria-label={fullName(c)} className="grid content-start gap-3">
                    <PersonCard
                      person={c}
                      href={`/trusted-contacts/${c.id}/edit`}
                      extra={<ReadinessLabel readiness={c.readiness} />}
                    />
                    <div className="grid gap-3 px-1">
                      <p className="text-sm text-foreground-muted">{readinessDetail(c.readiness, c.invitation.channel)}</p>
                      <InviteButton contact={c} />
                    </div>
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

// Only an email goes out automatically; an SMS is always the Customer's choice.
const addedToast = (c: TrustedContact) =>
  c.invitation.status === 'PENDING'
    ? `${c.firstName} was added and we’ve emailed them an invitation`
    : !c.email
      ? `${c.firstName} was added. You can now send them an invitation by SMS`
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
        description="A first name and one way to reach them (email or mobile) are needed. With an email, we’ll email them an invitation; with only a mobile, you choose when to send it by SMS."
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
          <TextField id="mobile" label="Mobile" type="tel" inputMode="tel" autoComplete="off" placeholder="+61 400 000 000" hint="With the country code. They can sign in with a code sent to this number." error={errors.mobile?.message} {...form.register('mobile')} />
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
