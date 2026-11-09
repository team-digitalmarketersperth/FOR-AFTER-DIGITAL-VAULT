import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ConsoleSmsVerification,
  createSmsVerification,
  SmsVerificationError,
  TwilioSmsVerification,
} from './sms-verification.js';

// The SDK is mocked: no test ever reaches Twilio. Fake, non-secret values.
const services = vi.fn();
const twilioFactory = vi.fn((..._args: unknown[]) => ({
  verify: { v2: { services } },
}));
vi.mock('twilio', () => ({ default: (...args: unknown[]) => twilioFactory(...args) }));

const SID = 'AC_fake_account_sid_0000';
const TOKEN = 'fake_auth_token_not_a_secret';
const SERVICE = 'VA_fake_verify_service_0000';
const TWILIO_ENV = {
  TWILIO_ACCOUNT_SID: SID,
  TWILIO_AUTH_TOKEN: TOKEN,
  TWILIO_VERIFY_SERVICE_SID: SERVICE,
};
const MOBILE = '+61400000000';

const fakeService = () => ({
  verifications: { create: vi.fn().mockResolvedValue({ status: 'pending' }) },
  verificationChecks: {
    create: vi.fn().mockResolvedValue({ status: 'approved' }),
  },
});
const twilioError = (status: number, code: number) =>
  Object.assign(new Error('provider says no'), {
    status,
    code,
    moreInfo: `https://www.twilio.com/docs/errors/${code}`,
  });

describe('TwilioSmsVerification', () => {
  it('send: one Verify verification, channel sms, E.164 number', async () => {
    const service = fakeService();
    await new TwilioSmsVerification(service as never).send(MOBILE);
    expect(service.verifications.create).toHaveBeenCalledExactlyOnceWith({
      to: MOBILE,
      channel: 'sms',
    });
  });

  it('check: sends mobile + code; only status approved counts', async () => {
    const service = fakeService();
    const sms = new TwilioSmsVerification(service as never);
    expect(await sms.check(MOBILE, '123456')).toBe(true);
    expect(service.verificationChecks.create).toHaveBeenCalledWith({
      to: MOBILE,
      code: '123456',
    });
    for (const status of ['pending', 'canceled', 'max_attempts_reached']) {
      service.verificationChecks.create.mockResolvedValueOnce({ status });
      expect(await sms.check(MOBILE, '123456')).toBe(false);
    }
  });

  it('check: no pending verification (expired/used, 404) or attempts used up → denied, not an error', async () => {
    const service = fakeService();
    const sms = new TwilioSmsVerification(service as never);
    service.verificationChecks.create.mockRejectedValueOnce(
      twilioError(404, 20404),
    );
    expect(await sms.check(MOBILE, '123456')).toBe(false);
    service.verificationChecks.create.mockRejectedValueOnce(
      twilioError(429, 60202),
    );
    expect(await sms.check(MOBILE, '123456')).toBe(false);
  });

  it('provider errors become a safe code only (no message, URL or response)', async () => {
    const service = fakeService();
    const sms = new TwilioSmsVerification(service as never);
    service.verifications.create.mockRejectedValueOnce(twilioError(400, 60200));
    const err = await sms.send(MOBILE).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SmsVerificationError);
    expect((err as SmsVerificationError).code).toBe('twilio_60200');
    expect((err as Error).message).not.toMatch(/provider says no|twilio\.com/);
    service.verificationChecks.create.mockRejectedValueOnce(
      new Error('ECONNRESET'),
    );
    await expect(sms.check(MOBILE, '123456')).rejects.toMatchObject({
      code: 'twilio_unreachable',
    });
  });
});

describe('createSmsVerification', () => {
  beforeEach(() => {
    services.mockReset().mockReturnValue(fakeService());
    twilioFactory.mockClear();
  });
  const create = (env: Record<string, string>) =>
    createSmsVerification(new ConfigService({ NODE_ENV: 'test', ...env }));

  it('all TWILIO_* set → Twilio Verify with that service', () => {
    expect(create(TWILIO_ENV).name).toBe('twilio');
    expect(twilioFactory).toHaveBeenCalledWith(SID, TOKEN, { timeout: 10_000 });
    expect(services).toHaveBeenCalledExactlyOnceWith(SERVICE);
  });

  it('nothing set → disabled; explicit twilio with missing config → startup error naming variables only', () => {
    expect(create({}).name).toBe('disabled');
    const { TWILIO_AUTH_TOKEN: _omit, ...partial } = TWILIO_ENV;
    expect(() => create({ SMS_VERIFY_PROVIDER: 'twilio', ...partial })).toThrow(
      'TWILIO_AUTH_TOKEN not set (SMS_VERIFY_PROVIDER=twilio).',
    );
    expect(() => create({ SMS_VERIFY_PROVIDER: 'carrier-pigeon' })).toThrow(
      /SMS_VERIFY_PROVIDER must be/,
    );
  });

  it('console only in development', () => {
    expect(() => create({ SMS_VERIFY_PROVIDER: 'console' })).toThrow(
      /only allowed with NODE_ENV=development/,
    );
    expect(
      create({ SMS_VERIFY_PROVIDER: 'console', NODE_ENV: 'development' }).name,
    ).toBe('console');
  });

  it('credentials and SIDs are never logged or put in errors', async () => {
    const spies = (['log', 'warn', 'error'] as const).map((m) =>
      vi.spyOn(Logger.prototype, m).mockImplementation(() => undefined),
    );
    create(TWILIO_ENV);
    create({ TWILIO_ACCOUNT_SID: SID });
    const errors = [
      (() => {
        try {
          create({ SMS_VERIFY_PROVIDER: 'twilio', TWILIO_ACCOUNT_SID: SID });
        } catch (e) {
          return (e as Error).message;
        }
      })(),
    ];
    services.mockReturnValue({
      ...fakeService(),
      verifications: {
        create: vi.fn().mockRejectedValue(twilioError(401, 20003)),
      },
    });
    await create(TWILIO_ENV)
      .send(MOBILE)
      .catch((e: Error) => errors.push(e.message));
    const logged = JSON.stringify([spies.map((s) => s.mock.calls), errors]);
    expect(logged).toContain('Twilio Verify: configured');
    expect(logged).toContain('twilio_20003');
    for (const secret of [SID, TOKEN, SERVICE]) {
      expect(logged).not.toContain(secret);
    }
    spies.forEach((s) => s.mockRestore());
  });
});

describe('ConsoleSmsVerification (development only)', () => {
  it('logs a masked number with the code; the code works once', async () => {
    const warn = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const sms = new ConsoleSmsVerification();
    await sms.send(MOBILE);
    const line = String(warn.mock.calls[0][0]);
    expect(line).toMatch(/^\[DEV ONLY\] SMS to \+61\*{6}000 \| Your For After code is \d{6}$/);
    expect(line).not.toContain(MOBILE);
    const code = line.slice(-6);
    expect(await sms.check(MOBILE, code === '000000' ? '111111' : '000000')).toBe(false);
    expect(await sms.check(MOBILE, code)).toBe(true);
    expect(await sms.check(MOBILE, code)).toBe(false);
    warn.mockRestore();
  });
});
