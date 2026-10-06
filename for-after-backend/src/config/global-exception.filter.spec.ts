import {
  type ArgumentsHost,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  type HttpServer,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import { Prisma } from '../generated/prisma/client.js';
import { GlobalExceptionFilter } from './global-exception.filter.js';

const FAKE_SECRET =
  'DATABASE_URL=postgres://fake-user:fake-password@example.invalid/db';

const run = (exception: unknown, traceId: string | null = null) => {
  const replies: { body: unknown; status: number }[] = [];
  const http = {
    reply: (_res: unknown, body: unknown, status: number) =>
      replies.push({ body, status }),
    isHeadersSent: () => false,
    end: vi.fn(),
  } as unknown as HttpServer;
  const host = {
    getType: () => 'http',
    getArgByIndex: () => ({}),
    switchToHttp: () => ({ getResponse: () => ({}), getRequest: () => ({}) }),
  } as unknown as ArgumentsHost;
  const logged: string[] = [];
  vi.spyOn(Logger.prototype, 'error').mockImplementation((...args) => {
    logged.push(args.map(String).join('\n'));
  });
  new GlobalExceptionFilter(http, {
    currentTraceId: () => traceId,
  }).catch(exception, host);
  return { ...replies[0], logged: logged.join('\n') };
};

describe('GlobalExceptionFilter', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    [new BadRequestException(['email must be an email']), 400],
    [new UnauthorizedException(), 401],
    [new ForbiddenException('Request origin not allowed.'), 403],
    [new NotFoundException('Message not found.'), 404],
    [new ConflictException('Already reported.'), 409],
    [new ThrottlerException(), 429],
    [new ServiceUnavailableException({ status: 'error' }), 503],
  ])('keeps an HttpException as Nest renders it (%s)', (err, status) => {
    const out = run(err);
    expect(out.status).toBe(status);
    const res = err.getResponse();
    expect(out.body).toEqual(
      typeof res === 'string' ? { statusCode: status, message: res } : res,
    );
  });

  it('a 4xx http-error (bad JSON body) keeps its status', () => {
    // body-parser's shape (http-errors).
    const err = Object.assign(new SyntaxError('Unexpected token } in JSON'), {
      statusCode: 400,
      status: 400,
      expose: true,
    });
    expect(run(err)).toMatchObject({
      status: 400,
      body: { statusCode: 400, message: 'Unexpected token } in JSON' },
    });
  });

  it('an unexpected Error is a bare 500 with the trace id; secrets reach neither client nor log', () => {
    const out = run(new Error(FAKE_SECRET), 'trace-123');
    expect(out).toMatchObject({
      status: 500,
      body: {
        statusCode: 500,
        message: 'Internal server error',
        traceId: 'trace-123',
      },
    });
    for (const text of [JSON.stringify(out.body), out.logged]) {
      expect(text).not.toMatch(
        /DATABASE_URL|fake-user|fake-password|postgres:/,
      );
    }
    expect(JSON.stringify(out.body)).not.toMatch(/stack|\.ts|\.js|[A-Z]:\\/);
    // Operators still get the class, a safe code, the trace and the frames.
    expect(out.logged).toContain(
      'unhandled_exception Error (code: UNKNOWN) trace trace-123',
    );
    expect(out.logged).toMatch(/at /);
  });

  it('no trace id without Observe; a thrown non-Error is a safe 500 too', () => {
    const out = run('raw string with fake-password');
    expect(out.status).toBe(500);
    expect(out.body).toEqual({
      statusCode: 500,
      message: 'Internal server error',
      traceId: undefined,
    });
    expect(out.logged).not.toContain('fake-password');
  });

  it('an unmapped Prisma error is a 500 with only its code logged', () => {
    const err = new Prisma.PrismaClientKnownRequestError(
      `Invalid query on host db.example.invalid: ${FAKE_SECRET}`,
      { code: 'P2010', clientVersion: 'test' },
    );
    const out = run(err);
    expect(out.status).toBe(500);
    expect(JSON.stringify(out.body)).not.toMatch(/P2010|example\.invalid|fake/);
    expect(out.logged).toContain('(code: P2010)');
    expect(out.logged).not.toMatch(/example\.invalid|fake-password/);
  });
});
