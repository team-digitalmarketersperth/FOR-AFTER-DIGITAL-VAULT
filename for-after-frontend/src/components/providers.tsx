'use client';

import { QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { Toaster } from 'sonner';
import { makeQueryClient } from '@/lib/query/query-client';

export function Providers({ children }: { children: ReactNode }) {
  // One client per browser tab (and per server render).
  const [queryClient] = useState(makeQueryClient);
  return (
    <QueryClientProvider client={queryClient}>
      {children}
      {/* Transient confirmations only; errors that need action stay inline. */}
      <Toaster
        position="bottom-center"
        toastOptions={{
          unstyled: true,
          classNames: {
            toast:
              'flex w-full items-center gap-3 rounded-full bg-primary px-5 py-3 text-sm font-medium text-primary-foreground shadow-menu',
            icon: 'text-primary-foreground',
          },
        }}
      />
    </QueryClientProvider>
  );
}
