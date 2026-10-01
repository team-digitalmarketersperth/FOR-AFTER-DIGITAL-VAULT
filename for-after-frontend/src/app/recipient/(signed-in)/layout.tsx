import type { ReactNode } from 'react';
import { PortalGate } from '@/components/portals/portal-shell';

// Checks this portal's own session only (never the Customer's).
export default function Layout({ children }: { children: ReactNode }) {
  return <PortalGate portal="recipient">{children}</PortalGate>;
}
