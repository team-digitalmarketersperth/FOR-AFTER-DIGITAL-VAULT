import { ChevronRight, Mail, Phone } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { fullName, initials } from '@/lib/format';

type Person = {
  firstName: string;
  lastName: string | null;
  relationship: string | null;
  email: string | null;
  mobile: string | null;
};

export function PersonAvatar({ person, size = 'md' }: { person: Pick<Person, 'firstName' | 'lastName'>; size?: 'md' | 'lg' }) {
  return (
    <span
      aria-hidden
      className={
        size === 'lg'
          ? 'flex size-20 shrink-0 items-center justify-center rounded-full bg-primary-soft font-heading text-3xl text-primary'
          : 'flex size-12 shrink-0 items-center justify-center rounded-full bg-primary-soft font-heading text-xl text-primary'
      }
    >
      {initials(person)}
    </span>
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
export function PersonCard({ person, href, extra }: { person: Person; href: string; extra?: ReactNode }) {
  return (
    <Link
      href={href}
      className="group flex items-center gap-4 rounded-lg border border-border bg-surface p-5 outline-none transition-colors hover:border-border-strong focus-visible:outline-2 focus-visible:outline-ring"
    >
      <PersonAvatar person={person} />
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
