import type { ReactNode } from 'react';
import { CustomerGate } from '@/components/auth/auth-gates';

// Every page in this group is Customer-only. The session lives in an HttpOnly
// cookie on the API origin, which Server Components cannot read, so the check
// runs in the browser against GET /auth/me before anything renders.
export default function DashboardLayout({ children }: { children: ReactNode }) {
  return <CustomerGate>{children}</CustomerGate>;
}
