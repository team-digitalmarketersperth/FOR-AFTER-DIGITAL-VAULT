import type { ReactNode } from 'react';
import { AdminAuthFrame } from '@/components/admin/admin-shell';

// Sign-in and MFA steps: public, no admin session yet.
export default function Layout({ children }: { children: ReactNode }) {
  return <AdminAuthFrame>{children}</AdminAuthFrame>;
}
