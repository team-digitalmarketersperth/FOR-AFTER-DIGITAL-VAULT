import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ConsoleSmsSender,
  createSmsSender,
  SmsSendError,
  TwilioSmsSender,
} from './sms-sender.js';

// The SDK is mocked: no test ever reaches Twilio. Fake, non-secret values.
const messages = { create: vi.fn() };
const services = vi.fn();
const twilioFactory = vi.fn((..._args: unknown[]) => ({
  messages,
  verify: { v2: { services } },
}));
vi.mock('twilio', () => ({ default: (...args: unknown[]) => twilioFactory(...args) }));

const SID = 'AC_fake_account_sid_0000';
const TOKEN = 'fake_auth_token_not_a_secret';
const MESSAGING = 'MG_fake_messaging_service_0000';
const VERIFY = 'VA_fake_verify_service_0000';
const ENV = {
  TWILIO_ACCOUNT_SID: SID,
  TWILIO_AUTH_TOKEN: TOKEN,
  TWILIO_MESSAGING_SERVICE_SID: MESSAGING,
};
const MOBILE = '+61400000000';
const create = (env: Record<string, string>) =>
  createSmsSender(new ConfigService({ NODE_ENV: 'test', ...env }));

beforeEach(() => {
  messages.create.mockReset().mockResolvedValue({ sid: 'SM_fake' });
  twilioFactory.mockClear();
});

describe('TwilioSmsSender', () => {
  it('one Programmable Messaging send through the Messaging Service', async () => {
    await new TwilioSmsSender(messages as never, MESSAGING).send({
      to: MOBILE,
      body: 'hello',
    });
    expect(messages.create).toHaveBeenCalledExactlyOnceWith({
      to: MOBILE,
      body: 'hello',
      messagingServiceSid: MESSAGING,
    });
  });

  it('provider errors become a safe code only', async () => {
    messages.create.mockRejectedValueOnce(
      Object.assign(new Error('provider says no'), {
        code: 21610,
        moreInfo: 'https://www.twilio.com/docs/errors/21610',
      }),
    );
    const err = await new TwilioSmsSender(messages as never, MESSAGING)
      .send({ to: MOBILE, body: 'x' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SmsSendError);
    expect((err as SmsSendError).code).toBe('twilio_21610');
    expect((err as Error).message).not.toMatch(/provider says no|twilio\.com/);
  });
});

describe('createSmsSender', () => {
  it('credentials + Messaging Service → twilio; never uses Verify', async () => {
    const sender = create({ ...ENV, TWILIO_VERIFY_SERVICE_SID: VERIFY });
    expect(sender.name).toBe('twilio');
    expect(twilioFactory).toHaveBeenCalledWith(SID, TOKEN, { timeout: 10_000 });
    await sender.send({ to: MOBILE, body: 'x' });
    expect(messages.create.mock.calls[0][0].messagingServiceSid).toBe(MESSAGING);
    expect(services).not.toHaveBeenCalled();
  });

  it('Verify-only config (no Messaging Service) → disabled, sends fail safely', async () => {
    const sender = create({
      TWILIO_ACCOUNT_SID: SID,
      TWILIO_AUTH_TOKEN: TOKEN,
      TWILIO_VERIFY_SERVICE_SID: VERIFY,
    });
    expect(sender.name).toBe('disabled');
    await expect(sender.send({ to: MOBILE, body: 'x' })).rejects.toMatchObject({
      code: 'sms_disabled',
    });
    expect(twilioFactory).not.toHaveBeenCalled();
  });

  it('explicit twilio with missing config → startup error naming variables only', () => {
    expect(() =>
      create({ SMS_MESSAGING_PROVIDER: 'twilio', TWILIO_ACCOUNT_SID: SID }),
    ).toThrow(
      'TWILIO_AUTH_TOKEN, TWILIO_MESSAGING_SERVICE_SID not set (SMS_MESSAGING_PROVIDER=twilio).',
    );
    expect(() => create({ SMS_MESSAGING_PROVIDER: 'pigeon' })).toThrow(
      /SMS_MESSAGING_PROVIDER must be/,
    );
  });

  it('console only in development; logs a masked number', async () => {
    expect(() => create({ SMS_MESSAGING_PROVIDER: 'console' })).toThrow(
      /only allowed with NODE_ENV=development/,
    );
    const warn = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const sender = create({
      SMS_MESSAGING_PROVIDER: 'console',
      NODE_ENV: 'development',
    });
    expect(sender).toBeInstanceOf(ConsoleSmsSender);
    await sender.send({ to: MOBILE, body: 'hi' });
    expect(String(warn.mock.calls[0][0])).toBe(
      '[DEV ONLY] SMS to +61******000 | hi',
    );
    warn.mockRestore();
  });

  it('never logs credentials or SIDs', () => {
    const spies = (['log', 'warn', 'error'] as const).map((m) =>
      vi.spyOn(Logger.prototype, m).mockImplementation(() => undefined),
    );
    create(ENV);
    create({ TWILIO_ACCOUNT_SID: SID });
    const logged = JSON.stringify(spies.map((s) => s.mock.calls));
    expect(logged).toContain('Twilio Messaging: configured');
    for (const secret of [SID, TOKEN, MESSAGING]) {
      expect(logged).not.toContain(secret);
    }
    spies.forEach((s) => s.mockRestore());
  });
});
