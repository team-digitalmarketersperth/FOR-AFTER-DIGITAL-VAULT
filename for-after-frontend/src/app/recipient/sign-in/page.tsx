import { PortalGuestGate, PortalShell } from '@/components/portals/portal-shell';
import { RecipientSignIn } from '@/components/portals/recipient';

export const metadata = { title: 'Messages shared with you' };

export default function Page() {
  return (
    <PortalShell portal="recipient">
      <div className="mx-auto max-w-md">
        <PortalGuestGate portal="recipient">
          <RecipientSignIn />
        </PortalGuestGate>
      </div>
    </PortalShell>
  );
}
