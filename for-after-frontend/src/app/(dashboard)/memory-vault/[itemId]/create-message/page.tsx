import { CreateMessageFromMemory } from '@/components/memory-vault/memory-to-message';

export const metadata = { title: 'Create a message' };

export default async function Page({ params }: PageProps<'/memory-vault/[itemId]/create-message'>) {
  const { itemId } = await params;
  return <CreateMessageFromMemory id={itemId} />;
}
