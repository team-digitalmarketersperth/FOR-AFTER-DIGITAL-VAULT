import { StoryWorkspace } from '@/components/prompts/story-workspace';

export const metadata = { title: 'My Story' };

export default async function Page({ searchParams }: PageProps<'/my-story'>) {
  const { category } = await searchParams;
  return <StoryWorkspace category={typeof category === 'string' ? category : undefined} />;
}
