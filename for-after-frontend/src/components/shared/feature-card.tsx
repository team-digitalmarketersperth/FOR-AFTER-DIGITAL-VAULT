import { ArrowRight } from 'lucide-react';
import Link from 'next/link';
import type { NavItem } from '@/components/layout/nav';
import { cn } from '@/lib/utils';

/**
 * Icon + title + one-line description. With an href it is a link with an
 * arrow; without one it is inert and says "Coming next" (never a fake button).
 */
export function FeatureCard({
  item: { label, description, icon: Icon, href },
  className,
}: {
  item: NavItem;
  className?: string;
}) {
  const status = href ? (
    <span className="inline-flex items-center gap-1.5 font-semibold text-primary">
      Open <ArrowRight aria-hidden className="size-4" />
    </span>
  ) : (
    <span className="text-foreground-muted">Coming next</span>
  );
  const cls = cn(
    'flex h-full flex-col gap-4 rounded-lg border border-border bg-surface p-6 sm:p-7',
    className,
  );
  const body = (
    <>
      <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-primary-soft text-primary">
        <Icon aria-hidden strokeWidth={1.5} className="size-5" />
      </span>
      <div className="grid flex-1 gap-1.5">
        <h3 className="text-[26px] leading-tight font-medium">
          {label}
        </h3>
        <p className="text-[15px] text-foreground-muted">{description}</p>
        <p className="mt-3 text-sm">{status}</p>
      </div>
    </>
  );

  if (!href) return <div className={cls}>{body}</div>;
  return (
    <Link
      href={href}
      className={cn(cls, 'outline-none transition-colors hover:border-border-strong focus-visible:outline-2 focus-visible:outline-ring')}
    >
      {body}
    </Link>
  );
}
