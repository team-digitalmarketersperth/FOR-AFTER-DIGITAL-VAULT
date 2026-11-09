import { IsIn, IsISO8601, IsOptional, IsUUID, Matches } from 'class-validator';
import { PageQueryDto } from '../admin/dto/admin.dto.js';
import { ADMIN_BILLING_FILTERS, type AdminBillingFilter } from './billing-access.js';

/** Only a plan key: never a price id, amount or currency from the client. */
export class CheckoutDto {
  @IsIn(['monthly', 'annual'], { message: 'plan must be one of: monthly, annual' })
  plan: 'monthly' | 'annual';
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
