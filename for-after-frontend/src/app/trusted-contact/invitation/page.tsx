import { PortalShell } from '@/components/portals/portal-shell';
import { TrustedContactInvitation } from '@/components/portals/trusted-contact';

export const metadata = { title: 'Trusted contact invitation' };

// Reached from the invitation email (Phase 10). No sign-in gate: the emailed
// token is the only credential, and it can only accept or decline.
export default async function Page({ searchParams }: PageProps<'/trusted-contact/invitation'>) {
  const { token } = await searchParams;
  return (
    <PortalShell portal="trusted-contact">
      <div className="mx-auto max-w-xl">
        <TrustedContactInvitation token={typeof token === 'string' ? token : undefined} />
      </div>
    </PortalShell>
  );
}
