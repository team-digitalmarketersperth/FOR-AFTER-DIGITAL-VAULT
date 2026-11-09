import { AiOperationsPage } from '@/components/admin/ai-operations';
import { AI_ACTIONS, AI_PAGES, AI_WINDOWS } from '@/lib/api/admin';
import { enumParam } from '@/lib/admin';

export const metadata = { title: 'AI operations · Admin' };

export default async function Page({ searchParams }: PageProps<'/admin/system/ai'>) {
  const p = await searchParams;
  const window = enumParam(p.window, AI_WINDOWS);
  return (
    <AiOperationsPage
      filters={{
        window: window === '24h' ? undefined : window,
        area: enumParam(p.area, AI_PAGES),
        action: enumParam(p.action, AI_ACTIONS),
      }}
    />
  );
}
