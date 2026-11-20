import { IsIn, IsISO8601, IsOptional, IsUUID, Matches } from 'class-validator';
import { PageQueryDto } from '../admin/dto/admin.dto.js';
import { PaidTier } from '../generated/prisma/client.js';
import { ADMIN_BILLING_FILTERS, type AdminBillingFilter } from './billing-access.js';

/**
 * Updated Plans Step 6: a tier and an interval only; the server picks the price. Never a price id, amount, currency or
 * metadata from the client (any other field is refused by the global whitelist).
 */
export class CheckoutDto {
  @IsIn([PaidTier.PREMIUM, PaidTier.COMPLETE], { message: 'tier must be one of: PREMIUM, COMPLETE' })
  tier: PaidTier;

  @IsIn(['monthly', 'annual'], { message: 'interval must be one of: monthly, annual' })
  interval: 'monthly' | 'annual';
}

export class BillingAdminQueryDto extends PageQueryDto {
  @IsOptional()
  @IsIn(ADMIN_BILLING_FILTERS, { message: `state must be one of: ${ADMIN_BILLING_FILTERS.join(', ')}` })
  state?: AdminBillingFilter;

  @IsOptional()
  @IsIn(['monthly', 'annual', 'unknown'], { message: 'plan must be one of: monthly, annual, unknown' })
  plan?: 'monthly' | 'annual' | 'unknown';

  /** Exact account (User) id. */
  @IsOptional()
  @IsUUID()
  accountId?: string;

  /** Exact Stripe subscription id (sub_…). */
  @IsOptional()
  @Matches(/^sub_[A-Za-z0-9]{1,100}$/, { message: 'subscriptionReference is invalid' })
  subscriptionReference?: string;

  /** Account-created range; at most 366 days. */
  @IsOptional()
  @IsISO8601({ strict: true })
  from?: string;

  @IsOptional()
  @IsISO8601({ strict: true })
  to?: string;
}
