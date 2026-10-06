'use client';

import { ChevronRight, Mail, Phone } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { useAccessUrl } from '@/hooks/use-media';
import { fullName, initials } from '@/lib/format';
import { cn } from '@/lib/utils';

type Person = {
  firstName: string;
  lastName: string | null;
  relationship: string | null;
  email: string | null;
  mobile: string | null;
};

/** A Recipient's photo (Phase 09): which Recipient, and its current photo id. */
export type AvatarPhoto = { recipientId: string; photoId: string | null };

/**
 * Initials, or the private photo when there is one. The photo comes from a
 * short-lived signed URL fetched only for avatars actually shown; initials
 * stay visible while it loads or if it can't be loaded, never a broken image.
 */
export function PersonAvatar({
  person,
  size = 'md',
  photo,
}: {
  person: Pick<Person, 'firstName' | 'lastName'>;
  size?: 'md' | 'lg';
  photo?: AvatarPhoto;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        'relative flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-primary-soft font-heading text-primary',
        size === 'lg' ? 'size-20 text-3xl' : 'size-12 text-xl',
      )}
    >
      {initials(person)}
      {photo?.photoId && <AvatarPhotoImage recipientId={photo.recipientId} photoId={photo.photoId} />}
    </span>
  );
}

function AvatarPhotoImage({ recipientId, photoId }: { recipientId: string; photoId: string }) {
  const access = useAccessUrl({ kind: 'recipients', id: recipientId }, photoId);
  if (!access.data) return null;
  return (
    // Signed, private, short-lived: plain <img>, never next/image's server cache.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={access.data.url}
      alt=""
      className="absolute inset-0 size-full object-cover"
      onError={() => void access.refetch()}
    />
  );
}

/** Contact cues only (which methods exist), never the full private details. */
export function ContactCues({ person }: { person: Pick<Person, 'email' | 'mobile'> }) {
  if (!person.email && !person.mobile) return null;
  return (
    <span className="flex items-center gap-3 text-foreground-muted">
      {person.email && (
        <span className="inline-flex items-center gap-1 text-xs">
          <Mail aria-hidden strokeWidth={1.5} className="size-3.5" /> Email
        </span>
      )}
      {person.mobile && (
        <span className="inline-flex items-center gap-1 text-xs">
          <Phone aria-hidden strokeWidth={1.5} className="size-3.5" /> Mobile
        </span>
      )}
    </span>
  );
}

/** One person as a calm row-card: avatar, name, relationship, cues. */
export function PersonCard({
  person,
  href,
  extra,
  photo,
}: {
  person: Person;
  href: string;
  extra?: ReactNode;
  photo?: AvatarPhoto;
}) {
  return (
    <Link
      href={href}
      className="group flex items-center gap-4 rounded-lg border border-border bg-surface p-5 outline-none transition-colors hover:border-border-strong focus-visible:outline-2 focus-visible:outline-ring"
    >
      <PersonAvatar person={person} photo={photo} />
      <span className="grid min-w-0 flex-1 gap-1">
        <span className="truncate font-heading text-2xl leading-tight">{fullName(person)}</span>
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-foreground-muted">
          {person.relationship && <span>{person.relationship}</span>}
          {extra}
          <ContactCues person={person} />
        </span>
      </span>
      <ChevronRight aria-hidden strokeWidth={1.5} className="size-5 text-foreground-muted transition-transform group-hover:translate-x-0.5" />
    </Link>
  );
}
