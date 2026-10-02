'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { DashboardShell } from '@/components/layout/dashboard-shell';
import { ErrorState, PageLoader, Spinner } from '@/components/shared/states';
import { Button } from '@/components/ui/button';
import { useCurrentUser, useLogout } from '@/hooks/use-auth';
import { isApiError } from '@/lib/api/errors';

// These gates are UX, not security: they decide what to render from GET
// /auth/me. The NestJS guards enforce every rule on every API request.

/** Wraps Customer pages: nothing private renders until /auth/me confirms a Customer. */
export function CustomerGate({ children }: { children: ReactNode }) {
  const router = useRouter();
  const { data: user, error, isPending, refetch } = useCurrentUser();
  const signedOut = user === null;

  useEffect(() => {
    if (signedOut) router.replace('/login');
  }, [signedOut, router]);

  if (isPending || signedOut) return <PageLoader label="Checking your session" />;

  if (!user) {
    // 403 is not "signed out": the session exists but may not see this.
    if (isApiError(error) && error.kind === 'forbidden') {
      return <ErrorState title="Access denied" message={error.message} />;
    }
    return (
      <ErrorState
        title="We couldn't load your account"
        message={isApiError(error) ? error.message : 'Please try again.'}
        onRetry={() => void refetch()}
      />
    );
  }

  // Admin sessions exist only after TOTP (Step 16). The Customer dashboard
  // must not render for an admin; they have their own portal (/admin).
  if (user.role !== 'CUSTOMER') return <NotACustomer />;

  return <DashboardShell user={user}>{children}</DashboardShell>;
}

function NotACustomer() {
  const router = useRouter();
  const logout = useLogout();
  return (
    <ErrorState
      title="This area is for Customer accounts"
      message="You're signed in with an administrator account. Administrator tools are in the Admin Portal."
      action={
        <>
          <Button asChild>
            <Link href="/admin">Open the Admin Portal</Link>
          </Button>
          <Button
            variant="outline"
            disabled={logout.isPending}
            onClick={() =>
              logout.mutate(undefined, { onSuccess: () => router.replace('/login') })
            }
          >
            Log out
          </Button>
        </>
      }
    />
  );
}

/** Wraps sign-in pages: a signed-in Customer goes straight to the dashboard. */
export function GuestGate({ children }: { children: ReactNode }) {
  const router = useRouter();
  const { data: user, isPending } = useCurrentUser();
  const isCustomer = user?.role === 'CUSTOMER';

  useEffect(() => {
    if (isCustomer) router.replace('/dashboard');
  }, [isCustomer, router]);

  if (isPending || isCustomer) {
    return (
      <div role="status" className="flex justify-center py-12 text-muted-foreground">
        <Spinner className="size-5" />
        <span className="sr-only">Loading…</span>
      </div>
    );
  }
  // Signed out, or /auth/me failed (e.g. API unreachable): show the form, which
  // reports its own errors when submitted.
  return children;
}
