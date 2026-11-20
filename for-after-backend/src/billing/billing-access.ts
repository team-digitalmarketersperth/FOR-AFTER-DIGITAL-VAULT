import { ConflictException, SetMetadata } from '@nestjs/common';
import { MediaKind, PaidTier, Prisma } from '../generated/prisma/client.js';

/**
 * The one definition of a Customer's billing/access state (docs/billing.md §3),
 * used by enforcement, the Customer plan page, Admin → Users and the admin
 * billing page. Pure: time comes in as `now`, so expiry needs no scheduler.
 * Billing state is kept apart from account security (User.status).
 */
export const TRIAL_DAYS = 7; // decided 2026-10-31: card-free, app-run 7-day trial
const DAY = 24 * 60 * 60 * 1000;
export const trialEnd = (start: Date) =>
  new Date(start.getTime() + TRIAL_DAYS * DAY);

export const ACCESS_STATES = [
  'no_billing_record', // not subject to billing (billing off, or an account created before enforcement)
  'trial_available', // subject to billing, no trial or subscription yet
  'trial_active',
  'trial_expired',
  'paid_active',
  'cancellation_scheduled', // paid, cancels at period end; access until then
  'payment_issue', // past_due within the paid period; access until period end
  'payment_pending', // checkout started, first payment not confirmed (incomplete)
  'plan_unresolved', // Updated Plans Step 6: paid in Stripe, but its price matches no configured plan; no access until resolved
  'access_ended', // subscription ended, unpaid, expired or paused
] as const;
export type AccessState = (typeof ACCESS_STATES)[number];

export type BillingInputs = {
  userCreatedAt: Date;
  trial: { startedAt: Date; endsAt: Date } | null;
  account: {
    plan: string | null;
    /** Updated Plans: the stored paid tier. Never consulted by accessState() (a tier grants no access). */
    tier?: PaidTier | null;
    /** Updated Plans Step 6: the subscription's price matched no configured mapping (see BillingService.sync). */
    priceUnresolved?: boolean;
    subscriptionStatus: string | null;
    cancelAtPeriodEnd: boolean;
    currentPeriodEnd: Date | null;
  } | null;
};
export type BillingPolicy = { enabled: boolean; enforceFrom: Date | null };

/** BILLING_ENABLED / BILLING_ENFORCE_FROM, read the same way by every service that needs the policy. */
export function billingPolicy(
  get: (key: string) => string | undefined,
): BillingPolicy {
  const enabled = get('BILLING_ENABLED') === 'true';
  const from = get('BILLING_ENFORCE_FROM')?.trim();
  const enforceFrom = from ? new Date(from) : null;
  if (enabled && (!enforceFrom || Number.isNaN(enforceFrom.getTime()))) {
    throw new Error(
      'BILLING_ENFORCE_FROM must be an ISO date when BILLING_ENABLED=true.',
    );
  }
  return { enabled, enforceFrom };
}

/** The User fields accessState() reads, for callers that resolve it inside their own transaction. */
export const accessInputsSelect = {
  createdAt: true,
  trial: { select: { startedAt: true, endsAt: true } },
  billingAccount: {
    select: {
      plan: true,
      tier: true,
      priceUnresolved: true,
      subscriptionStatus: true,
      cancelAtPeriodEnd: true,
      currentPeriodEnd: true,
    },
  },
} satisfies Prisma.UserSelect;

// Stripe statuses that keep paid access while the paid period lasts.
const PAID = ['active', 'trialing', 'past_due'];

export const REQUIRES_PLAN = 'billing:requires-plan';

/**
 * Step 6: why a gated write was refused (402), as a stable code beside the unchanged message. Only the states without
 * access appear here; the app shows the matching explanation (an expired trial is never told to start one).
 */
export const NO_ACCESS_CODES = {
  trial_expired: 'TRIAL_EXPIRED',
  trial_available: 'TRIAL_NOT_STARTED',
  payment_pending: 'PAYMENT_PENDING',
  plan_unresolved: 'PLAN_UNRESOLVED',
  access_ended: 'PLAN_ENDED',
} as const satisfies Partial<Record<AccessState, string>>;
export const noAccessCode = (state: AccessState): string =>
  (NO_ACCESS_CODES as Partial<Record<AccessState, string>>)[state] ??
  'PLAN_REQUIRED';
/**
 * On a Customer controller whose POST/PUT/PATCH routes create or change content,
 * upload, or use the AI companion: refused (402) without access. Reads and DELETE
 * stay open (docs/billing.md §3). Enforced by BillingAccessInterceptor.
 */
export const RequiresPlan = () => SetMetadata(REQUIRES_PLAN, true);

/**
 * Which of a customer's Stripe subscriptions the account shows: higher wins, so a
 * late event for a replaced subscription can never displace the entitled one.
 */
export const subscriptionRank = (
  s: {
    status: string;
    cancelAtPeriodEnd: boolean;
    currentPeriodEnd: Date | null;
  },
  now: Date,
) => {
  if (
    PAID.includes(s.status) &&
    !!s.currentPeriodEnd &&
    s.currentPeriodEnd > now
  ) {
    if (s.status === 'past_due') return 2;
    return s.cancelAtPeriodEnd ? 3 : 4;
  }
  return s.status === 'incomplete' ? 1 : 0;
};

export function accessState(
  { userCreatedAt, trial, account }: BillingInputs,
  policy: BillingPolicy,
  now: Date,
) {
  // Accounts created before enforcement keep their access (rollout rule, §5).
  const enforced =
    policy.enabled &&
    !!policy.enforceFrom &&
    userCreatedAt >= policy.enforceFrom;
  const status = account?.subscriptionStatus ?? null;
  const inPeriod =
    !!account?.currentPeriodEnd && account.currentPeriodEnd > now;
  const paidNow = !!status && PAID.includes(status) && inPeriod;
  let state: AccessState;
  if (paidNow && !account!.priceUnresolved) {
    state =
      status === 'past_due'
        ? 'payment_issue'
        : account!.cancelAtPeriodEnd
          ? 'cancellation_scheduled'
          : 'paid_active';
  } else if (trial && trial.endsAt > now) {
    state = 'trial_active';
  } else if (paidNow) {
    // Step 6: an unresolved price grants no paid access (fail closed) and no tier; an active trial still applies.
    state = 'plan_unresolved';
  } else if (status === 'incomplete') {
    state = 'payment_pending';
  } else if (status) {
    // Unknown, ended, unpaid, paused or a paid status whose period has passed: never treated as paid.
    state = 'access_ended';
  } else if (trial) {
    state = 'trial_expired';
  } else {
    state = enforced ? 'trial_available' : 'no_billing_record';
  }
  const entitled = [
    'trial_active',
    'paid_active',
    'cancellation_scheduled',
    'payment_issue',
  ].includes(state);
  return {
    state,
    enforced,
    // What the gate uses: unenforced accounts keep access whatever their records say.
    hasAccess: !enforced || entitled,
    trialEligible: enforced && !trial && !status,
  };
}

/**
 * Updated Plans Step 2: product TIER, billing INTERVAL and EXEMPTION are separate concepts, apart from the access
 * STATE above (whether the account may write now). An interval never decides a tier; exemptions (billing off,
 * grandfathered) are not tiers. Tier identifiers follow the schema's enum style; intervals keep the stored
 * "monthly"/"annual" values (BillingAccount.plan).
 */
export const PRODUCT_TIERS = [
  'FREE_TRIAL',
  PaidTier.PREMIUM,
  PaidTier.COMPLETE,
] as const;
export type ProductTier = (typeof PRODUCT_TIERS)[number];
export const BILLING_INTERVALS = ['monthly', 'annual'] as const;
export type BillingInterval = (typeof BILLING_INTERVALS)[number];
export type Exemption = 'billing_off' | 'grandfathered';

/** One plan's approved limits and capabilities (null = no count limit). Declarations: see PLAN_IN_EFFECT for what applies. */
export type PlanDefinition = {
  storageBytes: number;
  recipients: number;
  trustedContacts: number;
  answeredQuestions: number | null; // My Story + My Wishes combined
  memoryVaultEntries: number | null;
  contentMedia: readonly MediaKind[]; // new photos/audio/video in messages, My Story, My Wishes, Memory Vault
  memoryLinks: boolean; // new or replacement links (unlinking is always open)
  aiRequests: { successful: number; per: 'trial' | 'month' }; // one shared writing-assistance allowance
  support: 'standard' | 'priority';
};

/** The approved plan matrix (2026-11-16), the one source of these numbers. Decimal bytes throughout. */
export const PLAN_DEFINITIONS = {
  FREE_TRIAL: {
    storageBytes: 100_000_000, // decided 2026-11-12: 100 MB decimal, not MiB
    recipients: 1, // Trial Step 3
    trustedContacts: 1,
    answeredQuestions: 4, // Trial Step 5
    memoryVaultEntries: 1, // Trial Step 7
    contentMedia: [], // Trial Step 4 (recipient photos are not content media and stay allowed)
    memoryLinks: false, // Trial Step 5
    aiRequests: { successful: 5, per: 'trial' },
    support: 'standard',
  },
  PREMIUM: {
    storageBytes: 2_000_000_000,
    recipients: 10,
    trustedContacts: 2,
    answeredQuestions: null,
    memoryVaultEntries: null,
    contentMedia: [MediaKind.PHOTO, MediaKind.AUDIO], // no new video
    memoryLinks: true,
    aiRequests: { successful: 50, per: 'month' }, // monthly for annual subscriptions too
    support: 'standard',
  },
  COMPLETE: {
    storageBytes: 5_000_000_000,
    recipients: 50,
    trustedContacts: 2,
    answeredQuestions: null,
    memoryVaultEntries: null,
    contentMedia: [MediaKind.PHOTO, MediaKind.AUDIO, MediaKind.VIDEO],
    memoryLinks: true,
    aiRequests: { successful: 200, per: 'month' },
    support: 'priority', // no response-time promise
  },
} as const satisfies Record<ProductTier, PlanDefinition>;

/**
 * Which parts of each definition the server applies today, by any mechanism (the rest is declared only and enforced in
 * later steps). The trial's comes from Trial Steps 2–7. Premium and Complete (a mapped tier with paid access): storage
 * and recipient counts since Updated Plans Step 3, plus the fields where general paid behaviour already equals the
 * definition (two-contact maximum, no question or memory count, links allowed, and for Complete every media kind).
 * Premium's photo/audio-only content media since Step 4, AI allowances since Step 5. Support priority is NOT applied yet.
 */
export const PLAN_IN_EFFECT: Record<
  ProductTier,
  readonly (keyof PlanDefinition)[]
> = {
  FREE_TRIAL: [
    'storageBytes',
    'recipients',
    'trustedContacts',
    'answeredQuestions',
    'memoryVaultEntries',
    'contentMedia',
    'memoryLinks',
    'aiRequests',
  ],
  PREMIUM: [
    'storageBytes',
    'recipients',
    'trustedContacts',
    'answeredQuestions',
    'memoryVaultEntries',
    'contentMedia',
    'memoryLinks',
    'aiRequests',
  ],
  COMPLETE: [
    'storageBytes',
    'recipients',
    'trustedContacts',
    'answeredQuestions',
    'memoryVaultEntries',
    'contentMedia',
    'memoryLinks',
    'aiRequests',
  ],
};

/**
 * The account's tier, interval and exemption, from the access state (never the reverse: a tier grants nothing; write
 * access is still hasAccess). Billing off and pre-enforcement accounts are exemptions with no tier, whatever records
 * they hold (whether a grandfathered account that subscribes gets a tier is a pending decision). An enforced active
 * trial is FREE_TRIAL. A paid state is the subscription's stored tier; a paid subscription with no stored tier is
 * `unmapped` (legacy rows, never backfilled without an approved mapping) and keeps today's paid behaviour. States
 * without access have no tier. How an unknown Stripe price should map going forward is a separate pending decision.
 */
export type TierResolution = {
  tier: ProductTier | null;
  interval: BillingInterval | null;
  exemption: Exemption | null;
  mapping: 'trial' | 'mapped' | 'unmapped' | 'none';
};
const PAID_STATES: AccessState[] = [
  'paid_active',
  'cancellation_scheduled',
  'payment_issue',
];
/**
 * The stored tier, only while it is in force: an enforced account in a paid state. Billing off, grandfathered, trial and
 * states without access get null (their existing rules apply), so a stored tier can never lift a limit or open the gate.
 */
export const entitledPaidTier = (
  access: { state: AccessState; enforced: boolean },
  tier: PaidTier | null | undefined,
): PaidTier | null =>
  access.enforced && PAID_STATES.includes(access.state) ? (tier ?? null) : null;
export function planTier(
  access: { state: AccessState; enforced: boolean },
  policy: BillingPolicy,
  account: { plan: string | null; tier: PaidTier | null } | null,
): TierResolution {
  const none = { tier: null, interval: null, mapping: 'none' } as const;
  if (!policy.enabled) return { ...none, exemption: 'billing_off' };
  if (!access.enforced) return { ...none, exemption: 'grandfathered' };
  if (access.state === 'trial_active')
    return {
      tier: 'FREE_TRIAL',
      interval: null,
      exemption: null,
      mapping: 'trial',
    };
  if (!PAID_STATES.includes(access.state)) return { ...none, exemption: null };
  const interval = BILLING_INTERVALS.find((i) => i === account?.plan) ?? null;
  const tier = entitledPaidTier(access, account?.tier ?? null);
  return {
    tier,
    interval,
    exemption: null,
    mapping: tier ? 'mapped' : 'unmapped',
  };
}

// The trial's limits, as used by Trial Steps 2–7 (same names, now read from the plan definitions).
export const TRIAL_STORAGE_BYTES = PLAN_DEFINITIONS.FREE_TRIAL.storageBytes;
export const TRIAL_RECIPIENTS = PLAN_DEFINITIONS.FREE_TRIAL.recipients;
export const TRIAL_TRUSTED_CONTACTS =
  PLAN_DEFINITIONS.FREE_TRIAL.trustedContacts;
export const TRIAL_QUESTIONS = PLAN_DEFINITIONS.FREE_TRIAL.answeredQuestions;
export const TRIAL_MEMORIES = PLAN_DEFINITIONS.FREE_TRIAL.memoryVaultEntries;

/** paidTier: the entitled paid tier (entitledPaidTier), set by resolveAccess; absent or null = no tier limits apply. */
type Access = {
  state: AccessState;
  enforced: boolean;
  paidTier?: PaidTier | null;
};
const inEnforcedTrial = (a: Access) => a.enforced && a.state === 'trial_active';

/** Trial caps on creating records; null = no trial cap (the record type's own rules, e.g. two contacts, still apply). */
export type CreationCaps = {
  recipients: number | null;
  trustedContacts: number | null;
  questions: number | null;
  memories: number | null;
};
export const creationCaps = (access: Access): CreationCaps =>
  inEnforcedTrial(access)
    ? {
        recipients: TRIAL_RECIPIENTS,
        trustedContacts: TRIAL_TRUSTED_CONTACTS,
        questions: TRIAL_QUESTIONS,
        memories: TRIAL_MEMORIES,
      }
    : {
        recipients: null,
        trustedContacts: null,
        questions: null,
        memories: null,
      };

/**
 * Trial Step 4: photos, voice recordings and videos (non-text message formats, message media, and My Story, My Wishes
 * and Memory Vault media). Off only in an enforced active trial; paid wins, billing off and pre-enforcement accounts
 * keep it; states without access are refused earlier by the gate (402). The trial's storage allowance never turns it on.
 */
export type FeatureAccess = { media: boolean; memoryLinks: boolean };

const ALL_MEDIA: readonly MediaKind[] = [
  MediaKind.PHOTO,
  MediaKind.AUDIO,
  MediaKind.VIDEO,
];
/**
 * Updated Plans Step 4: which kinds of NEW content media this account may add. An enforced active trial: none (Trial
 * Step 4). An entitled mapped tier: its definition's (Premium photo and audio, Complete all three). Everything else
 * (unmapped paid, billing off, grandfathered, and states without access, which the gate refuses first): every kind, as
 * before. Existing files are never affected: this only decides new uploads, copies and formats.
 */
export const allowedMediaKinds = (access: Access): readonly MediaKind[] =>
  inEnforcedTrial(access)
    ? PLAN_DEFINITIONS.FREE_TRIAL.contentMedia
    : access.paidTier
      ? PLAN_DEFINITIONS[access.paidTier].contentMedia
      : ALL_MEDIA;
// Step 5 (2026-11-14): linking Memory Vault memories to My Story answers is paid-only too (no new or replacement links
// in the trial; unchanged links and unlinking stay open).
export const featureAccess = (access: Access): FeatureAccess => {
  const trial = inEnforcedTrial(access);
  const def = PLAN_DEFINITIONS.FREE_TRIAL;
  return {
    media: !trial || def.contentMedia.length > 0,
    memoryLinks: !trial || def.memoryLinks,
  };
};

export type Entitlements = CreationCaps &
  FeatureAccess & { storageBytes: number };

/**
 * What an account may hold, kept apart from whether it may write (hasAccess, the gate). An enforced active trial gets
 * the trial's allowance; an entitled mapped paid tier (Updated Plans Step 3) gets its definition's; everything else
 * (unmapped paid subscriptions, billing off, pre-enforcement accounts, states without access) keeps the configured
 * limit, as before. Never unlimited.
 */
export function entitlements(
  access: Access,
  configuredStorageBytes: number,
): Entitlements {
  return {
    storageBytes: inEnforcedTrial(access)
      ? TRIAL_STORAGE_BYTES
      : access.paidTier
        ? PLAN_DEFINITIONS[access.paidTier].storageBytes
        : configuredStorageBytes,
    ...creationCaps(access),
    ...featureAccess(access),
  };
}

/**
 * The live-recipient limit for creating one more, and where it comes from: the trial's (TRIAL_LIMIT, Trial Step 3) or
 * the entitled paid tier's (PLAN_LIMIT, Updated Plans Step 3). null = no limit (unmapped paid, billing off, grandfathered).
 */
export type RecipientLimit = { max: number; source: 'trial' | 'plan' } | null;
export const recipientLimit = (access: Access): RecipientLimit =>
  inEnforcedTrial(access)
    ? { max: TRIAL_RECIPIENTS, source: 'trial' }
    : access.paidTier
      ? { max: PLAN_DEFINITIONS[access.paidTier].recipients, source: 'plan' }
      : null;

/** The UTC calendar month containing `now`: [start, end), and its stable bucket key. */
export const utcMonth = (now: Date) => {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  return {
    key: `month:${y}-${String(m + 1).padStart(2, '0')}`,
    start: new Date(Date.UTC(y, m, 1)),
    end: new Date(Date.UTC(y, m + 1, 1)),
  };
};

/**
 * Updated Plans Step 5: the AI companion allowance that applies now, or null (not metered).
 * - An enforced active trial: one bucket for that trial (its row id), 5 successful replies in total.
 * - An entitled mapped tier: one bucket per UTC calendar month shared by every tier and interval, so a tier or
 *   monthly/annual change never starts a fresh count; the limit is the current tier's (Premium 50, Complete 200).
 * - Everything else is not metered: billing off, grandfathered, unmapped paid (existing behaviour, hourly limits
 *   only), and states without access (the gate refuses the request first, 402).
 */
export type AiMeter = {
  kind: 'trial' | 'month';
  period: string;
  allowance: number;
  periodEndsAt: Date;
  resetsAt: Date | null;
};
export type AiUnmetered =
  'billing_off' | 'grandfathered' | 'unmapped_paid' | 'no_access';
export function aiMeter(
  access: Access,
  trial: { id: string; endsAt: Date } | null,
  now: Date,
):
  | { meter: AiMeter; unmetered: null }
  | { meter: null; unmetered: AiUnmetered } {
  if (inEnforcedTrial(access) && trial) {
    const allowance = PLAN_DEFINITIONS.FREE_TRIAL.aiRequests.successful;
    return {
      meter: {
        kind: 'trial',
        period: `trial:${trial.id}`,
        allowance,
        periodEndsAt: trial.endsAt,
        resetsAt: null,
      },
      unmetered: null,
    };
  }
  if (access.paidTier) {
    const m = utcMonth(now);
    return {
      meter: {
        kind: 'month',
        period: m.key,
        allowance: PLAN_DEFINITIONS[access.paidTier].aiRequests.successful,
        periodEndsAt: m.end,
        resetsAt: m.end,
      },
      unmetered: null,
    };
  }
  // Billing off never reaches here (callers check the policy first), so not enforced means created before enforcement.
  if (!access.enforced) return { meter: null, unmetered: 'grandfathered' };
  return {
    meter: null,
    unmetered: PAID_STATES.includes(access.state)
      ? 'unmapped_paid'
      : 'no_access',
  };
}

/**
 * accessState() for one account, read through `client`: pass the transaction that holds the Customer's User row lock,
 * so the decision and the count it guards are one serialised step. Billing off reads nothing.
 */
export async function resolveAccess(
  client: Prisma.TransactionClient,
  userId: string,
  policy: BillingPolicy,
  now = new Date(),
): Promise<Access> {
  if (!policy.enabled) return { state: 'no_billing_record', enforced: false };
  const u = await client.user.findUniqueOrThrow({
    where: { id: userId },
    select: accessInputsSelect,
  });
  const access = accessState(
    { userCreatedAt: u.createdAt, trial: u.trial, account: u.billingAccount },
    policy,
    now,
  );
  return {
    ...access,
    paidTier: entitledPaidTier(access, u.billingAccount?.tier),
  };
}

/**
 * The trial cap for one record type, or null (no trial cap). Call inside the transaction that already holds
 * `SELECT … FROM "User" … FOR UPDATE` for this Customer and then counts and inserts, so parallel creates serialise.
 */
export async function trialCap(
  tx: Prisma.TransactionClient,
  userId: string,
  policy: BillingPolicy,
  kind: keyof CreationCaps,
  now = new Date(),
) {
  return creationCaps(await resolveAccess(tx, userId, policy, now))[kind];
}

/** Has written words: the same rule as the answer DTOs (`/\S/`), so whitespace never takes a question slot. */
export const hasAnswerText = (text: string | null | undefined) =>
  !!text && /\S/.test(text);

/**
 * The one count of trial question slots in use (Step 5): live My Story and My Wishes answers with written words, one
 * per question (each table is unique per owner and prompt). Files-only, memory-only and empty upload shells don't count;
 * unsaved drafts live elsewhere. `[^[:space:]]` matches hasAnswerText for every text the DTOs accept.
 */
export async function answeredQuestions(
  client: Prisma.TransactionClient,
  userId: string,
): Promise<number> {
  const [{ n }] = await client.$queryRaw<{ n: number }[]>`
    SELECT ((SELECT count(*) FROM "MyStoryResponse"
              WHERE "ownerUserId" = ${userId}::uuid AND "deletedAt" IS NULL AND "textContent" ~ '[^[:space:]]')
          + (SELECT count(*) FROM "MyWishResponse"
              WHERE "ownerUserId" = ${userId}::uuid AND "deletedAt" IS NULL AND "textContent" ~ '[^[:space:]]'))::int AS n`;
  return n;
}

/**
 * Start of a My Story / My Wishes save (Step 5): billing on, lock the Customer's User row (the Step 3 pattern, so saves
 * in both sections serialise) and return the question cap (null = no trial cap) and whether memories may be linked.
 * Billing off: no lock, nothing read.
 */
export async function lockAnswerEntitlements(
  tx: Prisma.TransactionClient,
  userId: string,
  policy: BillingPolicy,
) {
  if (!policy.enabled) return { questions: null, memoryLinks: true };
  await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${userId}::uuid FOR UPDATE`;
  const access = await resolveAccess(tx, userId, policy);
  return {
    questions: creationCaps(access).questions,
    memoryLinks: featureAccess(access).memoryLinks,
  };
}

/**
 * Refuses giving words to a question that has none while every slot is used. Editing or clearing an answer that has
 * words never needs a slot, so accounts already above the cap keep editing theirs.
 */
export async function assertQuestionSlot(
  tx: Prisma.TransactionClient,
  userId: string,
  cap: number | null,
  had: string | null | undefined,
  next: string | null | undefined,
) {
  if (cap === null || hasAnswerText(had) || !hasAnswerText(next)) return;
  if ((await answeredQuestions(tx, userId)) >= cap)
    throw trialLimitError(TRIAL_QUESTION_LIMIT);
}

/** A trial cap refusal: 409 like the other limits, with a code the app uses to offer plans (never 402, which means no access). */
export const TRIAL_LIMIT = 'TRIAL_LIMIT';
export const trialLimitError = (message: string) =>
  new ConflictException({
    statusCode: 409,
    error: 'Conflict',
    code: TRIAL_LIMIT,
    message,
  });
/**
 * Updated Plans Step 3: a paid plan's own limit (409, its own code; not TRIAL_LIMIT, and no promise that another plan
 * allows more). The app shows the message on the form and keeps what was typed.
 */
export const PLAN_LIMIT = 'PLAN_LIMIT';
export const planLimitError = (message: string) =>
  new ConflictException({
    statusCode: 409,
    error: 'Conflict',
    code: PLAN_LIMIT,
    message,
  });
export const planRecipientLimitMessage = (max: number) =>
  `Your plan includes up to ${max} people in People I Love. To add someone new, remove someone first.`;
/** A paid-only feature refusal (Step 4): same shape as TRIAL_LIMIT, its own code, so the app can tell them apart. */
export const PAID_FEATURE = 'PAID_FEATURE';
export const PAID_FEATURE_MESSAGE =
  'Your free trial includes text. Choose a plan to add photos, voice recordings and videos.';
export const paidFeatureError = (message = PAID_FEATURE_MESSAGE) =>
  new ConflictException({
    statusCode: 409,
    error: 'Conflict',
    code: PAID_FEATURE,
    message,
  });
/**
 * Updated Plans Step 4: a media kind the account's paid tier doesn't include (Premium + video). Same 409 shape, its own
 * code and the tier that includes it; not a trial limit. Only Complete adds a kind today.
 */
export const TIER_REQUIRED = 'TIER_REQUIRED';
export const VIDEO_REQUIRES_COMPLETE =
  'Video is available with For After Complete. Your plan includes photos and audio.';
export const videoRequiresCompleteError = () =>
  new ConflictException({
    statusCode: 409,
    error: 'Conflict',
    code: TIER_REQUIRED,
    requiredTier: PaidTier.COMPLETE,
    feature: MediaKind.VIDEO,
    message: VIDEO_REQUIRES_COMPLETE,
  });
export const PAID_MEMORY_LINK_MESSAGE =
  'Your free trial includes written answers. Choose a plan to link memories from your Memory Vault.';
export const TRIAL_RECIPIENT_LIMIT =
  'Your free trial includes one person. Choose a plan to add more.';
export const TRIAL_QUESTION_LIMIT =
  'Your free trial includes four answered questions across My Story and My Wishes. Choose a plan to answer more.';
export const TRIAL_MEMORY_LIMIT =
  'Your free trial includes one written memory. Choose a plan to save more memories.';
export const TRIAL_CONTACT_LIMIT =
  'Your free trial includes one trusted contact. Choose a plan to add another.';

/**
 * A Customer with a trial or a subscription status on file: exactly the accounts accessState() places outside
 * no_billing_record / trial_available (the billing e2e checks they agree). Not having one never means unpaid.
 */
export const billingRecordWhere: Prisma.UserWhereInput = {
  OR: [
    { trial: { isNot: null } },
    { billingAccount: { is: { subscriptionStatus: { not: null } } } },
  ],
};

/**
 * The accounts the admin billing page lists: Customers with a trial or a billing account row (a checkout that was
 * opened creates the row before any subscription). Its two "nothing yet" states are trial_available and
 * no_billing_record; everyone else here matches billingRecordWhere.
 */
export const billingListedWhere: Prisma.UserWhereInput = {
  role: 'CUSTOMER',
  OR: [{ trial: { isNot: null } }, { billingAccount: { isNot: null } }],
};

// timestamp(3) columns hold UTC wall time: compare with ISO text cast to timestamp, never a JS Date (session TZ).
const ts = (d: Date) => Prisma.sql`${d.toISOString()}::timestamp`;

/**
 * accessState() as one SQL CASE, same order of precedence, over aliases u ("User"), t ("CustomerTrial") and
 * b ("BillingAccount"), both LEFT JOINed: for counting every state in one scan. The billing e2e checks it against
 * the resolver on every combination.
 */
export function accessStateSql(policy: BillingPolicy, now: Date): Prisma.Sql {
  const paid = Prisma.join(PAID);
  const enforced =
    policy.enabled && policy.enforceFrom
      ? Prisma.sql`u."createdAt" >= ${ts(policy.enforceFrom)}`
      : Prisma.sql`FALSE`;
  const paidNow = Prisma.sql`b."subscriptionStatus" IN (${paid}) AND b."currentPeriodEnd" > ${ts(now)}`;
  return Prisma.sql`CASE
    WHEN ${paidNow} AND NOT b."priceUnresolved" THEN
      CASE WHEN b."subscriptionStatus" = 'past_due' THEN 'payment_issue'
           WHEN b."cancelAtPeriodEnd" THEN 'cancellation_scheduled' ELSE 'paid_active' END
    WHEN t."endsAt" > ${ts(now)} THEN 'trial_active'
    WHEN ${paidNow} THEN 'plan_unresolved'
    WHEN b."subscriptionStatus" = 'incomplete' THEN 'payment_pending'
    WHEN b."subscriptionStatus" IS NOT NULL THEN 'access_ended'
    WHEN t.id IS NOT NULL THEN 'trial_expired'
    WHEN ${enforced} THEN 'trial_available'
    ELSE 'no_billing_record' END`;
}

/** The states the admin list can filter by: those a billing row can be in whatever the enforcement date. */
export const ADMIN_BILLING_FILTERS = [
  'trial_active',
  'trial_expired',
  'paid_active',
  'cancellation_scheduled',
  'payment_issue',
  'payment_pending',
  'plan_unresolved',
  'access_ended',
] as const;
export type AdminBillingFilter = (typeof ADMIN_BILLING_FILTERS)[number];

/** accessState() as a query, in its order of precedence: the billing e2e checks they agree on every combination. */
export function accessStateWhere(
  state: AdminBillingFilter,
  now: Date,
): Prisma.UserWhereInput {
  const account = (
    is: Prisma.BillingAccountWhereInput,
  ): Prisma.UserWhereInput => ({ billingAccount: { is } });
  const inPeriod = { currentPeriodEnd: { gt: now }, priceUnresolved: false };
  const paidNow = {
    subscriptionStatus: { in: PAID },
    currentPeriodEnd: { gt: now },
  };
  // Not in a paid period at all (an unresolved price in a paid period is neither paid nor "not paid": plan_unresolved).
  const noPaidPeriod: Prisma.UserWhereInput = {
    OR: [
      { billingAccount: { is: null } },
      account({
        OR: [
          { subscriptionStatus: null },
          { subscriptionStatus: { notIn: PAID } },
          { currentPeriodEnd: null },
          { currentPeriodEnd: { lte: now } },
        ],
      }),
    ],
  };
  const notPaid: Prisma.UserWhereInput = {
    OR: [noPaidPeriod, account({ ...paidNow, priceUnresolved: true })],
  };
  const noTrialNow: Prisma.UserWhereInput = {
    OR: [{ trial: { is: null } }, { trial: { is: { endsAt: { lte: now } } } }],
  };
  switch (state) {
    case 'paid_active':
      return account({
        subscriptionStatus: { in: ['active', 'trialing'] },
        cancelAtPeriodEnd: false,
        ...inPeriod,
      });
    case 'cancellation_scheduled':
      return account({
        subscriptionStatus: { in: ['active', 'trialing'] },
        cancelAtPeriodEnd: true,
        ...inPeriod,
      });
    case 'payment_issue':
      return account({ subscriptionStatus: 'past_due', ...inPeriod });
    case 'trial_active':
      return { AND: [{ trial: { is: { endsAt: { gt: now } } } }, notPaid] };
    case 'plan_unresolved':
      return {
        AND: [account({ ...paidNow, priceUnresolved: true }), noTrialNow],
      };
    case 'payment_pending':
      return {
        AND: [account({ subscriptionStatus: 'incomplete' }), noTrialNow],
      };
    case 'access_ended':
      return {
        AND: [
          account({ subscriptionStatus: { not: 'incomplete' } }),
          noPaidPeriod,
          noTrialNow,
        ],
      };
    case 'trial_expired':
      return {
        AND: [
          { trial: { is: { endsAt: { lte: now } } } },
          {
            OR: [
              { billingAccount: { is: null } },
              account({ subscriptionStatus: null }),
            ],
          },
        ],
      };
  }
}
