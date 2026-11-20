import { MediaKind } from '../generated/prisma/client.js';
import {
  accessState,
  aiMeter,
  BILLING_INTERVALS,
  creationCaps,
  entitledPaidTier,
  entitlements,
  recipientLimit,
  featureAccess,
  PLAN_DEFINITIONS,
  PLAN_IN_EFFECT,
  planTier,
  PRODUCT_TIERS,
  TRIAL_MEMORIES,
  TRIAL_QUESTIONS,
  TRIAL_RECIPIENTS,
  TRIAL_STORAGE_BYTES,
  TRIAL_TRUSTED_CONTACTS,
  type BillingInputs,
  type BillingPolicy,
  utcMonth,
} from './billing-access.js';

// Updated Plans Step 2: tier, interval and exemption are separate from the access state, and declaring a plan
// definition changes no enforcement.
const NOW = new Date('2026-11-16T12:00:00.000Z');
const ON: BillingPolicy = { enabled: true, enforceFrom: new Date('2026-11-01T00:00:00.000Z') };
const OFF: BillingPolicy = { enabled: false, enforceFrom: null };
const NEW_ACCOUNT = new Date('2026-11-05T00:00:00.000Z');
const OLD_ACCOUNT = new Date('2026-10-01T00:00:00.000Z');
const later = new Date(NOW.getTime() + 86_400_000);
const earlier = new Date(NOW.getTime() - 86_400_000);
const activeTrial = { startedAt: new Date(NOW.getTime() - 86_400_000), endsAt: later };
const endedTrial = { startedAt: new Date(NOW.getTime() - 8 * 86_400_000), endsAt: earlier };
const sub = (status: string, plan: string | null = 'monthly', periodEnd: Date | null = later) => ({ plan, subscriptionStatus: status, cancelAtPeriodEnd: false, currentPeriodEnd: periodEnd });
const input = (over: Partial<BillingInputs> = {}): BillingInputs => ({ userCreatedAt: NEW_ACCOUNT, trial: null, account: null, ...over });
const CONFIGURED = 5_368_709_120; // today's STORAGE_LIMIT_BYTES default (5 GiB)

describe('plan definitions (approved matrix, exact values)', () => {
  it('tiers and intervals are the approved, separate sets', () => {
    expect(PRODUCT_TIERS).toEqual(['FREE_TRIAL', 'PREMIUM', 'COMPLETE']);
    expect(BILLING_INTERVALS).toEqual(['monthly', 'annual']);
  });

  it('Free Trial', () => {
    expect(PLAN_DEFINITIONS.FREE_TRIAL).toEqual({
      storageBytes: 100_000_000,
      recipients: 1,
      trustedContacts: 1,
      answeredQuestions: 4,
      memoryVaultEntries: 1,
      contentMedia: [],
      memoryLinks: false,
      aiRequests: { successful: 5, per: 'trial' },
      support: 'standard',
    });
  });

  it('Premium', () => {
    expect(PLAN_DEFINITIONS.PREMIUM).toEqual({
      storageBytes: 2_000_000_000,
      recipients: 10,
      trustedContacts: 2,
      answeredQuestions: null,
      memoryVaultEntries: null,
      contentMedia: [MediaKind.PHOTO, MediaKind.AUDIO],
      memoryLinks: true,
      aiRequests: { successful: 50, per: 'month' },
      support: 'standard',
    });
    expect(PLAN_DEFINITIONS.PREMIUM.contentMedia).not.toContain(MediaKind.VIDEO);
  });

  it('Complete', () => {
    expect(PLAN_DEFINITIONS.COMPLETE).toEqual({
      storageBytes: 5_000_000_000,
      recipients: 50,
      trustedContacts: 2,
      answeredQuestions: null,
      memoryVaultEntries: null,
      contentMedia: [MediaKind.PHOTO, MediaKind.AUDIO, MediaKind.VIDEO],
      memoryLinks: true,
      aiRequests: { successful: 200, per: 'month' },
      support: 'priority',
    });
  });

  it('the trial constants Steps 2–7 enforce are the Free Trial definition, unchanged', () => {
    expect([TRIAL_STORAGE_BYTES, TRIAL_RECIPIENTS, TRIAL_TRUSTED_CONTACTS, TRIAL_QUESTIONS, TRIAL_MEMORIES]).toEqual([100_000_000, 1, 1, 4, 1]);
  });

  it('in effect today: everything but support for every tier (storage, recipients: Step 3; media: Step 4; AI: Step 5)', () => {
    for (const tier of PRODUCT_TIERS) {
      expect(PLAN_IN_EFFECT[tier]).toContain('aiRequests');
      expect(PLAN_IN_EFFECT[tier]).not.toContain('support');
    }
    for (const tier of ['PREMIUM', 'COMPLETE'] as const) {
      for (const k of ['storageBytes', 'recipients'] as const) expect(PLAN_IN_EFFECT[tier]).toContain(k);
    }
    expect(PLAN_IN_EFFECT.PREMIUM).toContain('contentMedia'); // Step 4
    for (const tier of PRODUCT_TIERS) for (const k of PLAN_IN_EFFECT[tier]) expect(Object.keys(PLAN_DEFINITIONS[tier])).toContain(k);
  });
});

describe('planTier: tier, interval and exemption from the access state', () => {
  const tierFor = (i: BillingInputs, policy = ON, tier: 'PREMIUM' | 'COMPLETE' | null = null) =>
    planTier(accessState(i, policy, NOW), policy, i.account && { plan: i.account.plan, tier });

  it('billing off and grandfathered are exemptions with no tier, whatever records they hold', () => {
    expect(tierFor(input({ trial: activeTrial, account: sub('active') }), OFF, 'COMPLETE')).toEqual({ tier: null, interval: null, exemption: 'billing_off', mapping: 'none' });
    expect(tierFor(input({ userCreatedAt: OLD_ACCOUNT, account: sub('active') }), ON, 'COMPLETE')).toEqual({ tier: null, interval: null, exemption: 'grandfathered', mapping: 'none' });
  });

  it('an enforced active trial is FREE_TRIAL; an ended trial or one never started has no tier', () => {
    expect(tierFor(input({ trial: activeTrial }))).toEqual({ tier: 'FREE_TRIAL', interval: null, exemption: null, mapping: 'trial' });
    expect(tierFor(input({ trial: endedTrial })).tier).toBeNull();
    expect(tierFor(input()).tier).toBeNull();
  });

  it('interval never decides the tier: the same interval maps to either tier, and no stored tier is unmapped', () => {
    for (const interval of ['monthly', 'annual'] as const) {
      expect(tierFor(input({ account: sub('active', interval) }), ON, 'PREMIUM')).toEqual({ tier: 'PREMIUM', interval, exemption: null, mapping: 'mapped' });
      expect(tierFor(input({ account: sub('active', interval) }), ON, 'COMPLETE')).toEqual({ tier: 'COMPLETE', interval, exemption: null, mapping: 'mapped' });
      expect(tierFor(input({ account: sub('active', interval) }), ON, null)).toEqual({ tier: null, interval, exemption: null, mapping: 'unmapped' });
    }
    // An unrecognised stored interval is reported as unknown (null), never guessed.
    expect(tierFor(input({ account: sub('active', 'unknown') }), ON, 'COMPLETE')).toMatchObject({ tier: 'COMPLETE', interval: null });
  });

  it('paid precedence unchanged: paid over trial dates gives the paid tier; cancelling and payment issues keep it', () => {
    expect(tierFor(input({ trial: activeTrial, account: sub('active') }), ON, 'PREMIUM').tier).toBe('PREMIUM');
    expect(tierFor(input({ trial: activeTrial, account: { ...sub('active'), cancelAtPeriodEnd: true } }), ON, 'COMPLETE').tier).toBe('COMPLETE');
    expect(tierFor(input({ account: sub('past_due') }), ON, 'COMPLETE').tier).toBe('COMPLETE');
  });

  it('a stored tier never grants access: ended, pending or lapsed subscriptions have no tier and no write access', () => {
    for (const account of [sub('canceled'), sub('active', 'monthly', earlier), sub('incomplete')]) {
      const i = input({ account });
      expect(tierFor(i, ON, 'COMPLETE').tier).toBeNull();
      expect(accessState(i, ON, NOW).hasAccess).toBe(false);
    }
  });
});

describe('aiMeter (Updated Plans Step 5)', () => {
  const access = (i: BillingInputs, policy = ON) => accessState(i, policy, NOW);
  const trialRow = { id: 't-1', endsAt: activeTrial.endsAt };

  it('active trial: one bucket for that trial, 5 in total, no reset', () => {
    expect(aiMeter(access(input({ trial: activeTrial })), trialRow, NOW)).toEqual({
      meter: { kind: 'trial', period: 'trial:t-1', allowance: 5, periodEndsAt: activeTrial.endsAt, resetsAt: null },
      unmetered: null,
    });
  });

  it('entitled paid tiers share one UTC-month bucket; only the limit differs; the reset is the next month start', () => {
    const paid = access(input({ account: sub('active') }));
    const end = new Date('2026-12-01T00:00:00.000Z');
    expect(aiMeter({ ...paid, paidTier: 'PREMIUM' }, null, NOW).meter).toEqual({ kind: 'month', period: 'month:2026-11', allowance: 50, periodEndsAt: end, resetsAt: end });
    expect(aiMeter({ ...paid, paidTier: 'COMPLETE' }, null, NOW).meter).toMatchObject({ period: 'month:2026-11', allowance: 200 });
    // Paid wins over trial dates: never the trial bucket.
    expect(aiMeter({ ...access(input({ trial: activeTrial, account: sub('active') })), paidTier: 'PREMIUM' }, trialRow, NOW).meter?.kind).toBe('month');
  });

  it('exact UTC boundaries', () => {
    expect(utcMonth(new Date('2026-11-30T23:59:59.999Z')).key).toBe('month:2026-11');
    expect(utcMonth(new Date('2026-12-01T00:00:00.000Z')).key).toBe('month:2026-12');
    expect(utcMonth(new Date('2026-12-31T23:59:59.999Z')).end.toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });

  it('not metered: grandfathered, unmapped paid, and states without access (the gate refuses those first)', () => {
    expect(aiMeter(access(input({ userCreatedAt: OLD_ACCOUNT, trial: activeTrial })), trialRow, NOW)).toEqual({ meter: null, unmetered: 'grandfathered' });
    expect(aiMeter(access(input({ account: sub('active') })), null, NOW)).toEqual({ meter: null, unmetered: 'unmapped_paid' });
    expect(aiMeter(access(input({ trial: endedTrial })), { id: 't-1', endsAt: endedTrial.endsAt }, NOW)).toEqual({ meter: null, unmetered: 'no_access' });
  });
});

describe('enforcement is unchanged by the definitions', () => {
  const access = (i: BillingInputs, policy = ON) => accessState(i, policy, NOW);

  it('legacy/unmapped paid subscriptions keep exactly today’s paid behaviour', () => {
    const a = access(input({ account: sub('active', 'annual') }));
    expect(a).toMatchObject({ state: 'paid_active', hasAccess: true });
    expect(entitlements(a, CONFIGURED)).toEqual({ storageBytes: CONFIGURED, recipients: null, trustedContacts: null, questions: null, memories: null, media: true, memoryLinks: true });
  });

  it('Step 3: an entitled mapped tier gets its storage and recipient limit; trial and its error source unchanged', () => {
    const paidAccess = (tier: 'PREMIUM' | 'COMPLETE') => ({ ...access(input({ account: sub('active') })), paidTier: tier });
    expect(entitlements(paidAccess('PREMIUM'), CONFIGURED).storageBytes).toBe(2_000_000_000);
    expect(entitlements(paidAccess('COMPLETE'), CONFIGURED).storageBytes).toBe(5_000_000_000);
    expect(recipientLimit(paidAccess('PREMIUM'))).toEqual({ max: 10, source: 'plan' });
    expect(recipientLimit(paidAccess('COMPLETE'))).toEqual({ max: 50, source: 'plan' });
    // The trial-only caps (trialCaps in GET /billing, the trial UI) never carry a paid limit.
    expect(creationCaps(paidAccess('PREMIUM'))).toEqual({ recipients: null, trustedContacts: null, questions: null, memories: null });
    expect(featureAccess(paidAccess('PREMIUM'))).toEqual({ media: true, memoryLinks: true }); // media by kind is a later step
    expect(recipientLimit(access(input({ trial: activeTrial })))).toEqual({ max: 1, source: 'trial' });
    expect(recipientLimit(access(input({ account: sub('active') })))).toBeNull(); // unmapped
  });

  it('Step 3: a stored tier only counts while entitled (enforced, paid state); never for trial, exempt or no-access states', () => {
    const paid = access(input({ account: sub('active') }));
    expect(entitledPaidTier(paid, 'COMPLETE')).toBe('COMPLETE');
    expect(entitledPaidTier(paid, null)).toBeNull();
    for (const a of [
      access(input({ trial: activeTrial })),
      access(input({ trial: endedTrial })),
      access(input({ account: sub('canceled') })),
      access(input({ account: sub('incomplete') })),
      access(input({ account: sub('active') }), OFF),
      access(input({ userCreatedAt: OLD_ACCOUNT, account: sub('active') })),
    ]) {
      expect(entitledPaidTier(a, 'COMPLETE')).toBeNull();
      const e = entitlements({ ...a, paidTier: entitledPaidTier(a, 'COMPLETE') }, CONFIGURED);
      expect(e.storageBytes).not.toBe(5_000_000_000);
    }
  });

  it('unmapped paid accounts (no stored tier) are not limited to a tier: configured storage, no recipient cap, every media kind', () => {
    const e = entitlements(access(input({ account: sub('active') })), CONFIGURED);
    expect(e.storageBytes).not.toBe(PLAN_DEFINITIONS.COMPLETE.storageBytes);
    expect(e.storageBytes).not.toBe(PLAN_DEFINITIONS.PREMIUM.storageBytes);
    expect(e.recipients).toBeNull();
    expect(e.media).toBe(true);
  });

  it('billing off and grandfathered: configured storage and no caps, as before', () => {
    for (const a of [access(input({ trial: activeTrial }), OFF), access(input({ userCreatedAt: OLD_ACCOUNT, trial: activeTrial }))]) {
      expect(entitlements(a, CONFIGURED)).toEqual({ storageBytes: CONFIGURED, recipients: null, trustedContacts: null, questions: null, memories: null, media: true, memoryLinks: true });
      expect(a.hasAccess).toBe(true);
    }
  });

  it('trial limits and expiry unchanged', () => {
    const active = access(input({ trial: activeTrial }));
    expect(entitlements(active, CONFIGURED)).toEqual({ storageBytes: 100_000_000, recipients: 1, trustedContacts: 1, questions: 4, memories: 1, media: false, memoryLinks: false });
    expect(creationCaps(active)).toEqual({ recipients: 1, trustedContacts: 1, questions: 4, memories: 1 });
    expect(featureAccess(active)).toEqual({ media: false, memoryLinks: false });
    const atEnd = accessState(input({ trial: { startedAt: endedTrial.startedAt, endsAt: NOW } }), ON, NOW);
    expect(atEnd).toMatchObject({ state: 'trial_expired', hasAccess: false });
  });
});
