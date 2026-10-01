import { EditMessage } from '@/components/messages/message-form';

export const metadata = { title: 'Edit message' };

export default async function Page({ params }: PageProps<'/messages/[messageId]/edit'>) {
  const { messageId } = await params;
  return <EditMessage id={messageId} />;
}
