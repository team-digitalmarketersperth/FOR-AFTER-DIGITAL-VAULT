import { Reflector } from '@nestjs/core';
import { firstValueFrom, of } from 'rxjs';
import { AssistantController } from '../assistant/assistant.module.js';
import { AuthController } from '../auth/auth.controller.js';
import { CommunicationPreferencesController } from '../communications/communications.controller.js';
import { CustomerDeathVerificationController } from '../death-verification/death-verification.controller.js';
import { DraftRecoveryController } from '../draft-recovery/draft-recovery.module.js';
import { UserRole } from '../generated/prisma/client.js';
import { MediaController } from '../media/media.controller.js';
import { MemoryVaultController } from '../memory-vault/memory-vault.controller.js';
import { MessageSchedulesController } from '../message-schedules/message-schedules.controller.js';
import { MessagesController } from '../messages/messages.controller.js';
import { MyStoryBookController, MyStoryController } from '../my-story/my-story.controller.js';
import { MyWishesController, MyWishesDisclaimerController, MyWishSongsController } from '../my-wishes/my-wishes.controller.js';
import { RecipientsController } from '../recipients/recipients.controller.js';
import { SupportController } from '../support/support.controller.js';
import { TrustedContactInvitationController, TrustedContactsController } from '../trusted-contacts/trusted-contacts.controller.js';
import { UsersController } from '../users/users.controller.js';
import { accessState, REQUIRES_PLAN, subscriptionRank, trialEnd, type BillingInputs } from './billing-access.js';
import { BILLING_REQUIRED, BillingAccessInterceptor } from './billing-access.interceptor.js';
import { BillingController } from './billing.controller.js';
import type { BillingService } from './billing.service.js';

const NOW = new Date('2026-11-10T12:00:00.000Z');
const ON = { enabled: true, enforceFrom: new Date('2026-11-01T00:00:00.000Z') };
const NEW_ACCOUNT = new Date('2026-11-05T00:00:00.000Z');
const OLD_ACCOUNT = new Date('2026-10-01T00:00:00.000Z');
const input = (over: Partial<BillingInputs> = {}): BillingInputs => ({ userCreatedAt: NEW_ACCOUNT, trial: null, account: null, ...over });
const sub = (status: string, periodEnd: Date | null, cancelAtPeriodEnd = false) => ({ plan: 'monthly', subscriptionStatus: status, cancelAtPeriodEnd, currentPeriodEnd: periodEnd });
const later = new Date(NOW.getTime() + 1000);
const earlier = new Date(NOW.getTime() - 1000);

describe('billing access state', () => {
  it('trial is exactly 7 days, set from the server time', () => {
    expect(trialEnd(NOW).toISOString()).toBe('2026-11-17T12:00:00.000Z');
  });

  it('billing off: nothing is enforced, whatever the records say', () => {
    const off = { enabled: false, enforceFrom: null };
    expect(accessState(input(), off, NOW)).toMatchObject({ state: 'no_billing_record', enforced: false, hasAccess: true, trialEligible: false });
    expect(accessState(input({ trial: { startedAt: NOW, endsAt: earlier } }), off, NOW).hasAccess).toBe(true);
  });

  it('accounts created before enforcement keep access (rollout rule) and cannot start a trial', () => {
    expect(accessState(input({ userCreatedAt: OLD_ACCOUNT }), ON, NOW)).toMatchObject({ state: 'no_billing_record', hasAccess: true, trialEligible: false });
  });

  it('new accounts: trial available → active until the exact end instant → expired', () => {
    expect(accessState(input(), ON, NOW)).toMatchObject({ state: 'trial_available', hasAccess: false, trialEligible: true });
    const trial = { startedAt: new Date(NOW.getTime() - 7 * 86_400_000 + 1000), endsAt: later };
    expect(accessState(input({ trial }), ON, NOW)).toMatchObject({ state: 'trial_active', hasAccess: true, trialEligible: false });
    // At the end instant itself the trial is over (no scheduler needed).
    expect(accessState(input({ trial: { ...trial, endsAt: NOW } }), ON, NOW)).toMatchObject({ state: 'trial_expired', hasAccess: false });
  });

  it.each([
    ['active', later, false, 'paid_active', true],
    ['trialing', later, false, 'paid_active', true],
    ['active', later, true, 'cancellation_scheduled', true],
    ['past_due', later, false, 'payment_issue', true],
    ['active', earlier, false, 'access_ended', false], // period over without renewal
    ['active', null, false, 'access_ended', false], // unknown period is never paid
    ['canceled', later, false, 'access_ended', false],
    ['unpaid', later, false, 'access_ended', false],
    ['paused', later, false, 'access_ended', false],
    ['incomplete', later, false, 'payment_pending', false], // checkout not paid: never access
    ['something_new', later, false, 'access_ended', false], // unknown status is never paid
  ])('subscription %s (period end %s, cancel %s) → %s', (status, end, cancel, state, access) => {
    expect(accessState(input({ account: sub(status, end, cancel) }), ON, NOW)).toMatchObject({ state, hasAccess: access });
  });

  it('a paid period wins over an expired trial; an active trial wins over a failed checkout', () => {
    const expired = { startedAt: NOW, endsAt: earlier };
    expect(accessState(input({ trial: expired, account: sub('active', later) }), ON, NOW).state).toBe('paid_active');
    expect(accessState(input({ trial: { startedAt: NOW, endsAt: later }, account: sub('incomplete', later) }), ON, NOW).state).toBe('trial_active');
    expect(accessState(input({ trial: expired, account: sub('canceled', earlier) }), ON, NOW).state).toBe('access_ended');
  });

  it('gate: every content, upload and AI controller is marked; settings, billing, support, safety and portals are not', () => {
    const marked = (c: object) => Reflect.getMetadata(REQUIRES_PLAN, c) === true;
    for (const c of [
      MessagesController,
      MessageSchedulesController,
      MediaController,
      MemoryVaultController,
      MyStoryController,
      MyStoryBookController,
      MyWishesController,
      MyWishesDisclaimerController,
      MyWishSongsController,
      RecipientsController,
      TrustedContactsController,
      AssistantController,
      DraftRecoveryController,
    ])
      expect([c.name, marked(c)]).toEqual([c.name, true]);
    for (const c of [BillingController, SupportController, AuthController, UsersController, CommunicationPreferencesController, CustomerDeathVerificationController, TrustedContactInvitationController])
      expect([c.name, marked(c)]).toEqual([c.name, false]);
  });

  it('gate: only a Customer without access, only on a write to a marked route, whatever the URL looks like', async () => {
    const hasAccess = vi.fn(async () => false);
    const billing = { policy: { enabled: true }, hasAccess } as unknown as BillingService;
    const result = (method: string, controller: object, role?: UserRole) =>
      (async () => {
        try {
          // The URL is deliberately absent from the context: the decision cannot depend on its spelling.
          const o = await new BillingAccessInterceptor(billing, new Reflector()).intercept(
            {
              getHandler: () => () => undefined,
              getClass: () => controller,
              switchToHttp: () => ({ getRequest: () => ({ method, user: { id: 'u', role: role ?? UserRole.CUSTOMER } }) }),
            } as never,
            { handle: () => of('passed') },
          );
          return await firstValueFrom(o);
        } catch (e) {
          return (e as Error).message;
        }
      })();
    for (const m of ['POST', 'PUT', 'PATCH']) expect(await result(m, RecipientsController)).toBe(BILLING_REQUIRED);
    for (const m of ['GET', 'HEAD', 'DELETE']) expect(await result(m, RecipientsController)).toBe('passed');
    expect(await result('POST', SupportController)).toBe('passed');
    expect(await result('POST', RecipientsController, UserRole.ADMIN)).toBe('passed');
    hasAccess.mockResolvedValue(true);
    expect(await result('POST', RecipientsController)).toBe('passed');
  });

  it('which subscription an account shows: entitled beats ended; not cancelling beats cancelling; a payment issue beats pending', () => {
    const rank = (status: string, end: Date | null, cancel = false) => subscriptionRank({ status, cancelAtPeriodEnd: cancel, currentPeriodEnd: end }, NOW);
    expect(rank('active', later)).toBeGreaterThan(rank('active', later, true));
    expect(rank('active', later, true)).toBeGreaterThan(rank('past_due', later));
    expect(rank('past_due', later)).toBeGreaterThan(rank('incomplete', later));
    expect(rank('incomplete', later)).toBeGreaterThan(rank('canceled', later));
    expect(rank('active', earlier)).toBe(rank('canceled', later));
    expect(rank('active', null)).toBe(0);
  });
});
