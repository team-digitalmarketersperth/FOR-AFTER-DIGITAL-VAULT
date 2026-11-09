'use client';

import { ChevronDown, CreditCard, LogOut, Menu, UserRound } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { CompanionProvider } from '@/components/companion/companion';
import { BrandLogo } from '@/components/layout/brand-logo';
import { HELP_SUPPORT, NAV_GROUPS, type NavItem } from '@/components/layout/nav';
import { SafetyBanner } from '@/components/layout/safety-banner';
import { Spinner } from '@/components/shared/states';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { useLogout } from '@/hooks/use-auth';
import { useBilling } from '@/hooks/use-billing';
import type { CurrentUser } from '@/lib/api/auth';
import type { AccessState } from '@/lib/api/billing';
import { cn } from '@/lib/utils';

export function DashboardShell({ user, children }: { user: CurrentUser; children: ReactNode }) {
  const [menuOpen, setMenuOpen] = useState(false);

  // One companion for every Customer page, keyed by account: a new account never sees the last one's state.
  return (
    <CompanionProvider key={user.id}>
      <div className="flex min-h-dvh">
        <aside className="sticky top-0 hidden h-dvh w-72 shrink-0 flex-col border-r border-sidebar-border bg-sidebar lg:flex">
          <div className="px-8 pt-9 pb-10">
            <BrandLogo className="h-9" />
          </div>
          <SideNav />
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <header data-topbar className="sticky top-0 z-30 border-b border-border bg-background/90 backdrop-blur">
            <div className="mx-auto flex h-20 max-w-[1200px] items-center gap-3 px-4 sm:px-6 lg:px-12">
              <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
                <SheetTrigger asChild>
                  <Button variant="ghost" size="icon" className="-ml-2 lg:hidden" aria-label="Open navigation">
                    <Menu aria-hidden strokeWidth={1.5} className="size-6" />
                  </Button>
                </SheetTrigger>
                <SheetContent side="left" className="w-80 max-w-[85vw] gap-0 bg-sidebar p-0">
                  <SheetHeader className="px-6 pt-7 pb-8">
                    <SheetTitle asChild>
                      <div>
                        <BrandLogo className="h-8" />
                      </div>
                    </SheetTitle>
                    <SheetDescription className="sr-only">Main navigation</SheetDescription>
                  </SheetHeader>
                  <SideNav onNavigate={() => setMenuOpen(false)} />
                </SheetContent>
              </Sheet>
              <BrandLogo className="h-7 lg:hidden" />
              <Today />

              <div className="ml-auto">
                <AccountMenu user={user} />
              </div>
            </div>
          </header>

          <main
            id="main"
            className="mx-auto w-full max-w-[1200px] flex-1 px-4 pt-10 pb-20 sm:px-6 lg:px-12 lg:pt-14"
          >
            <SafetyBanner />
            <PlanAccess>{children}</PlanAccess>
          </main>
        </div>
      </div>
    </CompanionProvider>
  );
}

// Pages whose only purpose is to add or change content (docs/billing.md §3). Support's own /new stays open.
const PLAN_ROUTE = /^\/(messages|memory-vault|my-story|my-wishes|people|trusted-contacts)\/(.*\/)?(new|edit|create-message)$/;

const PLAN_NOTICE: Partial<Record<AccessState, [title: string, action: string]>> = {
  trial_available: ['Start your free trial', 'Start free trial'],
  trial_expired: ['Your free trial has ended', 'Choose a plan'],
  payment_pending: ['Your payment hasn’t been confirmed yet', 'View your plan'],
  access_ended: ['Your plan has ended', 'Choose a plan'],
};

/**
 * Billing on and no access: what is saved stays readable, downloadable and deletable
 * (docs/billing.md §1), so every page stays open under a plain notice; only pages for
 * adding or changing content show a blocker instead. UX only: the API refuses gated
 * writes itself (402, shown where the action failed), and an unknown state hides nothing.
 */
function PlanAccess({ children }: { children: ReactNode }) {
  const { data } = useBilling(false);
  const pathname = usePathname();
  if (!data?.enabled || data.hasAccess) return children;
  const [title, action] = PLAN_NOTICE[data.state] ?? ['Your plan needs attention', 'View your plan'];
  const planLink = (
    <Button asChild>
      <Link href="/settings/plan">{action}</Link>
    </Button>
  );
  const blocked = PLAN_ROUTE.test(pathname);
  return (
    <>
      {pathname !== '/settings/plan' && !blocked && (
        <section aria-labelledby="plan-notice" className="mb-10 flex flex-wrap items-center justify-between gap-4 rounded-xl border-l-4 border-primary bg-primary-soft p-6">
          <div className="grid max-w-2xl gap-1">
            <h2 id="plan-notice" className="text-xl">
              {title}
            </h2>
            <p className="text-[15px] text-foreground-secondary">
              You can still read, download and delete what you’ve saved. To add or change anything, or use the AI companion, you’ll need a plan.
            </p>
          </div>
          {planLink}
        </section>
      )}
      {blocked ? (
        <section aria-labelledby="plan-required" className="grid max-w-2xl gap-4 rounded-xl border border-border bg-surface p-8">
          <CreditCard aria-hidden strokeWidth={1.5} className="size-6 text-primary" />
          <h1 id="plan-required" className="text-[28px] leading-tight">
            {title}
          </h1>
          <p className="text-foreground-secondary">
            Adding or changing content needs a plan. Everything you’ve saved is still here to read, download or delete.
          </p>
          <div className="flex flex-wrap gap-3">{planLink}</div>
        </section>
      ) : (
        children
      )}
    </>
  );
}

const initials = ({ firstName, lastName }: CurrentUser) =>
  `${firstName.charAt(0)}${lastName.charAt(0)}`.toUpperCase();

function SideNav({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const isActive = (href?: string) => !!href && (pathname === href || pathname.startsWith(`${href}/`));
  // One scroll area: on a short screen the lower section scrolls into view, never overlapping the groups.
  return (
    <nav aria-label="Main" className="flex flex-1 flex-col overflow-y-auto px-4 pb-8">
      {NAV_GROUPS.map((group, i) => (
        <div key={group.label ?? i} className="mb-7">
          {group.label && <p className="eyebrow mb-2 px-4">{group.label}</p>}
          <ul className="grid gap-0.5">
            {group.items.map((item) => (
              <li key={item.label}>
                <NavLink item={item} active={isActive(item.href)} onNavigate={onNavigate} />
              </li>
            ))}
          </ul>
        </div>
      ))}
      <ul className="mt-auto grid gap-0.5 border-t border-sidebar-border pt-4">
        <li>
          <NavLink item={HELP_SUPPORT} active={isActive(HELP_SUPPORT.href)} onNavigate={onNavigate} />
        </li>
      </ul>
    </nav>
  );
}

function NavLink({
  item: { label, href, icon: Icon },
  active,
  onNavigate,
}: {
  item: NavItem;
  active: boolean;
  onNavigate?: () => void;
}) {
  const base = 'flex min-h-11 items-center gap-3 rounded-md px-4 text-[15px]';
  const icon = <Icon aria-hidden strokeWidth={1.5} className="size-[18px]" />;
  if (!href) {
    return (
      <span aria-disabled="true" className={cn(base, 'text-foreground-muted')}>
        {icon}
        <span className="flex-1">{label}</span>
        <span className="text-[11px] tracking-wide uppercase">Soon</span>
      </span>
    );
  }
  return (
    <Link
      href={href}
      onClick={onNavigate}
      aria-current={active ? 'page' : undefined}
      className={cn(
        base,
        'text-foreground-secondary outline-none transition-colors hover:bg-surface-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring',
        active && 'bg-sidebar-active font-medium text-primary hover:bg-sidebar-active hover:text-primary',
      )}
    >
      {icon}
      {label}
    </Link>
  );
}

// A quiet, real detail for the header (the shell only renders in the browser,
// after the session check, so there is no server/client date mismatch).
function Today() {
  const today = new Intl.DateTimeFormat('en-AU', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(new Date());
  return (
    <p className="hidden font-heading text-xl text-foreground-secondary italic lg:block">{today}</p>
  );
}

function Avatar({ user, className }: { user: CurrentUser; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        'flex shrink-0 items-center justify-center rounded-full bg-primary font-heading text-primary-foreground ring-4 ring-primary-soft',
        className,
      )}
    >
      {initials(user)}
    </span>
  );
}

function AccountMenu({ user }: { user: CurrentUser }) {
  const router = useRouter();
  const logout = useLogout();
  const fullName = `${user.firstName} ${user.lastName}`;

  return (
    <div className="flex items-center gap-3">
      {logout.isError && (
        <p role="alert" className="hidden rounded-full bg-danger/10 px-3 py-1.5 text-xs text-danger sm:block">
          Couldn&apos;t log out. Please try again.
        </p>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={`Account: ${fullName}`}
          disabled={logout.isPending}
          className="group flex items-center gap-3 rounded-full border border-border bg-surface py-1.5 pr-1.5 pl-1.5 outline-none transition-all hover:border-border-strong hover:shadow-soft focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring data-[state=open]:border-border-strong sm:pr-4"
        >
          <Avatar user={user} className="size-9 text-base" />
          <span className="hidden max-w-48 text-left leading-tight sm:block">
            <span className="block truncate text-sm font-semibold">{fullName}</span>
            <span className="block truncate text-xs text-foreground-muted">{user.email}</span>
          </span>
          {logout.isPending ? (
            <Spinner className="mr-2 sm:mr-0" />
          ) : (
            <ChevronDown
              aria-hidden
              strokeWidth={1.5}
              className="mr-2 size-4 text-foreground-muted transition-transform group-data-[state=open]:rotate-180 sm:mr-0"
            />
          )}
        </DropdownMenuTrigger>

        <DropdownMenuContent align="end" sideOffset={10} className="w-80 rounded-xl p-2 shadow-menu ring-border">
          <div className="flex items-center gap-4 rounded-lg bg-primary-soft p-4">
            <Avatar user={user} className="size-12 text-xl ring-surface" />
            <div className="min-w-0">
              <p className="eyebrow mb-1">Signed in as</p>
              <p className="truncate font-heading text-2xl leading-none">{user.firstName}</p>
              <p className="mt-1 truncate text-xs text-foreground-muted">{user.email}</p>
            </div>
          </div>
          <DropdownMenuSeparator className="mx-1 my-2" />
          <DropdownMenuItem asChild className="min-h-11 gap-3 rounded-md px-3 text-[15px] font-medium text-foreground-secondary">
            <Link href="/settings">
              <UserRound aria-hidden strokeWidth={1.5} className="size-[18px]" />
              Account settings
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => logout.mutate(undefined, { onSuccess: () => router.replace('/login') })}
            className="min-h-11 gap-3 rounded-md px-3 text-[15px] font-medium text-foreground-secondary"
          >
            <LogOut aria-hidden strokeWidth={1.5} className="size-[18px]" />
            Log out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
