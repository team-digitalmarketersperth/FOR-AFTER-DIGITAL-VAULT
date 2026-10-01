'use client';

import { LogOut } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { BrandLogo } from '@/components/layout/brand-logo';
import { ErrorState, PageLoader, Spinner } from '@/components/shared/states';
import { Button } from '@/components/ui/button';
import { usePortalLogout, usePortalSession } from '@/hooks/use-portals';
import type { Portal } from '@/lib/query/query-client';
import { cn } from '@/lib/utils';

export const PORTALS: Record<
  Portal,
  { label: string; home: string; signIn: string; nav: string; homeTitle: string }
> = {
  recipient: {
    label: 'Recipient access',
    home: '/recipient/messages',
    signIn: '/recipient/sign-in',
    nav: 'Messages',
    homeTitle: 'Messages shared with you',
  },
  'trusted-contact': {
    label: 'Trusted contact access',
    home: '/trusted-contact/accounts',
    signIn: '/trusted-contact/sign-in',
    nav: 'Accounts',
    homeTitle: 'Accounts that trust you',
  },
};

/**
 * Signed-in pages of one portal. Checks that portal's own session only; a
 * Customer or other-portal session never counts. Signed out → that portal's
 * own sign-in page (never the Customer /login).
 */
export function PortalGate({ portal, children }: { portal: Portal; children: ReactNode }) {
  const router = useRouter();
  const session = usePortalSession(portal);
  const signedOut = session.data === null;
  useEffect(() => {
    if (signedOut) router.replace(PORTALS[portal].signIn);
  }, [signedOut, router, portal]);

  if (session.isPending || signedOut) return <PageLoader label="Checking your sign-in" />;
  if (!session.data) {
    return (
      <ErrorState
        title="We couldn't check your sign-in"
        message={session.error?.message ?? 'Please try again.'}
        onRetry={() => void session.refetch()}
      />
    );
  }
  return (
    <PortalShell portal={portal} email={session.data.email}>
      {children}
    </PortalShell>
  );
}

/** Sign-in page: someone already signed in to this portal goes straight in. */
export function PortalGuestGate({ portal, children }: { portal: Portal; children: ReactNode }) {
  const router = useRouter();
  const session = usePortalSession(portal);
  const signedIn = !!session.data;
  useEffect(() => {
    if (signedIn) router.replace(PORTALS[portal].home);
  }, [signedIn, router, portal]);
  if (session.isPending || signedIn) {
    return (
      <div role="status" className="flex justify-center py-16 text-foreground-muted">
        <Spinner className="size-5" />
        <span className="sr-only">Loading…</span>
      </div>
    );
  }
  return children;
}

export function PortalShell({ portal, email, children }: { portal: Portal; email?: string; children: ReactNode }) {
  const config = PORTALS[portal];
  const pathname = usePathname();
  const router = useRouter();
  const logout = usePortalLogout(portal);
  const onHome = pathname === config.home;

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="border-b border-border bg-surface/90 backdrop-blur">
        <div className="mx-auto flex h-18 max-w-4xl items-center gap-4 px-4 sm:px-6">
          <BrandLogo href={config.home} className="h-7 sm:h-8" />
          <span className="hidden rounded-full bg-primary-soft px-3 py-1 text-xs font-medium text-primary sm:inline">
            {config.label}
          </span>
          {email && (
            <nav aria-label={config.label} className="ml-auto flex items-center gap-1 sm:gap-3">
              <Link
                href={config.home}
                aria-current={onHome ? 'page' : undefined}
                className={cn(
                  'rounded-full px-3 py-2 text-sm outline-none focus-visible:outline-2 focus-visible:outline-ring',
                  onHome ? 'bg-primary-soft font-medium text-primary' : 'text-foreground-secondary hover:bg-surface-muted',
                )}
              >
                {config.nav}
              </Link>
              <span className="hidden max-w-48 truncate text-xs text-foreground-muted md:inline">{email}</span>
              <Button
                variant="ghost"
                size="sm"
                disabled={logout.isPending}
                onClick={() => logout.mutate(undefined, { onSuccess: () => router.replace(config.signIn) })}
              >
                {logout.isPending ? <Spinner /> : <LogOut aria-hidden strokeWidth={1.5} className="size-4" />}
                Sign out
              </Button>
            </nav>
          )}
        </div>
      </header>
      <main id="main" className="mx-auto w-full max-w-4xl flex-1 px-4 pt-10 pb-20 sm:px-6 sm:pt-14">
        {children}
      </main>
      <footer className="border-t border-border py-6 text-center text-xs text-foreground-muted">
        For After · Private and secure
      </footer>
    </div>
  );
}
