import { PromptEditor } from '@/components/prompts/prompts';

export const metadata = { title: 'My Wishes' };

export default async function Page({ params }: PageProps<'/my-wishes/[promptKey]'>) {
  const { promptKey } = await params;
  return <PromptEditor area="my-wishes" promptKey={decodeURIComponent(promptKey)} />;
}
