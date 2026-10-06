import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  BREVO_SEND_URL,
  BrevoEmailProvider,
  ConsoleEmailProvider,
  createEmailProvider,
  DisabledEmailProvider,
  type EmailMessage,
  EmailSendError,
  ResendEmailProvider,
} from './email-provider.js';

const KEY = 're_test_not_a_real_key_000000000000';
const BREVO_KEY = 'xkeysib-test-not-a-real-key-0000000000';
const provider = (env: Record<string, string>) =>
  createEmailProvider(new ConfigService(env));
const message: EmailMessage = {
  kind: 'message-released',
  to: 'sofia@example.com',
  subject: 'A message is waiting for you',
  html: '<p>hi</p>',
  text: 'hi',
  idempotencyKey: 'release-notification/n1',
};

describe('createEmailProvider (EMAIL_PROVIDER)', () => {
  const resend = {
    EMAIL_PROVIDER: 'resend',
    RESEND_API_KEY: KEY,
    EMAIL_FROM_ADDRESS: 'notifications@example.com',
    APP_BASE_URL: 'https://app.example.com',
  };

  it('resend with a key, a sender and an https app link', () => {
    expect(provider({ ...resend, NODE_ENV: 'production' })).toBeInstanceOf(
      ResendEmailProvider,
    );
  });

  it('resend needs RESEND_API_KEY and a sender address; the key never appears in errors', () => {
    expect(() => provider({ ...resend, RESEND_API_KEY: '' })).toThrow(
      /RESEND_API_KEY is not set/,
    );
    expect(() => provider({ ...resend, EMAIL_FROM_ADDRESS: '' })).toThrow(
      /EMAIL_FROM_ADDRESS/,
    );
    try {
      provider({ ...resend, EMAIL_FROM_ADDRESS: 'nope' });
    } catch (err) {
      expect(String(err)).not.toContain(KEY);
    }
  });

  it('production must use brevo or resend with an https link', () => {
    for (const EMAIL_PROVIDER of ['console', 'disabled', '']) {
      expect(() =>
        provider({ NODE_ENV: 'production', EMAIL_PROVIDER }),
      ).toThrow(/must be "brevo" or "resend" in production/);
    }
    expect(() =>
      provider({
        ...resend,
        NODE_ENV: 'production',
        APP_BASE_URL: 'http://app.example.com',
      }),
    ).toThrow(/https in production/);
  });

  const brevo = {
    EMAIL_PROVIDER: 'brevo',
    BREVO_API_KEY: BREVO_KEY,
    EMAIL_FROM_ADDRESS: 'someone.dev@gmail.com',
    APP_BASE_URL: 'http://localhost:3000',
  };

  it('brevo with a key and a verified sender; no custom domain or RESEND_API_KEY needed', () => {
    expect(provider({ ...brevo, NODE_ENV: 'development' })).toBeInstanceOf(
      BrevoEmailProvider,
    );
    expect(
      provider({
        ...brevo,
        NODE_ENV: 'production',
        APP_BASE_URL: 'https://app.example.com',
      }),
    ).toBeInstanceOf(BrevoEmailProvider);
  });

  it('brevo needs BREVO_API_KEY and a sender address; the key never appears in errors', () => {
    expect(() => provider({ ...brevo, BREVO_API_KEY: '' })).toThrow(
      /BREVO_API_KEY is not set \(EMAIL_PROVIDER=brevo\)/,
    );
    // A Resend key does not stand in for the Brevo one.
    expect(() =>
      provider({ ...brevo, BREVO_API_KEY: '', RESEND_API_KEY: KEY }),
    ).toThrow(/BREVO_API_KEY/);
    expect(() => provider({ ...brevo, EMAIL_FROM_ADDRESS: '' })).toThrow(
      /EMAIL_FROM_ADDRESS must be a sender verified in Brevo/,
    );
    try {
      provider({ ...brevo, EMAIL_FROM_ADDRESS: 'nope' });
    } catch (err) {
      expect(String(err)).not.toContain(BREVO_KEY);
    }
  });

  it('resend does not need BREVO_API_KEY', () => {
    expect(provider({ ...resend, BREVO_API_KEY: '' })).toBeInstanceOf(
      ResendEmailProvider,
    );
  });

  it('console and disabled need neither key', () => {
    const dev = {
      NODE_ENV: 'development',
      APP_BASE_URL: 'http://localhost:3000',
    };
    expect(provider({ ...dev, EMAIL_PROVIDER: 'console' })).toBeInstanceOf(
      ConsoleEmailProvider,
    );
    expect(provider({ ...dev, EMAIL_PROVIDER: 'disabled' })).toBeInstanceOf(
      DisabledEmailProvider,
    );
  });

  it('console only in development (it logs sign-in codes)', () => {
    const dev = {
      NODE_ENV: 'development',
      APP_BASE_URL: 'http://localhost:3000',
    };
    expect(provider({ ...dev, EMAIL_PROVIDER: 'console' })).toBeInstanceOf(
      ConsoleEmailProvider,
    );
    for (const NODE_ENV of ['test', 'staging', '']) {
      expect(() =>
        provider({ ...dev, NODE_ENV, EMAIL_PROVIDER: 'console' }),
      ).toThrow(/only allowed with NODE_ENV=development/);
    }
  });

  it('defaults to disabled outside production; unknown providers and bad links stop startup', () => {
    expect(provider({})).toBeInstanceOf(DisabledEmailProvider);
    expect(() => provider({ EMAIL_PROVIDER: 'smtp' })).toThrow(
      /EMAIL_PROVIDER must be/,
    );
    expect(() =>
      provider({ ...resend, APP_BASE_URL: 'https://app.example.com/path' }),
    ).toThrow(/APP_BASE_URL/);
  });
});

describe('ResendEmailProvider', () => {
  const setup = (
    result: unknown,
    opts: { reject?: boolean; hang?: boolean } = {},
  ) => {
    const send = vi.fn(() =>
      opts.hang
        ? new Promise(() => {})
        : opts.reject
          ? Promise.reject(new Error('fetch failed: connect ECONNREFUSED'))
          : Promise.resolve(result),
    );
    const logs = (['log', 'warn'] as const).map((m) =>
      vi.spyOn(Logger.prototype, m).mockImplementation(() => undefined),
    );
    return {
      send,
      logs,
      provider: new ResendEmailProvider(
        { emails: { send } } as never,
        '"For After" <notifications@example.com>',
        50,
      ),
    };
  };

  it('sends with the sender, both parts, a kind tag and the idempotency key; returns the provider id', async () => {
    const { send, provider, logs } = setup({
      data: { id: 'em_1' },
      error: null,
    });
    expect(await provider.send(message)).toEqual({ providerMessageId: 'em_1' });
    expect(send).toHaveBeenCalledWith(
      {
        from: '"For After" <notifications@example.com>',
        to: 'sofia@example.com',
        subject: message.subject,
        html: message.html,
        text: message.text,
        tags: [{ name: 'kind', value: 'message_released' }],
      },
      { idempotencyKey: 'release-notification/n1' },
    );
    // Logs: masked address, no body.
    const logged = JSON.stringify(logs.map((l) => l.mock.calls));
    expect(logged).toContain('s***@example.com');
    expect(logged).not.toContain('sofia@example.com');
    expect(logged).not.toContain('<p>hi</p>');
    logs.forEach((l) => l.mockRestore());
  });

  it.each([
    [{ name: 'rate_limit_exceeded', statusCode: 429 }, true],
    [{ name: 'internal_server_error', statusCode: 500 }, true],
    [{ name: 'application_error', statusCode: 500 }, true],
    [{ name: 'validation_error', statusCode: 403 }, false],
    [{ name: 'invalid_from_address', statusCode: 422 }, false],
    [{ name: 'invalid_api_key', statusCode: 403 }, false],
    [{ name: 'application_error', statusCode: null }, true],
  ])(
    'maps Resend error %o to retryable=%s with only the error name',
    async (error, retryable) => {
      const { provider, logs } = setup({
        data: null,
        error: { ...error, message: 'secret detail' },
      });
      const err = await provider.send(message).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(EmailSendError);
      expect(err).toMatchObject({ code: error.name, retryable });
      expect(String(err)).not.toContain('secret detail');
      logs.forEach((l) => l.mockRestore());
    },
  );

  it('network errors and timeouts are retryable and never hang the worker', async () => {
    const down = setup(null, { reject: true });
    await expect(down.provider.send(message)).rejects.toMatchObject({
      code: 'network_error',
      retryable: true,
    });
    down.logs.forEach((l) => l.mockRestore());
    const slow = setup(null, { hang: true });
    await expect(slow.provider.send(message)).rejects.toMatchObject({
      code: 'timeout',
      retryable: true,
    });
    slow.logs.forEach((l) => l.mockRestore());
  });
});

describe('BrevoEmailProvider', () => {
  const setup = (respond: () => Promise<Response>, timeoutMs = 1000) => {
    const fetchFn = vi.fn((_url: string, _init: RequestInit) => respond());
    const logs = (['log', 'warn'] as const).map((m) =>
      vi.spyOn(Logger.prototype, m).mockImplementation(() => undefined),
    );
    return {
      fetchFn,
      logs,
      provider: new BrevoEmailProvider(
        BREVO_KEY,
        { name: 'For After', email: 'someone.dev@gmail.com' },
        timeoutMs,
        fetchFn as never,
      ),
    };
  };
  const json = (status: number, body: unknown) =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    );

  it('posts the sender, recipient, both parts, a kind tag and the idempotency key; returns the message id', async () => {
    const { fetchFn, provider, logs } = setup(() =>
      json(201, { messageId: '<abc@smtp-relay.mailin.fr>' }),
    );
    expect(await provider.send(message)).toEqual({
      providerMessageId: '<abc@smtp-relay.mailin.fr>',
    });
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe(BREVO_SEND_URL);
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ 'api-key': BREVO_KEY });
    expect(JSON.parse(init.body as string)).toEqual({
      sender: { name: 'For After', email: 'someone.dev@gmail.com' },
      to: [{ email: 'sofia@example.com' }],
      subject: message.subject,
      htmlContent: message.html,
      textContent: message.text,
      tags: ['message_released'],
      headers: { 'Idempotency-Key': 'release-notification/n1' },
    });
    // Logs: masked address; never the key or the body.
    const logged = JSON.stringify(logs.map((l) => l.mock.calls));
    expect(logged).toContain('s***@example.com');
    expect(logged).not.toContain('sofia@example.com');
    expect(logged).not.toContain('<p>hi</p>');
    expect(logged).not.toContain(BREVO_KEY);
    logs.forEach((l) => l.mockRestore());
  });

  it('omits the headers object without an idempotency key', async () => {
    const { fetchFn, provider, logs } = setup(() => json(201, {}));
    expect(
      await provider.send({ ...message, idempotencyKey: undefined }),
    ).toEqual({ providerMessageId: null });
    const body: unknown = JSON.parse(fetchFn.mock.calls[0][1].body as string);
    expect(body).not.toHaveProperty('headers');
    logs.forEach((l) => l.mockRestore());
  });

  it.each([
    [429, { code: 'too_many_requests' }, 'rate_limit_exceeded', true],
    [500, { code: 'internal_error' }, 'internal_error', true],
    [503, 'not json', 'http_503', true],
    [400, { code: 'invalid_parameter' }, 'invalid_parameter', false],
    [400, { code: 'missing_parameter' }, 'missing_parameter', false],
    [401, { code: 'unauthorized' }, 'unauthorized', false],
    [402, { code: 'insufficient_credits' }, 'insufficient_credits', false],
    [403, { code: 'Not A Safe Code!' }, 'http_403', false],
  ])(
    'maps HTTP %i %o to code %s, retryable=%s, without the message text',
    async (status, body, code, retryable) => {
      const { provider, logs } = setup(() =>
        typeof body === 'string'
          ? Promise.resolve(new Response(body, { status }))
          : json(status, { ...body, message: 'secret detail' }),
      );
      const err = await provider.send(message).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(EmailSendError);
      expect(err).toMatchObject({ code, retryable });
      expect(String(err)).not.toContain('secret detail');
      logs.forEach((l) => l.mockRestore());
    },
  );

  it('network errors and timeouts are retryable and never hang the worker', async () => {
    const down = setup(() =>
      Promise.reject(new TypeError('fetch failed: connect ECONNREFUSED')),
    );
    await expect(down.provider.send(message)).rejects.toMatchObject({
      code: 'network_error',
      retryable: true,
    });
    down.logs.forEach((l) => l.mockRestore());

    // A real abort: the provider hands AbortSignal.timeout to fetch.
    const slow = setup(() => Promise.resolve(new Response()), 20);
    slow.fetchFn.mockImplementation(
      (_url, init) =>
        new Promise((_, reject) =>
          init.signal?.addEventListener('abort', () =>
            reject(init.signal?.reason as Error),
          ),
        ),
    );
    await expect(slow.provider.send(message)).rejects.toMatchObject({
      code: 'timeout',
      retryable: true,
    });
    slow.logs.forEach((l) => l.mockRestore());
  });
});

describe('Console and disabled providers', () => {
  it('console prints a masked DEV ONLY line with the plain text', async () => {
    const warn = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    await new ConsoleEmailProvider().send({
      ...message,
      kind: 'recipient-otp',
      text: 'Your sign-in code is\n123456',
    });
    expect(warn).toHaveBeenCalledWith(
      '[DEV ONLY] Email (recipient-otp) to s***@example.com | A message is waiting for you | Your sign-in code is 123456',
    );
    warn.mockRestore();
  });

  it('disabled never sends and fails permanently', async () => {
    await expect(new DisabledEmailProvider().send()).rejects.toMatchObject({
      code: 'email_disabled',
      retryable: false,
    });
  });
});
