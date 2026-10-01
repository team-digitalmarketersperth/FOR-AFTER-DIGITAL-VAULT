import { ReleasedMessageView } from '@/components/portals/recipient';

export const metadata = { title: 'Message' };

export default async function Page({ params }: PageProps<'/recipient/messages/[messageId]'>) {
  const { messageId } = await params;
  return <ReleasedMessageView id={messageId} />;
}
