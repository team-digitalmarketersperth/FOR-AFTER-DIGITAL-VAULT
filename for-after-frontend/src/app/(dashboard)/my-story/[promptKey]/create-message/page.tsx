import { CreateMessageFromPrompt } from '@/components/memory-vault/memory-to-message';

export const metadata = { title: 'Create a message' };

export default async function Page({ params }: PageProps<'/my-story/[promptKey]/create-message'>) {
  const { promptKey } = await params;
  return <CreateMessageFromPrompt area="my-story" promptKey={decodeURIComponent(promptKey)} />;
}
