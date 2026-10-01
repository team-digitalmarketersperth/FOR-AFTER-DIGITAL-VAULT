'use client';

import { ErrorState } from '@/components/shared/states';

// Unexpected render errors. Never shows error.message: it may carry internals.
export default function Error({ retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <main className="flex min-h-dvh items-center justify-center">
      <ErrorState
        message="Something unexpected happened. Please try again."
        onRetry={retry}
      />
    </main>
  );
}
