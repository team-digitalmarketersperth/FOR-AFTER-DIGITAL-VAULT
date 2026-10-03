import { BadRequestException, Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AdminGuard } from '../auth/guards/admin.guard.js';
import { releaseDueAt } from '../message-release/message-release.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { EmailDeathNoticeDelivery } from './death-verification-notice.js';
import {
  EmailSendError,
  type EmailMessage,
  type EmailProvider,
} from '../email/email-provider.js';
import {
  deathTriggerDueAt,
  DeathVerificationWorkflow,
} from './death-verification-workflow.service.js';
import {
  ConfirmAliveDto,
  RejectDeathCaseDto,
  VerifyDeathCaseDto,
} from './dto/death-verification-decision.dto.js';

const DAY = 86_400_000;
const VERIFIED_AT = new Date('2026-09-29T05:00:00Z');
const DEATH_AT = new Date('2026-09-20T10:00:00Z');

describe('deathTriggerDueAt', () => {
  it('ON_DEATH is due when For After verified the death, not at the time of death', () => {
    expect(
      deathTriggerDueAt(
        { triggerType: 'ON_DEATH', afterDeathDays: null },
        VERIFIED_AT,
        DEATH_AT,
      ),
    ).toEqual(VERIFIED_AT);
  });

  it('AFTER_DEATH = verifiedDeathAt + afterDeathDays (30 days → 2026-10-20T10:00Z)', () => {
    expect(
      deathTriggerDueAt(
        { triggerType: 'AFTER_DEATH', afterDeathDays: 30 },
        VERIFIED_AT,
        DEATH_AT,
      ),
    ).toEqual(new Date('2026-10-20T10:00:00Z'));
  });

  it('AFTER_DEATH 0 days = the time of death (already due at verification)', () => {
    const due = deathTriggerDueAt(
      { triggerType: 'AFTER_DEATH', afterDeathDays: 0 },
      VERIFIED_AT,
      DEATH_AT,
    );
    expect(due).toEqual(DEATH_AT);
    expect(due! <= VERIFIED_AT).toBe(true);
  });

  it('overdue vs future relative to verification', () => {
    const longAgo = new Date(VERIFIED_AT.getTime() - 60 * DAY);
    expect(
      deathTriggerDueAt(
        { triggerType: 'AFTER_DEATH', afterDeathDays: 7 },
        VERIFIED_AT,
        longAgo,
      )! < VERIFIED_AT,
    ).toBe(true);
    expect(
      deathTriggerDueAt(
        { triggerType: 'AFTER_DEATH', afterDeathDays: 1 },
        VERIFIED_AT,
        VERIFIED_AT,
      )! > VERIFIED_AT,
    ).toBe(true);
  });

  it('never activates other triggers or AFTER_DEATH without days', () => {
    for (const triggerType of [
      'FIXED_DATE',
      'BIRTHDAY',
      'ANNIVERSARY',
      'CUSTOM_EVENT',
      'ANNUAL_AFTER_DEATH',
      'NOW',
    ] as const) {
      expect(
        deathTriggerDueAt(
          { triggerType, afterDeathDays: 1 },
          VERIFIED_AT,
          DEATH_AT,
        ),
      ).toBeNull();
    }
    expect(
      deathTriggerDueAt(
        { triggerType: 'AFTER_DEATH', afterDeathDays: null },
        VERIFIED_AT,
        DEATH_AT,
      ),
    ).toBeNull();
  });
});

describe('releaseDueAt (release worker eligibility)', () => {
  const activation = (status: string, triggerType = 'ON_DEATH') => ({
    triggerType: triggerType as never,
    dueAt: VERIFIED_AT,
    deathVerificationCase: { status: status as never },
  });
  const onDeath = {
    triggerType: 'ON_DEATH' as const,
    scheduledFor: null,
    afterDeathDays: null,
  };

  it('FIXED_DATE is unchanged: scheduledFor', () => {
    const at = new Date('2030-01-01T00:00:00Z');
    expect(
      releaseDueAt(
        { triggerType: 'FIXED_DATE', scheduledFor: at, afterDeathDays: null },
        null,
      ),
    ).toEqual(at);
  });

  it('death triggers need an activation of a VERIFIED case', () => {
    expect(releaseDueAt(onDeath, null)).toBeNull();
    for (const status of [
      'PENDING_VERIFICATION',
      'SAFEGUARD_ACTIVE',
      'READY_FOR_REVIEW',
      'REJECTED',
      'CANCELLED',
    ]) {
      expect(releaseDueAt(onDeath, activation(status))).toBeNull();
    }
    expect(releaseDueAt(onDeath, activation('VERIFIED'))).toEqual(VERIFIED_AT);
  });

  it('a mismatched activation trigger or AFTER_DEATH without days never runs', () => {
    expect(
      releaseDueAt(onDeath, activation('VERIFIED', 'AFTER_DEATH')),
    ).toBeNull();
    expect(
      releaseDueAt(
        {
          triggerType: 'AFTER_DEATH',
          scheduledFor: null,
          afterDeathDays: null,
        },
        activation('VERIFIED', 'AFTER_DEATH'),
      ),
    ).toBeNull();
  });
});

describe('Step 15 DTOs', () => {
  const pipe = new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  });
  const check = (metatype: new () => object, body: object) =>
    pipe.transform(body, { type: 'body', metatype });
  const ok = {
    verifiedDeathAt: '2026-09-28T14:30:00+10:00',
    confirmVerification: true,
  };

  it('verify: timezone-aware, not future, confirmVerification true', async () => {
    await expect(check(VerifyDeathCaseDto, ok)).resolves.toBeTruthy();
    for (const body of [
      { ...ok, verifiedDeathAt: undefined },
      { ...ok, verifiedDeathAt: '2026-09-28T14:30:00' },
      { ...ok, verifiedDeathAt: '2026-09-28' },
      { ...ok, verifiedDeathAt: '2099-01-01T00:00:00Z' },
      { ...ok, confirmVerification: false },
      { ...ok, confirmVerification: 'true' },
      { verifiedDeathAt: ok.verifiedDeathAt },
      { ...ok, decisionNote: 'x'.repeat(2001) },
    ]) {
      await expect(check(VerifyDeathCaseDto, body)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    }
  });

  it('rejects injected fields on every decision', async () => {
    for (const extra of [
      { ownerUserId: 'x' },
      { status: 'VERIFIED' },
      { verifiedByUserId: 'x' },
      { deathTriggersActivatedAt: '2026-01-01T00:00:00Z' },
    ]) {
      await expect(
        check(VerifyDeathCaseDto, { ...ok, ...extra }),
      ).rejects.toThrow();
      await expect(
        check(RejectDeathCaseDto, { confirmRejection: true, ...extra }),
      ).rejects.toThrow();
      await expect(
        check(ConfirmAliveDto, { confirmAlive: true, ...extra }),
      ).rejects.toThrow();
    }
  });

  it('confirm-alive and reject need their explicit boolean', async () => {
    await expect(check(ConfirmAliveDto, {})).rejects.toThrow();
    await expect(
      check(ConfirmAliveDto, { confirmAlive: false }),
    ).rejects.toThrow();
    await expect(check(RejectDeathCaseDto, {})).rejects.toThrow();
    const dto = (await check(RejectDeathCaseDto, {
      confirmRejection: true,
      decisionNote: '  Unable to verify.  ',
    })) as RejectDeathCaseDto;
    expect(dto.decisionNote).toBe('Unable to verify.');
  });
});

describe('AdminGuard', () => {
  const run = (role?: string, adminMfaVerifiedAt?: number) =>
    new AdminGuard().canActivate({
      switchToHttp: () => ({
        getRequest: () => ({
          user: role ? { role } : undefined,
          session: { adminMfaVerifiedAt },
        }),
      }),
    } as never);

  it('ADMIN and SUPER_ADMIN with completed MFA only (Customers → 403)', () => {
    expect(run('ADMIN', Date.now())).toBe(true);
    expect(run('SUPER_ADMIN', Date.now())).toBe(true);
    // Step 16: the role alone is never enough.
    expect(run('ADMIN')).toBe(false);
    expect(run('SUPER_ADMIN')).toBe(false);
    expect(run('CUSTOMER', Date.now())).toBe(false);
    expect(run(undefined)).toBe(false);
  });
});

describe('Safety notice delivery (Step 24: email)', () => {
  const sent: EmailMessage[] = [];
  const email = {
    name: 'fake',
    send: (m: EmailMessage) => (
      sent.push(m),
      Promise.resolve({ providerMessageId: 'x' })
    ),
  } as EmailProvider;

  it('sends one calm, content-free email with a per-case idempotency key', async () => {
    await new EmailDeathNoticeDelivery(
      email,
      'https://app.example',
    ).sendAccountHolderSafetyNotice({
      caseId: 'case-1',
      email: 'lisa@example.com',
      displayName: 'Lisa Test',
      safeguardEndsAt: new Date('2026-10-13T00:00:00Z'),
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      kind: 'death-safety',
      to: 'lisa@example.com',
      subject: 'Action needed on your For After account',
      idempotencyKey: 'death-safety/case-1',
    });
    // Sign-in link only: confirming is a signed-in action in the app.
    expect(sent[0].text).toContain('https://app.example/login');
    expect(sent[0].html).not.toMatch(/confirm-alive|token=/);
    expect(sent[0].text).toContain('Hello Lisa Test,');
  });

  it('a failed send throws, so no safeguard can start', async () => {
    const failing = {
      name: 'fake',
      send: () => Promise.reject(new EmailSendError('email_disabled', false)),
    } as unknown as EmailProvider;
    await expect(
      new EmailDeathNoticeDelivery(
        failing,
        'https://app.example',
      ).sendAccountHolderSafetyNotice({
        caseId: 'case-1',
        email: 'lisa@example.com',
        displayName: 'Lisa Test',
        safeguardEndsAt: new Date(),
      }),
    ).rejects.toBeInstanceOf(EmailSendError);
  });
});

describe('DeathVerificationWorkflow: safety notice and safeguard', () => {
  const NOW = new Date('2026-09-29T00:00:00Z');
  const setup = ({
    claim = 1,
    advance = 1,
    send = vi.fn(async () => undefined),
  } = {}) => {
    const updateMany = vi
      .fn()
      .mockResolvedValueOnce({ count: claim })
      .mockResolvedValueOnce({ count: advance });
    const auditCreate = vi.fn(async () => ({}));
    const caseModel = {
      updateMany,
      findUniqueOrThrow: vi.fn(async () => ({
        safetyNoticeAttemptCount: 1,
        owner: {
          email: 'lisa@example.com',
          firstName: 'Lisa',
          lastName: 'Test',
        },
      })),
      findUnique: vi.fn(),
    };
    const tx = {
      deathVerificationCase: caseModel,
      deathVerificationAuditEvent: { create: auditCreate },
    };
    const prisma = {
      ...tx,
      $transaction: (fn: (t: unknown) => unknown) => fn(tx),
    };
    const workflow = new DeathVerificationWorkflow(
      prisma as unknown as PrismaService,
      { sendAccountHolderSafetyNotice: send },
      new ConfigService({
        REDIS_URL: 'redis://test',
        DEATH_VERIFICATION_SAFEGUARD_SECONDS: '60',
      }),
    );
    return { workflow, updateMany, auditCreate, send, caseModel };
  };

  it('success: SAFEGUARD_ACTIVE with stored end = send time + configured duration, audited', async () => {
    const { workflow, updateMany, auditCreate } = setup();
    expect(await workflow.startSafeguard('case-1', NOW)).toEqual({
      result: 'started',
      safeguardEndsAt: new Date(NOW.getTime() + 60_000),
    });
    expect(updateMany.mock.calls[1][0]).toMatchObject({
      where: {
        id: 'case-1',
        status: 'PENDING_VERIFICATION',
        safetyNoticeSentAt: null,
      },
      data: {
        status: 'SAFEGUARD_ACTIVE',
        safetyNoticeSentAt: NOW,
        safeguardStartedAt: NOW,
        safeguardEndsAt: new Date(NOW.getTime() + 60_000),
      },
    });
    expect(
      auditCreate.mock.calls
        .map((c) => (c as never[])[0])
        .map((a: { data: { eventType: string } }) => a.data.eventType),
    ).toEqual(['SAFETY_NOTICE_SENT', 'SAFEGUARD_STARTED']);
  });

  it('delivery failure: stays PENDING (no second update, no timer), reported as failed', async () => {
    const warn = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const { workflow, updateMany, auditCreate } = setup({
      send: vi.fn(async () => {
        throw new Error('provider down');
      }),
    });
    expect(await workflow.startSafeguard('case-1', NOW)).toEqual({
      result: 'failed',
    });
    expect(updateMany).toHaveBeenCalledTimes(1); // only the attempt claim
    expect(auditCreate).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('nothing to claim (no reports, already sent, cancelled, or retried too soon): no send', async () => {
    const { workflow, send } = setup({ claim: 0 });
    expect(await workflow.startSafeguard('case-1', NOW)).toEqual({
      result: 'skipped',
    });
    expect(send).not.toHaveBeenCalled();
  });

  it('cancelled while sending: the safeguard does not start', async () => {
    const { workflow, auditCreate } = setup({ advance: 0 });
    expect(await workflow.startSafeguard('case-1', NOW)).toEqual({
      result: 'skipped',
    });
    expect(auditCreate).not.toHaveBeenCalled();
  });

  it('elapse: early → not_due at the stored end; cancelled/verified → stale no-op', async () => {
    const ends = new Date(NOW.getTime() + 30_000);
    const early = setup({ claim: 0 });
    early.caseModel.findUnique.mockResolvedValue({
      status: 'SAFEGUARD_ACTIVE',
      safeguardEndsAt: ends,
    });
    expect(await early.workflow.elapseSafeguard('case-1', NOW)).toEqual({
      result: 'not_due',
      dueAt: ends,
    });
    for (const status of [
      'CANCELLED',
      'VERIFIED',
      'REJECTED',
      'READY_FOR_REVIEW',
    ]) {
      const stale = setup({ claim: 0 });
      stale.caseModel.findUnique.mockResolvedValue({
        status,
        safeguardEndsAt: ends,
      });
      expect((await stale.workflow.elapseSafeguard('case-1', NOW)).result).toBe(
        'stale',
      );
      expect(stale.auditCreate).not.toHaveBeenCalled();
    }
  });

  it('elapse: due → READY_FOR_REVIEW only (never VERIFIED)', async () => {
    const { workflow, updateMany, auditCreate } = setup();
    expect(await workflow.elapseSafeguard('case-1', NOW)).toEqual({
      result: 'ready_for_review',
    });
    expect(updateMany.mock.calls[0][0]).toEqual({
      where: {
        id: 'case-1',
        status: 'SAFEGUARD_ACTIVE',
        safetyNoticeSentAt: { not: null },
        safeguardEndsAt: { lte: NOW },
      },
      data: { status: 'READY_FOR_REVIEW' },
    });
    expect(auditCreate).toHaveBeenCalledTimes(1);
  });
});
