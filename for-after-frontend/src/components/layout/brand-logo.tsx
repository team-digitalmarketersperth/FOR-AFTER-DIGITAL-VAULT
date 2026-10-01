import Image from 'next/image';
import Link from 'next/link';
import { cn } from '@/lib/utils';

/**
 * The For After wordmark, taken from the WordPress site's own logo files
 * (public/brand, 592×161). Height sets the size; width follows the ratio.
 */
export function BrandLogo({
  href = '/dashboard',
  tone = 'dark',
  className,
}: {
  href?: string;
  tone?: 'dark' | 'light';
  className?: string;
}) {
  return (
    <Link
      href={href}
      className={cn(
        'inline-block rounded-sm outline-none focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring',
        className,
      )}
    >
      <Image
        src={tone === 'dark' ? '/brand/for-after-logo.png' : '/brand/for-after-logo-light.png'}
        alt="For After"
        width={592}
        height={161}
        priority
        loading="eager"
        className="h-full w-auto"
      />
    </Link>
  );
}
