import { Suspense } from 'react';
import { StoryBookReader } from '@/components/prompts/story-book';

export const metadata = { title: 'My Story · Book' };

// ?chapter=CHILDHOOD (a category key) opens that chapter; anything else opens the
// first. The reader reads it with useSearchParams, so it can turn pages and
// follow Back/Forward without reloading the page.
export default function Page() {
  return (
    <Suspense>
      <StoryBookReader />
    </Suspense>
  );
}
