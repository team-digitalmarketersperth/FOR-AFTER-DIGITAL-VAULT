import { MessageDetail } from '@/components/messages/message-detail';

export const metadata = { title: 'Message' };

export default async function Page({ params }: PageProps<'/messages/[messageId]'>) {
  const { messageId } = await params;
  return <MessageDetail id={messageId} />;
}
