import type { ReactNode } from 'react';
import { AdminGate } from '@/components/admin/admin-shell';

// Every page here needs a completed admin sign-in (password + TOTP), checked
// against GET /admin-auth/me in the browser; AdminGuard enforces it on the API.
export default function Layout({ children }: { children: ReactNode }) {
  return <AdminGate>{children}</AdminGate>;
}
