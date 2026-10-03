import { AlertCircle, Loader2, type LucideIcon } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import type { ApiError } from '@/lib/api/errors';
import { cn } from '@/lib/utils';

/** Small spinner for buttons and inline waits. Decorative: pair it with text. */
export function Spinner({ className }: { className?: string }) {
  return (
    <Loader2 aria-hidden className={cn('size-4 animate-spin', className)} />
  );
}

/** Quiet placeholder while a whole page is being prepared (e.g. checking the session). */
export function PageLoader({ label = 'Loading' }: { label?: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-12"
    >
      <span className="sr-only">{label}…</span>
      <Skeleton className="h-8 w-2/5" />
      <Skeleton className="h-4 w-3/4" />
      <Skeleton className="h-4 w-1/2" />
      <div className="mt-6 grid gap-4 sm:grid-cols-2">
        <Skeleton className="h-28" />
        <Skeleton className="h-28" />
      </div>
    </div>
  );
}

type ErrorStateProps = {
  title?: string;
  /** Must already be safe text, e.g. ApiError.message or errorMessage(error). */
  message: string;
  onRetry?: () => void;
  action?: ReactNode;
  className?: string;
  /** h1 when this state is the whole page (no PageHeader above it). */
  heading?: 'h1' | 'h2';
};

export function ErrorState({
  title = 'Something went wrong',
  message,
  onRetry,
  action,
  className,
  heading: Heading = 'h2',
}: ErrorStateProps) {
  return (
    <section
      role="alert"
      className={cn(
        'mx-auto flex max-w-md flex-col items-center gap-3 px-4 py-12 text-center',
        className,
      )}
    >
      <AlertCircle aria-hidden className="size-6 text-muted-foreground" />
      <Heading className="text-3xl">{title}</Heading>
      <p className="text-muted-foreground">{message}</p>
      {(onRetry || action) && (
        <div className="mt-2 flex flex-wrap justify-center gap-2">
          {onRetry && (
            <Button variant="outline" onClick={onRetry}>
              Try again
            </Button>
          )}
          {action}
        </div>
      )}
    </section>
  );
}

type EmptyStateProps = {
  icon?: LucideIcon;
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
  /** h1 when this state is the whole page (no PageHeader above it). */
  heading?: 'h1' | 'h2';
};

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
  heading: Heading = 'h2',
}: EmptyStateProps) {
  return (
    <section
      className={cn(
        'flex flex-col items-center gap-2 rounded-xl border border-dashed border-border-strong bg-surface px-6 py-14 text-center',
        className,
      )}
    >
      {Icon && <Icon aria-hidden className="mb-1 size-6 text-muted-foreground" />}
      <Heading className="text-2xl">{title}</Heading>
      {description && (
        <p className="max-w-sm text-sm text-muted-foreground">{description}</p>
      )}
      {action && <div className="mt-3">{action}</div>}
    </section>
  );
}

/** Skeleton rows for a list or detail while its query loads. */
export function ListSkeleton({ rows = 3, label = 'Loading' }: { rows?: number; label?: string }) {
  return (
    <div role="status" aria-live="polite" className="grid gap-4">
      <span className="sr-only">{label}…</span>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-24 rounded-lg" />
      ))}
    </div>
  );
}

type QueryLike<T> = {
  data: T | undefined;
  error: ApiError | null;
  isPending: boolean;
  refetch: () => unknown;
};

/**
 * Loading / error / not-found / data for one query. A 404 is shown the same
 * whether the item never existed, was removed or belongs to someone else.
 */
export function QueryView<T>({
  query,
  notFound,
  loadingLabel,
  children,
}: {
  query: QueryLike<T>;
  notFound?: { title: string; backHref: string; backLabel: string };
  loadingLabel?: string;
  children: (data: T) => ReactNode;
}) {
  if (query.isPending) return <ListSkeleton label={loadingLabel} />;
  if (query.error || query.data === undefined) {
    const error = query.error;
    // Detail pages (the ones with notFound) render their PageHeader from the
    // data, so without data this state is the page and carries its h1.
    const heading = notFound ? 'h1' : 'h2';
    // A malformed id in the URL (400) is, for the person, just "not found".
    if (notFound && (error?.kind === 'not_found' || error?.kind === 'validation')) {
      return (
        <EmptyState
          heading={heading}
          title={notFound.title}
          description="It may have been removed, or the link may be incorrect."
          action={
            <Button asChild variant="outline">
              <Link href={notFound.backHref}>{notFound.backLabel}</Link>
            </Button>
          }
        />
      );
    }
    return (
      <ErrorState
        heading={heading}
        title={error?.kind === 'forbidden' ? 'Access denied' : "We couldn't load this"}
        message={error?.message ?? 'Please try again.'}
        onRetry={error?.kind === 'forbidden' ? undefined : () => void query.refetch()}
      />
    );
  }
  return <>{children(query.data)}</>;
}
