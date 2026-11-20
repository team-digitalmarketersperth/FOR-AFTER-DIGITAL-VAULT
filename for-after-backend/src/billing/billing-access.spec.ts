import type { HttpException } from '@nestjs/common';
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
import { accessState, billingPolicy, creationCaps, entitlements, featureAccess, hasAnswerText, REQUIRES_PLAN, subscriptionRank, trialEnd, TRIAL_STORAGE_BYTES, type BillingInputs, type BillingPolicy } from './billing-access.js';
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

  describe('entitlements (storage allowance, separate from access)', () => {
    const CONFIGURED = 5 * 1024 ** 3;
    const allowance = (over: Partial<BillingInputs>, policy: BillingPolicy = ON) => entitlements(accessState(input(over), policy, NOW), CONFIGURED).storageBytes;
    const active = { startedAt: NOW, endsAt: later };
    const expired = { startedAt: NOW, endsAt: earlier };

    it('an active trial gets exactly 100,000,000 bytes (decimal MB, not MiB)', () => {
      expect(TRIAL_STORAGE_BYTES).toBe(100_000_000);
      expect(allowance({ trial: active })).toBe(100_000_000);
    });

    it('paid access wins over active trial dates: the configured limit', () => {
      expect(allowance({ trial: active, account: sub('active', later) })).toBe(CONFIGURED);
      expect(allowance({ trial: active, account: sub('past_due', later) })).toBe(CONFIGURED);
      expect(allowance({ trial: active, account: sub('active', later, true) })).toBe(CONFIGURED);
    });

    it('billing off and pre-enforcement accounts keep the configured limit, even with an active trial row', () => {
      expect(allowance({ trial: active }, { enabled: false, enforceFrom: null })).toBe(CONFIGURED);
      expect(allowance({ userCreatedAt: OLD_ACCOUNT, trial: active })).toBe(CONFIGURED);
    });

    it('states without access keep the configured limit and gain no access', () => {
      for (const over of [{}, { trial: expired }, { account: sub('canceled', earlier) }, { account: sub('incomplete', later) }]) {
        const a = accessState(input(over), ON, NOW);
        expect(a.hasAccess).toBe(false);
        expect(entitlements(a, CONFIGURED).storageBytes).toBe(CONFIGURED);
      }
    });
  });

  it('creation caps (Steps 3, 5): one Recipient, one Trusted Contact and four questions only for an enforced active trial', () => {
    const caps = (over: Partial<BillingInputs>, policy: BillingPolicy = ON) => creationCaps(accessState(input(over), policy, NOW));
    const active = { startedAt: NOW, endsAt: later };
    expect(caps({ trial: active })).toEqual({ recipients: 1, trustedContacts: 1, questions: 4, memories: 1 });
    expect(entitlements(accessState(input({ trial: active }), ON, NOW), 5)).toEqual({ storageBytes: TRIAL_STORAGE_BYTES, recipients: 1, trustedContacts: 1, questions: 4, memories: 1, media: false, memoryLinks: false });
    const none = { recipients: null, trustedContacts: null, questions: null, memories: null };
    expect(caps({ trial: active, account: sub('active', later) })).toEqual(none); // paid wins
    expect(caps({ trial: active }, { enabled: false, enforceFrom: null })).toEqual(none); // billing off
    expect(caps({ userCreatedAt: OLD_ACCOUNT, trial: active })).toEqual(none); // grandfathered
    // No access at all: the gate (402) refuses first; caps are not what refuses them.
    expect(caps({})).toEqual(none);
    expect(caps({ trial: { startedAt: NOW, endsAt: earlier } })).toEqual(none);
  });

  it('hasAnswerText (Step 5): only written words take a question slot', () => {
    for (const t of [null, undefined, '', ' ', '\n\t  \r']) expect(hasAnswerText(t)).toBe(false);
    for (const t of ['a', '  words  ', '\n.']) expect(hasAnswerText(t)).toBe(true);
  });

  it('feature access (Step 4): photos, recordings and videos are off only in an enforced active trial', () => {
    const media = (over: Partial<BillingInputs>, policy: BillingPolicy = ON) => featureAccess(accessState(input(over), policy, NOW)).media;
    const active = { startedAt: NOW, endsAt: later };
    expect(media({ trial: active })).toBe(false);
    // The trial's storage allowance never turns it on: it is a separate entitlement.
    expect(entitlements(accessState(input({ trial: active }), ON, NOW), 10 ** 12)).toMatchObject({ storageBytes: TRIAL_STORAGE_BYTES, media: false });
    expect(media({ trial: active, account: sub('active', later) })).toBe(true); // paid wins over trial dates
    expect(media({ trial: active, account: sub('past_due', later) })).toBe(true);
    expect(media({ trial: active }, { enabled: false, enforceFrom: null })).toBe(true); // billing off
    expect(media({ userCreatedAt: OLD_ACCOUNT, trial: active })).toBe(true); // grandfathered
    // No access at all: the gate (402) refuses every write first; this flag is not what refuses them.
    expect(media({})).toBe(true);
    expect(media({ trial: { startedAt: NOW, endsAt: earlier } })).toBe(true);
  });

  it('feature access (Step 5): memory links are off only in an enforced active trial', () => {
    const links = (over: Partial<BillingInputs>, policy: BillingPolicy = ON) => featureAccess(accessState(input(over), policy, NOW)).memoryLinks;
    const active = { startedAt: NOW, endsAt: later };
    expect(links({ trial: active })).toBe(false);
    expect(links({ trial: active, account: sub('active', later) })).toBe(true); // paid wins over trial dates
    expect(links({ trial: active }, { enabled: false, enforceFrom: null })).toBe(true); // billing off
    expect(links({ userCreatedAt: OLD_ACCOUNT, trial: active })).toBe(true); // grandfathered
    expect(links({})).toBe(true); // no access: refused earlier by the gate (402)
  });

  it('billingPolicy: off unless "true"; enabled needs a valid BILLING_ENFORCE_FROM', () => {
    const env = (vars: Record<string, string>) => (key: string) => vars[key];
    expect(billingPolicy(env({}))).toEqual({ enabled: false, enforceFrom: null });
    expect(billingPolicy(env({ BILLING_ENABLED: 'true', BILLING_ENFORCE_FROM: ' 2026-11-01T00:00:00.000Z ' }))).toEqual(ON);
    expect(() => billingPolicy(env({ BILLING_ENABLED: 'true' }))).toThrow('BILLING_ENFORCE_FROM');
    expect(() => billingPolicy(env({ BILLING_ENABLED: 'true', BILLING_ENFORCE_FROM: 'soon' }))).toThrow('BILLING_ENFORCE_FROM');
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
    const writeAccess = vi.fn(async () => ({ hasAccess: false, state: 'trial_expired' }));
    const billing = { policy: { enabled: true }, writeAccess } as unknown as BillingService;
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
    writeAccess.mockResolvedValue({ hasAccess: true, state: 'paid_active' });
    expect(await result('POST', RecipientsController)).toBe('passed');
  });

  it('Step 6: the 402 keeps its message and adds a stable reason code for each state without access', async () => {
    const body = async (state: string) => {
      const billing = { policy: { enabled: true }, writeAccess: async () => ({ hasAccess: false, state }) } as unknown as BillingService;
      try {
        await new BillingAccessInterceptor(billing, new Reflector()).intercept(
          {
            getHandler: () => () => undefined,
            getClass: () => RecipientsController,
            switchToHttp: () => ({ getRequest: () => ({ method: 'POST', user: { id: 'u', role: UserRole.CUSTOMER } }) }),
          } as never,
          { handle: () => of('passed') },
        );
        return null;
      } catch (e) {
        return { status: (e as HttpException).getStatus(), body: (e as HttpException).getResponse() };
      }
    };
    const expected = { trial_expired: 'TRIAL_EXPIRED', trial_available: 'TRIAL_NOT_STARTED', payment_pending: 'PAYMENT_PENDING', access_ended: 'PLAN_ENDED' };
    for (const [state, code] of Object.entries(expected)) {
      expect(await body(state)).toEqual({ status: 402, body: { statusCode: 402, error: 'Payment Required', code, message: BILLING_REQUIRED } });
    }
  });

  it('Step 6: the trial ends exactly at endsAt (server time); paid wins over ended trial dates; billing off and grandfathered keep access', () => {
    const END = new Date('2030-01-01T00:00:00.000Z');
    const trial = { startedAt: new Date(END.getTime() - 7 * 86_400_000), endsAt: END };
    const at = (ms: number, over: Partial<BillingInputs> = {}, policy: BillingPolicy = ON) =>
      accessState(input({ trial, ...over }), policy, new Date(END.getTime() + ms));
    expect(at(-1)).toMatchObject({ state: 'trial_active', hasAccess: true });
    expect(at(0)).toMatchObject({ state: 'trial_expired', hasAccess: false });
    expect(at(1)).toMatchObject({ state: 'trial_expired', hasAccess: false });
    const paidUntil = new Date(END.getTime() + 30 * 86_400_000);
    expect(at(1, { account: sub('active', paidUntil) })).toMatchObject({ state: 'paid_active', hasAccess: true });
    expect(at(1, { account: sub('past_due', paidUntil) })).toMatchObject({ state: 'payment_issue', hasAccess: true });
    expect(at(1, {}, { enabled: false, enforceFrom: null })).toMatchObject({ hasAccess: true, enforced: false });
    expect(at(1, { userCreatedAt: OLD_ACCOUNT })).toMatchObject({ hasAccess: true, enforced: false });
    // Never restarted: an ended trial is not eligible for a new one.
    expect(at(1).trialEligible).toBe(false);
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
