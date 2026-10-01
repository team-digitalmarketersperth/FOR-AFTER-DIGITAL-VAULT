import { PortalGuestGate, PortalShell } from '@/components/portals/portal-shell';
import { TrustedContactSignIn } from '@/components/portals/trusted-contact';

export const metadata = { title: 'Trusted contact sign-in' };

export default function Page() {
  return (
    <PortalShell portal="trusted-contact">
      <div className="mx-auto max-w-md">
        <PortalGuestGate portal="trusted-contact">
          <TrustedContactSignIn />
        </PortalGuestGate>
      </div>
    </PortalShell>
  );
}
