import { PlanPage } from '@/components/account/plan';

export const metadata = { title: 'Your plan' };

// ?checkout=success|cancelled from the Stripe return URL; it only changes the message, never access.
export default async function Page({ searchParams }: PageProps<'/settings/plan'>) {
  const { checkout } = await searchParams;
  return <PlanPage checkout={checkout === 'success' || checkout === 'cancelled' ? checkout : undefined} />;
}
