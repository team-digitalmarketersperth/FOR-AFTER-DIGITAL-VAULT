'use client';

import { BookOpen, PenLine, type LucideIcon } from 'lucide-react';
import Link from 'next/link';
import { createContext, useContext, useState, type ComponentProps, type ReactNode } from 'react';
import { EmptyState } from '@/components/shared/states';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { useBilling } from '@/hooks/use-billing';
import type { BillingStatus } from '@/lib/api/billing';

type CapKind = Exclude<keyof NonNullable<BillingStatus['trialCaps']>, 'questions'>;

/**
 * Whether the free trial's allowance for this kind of record is used, from the API's own cap (GET /billing trialCaps)
 * and the live list's count. Paid, exempt and billing-off accounts have no cap, so they are never locked; if the plan
 * can't be read nothing is locked (the API still enforces). `ready` once both are known.
 */
export function useTrialCap(kind: CapKind, used: number | undefined) {
  const billing = useBilling(false);
  const cap = capFor(billing.data, kind);
  return {
    locked: cap !== null && used !== undefined && used >= cap,
    ready: !billing.isPending && used !== undefined,
  };
}

/**
 * The create limit the API enforces for this kind (Updated Plans Step 7): People I Love uses the server-resolved limit
 * (the trial's, or an entitled Premium/Complete plan's, GET /billing people); everything else the trial's cap. The
 * two-contact maximum isn't a cap here: the trusted-contacts page handles it without offering any plan. Never derived
 * from an interval; null = no limit to show (the API still decides).
 */
function capFor(data: BillingStatus | undefined, kind: CapKind): number | null {
  if (kind === 'recipients' && data?.people) return data.people.recipients.limit;
  return data?.trialCaps?.[kind] ?? null;
}

export type CapCopy = { title: string; description: string; badge: string | null; action: DialogAction | null };

/**
 * What a locked create control explains, from the server's own limit, its source and the tier in force:
 * - trial cap: the trial's allowance, "Premium", View plans (Premium's number from the server's plan matrix);
 * - Premium's recipient limit: Complete's larger one, "Complete", View plans (the plan page; never Checkout);
 * - Complete's recipient limit: the most any plan includes; no badge and no plan offer, Close only.
 */
export function useCapCopy(kind: CapKind): CapCopy {
  const data = useBilling(false).data;
  const premium = data?.planDefinitions?.PREMIUM;
  const complete = data?.planDefinitions?.COMPLETE;
  const people = data?.people?.recipients;
  if (kind === 'recipients' && people?.limitSource === 'plan' && people.limit !== null) {
    if (data?.productTier?.tier === 'PREMIUM' && complete && complete.recipients > people.limit) {
      return {
        title: 'You’ve added everyone your plan includes',
        description: `For After Premium includes up to ${people.limit} people in People I Love. For After Complete includes up to ${complete.recipients}. Everyone you’ve added stays as they are, and you can still edit or remove them.`,
        badge: 'Complete',
        action: VIEW_PLANS,
      };
    }
    return {
      title: 'You’ve added the most people a plan includes',
      description: `Your plan includes up to ${people.limit} people in People I Love, the most on any plan. To add someone new, remove someone first. Everyone you’ve added stays as they are.`,
      badge: null,
      action: null,
    };
  }
  const base = TRIAL_CAP_COPY[kind];
  const more =
    kind === 'recipients' && premium
      ? ` For After Premium includes up to ${premium.recipients} people.`
      : kind === 'trustedContacts' && premium
        ? ` For After Premium includes ${premium.trustedContacts}.`
        : '';
  return { title: base.title, description: base.description + more, badge: 'Premium', action: VIEW_PLANS };
}

export type CreateGate = 'open' | 'locked' | 'checking' | 'unknown';

/**
 * Whether a create page (`…/new`) may show its form. Decided once, when the plan and the live count are both known, so a
 * later refetch never swaps a half-filled form for the explanation (a refusal from the API is shown on the form, with
 * the input kept). Until then it is `checking`, or `unknown` if the plan can't be read: never treated as unlimited.
 */
export function useCreateGate(kind: CapKind, used: number | undefined): CreateGate {
  const billing = useBilling(false);
  const { locked, ready } = useTrialCap(kind, used);
  const [atOpen, setAtOpen] = useState<'open' | 'locked' | null>(null);
  // A guarded update during render: React's pattern for state derived from data that arrives later.
  // No trial cap (paid, exempt, billing off): open at once, whatever the count's own request does.
  const uncapped = billing.isSuccess && capFor(billing.data, kind) === null;
  if (atOpen === null && billing.isSuccess && (uncapped || ready)) setAtOpen(locked ? 'locked' : 'open');
  return atOpen ?? (billing.isError ? 'unknown' : 'checking');
}

/**
 * A create page that can't show its form (yet): the trial explanation with View plans and a way back, or the plan
 * status while it is read. The shell's own notice offers "Check plan again" when the plan can't be read.
 */
export function CreateGateNotice({
  gate,
  kind,
  icon,
  back,
}: {
  gate: Exclude<CreateGate, 'open'>;
  kind: CapKind;
  icon: LucideIcon;
  back: { href: string; label: string };
}) {
  const billing = useBilling(false);
  if (gate !== 'locked') {
    return (
      <div className="grid gap-3 rounded-xl border border-border bg-surface-muted p-6">
        <PlanCheck billing={billing} />
        {gate === 'unknown' && (
          <p className="text-sm text-foreground-muted">You can add something new once we’ve checked your plan. Everything saved stays as it is.</p>
        )}
      </div>
    );
  }
  return <LockedNotice kind={kind} icon={icon} back={back} />;
}

function LockedNotice({ kind, icon, back }: { kind: CapKind; icon: LucideIcon; back: { href: string; label: string } }) {
  const copy = useCapCopy(kind);
  return (
    <EmptyState
      icon={icon}
      title={copy.title}
      description={copy.description}
      action={
        <div className="flex flex-wrap justify-center gap-3">
          {copy.action && (
            <Button asChild>
              <Link href={copy.action.href}>{copy.action.label}</Link>
            </Button>
          )}
          <Button asChild variant="outline">
            <Link href={back.href}>{back.label}</Link>
          </Button>
        </div>
      }
    />
  );
}

export const TRIAL_CAP_COPY: Record<CapKind, { title: string; description: string }> = {
  recipients: {
    title: 'Add more people with a plan',
    description:
      'Your free trial includes one person in People I Love. Choose a plan to add more. Everyone you’ve added stays as it is, and you can still edit or remove them.',
  },
  trustedContacts: {
    title: 'Add another trusted contact with a plan',
    description:
      'Your free trial includes one trusted contact. Choose a plan to nominate a second. Your current contact stays as they are, and you can still edit, invite or remove them.',
  },
  // Trial Step 7 (approved): one written memory, separate from the four questions.
  memories: {
    title: 'Save more memories with a plan',
    description:
      'Your free trial includes one written memory in your Memory Vault. Choose a plan to save more. Your memories stay as they are, and you can still edit or delete them.',
  },
};

/**
 * Updated Plans Step 7: "3 of 10 people" / "1 of 2 trusted contacts" from the API's own count and limit (GET /billing
 * people). With no count limit just the number ("4 people added", never "unlimited"). Nothing while the plan is
 * unknown or on an older API.
 */
export function PeopleCounter({ kind, className = 'text-sm text-foreground-muted' }: { kind: 'recipients' | 'trustedContacts'; className?: string }) {
  const p = useBilling(false).data?.people?.[kind];
  if (!p) return null;
  const noun = kind === 'recipients' ? (p.limit === 1 ? 'person' : 'people') : p.limit === 1 ? 'trusted contact' : 'trusted contacts';
  const text =
    p.limit === null ? `${p.used} ${p.used === 1 ? 'person' : 'people'} added` : `${p.used} of ${p.limit} ${noun}${kind === 'trustedContacts' && p.limitSource === 'maximum' ? ' (the most on any plan)' : ''}`;
  return (
    <p aria-live="polite" className={className}>
      {text}
    </p>
  );
}

/**
 * "X of 1 trial memory used" on the Memory Vault, from the API's own count (GET /billing memoriesSaved: every live
 * memory, whatever the list's filters). Nothing without a trial cap (paid, exempt, billing off) or while unknown.
 */
export function TrialMemories({ className = 'text-sm text-foreground-muted' }: { className?: string }) {
  const data = useBilling(false).data;
  const cap = data?.trialCaps?.memories ?? null;
  const used = data?.memoriesSaved;
  if (cap === null || used === undefined) return null;
  return (
    <p aria-live="polite" className={className}>
      {used} of {cap} trial {cap === 1 ? 'memory' : 'memories'} used
    </p>
  );
}

/**
 * The small mark on a creation control the plan doesn't include: the lowest tier that includes it (Updated Plans Step
 * 7): "Premium" for what any paid plan adds, "Complete" for video and Premium's recipient limit. Text, not colour alone.
 */
export function ProBadge({ label = 'Premium' }: { label?: string }) {
  return (
    <span className="rounded-full bg-primary-soft px-2 py-0.5 text-xs font-semibold tracking-wide text-primary">{label}</span>
  );
}

/**
 * The one "needs a plan" explanation: title, text, "View plans" and Close. Radix traps focus, closes on Escape and
 * returns focus to the trigger. Opening or closing it changes nothing on the page (a form keeps what was typed).
 */
export type DialogAction = { label: string; href: string };
const VIEW_PLANS: DialogAction = { label: 'View plans', href: '/settings/plan' };

export function ProDialog({
  trigger,
  title,
  description,
  action = VIEW_PLANS,
}: {
  trigger: ReactNode;
  title: string;
  description: string;
  /** null: nothing to offer (no plan includes more), so Close only. */
  action?: DialogAction | null;
}) {
  return (
    <Dialog>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="gap-6 rounded-xl bg-surface p-7 sm:max-w-md" showCloseButton={false}>
        <DialogHeader className="gap-3">
          <DialogTitle className="text-[28px] leading-tight font-normal">{title}</DialogTitle>
          <DialogDescription className="text-[15px] leading-relaxed text-foreground-muted">{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter className="mx-0 mb-0 flex-col-reverse gap-3 rounded-none border-0 bg-transparent p-0 sm:flex-row">
          <DialogClose asChild>
            <Button type="button" variant="outline">
              Close
            </Button>
          </DialogClose>
          {action && (
            <Button asChild>
              <Link href={action.href}>{action.label}</Link>
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** A control the plan doesn't include: its own label plus its tier badge; type="button", so it never submits a form. */
function ProButton({ label, icon: Icon, badge, ...props }: { label: string; icon: LucideIcon; badge?: string | null } & ComponentProps<typeof Button>) {
  return (
    <Button type="button" variant="outline" {...props}>
      <Icon aria-hidden strokeWidth={1.5} />
      {label}
      {badge !== null && <ProBadge label={badge} />}
    </Button>
  );
}

/** An add control whose trial allowance is used (Step 3). Creates nothing. */
export function TrialLockedButton({ kind, label, icon, className }: { kind: CapKind; label: string; icon: LucideIcon; className?: string }) {
  const copy = useCapCopy(kind);
  return (
    <ProDialog
      trigger={<ProButton label={label} icon={icon} className={className} badge={copy.badge} />}
      title={copy.title}
      description={copy.description}
      action={copy.action}
    />
  );
}

// Trial Step 4, worded by tier in Updated Plans Step 7: photos and audio start at Premium; video is Complete's.
export const PAID_MEDIA_COPY = {
  title: 'Photos and recordings come with a plan',
  description: 'Your free trial includes written messages. For After Premium adds photos and voice recordings; video is part of For After Complete.',
  badge: 'Premium',
};
export const TRIAL_VIDEO_COPY = {
  title: 'Video is part of For After Complete',
  description: 'Your free trial includes written messages. Video is available with For After Complete.',
  badge: 'Complete',
};

/**
 * Photos, voice recordings and videos, from the API's own `features.media` (GET /billing): false only in an enforced
 * active trial, so paid, exempt and billing-off accounts are never locked. Unknown (loading, error, an older API) is
 * not locked: the API still refuses, and `PlanCheck` says the plan couldn't be read.
 */
export function usePaidMedia() {
  const billing = useBilling(false);
  const features = billing.data?.features;
  const locked = features?.media === false;
  // Updated Plans Step 4: media allowed, but not video (an entitled Premium plan). Unknown (loading, error, an older API
  // without mediaKinds) is not locked: the API still refuses with TIER_REQUIRED, and nothing on the page is swapped.
  const videoLocked = !locked && !!features?.mediaKinds && !features.mediaKinds.includes('VIDEO');
  return { locked, videoLocked, billing };
}

// Updated Plans Step 4: video on Premium. Names the tier that includes it; no claim about buying it online (the plan
// page says when plans can't be bought).
export const COMPLETE_VIDEO_COPY = {
  title: 'Video is part of For After Complete',
  description:
    'Your plan includes photos and audio. Video is available with For After Complete. Videos you already have stay as they are, and you can still view or remove them.',
  badge: 'Complete',
};

/** A video control Premium doesn't include: its own label plus "Complete", opening the explanation. */
export function CompleteVideoButton({ label, icon }: { label: string; icon: LucideIcon }) {
  return <ProDialog trigger={<ProButton label={label} icon={icon} badge={COMPLETE_VIDEO_COPY.badge} />} {...COMPLETE_VIDEO_COPY} />;
}

/** A media control the trial doesn't include: "Premium" for photos and audio, "Complete" for video. */
export function PaidMediaButton({ label, icon, video = false }: { label: string; icon: LucideIcon; video?: boolean }) {
  const copy = video ? TRIAL_VIDEO_COPY : PAID_MEDIA_COPY;
  return <ProDialog trigger={<ProButton label={label} icon={icon} badge={copy.badge} />} title={copy.title} description={copy.description} />;
}

/** True inside the dashboard shell while it shows its own "Check plan again", so pages don't repeat it. */
export const ShellShowsPlanCheck = createContext(false);

/** While the plan is being read, or if it couldn't be: a quiet status with Try again. Nothing once it is known. */
export function PlanCheck({ billing }: { billing: ReturnType<typeof useBilling> }) {
  const shellShows = useContext(ShellShowsPlanCheck);
  if (billing.isPending) {
    return (
      <p role="status" className="text-sm text-foreground-muted">
        Checking your plan…
      </p>
    );
  }
  if (!billing.isError || shellShows) return null;
  return (
    <p role="status" className="flex flex-wrap items-center gap-2 text-sm text-foreground-muted">
      We couldn’t check your plan just now.
      {/* Not "Try again": that name belongs to the content's own retry beside it. */}
      <Button type="button" size="sm" variant="outline" onClick={() => void billing.refetch()}>
        Check plan again
      </Button>
    </p>
  );
}

// Trial Step 5: four questions with written answers, My Story and My Wishes combined.
export const TRIAL_QUESTIONS_COPY = {
  title: 'Answer more questions with a plan',
  description:
    'Your free trial includes four answered questions across My Story and My Wishes. For After Premium includes every question. Your answers stay as they are, and you can still edit or delete them.',
};

/** Written words: the API's rule, so whitespace never counts as an answered question. */
export const hasAnswerText = (text: string | null | undefined) => !!text && /\S/.test(text);

/**
 * The shared question count (GET /billing questionsAnswered against trialCaps.questions). `cap` null = no trial cap
 * (paid, exempt, billing off): never locked. Unknown (loading, error) is not locked either; `PlanCheck` says so and the
 * API still refuses a fifth question.
 */
export function useTrialQuestions() {
  const billing = useBilling(false);
  const cap = billing.data?.trialCaps?.questions ?? null;
  const used = billing.data?.questionsAnswered;
  return { billing, cap, used, full: cap !== null && used !== undefined && used >= cap };
}

export type QuestionGate = 'open' | 'locked' | 'checking' | 'unknown' | 'readonly';

/**
 * Whether this question's answer box may open. A saved written answer is always editable while writes are allowed.
 * A new answer opens once the plan is known and a slot is free: while the plan loads it is `checking`, if it can't be
 * read `unknown` (never treated as unlimited), and with every slot used `locked`. Step 6: with no write access at all
 * (an ended trial, or another state without access) it is `readonly`. Once open (or with unsaved typing, `keep`) it
 * stays open, so a refetch never swaps a half-written answer away; a refusal from the API is shown on the form, with
 * the text kept. A lock lifts as soon as a slot frees up or access returns.
 */
export function useQuestionGate(savedText: string | null | undefined, keep = false): QuestionGate {
  const { billing, full } = useTrialQuestions();
  const answered = hasAnswerText(savedText);
  const noAccess = billing.isSuccess && billing.data.enabled && !billing.data.hasAccess;
  const [opened, setOpened] = useState(false);
  if (!opened && billing.isSuccess && !noAccess && (answered || !full)) setOpened(true);
  if (opened || keep) return 'open';
  if (noAccess) return 'readonly';
  // Plan still loading or unreadable: a saved answer stays editable (the API decides).
  if (answered) return 'open';
  if (billing.isSuccess) return full ? 'locked' : 'open';
  return billing.isError ? 'unknown' : 'checking';
}

/** "X of 4 trial questions answered", the same line in both sections; nothing without a trial cap. */
export function TrialQuestions({ className, quiet }: { className?: string; quiet?: boolean }) {
  const { billing, cap, used } = useTrialQuestions();
  // Loading or unreadable: the plan status (unless the answer box below already shows it, `quiet`).
  if (!billing.isSuccess) return quiet ? null : <PlanCheck billing={billing} />;
  if (cap === null || used === undefined) return null;
  return (
    <p aria-live="polite" className={className ?? 'text-sm text-foreground-muted'}>
      {used} of {cap} trial questions answered
    </p>
  );
}

/** In place of the answer box on a new question that can't open yet: checking, unreadable plan, or locked. */
export function QuestionGateNotice({ gate }: { gate: Exclude<QuestionGate, 'open' | 'readonly'> }) {
  const { billing } = useTrialQuestions();
  if (gate === 'locked') return <QuestionLocked />;
  return (
    <div className="grid gap-3 rounded-xl border border-border bg-surface-muted p-6">
      <PlanCheck billing={billing} />
      {gate === 'unknown' && (
        <p className="text-sm text-foreground-muted">You can write a new answer once we’ve checked your plan. Saved answers stay as they are.</p>
      )}
    </div>
  );
}

/** In place of the answer box on a locked question: opens the shared plan dialog. Creates nothing. */
function QuestionLocked() {
  return (
    <div className="grid gap-3 rounded-xl border border-border bg-surface-muted p-6">
      <p className="text-[15px] text-foreground-secondary">{TRIAL_QUESTIONS_COPY.description}</p>
      <div>
        <ProDialog trigger={<ProButton label="Write your answer" icon={PenLine} />} {...TRIAL_QUESTIONS_COPY} />
      </div>
    </div>
  );
}

// Trial Step 5: linking Memory Vault memories to My Story answers is paid-only (the API's PAID_MEMORY_LINK_MESSAGE).
export const PAID_MEMORY_LINK_COPY = {
  title: 'Available with a paid plan',
  description: 'Your free trial includes written answers. For After Premium and Complete let you link memories from your Memory Vault.',
};

/** From the API's `features.memoryLinks`: false only in an enforced active trial. Unknown is not locked (the API refuses). */
export function usePaidMemoryLinks() {
  return useBilling(false).data?.features?.memoryLinks === false;
}

/** The memory-link control the trial doesn't include. Linked memories stay listed, with Unlink. */
export function PaidMemoryLinkButton({ label }: { label: string }) {
  return <ProDialog trigger={<ProButton label={label} icon={BookOpen} />} {...PAID_MEMORY_LINK_COPY} />;
}
