import { AuthHeading } from '@/components/auth/auth-heading';
import { Unsubscribe } from '@/components/auth/account-links';

export const metadata = { title: 'Unsubscribe' };

// Reached from the link in an announcement email, signed in or not (GuestGate lets it through).
export default async function UnsubscribePage({ searchParams }: PageProps<'/unsubscribe'>) {
  const { token } = await searchParams;
  return (
    <>
      <AuthHeading title={<>Unsubscribe from <em>news</em></>} description="Stop optional news emails from For After." />
      <Unsubscribe token={typeof token === 'string' ? token : undefined} />
    </>
  );
}
