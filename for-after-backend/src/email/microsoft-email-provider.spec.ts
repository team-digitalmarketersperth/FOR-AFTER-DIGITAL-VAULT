import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ConfidentialClientApplication, type INetworkModule } from '@azure/msal-node';
import { type EmailMessage, EmailSendError } from './email-provider.js';
import { emailProviderFor } from './email-provider.factory.js';
import {
  GRAPH_SCOPE,
  graphSendMailUrl,
  MicrosoftGraphEmailProvider,
  sanitizeGraphMessage,
  type GraphTokenSource,
} from './microsoft-email-provider.js';

// Fictional values shaped like a real app registration; never real credentials.
const TENANT = '7f3c2a10-5b4d-4e6f-8a9b-0c1d2e3f4a5b';
const CLIENT = '2b9e4d71-6c3a-4f8e-9d1b-5a7c3e2f1d0a';
const SECRET = 'Fq8~test.Secret-NotReal_9xY2zW4vU6tS8rQ0';
const TOKEN = 'eyJ0eXAiOi.test-access-token.not-real';
const env = {
  NODE_ENV: 'development',
  EMAIL_PROVIDER: 'microsoft',
  APP_BASE_URL: 'http://localhost:3000',
  MS_TENANT_ID: TENANT,
  MS_CLIENT_ID: CLIENT,
  MS_CLIENT_SECRET: SECRET,
  MS_SENDER_MAILBOX: 'notifications@forafter.test',
  EMAIL_FROM: 'notifications@forafter.test',
};
const message: EmailMessage = {
  kind: 'recipient-otp',
  to: 'sofia@forafter.test',
  subject: 'Your For After sign-in code',
  html: '<p>Your code is 123456</p>',
  text: 'Your code is 123456',
  idempotencyKey: 'otp/1',
};
const quiet = () =>
  (['log', 'warn'] as const).map((m) => vi.spyOn(Logger.prototype, m).mockImplementation(() => undefined));
const logged = (logs: ReturnType<typeof quiet>) => JSON.stringify(logs.map((l) => l.mock.calls));

describe('EMAIL_PROVIDER=microsoft: configuration', () => {
  const create = (over: Record<string, string>) => emailProviderFor(new ConfigService({ ...env, ...over }));

  it('builds the Graph provider from the five variables, in development and production', () => {
    const logs = quiet();
    expect(create({}).name).toBe('microsoft');
    expect(create({ NODE_ENV: 'production', APP_BASE_URL: 'https://app.forafter.test' }).name).toBe('microsoft');
    // Production with a client secret: a warning pointing at certificates / federation, never the secret.
    expect(logged(logs)).toContain('certificate or a federated credential');
    expect(logged(logs)).not.toContain(SECRET);
    logs.forEach((l) => l.mockRestore());
  });

  it.each(['MS_TENANT_ID', 'MS_CLIENT_ID', 'MS_CLIENT_SECRET', 'MS_SENDER_MAILBOX', 'EMAIL_FROM'])(
    'a missing %s stops startup, naming the variable only',
    (name) => {
      expect(() => create({ [name]: '' })).toThrow(new RegExp(`Set ${name} in .env`));
      expect(() => create({ [name]: '   ' })).toThrow(name);
    },
  );

  it.each([
    ['MS_CLIENT_SECRET', 'your-client-secret'],
    ['MS_CLIENT_SECRET', '<client-secret>'],
    ['MS_CLIENT_SECRET', 'changeme'],
    ['MS_CLIENT_SECRET', 'short-secret'],
    ['MS_CLIENT_ID', '00000000-0000-0000-0000-000000000000'],
    ['MS_TENANT_ID', 'your-tenant-id'],
    ['MS_SENDER_MAILBOX', 'sender@example.com'],
    ['EMAIL_FROM', 'noreply@example.com'],
  ])('rejects the placeholder %s=%s without echoing it', (name, value) => {
    let error: unknown;
    try {
      create({ [name]: value });
    } catch (e) {
      error = e;
    }
    expect(String(error)).toContain(`${name}`);
    expect(String(error)).toContain('placeholder');
    expect(String(error)).not.toContain(value);
    expect(String(error)).not.toContain(SECRET);
  });

  it('rejects malformed ids and addresses', () => {
    expect(() => create({ MS_CLIENT_ID: 'not-a-guid-value-123' })).toThrow('MS_CLIENT_ID');
    expect(() => create({ MS_TENANT_ID: 'contoso' })).toThrow('MS_TENANT_ID');
    expect(() => create({ EMAIL_FROM: 'For After <n@forafter.test>' })).toThrow('EMAIL_FROM');
    // A verified domain and a mailbox object id are fine.
    expect(create({ MS_TENANT_ID: 'contoso.onmicrosoft.com', MS_SENDER_MAILBOX: CLIENT }).name).toBe('microsoft');
  });

  it('unknown providers still stop startup; the message lists microsoft', () => {
    expect(() => create({ EMAIL_PROVIDER: 'graph' })).toThrow('"microsoft"');
  });
});

describe('MicrosoftGraphEmailProvider', () => {
  const setup = (respond: (init: RequestInit) => Promise<Response>, opts: { tokens?: GraphTokenSource; timeoutMs?: number } = {}) => {
    const tokens = opts.tokens ?? { acquireTokenByClientCredential: vi.fn(async () => ({ accessToken: TOKEN }) as never) };
    const fetchFn = vi.fn((_url: string, init: RequestInit) => respond(init));
    const logs = quiet();
    const provider = new MicrosoftGraphEmailProvider(
      tokens,
      'notifications@forafter.test',
      { name: 'For After', address: 'notifications@forafter.test' },
      opts.timeoutMs ?? 1000,
      fetchFn as never,
    );
    return { provider, fetchFn, tokens, logs };
  };
  const graph = (status: number, body?: unknown, headers: Record<string, string> = {}) =>
    Promise.resolve(new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'request-id': 'req-123', ...headers } }));

  it('202: app-only token for the Graph scope, POST sendMail as the mailbox, no Sent Items copy; returns the request id', async () => {
    const { provider, fetchFn, tokens, logs } = setup(() => graph(202));
    expect(await provider.send(message)).toEqual({ providerMessageId: 'req-123' });
    expect(tokens.acquireTokenByClientCredential).toHaveBeenCalledWith({ scopes: [GRAPH_SCOPE] });
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe('https://graph.microsoft.com/v1.0/users/notifications%40forafter.test/sendMail');
    expect(url).toBe(graphSendMailUrl('notifications@forafter.test'));
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ authorization: `Bearer ${TOKEN}`, 'return-client-request-id': 'true' });
    expect((init.headers as Record<string, string>)['client-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.parse(init.body as string)).toEqual({
      message: {
        subject: message.subject,
        body: { contentType: 'HTML', content: message.html },
        from: { emailAddress: { name: 'For After', address: 'notifications@forafter.test' } },
        toRecipients: [{ emailAddress: { address: 'sofia@forafter.test' } }],
      },
      saveToSentItems: false,
    });
    // "accepted", not "delivered"; masked address; never the token, code or body.
    const out = logged(logs);
    expect(out).toContain('email_accepted recipient-otp to s***@forafter.test status 202 request req-123');
    expect(out).not.toMatch(/sofia@|123456|eyJ0|Bearer|<p>/);
    logs.forEach((l) => l.mockRestore());
  });

  it.each([
    [429, { error: { code: 'ApplicationThrottled' } }, { 'retry-after': '17' }, 'rate_limit_exceeded', true],
    [503, { error: { code: 'ServiceUnavailable' } }, { 'retry-after': '5' }, 'ServiceUnavailable', true],
    [500, 'not json', {}, 'http_500', true],
    [401, { error: { code: 'InvalidAuthenticationToken' } }, {}, 'unauthorized', true],
    [403, { error: { code: 'ErrorAccessDenied' } }, {}, 'forbidden_ErrorAccessDenied', false],
    [403, { error: { code: 'ErrorSendAsDenied' } }, {}, 'forbidden_ErrorSendAsDenied', false],
    [404, { error: { code: 'ErrorInvalidUser' } }, {}, 'mailbox_not_found', false],
    [400, { error: { code: 'ErrorInvalidRecipients' } }, {}, 'ErrorInvalidRecipients', false],
    [400, { error: { code: 'not a safe code!' } }, {}, 'http_400', false],
  ])('HTTP %i %o → %s (retryable=%s), message text never in the error', async (status, body, headers, code, retryable) => {
    const { provider, logs } = setup(() =>
      typeof body === 'string'
        ? Promise.resolve(new Response(body, { status, headers }))
        : graph(status, { error: { ...body.error, message: 'secret detail for sofia@forafter.test' } }, headers),
    );
    const err = await provider.send(message).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EmailSendError);
    expect(err).toMatchObject({ code, retryable });
    expect(String(err)).not.toContain('secret detail');
    const out = logged(logs);
    // Graph's text reaches the log line only, sanitized; never the error or an address.
    expect(out).not.toContain('sofia@forafter.test');
    const retryAfter = (headers as Record<string, string>)['retry-after'];
    if (retryAfter) expect(out).toContain(`retry-after: ${retryAfter}`);
    logs.forEach((l) => l.mockRestore());
  });

  it("403: the log carries Graph's sanitized message, request id, client request id and date; the error keeps only the code", async () => {
    const { provider, fetchFn, logs } = setup(() =>
      graph(
        403,
        {
          error: {
            code: 'ErrorAccessDenied',
            message: 'Access is denied. Check credentials and try again. Mailbox info@forafter.test, Bearer eyJabc.def.ghi\r\nsecond line',
            innerError: { date: '2026-10-21T11:30:00', 'request-id': 'inner-req-9', 'client-request-id': 'ignored "quote' },
          },
        },
        { date: 'Tue, 21 Oct 2026 11:30:00 GMT' },
      ),
    );
    const err = await provider.send(message).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'forbidden_ErrorAccessDenied', retryable: false });
    expect(String(err)).not.toContain('Access is denied');
    const clientRequestId = (fetchFn.mock.calls[0][1].headers as Record<string, string>)['client-request-id'];
    const out = logged(logs);
    expect(out).toContain('status: 403, graph: ErrorAccessDenied');
    expect(out).toContain('Access is denied. Check credentials and try again. Mailbox <address>, Bearer <redacted> second line');
    expect(out).toContain('request: inner-req-9');
    // An unsafe inner value is replaced by our own id for this attempt.
    expect(out).toContain(`client-request: ${clientRequestId}`);
    expect(out).toContain('date: 2026-10-21T11:30:00');
    expect(out).not.toMatch(/info@forafter|eyJabc|sofia@/);
    logs.forEach((l) => l.mockRestore());
  });

  it('sanitizeGraphMessage: one line, no addresses or tokens, at most 200 characters', () => {
    expect(sanitizeGraphMessage('a@b.co said\n"no" Bearer xyz eyJa.b.c')).toBe("<address> said 'no' Bearer <redacted> <token>");
    expect(sanitizeGraphMessage('x'.repeat(500))).toHaveLength(200);
    expect(sanitizeGraphMessage(undefined)).toBeNull();
  });

  it('token errors: a rejected app registration is permanent; an unreachable Entra ID is retryable; neither leaks', async () => {
    for (const [errorCode, code, retryable] of [
      ['invalid_client', 'auth_rejected', false],
      ['unauthorized_client', 'auth_rejected', false],
      ['network_error', 'token_unavailable', true],
      ['temporarily_unavailable', 'token_unavailable', true],
    ] as const) {
      const tokens = {
        acquireTokenByClientCredential: vi.fn(() =>
          Promise.reject(Object.assign(new Error(`AADSTS7000215 ${SECRET}`), { errorCode })),
        ),
      } as unknown as GraphTokenSource;
      const { provider, fetchFn, logs } = setup(() => graph(202), { tokens });
      const err = await provider.send(message).catch((e: unknown) => e);
      expect(err).toMatchObject({ code, retryable });
      expect(String(err)).not.toContain(SECRET);
      expect(logged(logs)).not.toContain(SECRET);
      expect(fetchFn).not.toHaveBeenCalled();
      logs.forEach((l) => l.mockRestore());
    }
  });

  it('a hanging token request or Graph call times out (retryable) and never hangs the worker', async () => {
    const stuck = { acquireTokenByClientCredential: vi.fn(() => new Promise<never>(() => undefined)) } as unknown as GraphTokenSource;
    const a = setup(() => graph(202), { tokens: stuck, timeoutMs: 20 });
    await expect(a.provider.send(message)).rejects.toMatchObject({ code: 'timeout', retryable: true });
    a.logs.forEach((l) => l.mockRestore());

    const b = setup(
      (init) => new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(init.signal?.reason as Error))),
      { timeoutMs: 20 },
    );
    await expect(b.provider.send(message)).rejects.toMatchObject({ code: 'timeout', retryable: true });
    b.logs.forEach((l) => l.mockRestore());

    const c = setup(() => Promise.reject(new TypeError('fetch failed')));
    await expect(c.provider.send(message)).rejects.toMatchObject({ code: 'network_error', retryable: true });
    c.logs.forEach((l) => l.mockRestore());
  });
});

describe('MSAL client credentials (real library, mocked network)', () => {
  // Entra ID stand-in: discovery documents and a token endpoint issuing t1, t2, …
  const network = (expiresIn: number) => {
    let issued = 0;
    const tokenRequests: string[] = [];
    const client: INetworkModule = {
      sendGetRequestAsync: async (url: string) => {
        const base = `https://login.microsoftonline.com/${TENANT}`;
        const body = url.includes('openid-configuration')
          ? {
              token_endpoint: `${base}/oauth2/v2.0/token`,
              authorization_endpoint: `${base}/oauth2/v2.0/authorize`,
              end_session_endpoint: `${base}/oauth2/v2.0/logout`,
              issuer: `https://login.microsoftonline.com/${TENANT}/v2.0`,
              jwks_uri: `${base}/discovery/v2.0/keys`,
            }
          : {
              tenant_discovery_endpoint: `${base}/v2.0/.well-known/openid-configuration`,
              'api-version': '1.1',
              metadata: [{ preferred_network: 'login.microsoftonline.com', preferred_cache: 'login.windows.net', aliases: ['login.microsoftonline.com', 'login.windows.net'] }],
            };
        return { headers: {}, body, status: 200 } as never;
      },
      sendPostRequestAsync: async (_url: string, options?: { body?: string }) => {
        tokenRequests.push(options?.body ?? '');
        issued++;
        return { headers: {}, status: 200, body: { token_type: 'Bearer', expires_in: expiresIn, access_token: `t${issued}` } } as never;
      },
    };
    return { client, tokenRequests };
  };
  const msal = (client: INetworkModule) =>
    new ConfidentialClientApplication({
      auth: { clientId: CLIENT, authority: `https://login.microsoftonline.com/${TENANT}`, clientSecret: SECRET },
      system: { networkClient: client, loggerOptions: { loggerCallback: () => undefined } },
    });

  it('caches the token across sends and asks Entra ID again only when it is about to expire', async () => {
    const long = network(3600);
    const cached = msal(long.client);
    const first = await cached.acquireTokenByClientCredential({ scopes: [GRAPH_SCOPE] });
    const second = await cached.acquireTokenByClientCredential({ scopes: [GRAPH_SCOPE] });
    expect([first?.accessToken, second?.accessToken]).toEqual(['t1', 't1']);
    expect(long.tokenRequests).toHaveLength(1);
    expect(long.tokenRequests[0]).toContain('grant_type=client_credentials');
    expect(decodeURIComponent(long.tokenRequests[0])).toContain(`scope=${GRAPH_SCOPE}`);

    // Inside MSAL's renewal window (5 min before expiry): a fresh token each time.
    const short = network(60);
    const renewing = msal(short.client);
    const a = await renewing.acquireTokenByClientCredential({ scopes: [GRAPH_SCOPE] });
    const b = await renewing.acquireTokenByClientCredential({ scopes: [GRAPH_SCOPE] });
    expect([a?.accessToken, b?.accessToken]).toEqual(['t1', 't2']);
    expect(short.tokenRequests).toHaveLength(2);
  });
});
