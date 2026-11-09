'use client';

import { ArrowRight, Info, KeyRound, Lock, Monitor, ShieldCheck, ShieldAlert } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { toast } from 'sonner';
import { ChangePasswordDialog } from '@/components/account/account-settings';
import { AdminAvatar } from '@/components/admin/admin-shell';
import { Badge, Facts, linkClass } from '@/components/admin/admin-ui';
import { FormError, TextField } from '@/components/shared/form-field';
import { QueryView, Spinner } from '@/components/shared/states';
import { Button } from '@/components/ui/button';
import { useChangeAdminPassword, useOwnAdminAccount, useSendAdminVerification, useUpdateAdminProfile } from '@/hooks/use-admin';
import { useUnsavedChanges } from '@/hooks/use-unsaved-changes';
import { ROLE_LABEL } from '@/lib/admin';
import type { OwnAdminAccount } from '@/lib/api/admin';
import { formatDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { profileSchema } from '@/schemas/auth';

const SECTIONS = [
  { key: 'profile', label: 'Profile' },
  { key: 'security', label: 'Security' },
  { key: 'sessions', label: 'Sessions' },
] as const;
type Section = (typeof SECTIONS)[number]['key'];

/** Only the section name is in the URL (?section=…). */
const sectionFromUrl = (): Section => {
  if (typeof window === 'undefined') return 'profile';
  const s = new URLSearchParams(window.location.search).get('section');
  return SECTIONS.find((x) => x.key === s)?.key ?? 'profile';
};

const card = 'grid min-w-0 gap-5 rounded-xl border border-border bg-surface p-5 sm:p-7';

/**
 * The signed-in administrator's own account (ADMIN and SUPER_ADMIN). Every
 * value comes from GET /admin/account; nothing here can change a role, status,
 * email, verification or two-factor state.
 */
export function AdminAccountSettings() {
  const account = useOwnAdminAccount();
  return (
    <>
      <header className="mb-6 grid gap-2">
        <p className="eyebrow">Your account</p>
        <h1 className="text-[34px] leading-[1.05] sm:text-[42px]">Account settings</h1>
        <p className="text-lg text-foreground-muted">Manage your details and keep your admin account secure.</p>
      </header>
      <QueryView query={account} loadingLabel="Loading your account">
        {(a) => <Settings account={a} />}
      </QueryView>
    </>
  );
}

type Name = { firstName: string; lastName: string };
const nameOf = (a: OwnAdminAccount): Name => ({ firstName: a.profile.firstName ?? '', lastName: a.profile.lastName ?? '' });

function Settings({ account }: { account: OwnAdminAccount }) {
  const [section, setSection] = useState<Section>(sectionFromUrl);
  // Kept here, so switching sections never loses typed values.
  const [saved, setSaved] = useState(() => nameOf(account));
  const [name, setName] = useState(saved);
  const dirty = name.firstName !== saved.firstName || name.lastName !== saved.lastName;
  useUnsavedChanges(dirty);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);

  const go = (next: Section, focusTab = false) => {
    setSection(next);
    window.history.pushState(null, '', `${window.location.pathname}?section=${next}`);
    if (focusTab) tabs.current[SECTIONS.findIndex((s) => s.key === next)]?.focus();
  };
  useEffect(() => {
    const back = () => setSection(sectionFromUrl());
    window.addEventListener('popstate', back);
    return () => window.removeEventListener('popstate', back);
  }, []);
  // Arrow keys / Home / End move between tabs (WAI-ARIA tabs, automatic activation).
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    const i = SECTIONS.findIndex((s) => s.key === section);
    const to = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: SECTIONS.length - 1 }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    go(SECTIONS[(to + SECTIONS.length) % SECTIONS.length]!.key, true);
  };

  return (
    <>
      {/* Three short tabs fit at every width (checked down to 390 px), so no overflow container and no scrollbar. */}
      <div role="tablist" aria-label="Account settings sections" className="mb-6 flex gap-1 border-b border-border">
        {SECTIONS.map((s, i) => (
          <button
            key={s.key}
            ref={(el) => {
              tabs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={`tab-${s.key}`}
            aria-selected={section === s.key}
            aria-controls={`panel-${s.key}`}
            tabIndex={section === s.key ? 0 : -1}
            onClick={() => go(s.key)}
            onKeyDown={onKeyDown}
            className={cn(
              '-mb-px border-b-2 px-4 py-3 text-[15px] whitespace-nowrap outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring',
              section === s.key ? 'border-primary font-semibold text-primary' : 'border-transparent text-foreground-secondary hover:text-foreground',
            )}
          >
            {s.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`panel-${section}`} aria-labelledby={`tab-${section}`}>
        {section === 'profile' && (
          <ProfileSection account={account} name={name} setName={setName} dirty={dirty} onSaved={(n) => (setSaved(n), setName(n))} go={go} />
        )}
        {section === 'security' && <SecuritySection account={account} />}
        {section === 'sessions' && <SessionsSection account={account} go={go} />}
      </div>
      <p className="mt-8 border-t border-border pt-4 text-sm text-foreground-muted">These settings apply to your administrator account.</p>
    </>
  );
}

// ─── Profile ────────────────────────────────────────────────────────────────

function ProfileSection({
  account,
  name,
  setName,
  dirty,
  onSaved,
  go,
}: {
  account: OwnAdminAccount;
  name: Name;
  setName: (n: Name) => void;
  dirty: boolean;
  onSaved: (n: Name) => void;
  go: (s: Section) => void;
}) {
  const save = useUpdateAdminProfile();
  const [errors, setErrors] = useState<Partial<Record<keyof Name, string>>>({});
  const p = account.profile;
  const display = [name.firstName, name.lastName].filter(Boolean).join(' ') || p.email;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (save.isPending) return;
    const parsed = profileSchema.safeParse(name);
    if (!parsed.success) {
      const next: typeof errors = {};
      for (const issue of parsed.error.issues) next[issue.path[0] as keyof Name] ??= issue.message;
      setErrors(next);
      document.getElementById(next.firstName ? 'admin-first-name' : 'admin-last-name')?.focus();
      return;
    }
    setErrors({});
    // Values stay in the form on any error; success only after the API answers.
    save.mutate(parsed.data, {
      onSuccess: (n) => {
        onSaved(n);
        toast.success('Your details were saved.');
      },
    });
  };

  return (
    <div className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)] lg:items-start">
      <form noValidate onSubmit={submit} aria-labelledby="personal-details" className={card}>
        <h2 id="personal-details" className="text-2xl">
          Personal details
        </h2>
        <div className="flex items-center gap-4">
          <AdminAvatar me={{ ...name, email: p.email }} className="size-14 text-xl" />
          <div className="min-w-0">
            <p className="font-heading text-xl break-words">{display}</p>
            <p className="text-foreground-muted">{ROLE_LABEL[p.role]}</p>
          </div>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            id="admin-first-name"
            label="First name"
            autoComplete="given-name"
            maxLength={100}
            value={name.firstName}
            onChange={(e) => setName({ ...name, firstName: e.target.value })}
            error={errors.firstName}
          />
          <TextField
            id="admin-last-name"
            label="Last name"
            autoComplete="family-name"
            maxLength={100}
            value={name.lastName}
            onChange={(e) => setName({ ...name, lastName: e.target.value })}
            error={errors.lastName}
          />
        </div>
        <EmailRow account={account} />
        <FormError error={save.error} />
        <div className="flex flex-wrap items-center justify-end gap-3">
          {dirty && (
            <p aria-live="polite" className="mr-auto flex items-center gap-2 text-sm text-foreground-secondary">
              <span aria-hidden className="size-2 rounded-full bg-warning" />
              Unsaved changes
            </p>
          )}
          <Button
            type="button"
            variant="outline"
            disabled={!dirty || save.isPending}
            onClick={() => {
              setName(nameOf(account));
              setErrors({});
              save.reset();
            }}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={!dirty || save.isPending}>
            {save.isPending && <Spinner />}
            Save changes
          </Button>
        </div>
      </form>

      <div className="grid min-w-0 gap-6">
        <SecurityOverview account={account} go={go} />
        <section aria-labelledby="admin-access-heading" className={cn(card, 'bg-brand-ivory')}>
          <div className="flex items-start gap-3">
            <Lock aria-hidden strokeWidth={1.5} className="mt-1 size-5 shrink-0 text-foreground-secondary" />
            <div className="grid gap-1">
              <h2 id="admin-access-heading" className="text-xl">
                Administrator access
              </h2>
              <p className="text-sm text-foreground-secondary">
                Your role controls which admin tools you can use. Permission changes are managed separately.
              </p>
              {/* Admin access is open to every admin role (see the sidebar); the API checks again. */}
              <Link href="/admin/access" className={cn(linkClass, 'w-fit text-sm')}>
                View Admin access
              </Link>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

function EmailRow({ account }: { account: OwnAdminAccount }) {
  const send = useSendAdminVerification();
  const { email, emailVerified } = account.profile;
  return (
    <div className="grid gap-2">
      <label htmlFor="admin-email" className="text-[15px] font-medium">
        Email address
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <input
          id="admin-email"
          readOnly
          value={email}
          aria-describedby="admin-email-hint"
          className="h-11 min-w-0 flex-1 basis-56 rounded-md border border-border bg-surface-muted px-3 text-foreground"
        />
        {emailVerified ? (
          <Badge tone="done">
            <ShieldCheck aria-hidden strokeWidth={1.5} className="mr-1 inline size-4 align-[-3px]" />
            Verified
          </Badge>
        ) : (
          <Badge tone="warning">Not verified</Badge>
        )}
      </div>
      <p id="admin-email-hint" className="text-sm text-foreground-muted">
        Administrator email addresses can&apos;t be changed in the app.
        {!emailVerified && ' Verify this address to use features that email you, such as Notification centre test emails.'}
      </p>
      {!emailVerified && (
        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" variant="outline" size="sm" disabled={send.isPending || send.isSuccess} onClick={() => send.mutate()}>
            {send.isPending && <Spinner />}
            Send verification link
          </Button>
          <p role="status" className="text-sm text-foreground-secondary">
            {send.isSuccess && `We sent a verification link to ${email}. Open it from that inbox to verify this address.`}
          </p>
        </div>
      )}
      <FormError error={send.error} />
    </div>
  );
}

function SecurityOverview({ account, go }: { account: OwnAdminAccount; go: (s: Section) => void }) {
  const s = account.security;
  const rows: [ReactNode, string, ReactNode][] = [
    [
      s.twoFactorEnabled ? <ShieldCheck aria-hidden strokeWidth={1.5} className="size-6 text-success" /> : <ShieldAlert aria-hidden strokeWidth={1.5} className="size-6 text-warning" />,
      'Two-factor authentication',
      s.twoFactorEnabled ? 'Enabled' : 'Not enrolled',
    ],
    [
      <KeyRound key="k" aria-hidden strokeWidth={1.5} className="size-6 text-foreground-secondary" />,
      'Password',
      <button key="b" type="button" onClick={() => go('security')} className={cn(linkClass, 'text-left')}>
        Manage in Security
      </button>,
    ],
    [
      <Monitor key="m" aria-hidden strokeWidth={1.5} className="size-6 text-foreground-secondary" />,
      'Sessions',
      <button key="b" type="button" onClick={() => go('sessions')} className={cn(linkClass, 'text-left')}>
        Review in Sessions
      </button>,
    ],
  ];
  return (
    <section aria-labelledby="security-overview" className={card}>
      <h2 id="security-overview" className="text-2xl">
        Security overview
      </h2>
      <ul className="divide-y divide-border">
        {rows.map(([icon, label, value]) => (
          <li key={label} className="flex items-start gap-4 py-3">
            <span className="mt-0.5">{icon}</span>
            <span className="grid gap-0.5">
              <span className="font-semibold">{label}</span>
              <span className="text-sm text-foreground-secondary">{value}</span>
            </span>
          </li>
        ))}
      </ul>
      <Button type="button" variant="outline" className="justify-between" onClick={() => go('security')}>
        Manage security
        <ArrowRight aria-hidden strokeWidth={1.5} />
      </Button>
    </section>
  );
}

// ─── Security ───────────────────────────────────────────────────────────────

function SecuritySection({ account }: { account: OwnAdminAccount }) {
  const change = useChangeAdminPassword();
  const s = account.security;
  return (
    <div className="grid min-w-0 gap-6 lg:grid-cols-2 lg:items-start">
      <section aria-labelledby="password-heading" className={card}>
        <h2 id="password-heading" className="text-2xl">
          Password
        </h2>
        <p className="text-foreground-secondary">
          {s.passwordChangedAt ? `Last changed ${formatDateTime(s.passwordChangedAt)}.` : 'Not changed since your account was set up.'}
        </p>
        <p className="text-sm text-foreground-muted">
          You&apos;ll need your current password. Changing it signs out your other sessions; this one stays signed in.
        </p>
        <div>
          <ChangePasswordDialog change={change} />
        </div>
      </section>

      <section aria-labelledby="mfa-heading" className={card}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="mfa-heading" className="text-2xl">
            Two-factor authentication
          </h2>
          <Badge tone={s.twoFactorEnabled ? 'done' : 'warning'}>{s.twoFactorEnabled ? 'Enabled' : 'Not enrolled'}</Badge>
        </div>
        <Facts
          narrow
          items={[
            ['Authenticator app', s.twoFactorEnabledAt ? `Set up ${formatDateTime(s.twoFactorEnabledAt)}` : 'Not set up'],
            ['Unused recovery codes', String(s.recoveryCodesRemaining)],
          ]}
        />
        {s.recoveryCodesRemaining <= 2 && (
          <p className="rounded-lg bg-warning/10 px-4 py-3 text-sm">
            You have few recovery codes left. Keep the ones you have somewhere safe; new codes are issued when the operations
            team re-enrols your authenticator.
          </p>
        )}
        <p className="flex items-start gap-3 rounded-lg bg-brand-ivory px-4 py-3 text-sm text-foreground-secondary">
          <Info aria-hidden strokeWidth={1.5} className="mt-px size-[18px] shrink-0 text-primary" />
          Two-factor authentication is required for every administrator and can&apos;t be turned off. If you lose your
          authenticator, sign in with a recovery code. If you have none left, the operations team re-enrols you after
          verifying your identity.
        </p>
      </section>
    </div>
  );
}

// ─── Sessions ───────────────────────────────────────────────────────────────

function SessionsSection({ account, go }: { account: OwnAdminAccount; go: (s: Section) => void }) {
  const s = account.session;
  return (
    <div className="grid min-w-0 gap-6 lg:grid-cols-2 lg:items-start">
      <section aria-labelledby="this-session" className={card}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="this-session" className="text-2xl">
            Current session
          </h2>
          <Badge tone="open">This session</Badge>
        </div>
        <Facts
          narrow
          items={[
            ['Signed in', s.signedInAt ? formatDateTime(s.signedInAt) : 'Unavailable'],
            ['Two-factor completed', s.twoFactorAt ? formatDateTime(s.twoFactorAt) : 'Unavailable'],
            ['Signs out after', `${s.idleTimeoutMinutes} minutes without activity`],
            ['Session ends by', s.expiresAt ? formatDateTime(s.expiresAt) : 'Unavailable'],
          ]}
        />
        <p className="text-sm text-foreground-muted">To end this session, use Sign out.</p>
      </section>

      <section aria-labelledby="other-sessions" className={card}>
        <h2 id="other-sessions" className="text-2xl">
          Other sessions
        </h2>
        <p className="text-foreground-secondary">
          Other signed-in browsers can&apos;t be listed here: the admin portal doesn&apos;t keep a list of sessions per account.
          Changing your password signs out every other session.
        </p>
        <Button type="button" variant="outline" className="w-fit" onClick={() => go('security')}>
          Change password
        </Button>
      </section>

      <section aria-labelledby="recent-sign-ins" className={cn(card, 'lg:col-span-2')}>
        <h2 id="recent-sign-ins" className="text-2xl">
          Recent sign-ins
        </h2>
        <p className="text-sm text-foreground-muted">From the audit log. These are past sign-ins, not a list of active sessions.</p>
        {account.recentSignIns.length === 0 ? (
          <p className="text-sm text-foreground-secondary">None recorded.</p>
        ) : (
          <ul className="divide-y divide-border">
            {account.recentSignIns.map((r) => (
              <li key={r.at} className="grid gap-1 py-3 sm:grid-cols-[14rem_minmax(0,1fr)] sm:gap-4">
                <span className="font-medium">{formatDateTime(r.at)}</span>
                <span className="min-w-0 text-sm break-words text-foreground-secondary">
                  {/* Browser-supplied text: shown as plain text, shortened. */}
                  {(r.device ?? 'Browser not recorded').slice(0, 120)}
                  {r.network && <span className="block text-foreground-muted">Network {r.network}</span>}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
