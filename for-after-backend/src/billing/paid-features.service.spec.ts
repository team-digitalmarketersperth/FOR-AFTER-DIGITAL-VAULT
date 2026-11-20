import { ConflictException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { PrismaService } from '../prisma/prisma.service.js';
import {
  PAID_FEATURE,
  PAID_FEATURE_MESSAGE,
  TIER_REQUIRED,
  VIDEO_REQUIRES_COMPLETE,
} from './billing-access.js';
import { PaidFeatures } from './paid-features.service.js';

const DAY = 86_400_000;
const BILLING_ON = {
  BILLING_ENABLED: 'true',
  BILLING_ENFORCE_FROM: '2026-01-01T00:00:00.000Z',
};
const account = (
  trialEndsAt: Date | null,
  subscription: object | null = null,
  createdAt = new Date('2026-06-01T00:00:00.000Z'),
) => ({
  createdAt,
  trial: trialEndsAt && {
    startedAt: new Date(trialEndsAt.getTime() - 7 * DAY),
    endsAt: trialEndsAt,
  },
  billingAccount: subscription,
});
const inTrial = () => account(new Date(Date.now() + DAY));
const paid = {
  plan: 'monthly',
  subscriptionStatus: 'active',
  cancelAtPeriodEnd: false,
  currentPeriodEnd: new Date(Date.now() + DAY),
};

const setup = (env: Record<string, string>, row: object) => {
  const findUniqueOrThrow = vi.fn(async () => row);
  const prisma = { user: { findUniqueOrThrow } };
  const features = new PaidFeatures(
    prisma as unknown as PrismaService,
    { get: (k: string) => env[k] } as unknown as ConfigService,
  );
  return { features, findUniqueOrThrow };
};

describe('PaidFeatures (Trial Step 4)', () => {
  it('billing off: allowed without reading anything', async () => {
    const t = setup({}, inTrial());
    expect(await t.features.mediaAllowed('owner-a')).toBe(true);
    await t.features.assertMedia('owner-a');
    expect(t.findUniqueOrThrow).not.toHaveBeenCalled();
  });

  it('enforced active trial: refused with 409 PAID_FEATURE (not TRIAL_LIMIT, not 402)', async () => {
    const t = setup(BILLING_ON, inTrial());
    expect(await t.features.mediaAllowed('owner-a')).toBe(false);
    const err = await t.features
      .assertMedia('owner-a')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toEqual({
      statusCode: 409,
      error: 'Conflict',
      code: PAID_FEATURE,
      message: PAID_FEATURE_MESSAGE,
    });
  });

  it.each([
    ['paid over active trial dates', account(new Date(Date.now() + DAY), paid)],
    [
      'grandfathered (before enforcement)',
      account(
        new Date(Date.now() + DAY),
        null,
        new Date('2025-12-01T00:00:00.000Z'),
      ),
    ],
  ])('%s: allowed', async (_, row) => {
    expect(await setup(BILLING_ON, row).features.mediaAllowed('owner-a')).toBe(
      true,
    );
  });

  it('reads through the caller’s transaction when given one', async () => {
    const t = setup(BILLING_ON, inTrial());
    const tx = {
      user: { findUniqueOrThrow: vi.fn(async () => account(null, paid)) },
    };
    expect(await t.features.mediaAllowed('owner-a', 'any', tx as never)).toBe(
      true,
    );
    expect(tx.user.findUniqueOrThrow).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'owner-a' } }),
    );
    expect(t.findUniqueOrThrow).not.toHaveBeenCalled();
  });
});

describe('PaidFeatures by media kind (Updated Plans Step 4)', () => {
  const tier = (t: 'PREMIUM' | 'COMPLETE' | null, status = 'active') =>
    account(null, { ...paid, tier: t, subscriptionStatus: status });
  const refusal = async (
    row: object,
    needed: Parameters<PaidFeatures['mediaRefusal']>[1],
  ) =>
    (
      (await setup(BILLING_ON, row).features.mediaRefusal(
        'owner-a',
        needed,
      )) as ConflictException | null
    )?.getResponse() ?? null;

  it('Premium: photo, audio and "any" allowed; video refused with TIER_REQUIRED naming Complete (not a trial limit)', async () => {
    for (const ok of [['PHOTO'], ['AUDIO'], ['PHOTO', 'AUDIO'], 'any'] as const)
      expect(await refusal(tier('PREMIUM'), ok)).toBeNull();
    for (const bad of [['VIDEO'], ['PHOTO', 'VIDEO']] as const) {
      expect(await refusal(tier('PREMIUM'), bad)).toEqual({
        statusCode: 409,
        error: 'Conflict',
        code: TIER_REQUIRED,
        requiredTier: 'COMPLETE',
        feature: 'VIDEO',
        message: VIDEO_REQUIRES_COMPLETE,
      });
    }
  });

  it('Complete, unmapped paid, grandfathered: every kind allowed', async () => {
    for (const row of [
      tier('COMPLETE'),
      tier(null),
      account(
        null,
        { ...paid, tier: 'PREMIUM' },
        new Date('2025-12-01T00:00:00.000Z'),
      ),
    ]) {
      expect(await refusal(row, ['PHOTO', 'AUDIO', 'VIDEO'])).toBeNull();
    }
  });

  it('trial: any kind is the unchanged PAID_FEATURE; nothing needed (a text format) is never refused', async () => {
    expect(await refusal(inTrial(), ['VIDEO'])).toMatchObject({
      code: PAID_FEATURE,
    });
    expect(await refusal(inTrial(), [])).toBeNull();
  });

  it('a stored Premium tier whose access ended is not applied (the gate, not the tier, decides writes)', async () => {
    expect(await refusal(tier('PREMIUM', 'canceled'), ['VIDEO'])).toBeNull();
  });
});
