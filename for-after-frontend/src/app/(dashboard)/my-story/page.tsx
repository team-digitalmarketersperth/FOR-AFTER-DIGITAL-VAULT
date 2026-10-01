import { PromptList } from '@/components/prompts/prompts';

export const metadata = { title: 'My Story' };

export default async function Page({ searchParams }: PageProps<'/my-story'>) {
  const { category } = await searchParams;
  return <PromptList area="my-story" category={typeof category === 'string' ? category : undefined} />;
}
