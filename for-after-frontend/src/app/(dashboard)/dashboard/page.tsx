import Image from 'next/image';
import Link from 'next/link';
import { Greeting } from '@/components/layout/greeting';
import {
  PEOPLE_I_LOVE,
  QUICK_ACTIONS,
  SPACES,
  TRUSTED_CONTACTS,
} from '@/components/layout/nav';
import { FeatureCard } from '@/components/shared/feature-card';
import { SectionHeading } from '@/components/shared/section-heading';
import { Button } from '@/components/ui/button';

export const metadata = { title: 'Dashboard' };

// Only real data: the Customer's name from /auth/me. There are no APIs yet for
// counts, progress or storage, so the page shows none.
export default function DashboardPage() {
  return (
    <div className="grid gap-16 lg:gap-20">
      <header className="grid gap-4">
        <p className="eyebrow">Your private space</p>
        <Greeting />
        <p className="max-w-xl text-lg text-foreground-muted">
          A secure place for the things that matter most, kept for the people you love.
        </p>
      </header>

      <section
        aria-labelledby="your-for-after"
        className="grid overflow-hidden rounded-xl bg-primary text-primary-foreground md:grid-cols-[1.15fr_1fr]"
      >
        <div className="flex flex-col gap-5 p-8 sm:p-12">
          <p className="text-xs font-medium tracking-[0.14em] uppercase opacity-80">Your For After</p>
          <h2 id="your-for-after" className="text-[40px] leading-[1.05] text-primary-foreground">
            A thoughtful <em>beginning.</em>
          </h2>
          <p className="max-w-md opacity-90">
            Create a private space for the people, stories and memories that matter. Begin with the
            people you love, then write your first message to them.
          </p>
          <div className="mt-2">
            <Button asChild variant="secondary">
              <Link href="/people">Begin with People I Love</Link>
            </Button>
          </div>
        </div>
        <div className="relative hidden min-h-72 md:block">
          <Image
            src="/brand/writing.webp"
            alt=""
            fill
            sizes="(min-width: 768px) 45vw, 0px"
            className="object-cover"
          />
        </div>
      </section>

      <section aria-labelledby="quick-actions">
        <SectionHeading id="quick-actions" title={<>What would you like <em>to do?</em></>} />
        <ul className="grid gap-4 lg:grid-cols-3">
          {QUICK_ACTIONS.map((action) => (
            <li key={action.label}>
              <FeatureCard item={action} compact />
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="your-spaces-heading" id="your-spaces" className="scroll-mt-24">
        <SectionHeading
          id="your-spaces-heading"
          eyebrow="Preserve"
          title={<>Your <em>spaces</em></>}
          description="Everything you need to leave something meaningful, in your own time."
        />
        <ul className="grid gap-4 sm:grid-cols-2">
          {SPACES.map((space) => (
            <li key={space.label}>
              <FeatureCard item={space} />
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="people">
        <SectionHeading
          id="people"
          eyebrow="People"
          title={<>The people <em>who matter</em></>}
        />
        <ul className="grid gap-4 lg:grid-cols-2">
          {[PEOPLE_I_LOVE, TRUSTED_CONTACTS].map((item) => (
            <li key={item.label}>
              <FeatureCard item={item} className="bg-surface-muted" />
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
