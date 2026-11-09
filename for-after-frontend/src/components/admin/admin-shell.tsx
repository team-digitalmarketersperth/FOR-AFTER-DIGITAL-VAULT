'use client';

import { Activity, CalendarClock, ChevronDown, CreditCard, Gauge, HardDrive, KeyRound, Layers, LifeBuoy, LogOut, Mail, Megaphone, Menu, ScrollText, ShieldAlert, ShieldCheck, Sparkles, UserRound, Users, type LucideIcon } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { BrandLogo } from '@/components/layout/brand-logo';
import { ErrorState, PageLoader, Spinner } from '@/components/shared/states';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { useAdminLogout, useAdminSession } from '@/hooks/use-admin';
import { ADMIN_ROLES, type AdminMe } from '@/lib/api/admin';
import { personName, ROLE_LABEL } from '@/lib/admin';
import { cn } from '@/lib/utils';

export const ADMIN_HOME = '/admin';
export const ADMIN_LOGIN = '/admin/login';
/** The signed-in admin's own settings: reached from the account menu (top right), never the sidebar. */
export const ADMIN_ACCOUNT = '/admin/account';

/** superAdminOnly: hidden for other admins (the API refuses them anyway). */
type Item = { label: string; href: string; icon: LucideIcon; superAdminOnly?: true };

// Operational areas only. No Customer vault sections, and nothing without a
// real backend API.
const NAV: { label?: string; items: Item[] }[] = [
  { items: [{ label: 'Overview', href: ADMIN_HOME, icon: Gauge }] },
  {
    label: 'Management',
    items: [
      { label: 'Users', href: '/admin/users', icon: Users },
      { label: 'Death verification', href: '/admin/death-verifications', icon: ShieldCheck },
      { label: 'Support', href: '/admin/support', icon: LifeBuoy },
      { label: 'Subscriptions & payments', href: '/admin/billing', icon: CreditCard, superAdminOnly: true },
    ],
  },
  {
    label: 'Operations',
    items: [
      { label: 'Releases', href: '/admin/releases', icon: CalendarClock },
      { label: 'Deliveries', href: '/admin/deliveries', icon: Mail },
      { label: 'Notification centre', href: '/admin/announcements', icon: Megaphone, superAdminOnly: true },
      { label: 'Security activity', href: '/admin/security', icon: ShieldAlert },
      { label: 'Admin access', href: '/admin/access', icon: KeyRound },
      { label: 'Audit logs', href: '/admin/audit-logs', icon: ScrollText },
      { label: 'Storage & scans', href: '/admin/storage', icon: HardDrive },
      { label: 'Queues', href: '/admin/system/queues', icon: Layers },
      { label: 'System health', href: '/admin/system/health', icon: Activity },
      { label: 'AI operations', href: '/admin/system/ai', icon: Sparkles },
    ],
  },
];

/**
 * Wraps every signed-in admin page. UX, not security: AdminGuard on the API
 * checks role and completed MFA on every request. Needs GET /admin-auth/me:
 * a password-only challenge, a Customer, Recipient or Trusted Contact session
 * never gets past it. Signed out → the admin sign-in (never the Customer /login).
 */
export function AdminGate({ children }: { children: ReactNode }) {
  const router = useRouter();
  const session = useAdminSession();
  const signedOut = session.data === null;
  useEffect(() => {
    if (signedOut) router.replace(ADMIN_LOGIN);
  }, [signedOut, router]);

  if (session.isPending || signedOut) return <PageLoader label="Checking your admin session" />;
  const me = session.data;
  if (!me) {
    // 403 = signed in but not an admin: not "signed out", so no automatic logout.
    if (session.error?.kind === 'forbidden') return <NotAnAdmin />;
    return (
      <ErrorState
        title="We couldn't check your admin session"
        message={session.error?.message ?? 'Please try again.'}
        onRetry={() => void session.refetch()}
      />
    );
  }
  if (!ADMIN_ROLES.includes(me.role) || !me.mfaVerified) return <NotAnAdmin />;
  return <AdminShell me={me}>{children}</AdminShell>;
}

function NotAnAdmin() {
  const router = useRouter();
  const logout = useAdminLogout();
  return (
    <AdminAuthFrame>
      <ErrorState
        title="Access denied"
        message="This area is for the For After team. The account you're signed in with doesn't have administrator access."
        action={
          <Button
            variant="outline"
            disabled={logout.isPending}
            onClick={() => logout.mutate(undefined, { onSuccess: () => router.replace(ADMIN_LOGIN) })}
          >
            Sign out and use an administrator account
          </Button>
        }
      />
    </AdminAuthFrame>
  );
}

/** Admin sign-in page: an admin who is already signed in goes straight in. */
export function AdminGuestGate({ children }: { children: ReactNode }) {
  const router = useRouter();
  const session = useAdminSession();
  const signedIn = !!session.data;
  useEffect(() => {
    if (signedIn) router.replace(ADMIN_HOME);
  }, [signedIn, router]);
  if (session.isPending || signedIn) {
    return (
      <div role="status" className="flex justify-center py-16 text-foreground-muted">
        <Spinner className="size-5" />
        <span className="sr-only">Loading…</span>
      </div>
    );
  }
  // Signed out, a Customer session (403) or API unreachable: show the form.
  return children;
}

/** Centred frame for the sign-in and MFA steps. */
export function AdminAuthFrame({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="border-b border-border bg-surface/90">
        <div className="mx-auto flex h-18 max-w-5xl items-center gap-4 px-4 sm:px-6">
          <BrandLogo href={ADMIN_LOGIN} className="h-7 sm:h-8" />
          <PortalChip />
        </div>
      </header>
      <main id="main" className="mx-auto w-full max-w-md flex-1 px-4 pt-10 pb-20 sm:pt-16">
        {children}
      </main>
    </div>
  );
}

const PortalChip = () => (
  <span className="rounded-full bg-primary px-3 py-1 text-xs font-medium tracking-wide text-primary-foreground">
    Admin Portal
  </span>
);

export function AdminShell({ me, children }: { me: AdminMe; children: ReactNode }) {
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <div className="flex min-h-dvh">
      <aside className="sticky top-0 hidden h-dvh w-64 shrink-0 flex-col border-r border-sidebar-border bg-sidebar lg:flex">
        <div className="flex items-center gap-3 px-6 pt-8 pb-8">
          <BrandLogo href={ADMIN_HOME} className="h-8" />
        </div>
        <SideNav />
        <div className="border-t border-border p-4">
          <SignOut />
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 border-b border-border bg-background/90 backdrop-blur">
          <div className="mx-auto flex h-18 max-w-[1280px] items-center gap-3 px-4 sm:px-6 lg:px-10">
            <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
              <SheetTrigger asChild>
                <Button variant="ghost" size="icon" className="-ml-2 lg:hidden" aria-label="Open navigation">
                  <Menu aria-hidden strokeWidth={1.5} className="size-6" />
                </Button>
              </SheetTrigger>
              <SheetContent side="left" className="w-72 max-w-[85vw] gap-0 bg-sidebar p-0">
                <SheetHeader className="px-6 pt-7 pb-6">
                  <SheetTitle asChild>
                    <div>
                      <BrandLogo href={ADMIN_HOME} className="h-8" />
                    </div>
                  </SheetTitle>
                  <SheetDescription className="sr-only">Admin navigation</SheetDescription>
                </SheetHeader>
                <SideNav onNavigate={() => setMenuOpen(false)} />
                <div className="border-t border-border p-4">
                  <SignOut />
                </div>
              </SheetContent>
            </Sheet>
            <PortalChip />
            <div className="ml-auto flex min-w-0 items-center gap-3">
              <AccountMenu me={me} />
              <div className="hidden sm:block lg:hidden">
                <SignOut compact />
              </div>
            </div>
          </div>
        </header>
        <main id="main" className="mx-auto w-full max-w-[1280px] flex-1 px-4 pt-8 pb-20 sm:px-6 lg:px-10 lg:pt-12">
          {children}
        </main>
      </div>
    </div>
  );
}

function SideNav({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const superAdmin = useAdminSession().data?.role === 'SUPER_ADMIN';
  const isActive = (href: string) =>
    href === ADMIN_HOME ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);
  return (
    <nav aria-label="Admin" className="flex-1 overflow-y-auto px-3 pb-6">
      {NAV.map((group, i) => (
        <div key={group.label ?? i} className="mb-6">
          {group.label && <p className="eyebrow mb-2 px-3">{group.label}</p>}
          <ul className="grid gap-0.5">
            {group.items.filter((item) => superAdmin || !item.superAdminOnly).map(({ label, href, icon: Icon }) => (
              <li key={href}>
                <Link
                  href={href}
                  onClick={onNavigate}
                  aria-current={isActive(href) ? 'page' : undefined}
                  className={cn(
                    'flex min-h-11 items-center gap-3 rounded-md px-3 text-[15px] text-foreground-secondary outline-none transition-colors hover:bg-surface-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring',
                    isActive(href) && 'bg-sidebar-active font-medium text-primary hover:bg-sidebar-active hover:text-primary',
                  )}
                >
                  <Icon aria-hidden strokeWidth={1.5} className="size-[18px]" />
                  {label}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}

function SignOut({ compact }: { compact?: boolean }) {
  const router = useRouter();
  const logout = useAdminLogout();
  return (
    <div className="grid gap-2">
      <Button
        variant="ghost"
        size={compact ? 'sm' : 'default'}
        className={compact ? undefined : 'w-full justify-start'}
        disabled={logout.isPending}
        onClick={() => logout.mutate(undefined, { onSuccess: () => router.replace(ADMIN_LOGIN) })}
      >
        {logout.isPending ? <Spinner /> : <LogOut aria-hidden strokeWidth={1.5} className="size-4" />}
        Sign out
      </Button>
      {logout.isError && (
        <p role="alert" className="text-xs text-danger">
          Couldn&apos;t sign out. Please try again.
        </p>
      )}
    </div>
  );
}

const adminInitials = (me: Pick<AdminMe, 'firstName' | 'lastName' | 'email'>) =>
  (me.firstName || me.lastName ? `${me.firstName?.charAt(0) ?? ''}${me.lastName?.charAt(0) ?? ''}` : me.email.charAt(0)).toUpperCase();

export function AdminAvatar({ me, className }: { me: Pick<AdminMe, 'firstName' | 'lastName' | 'email'>; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn('flex shrink-0 items-center justify-center rounded-full bg-primary font-heading text-primary-foreground', className)}
    >
      {adminInitials(me)}
    </span>
  );
}

/**
 * Top-right account menu (Radix: keyboard, arrow keys, Escape, outside click and
 * focus return). Identity and role, and the way to the admin's own Account
 * settings. Sign out stays where it was (sidebar, mobile sheet, tablet header).
 */
function AccountMenu({ me }: { me: AdminMe }) {
  const name = personName(me) ?? me.email;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`Account menu for ${name}`}
        className="group flex min-w-0 items-center gap-3 rounded-full border border-border bg-surface p-1.5 outline-none transition-colors hover:border-border-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-solid focus-visible:outline-ring data-[state=open]:border-border-strong sm:pr-4"
      >
        <AdminAvatar me={me} className="size-9 text-sm" />
        <span className="hidden min-w-0 max-w-56 text-left leading-tight sm:block">
          <span className="block truncate text-sm font-semibold">{name}</span>
          <span className="block truncate text-xs text-foreground-muted">{me.email}</span>
        </span>
        <ChevronDown
          aria-hidden
          strokeWidth={1.5}
          className="mr-1 size-4 shrink-0 text-foreground-muted transition-transform group-data-[state=open]:rotate-180 motion-reduce:transition-none sm:mr-0"
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={10} className="w-80 max-w-[calc(100vw-2rem)] rounded-xl p-2 shadow-menu ring-border">
        <div className="flex items-center gap-4 rounded-lg bg-primary-soft p-4">
          <AdminAvatar me={me} className="size-12 text-lg" />
          <div className="min-w-0">
            <p className="font-semibold break-words">{name}</p>
            <p className="text-sm break-all text-foreground-secondary">{me.email}</p>
            <p className="mt-1 text-xs text-foreground-muted">{ROLE_LABEL[me.role]}</p>
          </div>
        </div>
        <DropdownMenuSeparator className="mx-1 my-2" />
        <DropdownMenuItem asChild className="min-h-11 gap-3 rounded-md px-3 text-[15px] font-medium text-foreground-secondary">
          <Link href={ADMIN_ACCOUNT}>
            <UserRound aria-hidden strokeWidth={1.5} className="size-[18px]" />
            Account settings
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
