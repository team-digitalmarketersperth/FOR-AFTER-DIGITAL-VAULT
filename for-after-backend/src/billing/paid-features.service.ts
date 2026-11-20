import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { type ConflictException } from '@nestjs/common';
import { MediaKind, type Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  allowedMediaKinds,
  billingPolicy,
  type BillingPolicy,
  paidFeatureError,
  resolveAccess,
  videoRequiresCompleteError,
} from './billing-access.js';

/** The media a write would newly add: specific kinds, or 'any' (a format that needs some media, e.g. MIXED). */
export type MediaNeeded = readonly MediaKind[] | 'any';

/**
 * The one server-side check for paid-only features (Trial Step 4), from the central policy (featureAccess). Provided by
 * MediaModule, which every module that issues uploads or writes messages already imports; it reads the billing policy
 * itself, like StorageQuota, so it needs no BillingModule.
 */
@Injectable()
export class PaidFeatures {
  private readonly policy: BillingPolicy;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    this.policy = billingPolicy((key) => config.get<string>(key));
  }

  /**
   * Why adding this media is refused now, or null when it's allowed (Trial Step 4, Updated Plans Step 4). No media at
   * all (an enforced trial): PAID_FEATURE, unchanged. A kind the paid tier doesn't include (Premium video):
   * TIER_REQUIRED naming Complete. Billing off reads nothing. Pass the caller's transaction when there is one.
   */
  async mediaRefusal(
    ownerUserId: string,
    needed: MediaNeeded = 'any',
    client: Prisma.TransactionClient = this.prisma,
  ): Promise<ConflictException | null> {
    if (!this.policy.enabled) return null;
    const kinds = allowedMediaKinds(
      await resolveAccess(client, ownerUserId, this.policy),
    );
    if (needed !== 'any' && needed.length === 0) return null;
    if (kinds.length === 0) return paidFeatureError();
    const missing =
      needed === 'any' ? [] : needed.filter((k) => !kinds.includes(k));
    if (!missing.length) return null;
    return missing.includes(MediaKind.VIDEO)
      ? videoRequiresCompleteError()
      : paidFeatureError();
  }

  async mediaAllowed(
    ownerUserId: string,
    needed: MediaNeeded = 'any',
    client?: Prisma.TransactionClient,
  ): Promise<boolean> {
    return !(await this.mediaRefusal(ownerUserId, needed, client));
  }

  /** Throws the refusal, if any. Call before anything is reserved, signed or written. */
  async assertMedia(
    ownerUserId: string,
    needed: MediaNeeded = 'any',
    client?: Prisma.TransactionClient,
  ): Promise<void> {
    const refusal = await this.mediaRefusal(ownerUserId, needed, client);
    if (refusal) throw refusal;
  }
}
