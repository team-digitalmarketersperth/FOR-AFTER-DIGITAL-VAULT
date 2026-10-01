import { ReleasedMessageList } from '@/components/portals/recipient';

export const metadata = { title: 'Messages shared with you' };

export default function Page() {
  return <ReleasedMessageList />;
}
