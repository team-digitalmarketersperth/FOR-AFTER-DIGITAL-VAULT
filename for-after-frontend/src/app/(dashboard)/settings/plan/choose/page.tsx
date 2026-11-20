import { ChoosePlanPage } from '@/components/account/plan';

export const metadata = { title: 'Choose a plan' };

// Authenticated purchase route (Updated Plans Step 8). Checkout returns to /settings/plan, which waits for the server.
export default function Page() {
  return <ChoosePlanPage />;
}
