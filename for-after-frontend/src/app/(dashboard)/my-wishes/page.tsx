import { PromptList } from '@/components/prompts/prompts';

export const metadata = { title: 'My Wishes' };

export default async function Page({ searchParams }: PageProps<'/my-wishes'>) {
  const { category } = await searchParams;
  return <PromptList area="my-wishes" category={typeof category === 'string' ? category : undefined} />;
}
