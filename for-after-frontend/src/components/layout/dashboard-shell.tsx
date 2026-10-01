'use client';

import { ChevronDown, LogOut, Menu } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { BrandLogo } from '@/components/layout/brand-logo';
import { NAV_GROUPS, type NavItem } from '@/components/layout/nav';
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
import type { CurrentUser } from '@/lib/api/auth';
import { cn } from '@/lib/utils';

export function DashboardShell({ user, children }: { user: CurrentUser; children: ReactNode }) {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <div className="flex min-h-dvh">
      <aside className="sticky top-0 hidden h-dvh w-72 shrink-0 flex-col border-r border-sidebar-border bg-sidebar lg:flex">
        <div className="px-8 pt-9 pb-10">
          <BrandLogo className="h-9" />
        </div>
        <SideNav />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 border-b border-border bg-background/90 backdrop-blur">
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
          {children}
        </main>
      </div>
    </div>
  );
}

const initials = ({ firstName, lastName }: CurrentUser) =>
  `${firstName.charAt(0)}${lastName.charAt(0)}`.toUpperCase();

function SideNav({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Main" className="flex-1 overflow-y-auto px-4 pb-8">
      {NAV_GROUPS.map((group, i) => (
        <div key={group.label ?? i} className="mb-7">
          {group.label && <p className="eyebrow mb-2 px-4">{group.label}</p>}
          <ul className="grid gap-0.5">
            {group.items.map((item) => (
              <li key={item.label}>
                <NavLink item={item} active={!!item.href && (pathname === item.href || pathname.startsWith(`${item.href}/`))} onNavigate={onNavigate} />
              </li>
            ))}
          </ul>
        </div>
      ))}
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
