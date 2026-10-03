import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';
import session, { type SessionData, type Store } from 'express-session';
import helmet from 'helmet';

export const SESSION_COOKIE = 'for_after_session';
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
 * HTTP-level setup shared by main.ts and the auth integration test.
 * The session store is a required argument, so there is no path that falls
 * back to express-session's in-memory store.
 */
export function configureApp(app: NestExpressApplication, store: Store): void {
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

  app.use(
    session({
      store,
      name: SESSION_COOKIE,
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
    }),
  );
}
