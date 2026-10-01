import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/** Eyebrow + Cormorant heading + optional intro, as on the WordPress sections. */
export function SectionHeading({
  id,
  eyebrow,
  title,
  description,
  className,
}: {
  id?: string;
  eyebrow?: string;
  title: ReactNode;
  description?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('mb-6 grid gap-2', className)}>
      {eyebrow && <p className="eyebrow">{eyebrow}</p>}
      <h2 id={id} className="text-3xl sm:text-[34px] sm:leading-tight">
        {title}
      </h2>
      {description && <p className="max-w-2xl text-foreground-muted">{description}</p>}
    </div>
  );
}
