import { SharePreview } from '@/components/dashboard/share-preview';
import { MessageList } from '@/components/messages/message-list';

export const metadata = { title: 'Messages' };

export default function Page() {
  return (
    <>
      <MessageList />
      {/* Secondary, after the list (moved from the dashboard 2026-11-10). Read-only: never schedules or sends. */}
      <div className="mt-16 lg:mt-20">
        <SharePreview />
      </div>
    </>
  );
}
