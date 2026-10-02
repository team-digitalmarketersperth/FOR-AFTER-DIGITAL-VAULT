import { AdminLoginForm } from '@/components/admin/admin-auth';
import { AdminGuestGate } from '@/components/admin/admin-shell';

export const metadata = { title: 'Admin sign-in' };

export default function Page() {
  return (
    <AdminGuestGate>
      <AdminLoginForm />
    </AdminGuestGate>
  );
}
