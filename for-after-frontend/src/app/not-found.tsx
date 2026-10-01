import Link from 'next/link';
import { Button } from '@/components/ui/button';

export const metadata = { title: 'Page not found' };

export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-4 px-4 text-center">
      <p className="text-sm tracking-wide text-muted-foreground uppercase">404</p>
      <h1 className="text-5xl">We couldn&apos;t find that page</h1>
      <p className="text-muted-foreground">
        The page may have moved, or the address may be mistyped.
      </p>
      <Button asChild variant="outline" size="lg" className="mt-2">
        <Link href="/">Go to For After</Link>
      </Button>
    </main>
  );
}
