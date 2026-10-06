import type { INestApplication } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { RECIPIENT_SESSION_COOKIE } from '../recipient-auth/recipient-auth.service.js';
import { TRUSTED_CONTACT_SESSION_COOKIE } from '../trusted-contact-auth/trusted-contact-auth.service.js';
import { ADMIN_SESSION_COOKIE, SESSION_COOKIE } from './app.setup.js';

export const DOCS_PATH = 'api/docs';

/** Swagger security scheme names, one per session cookie (principal). */
export const AUTH = {
  customer: 'customer-session',
  admin: 'admin-session',
  recipient: 'recipient-session',
  trustedContact: 'trusted-contact-session',
} as const;

/**
 * SWAGGER_ENABLED=true|false. Unset: on only in development, so test and
 * production stay closed unless someone opts in (e.g. staging).
 */
export const swaggerEnabled = (config: ConfigService): boolean => {
  const raw = config.get<string>('SWAGGER_ENABLED')?.trim();
  if (!raw) return config.get<string>('NODE_ENV') === 'development';
  if (raw !== 'true' && raw !== 'false') {
    throw new Error('SWAGGER_ENABLED must be "true" or "false".');
  }
  return raw === 'true';
};

export const buildOpenApiConfig = () =>
  new DocumentBuilder()
    .setTitle('For After API')
    .setDescription(
      'Backend API for For After. Sessions are HttpOnly cookies set by the sign-in endpoints (no bearer tokens); each principal has its own cookie.',
    )
    .setVersion('v1')
    .addCookieAuth(SESSION_COOKIE, { type: 'apiKey' }, AUTH.customer)
    .addCookieAuth(ADMIN_SESSION_COOKIE, { type: 'apiKey' }, AUTH.admin)
    .addCookieAuth(RECIPIENT_SESSION_COOKIE, { type: 'apiKey' }, AUTH.recipient)
    .addCookieAuth(
      TRUSTED_CONTACT_SESSION_COOKIE,
      { type: 'apiKey' },
      AUTH.trustedContact,
    )
    .build();

/** Swagger UI at /api/docs and the document at /api/docs-json, when enabled. */
export function setupSwagger(app: INestApplication, config: ConfigService) {
  if (!swaggerEnabled(config)) return;
  // Built on first request, after every module is registered.
  SwaggerModule.setup(DOCS_PATH, app, () =>
    SwaggerModule.createDocument(app, buildOpenApiConfig()),
  );
}
