'use client';

import type { UseQueryResult } from '@tanstack/react-query';
import { ArrowRight, Check, Circle, Heart, Play, ShieldCheck } from 'lucide-react';
import Image from 'next/image';
import Link from 'next/link';
import type { CSSProperties, ReactNode } from 'react';
import { useReadiness } from '@/hooks/use-readiness';
import type { ApiError } from '@/lib/api/errors';
import type { Readiness, ReadinessKey, ReadinessStep } from '@/lib/api/readiness';
import { cn } from '@/lib/utils';

type Cta = { label: string; href: string };
type Progress = { text: string; cta: Cta };

type Step = {
  title: string;
  copy: string;
  /** The setup step this card stands for; the outcome card is not one. */
  key?: ReadinessKey;
  /** Shown until (or if) progress loads; omitted on the outcome card, which has no page. */
  cta?: Cta;
  visual: ReactNode;
};

// The whole product story, in order. Destinations are existing routes only.
const STEPS: Step[] = [
  {
    key: 'PEOPLE',
    title: 'Add the people you love',
    copy: 'Choose the people you want to preserve messages, memories and wishes for.',
    cta: { label: 'Manage people', href: '/people' },
    visual: <PeopleVisual />,
  },
  {
    key: 'TRUSTED_CONTACTS',
    title: 'Choose trusted contacts',
    copy: 'Add one or two people you trust to help when needed.',
    cta: { label: 'Add contacts', href: '/trusted-contacts' },
    visual: <TrustedVisual />,
  },
  {
    key: 'PRESERVED',
    title: 'Record what matters',
    copy: 'Write messages, save memories, tell your story and record your wishes.',
    cta: { label: 'Start preserving', href: '/dashboard#your-spaces' },
    visual: <RecordVisual />,
  },
  {
    key: 'SCHEDULING',
    title: 'Choose when it’s shared',
    copy: 'Decide when each message should be delivered.',
    cta: { label: 'Review scheduling', href: '/messages' },
    visual: <ScheduleVisual />,
  },
  {
    key: 'WISHES',
    title: 'Keep your space updated',
    copy: 'Return anytime to review your wishes and refine what you’ve created.',
    cta: { label: 'Review your wishes', href: '/my-wishes' },
    visual: <ReviewVisual />,
  },
  {
    title: 'They receive it at the right time',
    copy: 'Your loved ones receive what you leave for them in a calm, private experience.',
    visual: <ReceiveVisual />,
  },
];

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

// Real status for each setup step, from the API's counts: what is done, or
// the next thoughtful step. Calm wording only (never "incomplete" or "urgent").
const PROGRESS: { [K in ReadinessKey]: (s: Extract<ReadinessStep, { key: K }>) => Progress } = {
  PEOPLE: (s) =>
    s.complete
      ? { text: `${count(s.people, 'person', 'people')} added`, cta: { label: 'Manage people', href: '/people' } }
      : { text: 'No one added yet', cta: { label: 'Add someone you love', href: '/people' } },
  // Ready = accepted their invitation (the Trusted Contacts page shows the same).
  TRUSTED_CONTACTS: (s) =>
    s.complete
      ? {
          text: s.ready === s.trustedContacts ? `${count(s.ready, 'contact', 'contacts')} ready` : `${s.ready} of ${s.trustedContacts} ready`,
          cta: { label: 'Manage contacts', href: '/trusted-contacts' },
        }
      : s.trustedContacts
        ? {
            text: `Waiting for ${s.trustedContacts === 1 ? 'your contact' : 'your contacts'} to accept`,
            cta: { label: 'Check your contacts', href: '/trusted-contacts' },
          }
        : { text: 'Not set up yet', cta: { label: 'Add a trusted contact', href: '/trusted-contacts' } },
  PRESERVED: (s) =>
    s.complete
      ? {
          text: [
            [s.messages, 'message', 'messages'],
            [s.memories, 'memory', 'memories'],
            [s.storyAnswers, 'story answer', 'story answers'],
          ]
            .filter(([n]) => (n as number) > 0)
            .map(([n, one, many]) => count(n as number, one as string, many as string))
            .join(' · '),
          cta: { label: 'Open your spaces', href: '/dashboard#your-spaces' },
        }
      : { text: 'Nothing preserved yet', cta: { label: 'Preserve something meaningful', href: '/dashboard#your-spaces' } },
  SCHEDULING: (s) =>
    s.complete
      ? {
          text: s.messages === 1 ? 'Your message has its timing' : `All ${s.messages} messages have their timing`,
          cta: { label: 'Review scheduling', href: '/messages' },
        }
      : s.messages === 0
        ? { text: 'No messages yet', cta: { label: 'Write your first message', href: '/messages/new' } }
        : {
            text: s.needsScheduling === 1 ? '1 message needs scheduling' : `${s.needsScheduling} messages need scheduling`,
            cta: { label: 'Choose when they’re shared', href: '/messages' },
          },
  WISHES: (s) => ({
    text: s.complete ? 'Wishes recorded' : 'No wishes recorded yet',
    cta: { label: 'Review your wishes', href: '/my-wishes' },
  }),
};
const progressFor = (s: ReadinessStep) => (PROGRESS[s.key] as (s: ReadinessStep) => Progress)(s);

// One geometry for every connector: the line runs level with each card's
// number rule (--node-y), through the column gaps (--gap) on desktop and down
// a left rail (--rail) below lg. Lines are an opaque bronze tint, so where two
// segments meet they never darken. Everything here is decorative (aria-hidden)
// and pointer-events-none, so it can never take a click.
const GEOMETRY = {
  '--gap': '2.5rem',
  '--node-y': '2.25rem',
  '--rail': '1.75rem',
  '--line': 'color-mix(in srgb, var(--brand-bronze) 42%, var(--background))',
  // Step numbers: bronze deepened with the body ink for AA contrast at 11px.
  '--ink': 'color-mix(in srgb, var(--brand-bronze) 72%, var(--brand-semi-black))',
} as CSSProperties;

const node = 'absolute size-[7px] -translate-x-1/2 -translate-y-1/2 rounded-full border border-(--line) bg-background transition-colors duration-200';

type StepState = { loading: boolean; status?: ReadinessStep };

/**
 * "Your For After journey": the setup progress (real readiness data) above
 * six connected steps. Desktop: 01 → 02 → 03, a return line down and back,
 * then 04 → 05 → 06, ending on the destination card. Below lg: one vertical
 * timeline. Steps 01–05 carry their real status; 06 is the outcome and never
 * counts toward the score.
 */
export function DashboardJourney() {
  const readiness = useReadiness();
  const state = (step: Step): StepState => ({
    loading: !!step.key && readiness.isPending,
    status: step.key ? readiness.data?.steps.find((s) => s.key === step.key) : undefined,
  });
  return (
    <section aria-labelledby="journey-heading" style={GEOMETRY}>
      <ReadinessHeader query={readiness} />
      <ol className="relative grid gap-y-8 pl-(--rail) sm:pl-[calc(var(--rail)+0.75rem)] lg:grid-cols-3 lg:grid-rows-[auto_4.5rem_auto] lg:gap-x-(--gap) lg:gap-y-0 lg:pl-0">
        {STEPS.slice(0, 3).map((step, i) => (
          <JourneyStep key={step.title} step={step} index={i} {...state(step)} />
        ))}
        <ReturnConnector />
        {STEPS.slice(3).map((step, i) => (
          <JourneyStep key={step.title} step={step} index={i + 3} {...state(step)} />
        ))}
      </ol>
    </section>
  );
}

/**
 * Heading left, score right, one supporting line, a thin bar. Loading: quiet
 * placeholders (never a 0 that jumps). Error: "unavailable", never 0%, and the
 * journey stays usable.
 */
function ReadinessHeader({ query }: { query: UseQueryResult<Readiness, ApiError> }) {
  const data = query.data;
  const ready = data?.score === 100;
  return (
    <header className="mb-12 grid gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-8 gap-y-1">
        <h2 id="journey-heading" className="text-3xl sm:text-[34px] sm:leading-tight">
          Your For After <em>journey</em>
        </h2>
        {query.isPending ? (
          <span aria-hidden className="h-6 w-24 animate-pulse rounded-md bg-surface-muted" />
        ) : data ? (
          <p className="font-heading text-xl text-foreground-secondary">{data.score}% ready</p>
        ) : null}
      </div>
      {query.isPending ? (
        <div aria-busy="true" aria-label="Loading your progress" className="grid gap-3">
          <span className="h-4 w-48 animate-pulse rounded-md bg-surface-muted" />
          <span className="h-[2px] w-full rounded-full bg-surface-muted" />
        </div>
      ) : data ? (
        <>
          {ready ? (
            <div className="grid gap-1">
              <p className="text-sm font-medium text-foreground-secondary">Your essentials are in place</p>
              <p className="text-sm text-foreground-muted">
                Everything important is set up. You can return anytime to make changes.
              </p>
            </div>
          ) : (
            <p className="text-sm text-foreground-muted">
              {data.completedSteps} of {data.totalSteps} essentials in place
            </p>
          )}
          <div
            role="progressbar"
            aria-label="Setup progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={data.score}
            aria-valuetext={`${data.score}% ready, ${data.completedSteps} of ${data.totalSteps} essentials in place`}
            className="mt-1 h-[2px] overflow-hidden rounded-full bg-brand-lilac-grey/70"
          >
            <div className="h-full rounded-full bg-primary transition-[width] duration-500 ease-out" style={{ width: `${data.score}%` }} />
          </div>
        </>
      ) : (
        <p className="text-sm text-foreground-muted">Progress is unavailable right now.</p>
      )}
    </header>
  );
}

function JourneyStep({ step, index, ...state }: { step: Step; index: number } & StepState) {
  const last = index === STEPS.length - 1;
  const rowEnd = index === 2 || last;
  return (
    <li className={cn('group relative flex', index > 2 && 'lg:row-start-3')}>
      {/* Below lg: rail node, and the segment down to the next card's node. */}
      <span aria-hidden className="pointer-events-none lg:hidden">
        <span
          className={cn(
            node,
            '-left-[calc(var(--rail)/2)] top-(--node-y) sm:-left-[calc(var(--rail)/2+0.375rem)]',
            last ? 'border-primary bg-primary' : state.status?.complete ? 'bg-(--line)' : 'group-hover:bg-(--line)',
          )}
        />
        {!last && (
          <span className="absolute -left-[calc(var(--rail)/2)] top-[calc(var(--node-y)+4px)] h-[calc(100%+2rem-8px)] border-l border-(--line) sm:-left-[calc(var(--rail)/2+0.375rem)]" />
        )}
      </span>
      {/* lg: the hairline across the gap to the next card, with its node. */}
      {!rowEnd && (
        <span
          aria-hidden
          className="pointer-events-none absolute top-(--node-y) left-full hidden w-(--gap) border-t border-(--line) lg:block"
        >
          <span className={cn(node, 'top-0 left-1/2 group-hover:bg-(--line)')} />
        </span>
      )}
      <StepCard step={step} index={index} destination={last} {...state} />
    </li>
  );
}

function StepCard({
  step,
  index,
  destination,
  loading,
  status,
}: { step: Step; index: number; destination: boolean } & StepState) {
  const progress = status && progressFor(status);
  const cta = progress?.cta ?? step.cta;
  return (
    <article
      className={cn(
        // Tablet (md): asymmetric, visual left and words right, so a full-width
        // card never turns into an empty band. Phone and desktop: stacked.
        'relative flex w-full flex-col gap-6 rounded-xl border p-7 transition duration-200 ease-out',
        'md:grid md:grid-cols-[13rem_1fr] md:gap-x-10 lg:flex',
        'has-[a:focus-visible]:outline-2 has-[a:focus-visible]:outline-offset-2 has-[a:focus-visible]:outline-ring',
        destination
          ? 'border-primary bg-primary text-primary-foreground'
          : 'border-border bg-surface hover:-translate-y-0.5 hover:border-(--line) hover:shadow-soft',
      )}
    >
      <p className="flex items-center gap-3 text-[11px] leading-4 font-medium tracking-[0.2em] md:col-span-2">
        <span className={destination ? 'text-(--brand-lilac)' : 'text-(--ink)'}>{String(index + 1).padStart(2, '0')}</span>
        <span aria-hidden className={cn('h-px', destination ? 'w-5 bg-(--brand-lilac) opacity-50' : 'w-8 bg-(--line)')} />
        {destination && <span className="whitespace-nowrap text-(--brand-lilac) uppercase">Where it leads</span>}
        {status && (
          <span
            className={cn(
              'ml-auto inline-flex items-center gap-1.5 tracking-[0.14em] uppercase',
              status.complete ? 'text-(--ink)' : 'text-foreground-muted',
            )}
          >
            {status.complete ? (
              <Check aria-hidden strokeWidth={2} className="size-3" />
            ) : (
              <Circle aria-hidden strokeWidth={1.5} className="size-2.5" />
            )}
            {status.complete ? 'Complete' : 'To do'}
          </span>
        )}
      </p>
      <div aria-hidden className={cn('h-24 transition-opacity', status?.complete && 'opacity-80')}>
        {step.visual}
      </div>
      <div className="flex flex-1 flex-col gap-6">
        <div className="grid gap-2">
          <h3 className={cn('text-[26px] leading-[1.1]', destination && 'text-primary-foreground')}>{step.title}</h3>
          <p className={cn('text-[15px]', destination ? 'text-primary-foreground/80' : 'text-foreground-muted')}>
            {step.copy}
          </p>
        </div>
        <div className="mt-auto grid gap-3 pt-1 text-sm">
          {loading && <span aria-hidden className="h-4 w-40 animate-pulse rounded bg-surface-muted" />}
          {progress && (
            <p
              className={cn(
                'flex items-center gap-2',
                status.complete ? 'text-foreground-muted' : 'font-medium text-foreground-secondary',
              )}
            >
              {status.complete ? (
                <Check aria-hidden strokeWidth={1.75} className="size-4 shrink-0 text-(--ink)" />
              ) : (
                <Circle aria-hidden strokeWidth={1.5} className="size-3.5 shrink-0 text-brand-bronze" />
              )}
              {progress.text}
            </p>
          )}
          {cta ? (
            // The whole card is the link's hit area (after:inset-0); the link
            // text stays the accessible name.
            <Link
              href={cta.href}
              className="inline-flex w-fit items-center gap-2 font-medium text-primary outline-none after:absolute after:inset-0 after:rounded-xl"
            >
              {cta.label}
              <ArrowRight aria-hidden strokeWidth={1.5} className="size-4 transition-transform duration-200 group-hover:translate-x-0.5" />
            </Link>
          ) : (
            // No page of its own: an informational line, never a fake link.
            <p className="flex items-start gap-2 text-primary-foreground/75">
              <ShieldCheck aria-hidden strokeWidth={1.5} className="mt-0.5 size-4 shrink-0" />
              Released only after our team verifies, never automatically.
            </p>
          )}
        </div>
      </div>
    </article>
  );
}

/**
 * The turn from 03 to 04 (lg only): down from 03's centre, back along the
 * middle of the connector row with softened corners, down into 04's centre.
 * Column centres from the grid itself: c = (100% - 2 gaps) / 6 from each edge.
 */
function ReturnConnector() {
  const c = '((100% - 2 * var(--gap)) / 6)';
  return (
    <li aria-hidden className="pointer-events-none relative hidden lg:col-span-3 lg:row-start-2 lg:block">
      <span
        className="absolute top-0 h-1/2 rounded-br-[14px] border-r border-b border-(--line)"
        style={{ left: `calc(${c} + 14px)`, right: `calc(${c})` }}
      />
      <span
        className="absolute top-[calc(50%-1px)] bottom-0 w-[15px] rounded-tl-[14px] border-t border-l border-(--line)"
        style={{ left: `calc(${c})` }}
      />
      <span className={cn(node, 'top-0')} style={{ left: `calc(100% - ${c})` }} />
      <span className={cn(node, 'top-full')} style={{ left: `calc(${c})` }} />
    </li>
  );
}

// ─── Visuals: quiet, abstract, brand colours; two existing brand photos ────

function PeopleVisual() {
  return (
    <div className="relative flex h-full items-end gap-2">
      <span className="flex h-24 w-[68px] items-center justify-center rounded-t-full bg-primary-soft">
        <Heart strokeWidth={1.25} className="size-5 text-primary" />
      </span>
      <span className="h-[72px] w-[52px] rounded-t-full bg-brand-lilac-grey/70" />
      <span className="h-12 w-9 rounded-t-full border border-(--line)" />
    </div>
  );
}

function TrustedVisual() {
  return (
    <div className="flex h-full items-center">
      <span className="flex size-16 items-center justify-center rounded-full bg-primary-soft font-heading text-2xl text-primary ring-4 ring-surface">
        A
      </span>
      <span className="-ml-4 flex size-16 items-center justify-center rounded-full bg-brand-lilac-grey/80 font-heading text-2xl text-foreground-secondary ring-4 ring-surface">
        J
      </span>
      <span className="-ml-3 flex size-8 items-center justify-center self-end rounded-full border border-(--line) bg-surface">
        <ShieldCheck strokeWidth={1.5} className="size-4 text-brand-bronze" />
      </span>
    </div>
  );
}

function RecordVisual() {
  const bars = [6, 14, 9, 20, 12, 24, 10, 17, 7, 13, 5];
  return (
    <div className="relative flex h-full items-center">
      <div className="relative h-24 w-[72px] -rotate-3 overflow-hidden rounded-md shadow-soft ring-4 ring-surface transition-transform duration-200 group-hover:scale-[1.01]">
        <Image src="/brand/writing.webp" alt="" fill sizes="72px" className="object-cover" />
      </div>
      <div className="-ml-3 flex h-14 items-center gap-[3px] rounded-md border border-border bg-surface px-3 shadow-soft">
        <span className="mr-2 flex size-6 items-center justify-center rounded-full bg-primary text-primary-foreground">
          <Play strokeWidth={1.5} className="size-3 translate-x-px fill-current" />
        </span>
        {bars.map((h, i) => (
          <span key={i} className="w-[2px] rounded-full bg-brand-bronze/60" style={{ height: h }} />
        ))}
      </div>
    </div>
  );
}

function ScheduleVisual() {
  return (
    <ul className="grid h-full content-center gap-1.5 text-[13px]">
      {['Specific date', 'Birthday', 'After I’m gone'].map((label, i) => (
        <li
          key={label}
          className={cn(
            'flex w-48 items-center gap-2.5 rounded-md border px-3 py-1',
            i === 2 ? 'border-(--line) bg-primary-soft/60 text-foreground' : 'border-border text-foreground-muted',
          )}
        >
          <span className={cn('size-2.5 rounded-full border', i === 2 ? 'border-primary bg-primary' : 'border-border-strong')} />
          {label}
        </li>
      ))}
    </ul>
  );
}

function ReviewVisual() {
  return (
    <ul className="grid h-full content-center gap-2.5">
      {[40, 32, 36].map((w, i) => (
        <li key={i} className="flex items-center gap-3">
          <span className="flex size-5 items-center justify-center rounded-full border border-(--line)">
            <Check strokeWidth={1.75} className="size-3 text-brand-bronze" />
          </span>
          <span className="h-1.5 rounded-full bg-brand-lilac-grey/80" style={{ width: `${w * 3}px` }} />
        </li>
      ))}
    </ul>
  );
}

function ReceiveVisual() {
  return (
    <div className="relative h-24 w-40 overflow-hidden rounded-lg ring-1 ring-primary-foreground/20">
      <Image
        src="/brand/together.webp"
        alt=""
        fill
        sizes="160px"
        className="object-cover object-[35%_40%] transition-transform duration-200 group-hover:scale-[1.01]"
      />
      <span className="absolute bottom-2 left-2 flex size-7 items-center justify-center rounded-full bg-primary-foreground/90 text-primary">
        <Play strokeWidth={1.5} className="size-3 translate-x-px fill-current" />
      </span>
    </div>
  );
}
