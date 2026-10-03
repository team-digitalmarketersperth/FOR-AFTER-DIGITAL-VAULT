import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';
import session, { type SessionData, type Store } from 'express-session';
import helmet from 'helmet';

export const SESSION_COOKIE = 'for_after_session';
// Admins have their own session (Step 23 follow-up), so a Customer and an admin
// can be signed in in the same browser. Only admin routes ever read it.
export const ADMIN_SESSION_COOKIE = 'for_after_admin_session';
const ADMIN_PATH = /^\/api\/v1\/admin(-auth)?(\/|$)/;
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * A new session ID (prevents session fixation) holding only `data` and the
 * sign-in time, saved before the response. Used by Customer login, admin MFA
 * completion and Customer password change.
 */
export async function establishSession(
  req: Request,
  data: Partial<SessionData>,
): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    req.session.regenerate((err) => (err ? reject(err) : resolve())),
  );
  Object.assign(req.session, { authenticatedAt: Date.now() }, data);
  await new Promise<void>((resolve, reject) =>
    req.session.save((err) => (err ? reject(err) : resolve())),
  );
}

/**
 * Destroys this request's session and clears its cookie (`name` must be the
 * cookie that session came from). Returns what the session held. Safe without
 * a session.
 */
export async function endSession(
  req: Request,
  res: Response,
  name: string,
): Promise<Partial<SessionData>> {
  const { userId, role, adminMfaVerifiedAt } = req.session;
  const { path, domain, httpOnly, sameSite, secure } = req.session.cookie;
  await new Promise<void>((resolve, reject) =>
    req.session.destroy((err) => (err ? reject(err) : resolve())),
  );
  // Same path/domain/flags as when set, or the browser keeps the cookie.
  res.clearCookie(name, {
    path,
    domain,
    httpOnly,
    sameSite,
    secure: secure === true,
  });
  return { userId, role, adminMfaVerifiedAt };
}

/**
 * HTTP-level setup shared by main.ts and the auth integration test.
 * The session store is a required argument, so there is no path that falls
 * back to express-session's in-memory store. main.ts gives admins their own
 * Redis prefix; tests may share one in-memory store (separate cookies).
 */
export function configureApp(
  app: NestExpressApplication,
  store: Store,
  adminStore: Store = store,
): void {
  const config = app.get(ConfigService);
  const isProd = config.get<string>('NODE_ENV') === 'production';

  const secret = config.get<string>('SESSION_SECRET');
  if (!secret || secret.length < 32) {
    throw new Error(
      'SESSION_SECRET is not set or too short. Add a random value of at least 32 characters to .env.',
    );
  }
  const ttlSeconds = Number(
    config.get<string>('SESSION_TTL_SECONDS') ?? 604800,
  );
  if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0) {
    throw new Error('SESSION_TTL_SECONDS must be a positive whole number.');
  }
  // Each may be a comma-separated list, e.g. WORDPRESS_URL=https://forafter.com.au,https://www.forafter.com.au
  const origins = ['FRONTEND_URL', 'WORDPRESS_URL']
    .flatMap((key) => (config.get<string>(key) ?? '').split(','))
    .map((origin) => origin.trim())
    .filter(Boolean);

  // Health checks stay at /health/* for load balancers.
  app.setGlobalPrefix('api/v1', { exclude: ['health/*path'] });
  app.use(helmet());
  app.enableCors({ origin: origins, credentials: true });
  // CSRF defence in depth. SameSite=Lax keeps the cookies off cross-site
  // requests, but not off same-site ones (another subdomain, another localhost
  // port), and a plain HTML form needs no CORS preflight. Browsers send Origin
  // on every state-changing request, so refuse any outside the CORS allowlist.
  // Requests without Origin (curl, Postman, server-to-server) are unaffected.
  app.use((req: Request, res: Response, next: NextFunction) => {
    const { origin } = req.headers;
    if (SAFE_METHODS.has(req.method) || !origin || origins.includes(origin)) {
      return next();
    }
    res
      .status(403)
      .json({ statusCode: 403, message: 'Request origin not allowed.' });
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // Production runs behind the AWS load balancer that terminates TLS. Trusting
  // one proxy hop lets secure cookies be issued and gives the throttler the real client IP.
  if (isProd) app.set('trust proxy', 1);

  const sessionFor = (name: string, sessionStore: Store) =>
    session({
      store: sessionStore,
      name,
      secret,
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        secure: isProd,
        sameSite: 'lax',
        path: '/',
        // Unset on localhost; .forafter.com.au in production.
        domain: config.get<string>('COOKIE_DOMAIN') || undefined,
        maxAge: ttlSeconds * 1000,
      },
    });
  const customerSession = sessionFor(SESSION_COOKIE, store);
  const adminSession = sessionFor(ADMIN_SESSION_COOKIE, adminStore);
  // Exactly one session per request: /admin/* and /admin-auth/* see only the
  // admin cookie, every other route only the Customer cookie. So neither
  // principal's sign-in, logout or expiry can touch the other's session.
  app.use((req: Request, res: Response, next: NextFunction) =>
    ADMIN_PATH.test(req.path)
      ? adminSession(req, res, next)
      : customerSession(req, res, next),
  );
}
