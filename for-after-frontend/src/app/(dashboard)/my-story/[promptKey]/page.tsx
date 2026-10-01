import { PromptEditor } from '@/components/prompts/prompts';

export const metadata = { title: 'My Story' };

export default async function Page({ params }: PageProps<'/my-story/[promptKey]'>) {
  const { promptKey } = await params;
  return <PromptEditor area="my-story" promptKey={decodeURIComponent(promptKey)} />;
}
