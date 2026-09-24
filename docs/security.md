# For After — Security

This document details the security principles, measures, and best practices applied across the For After application.

## 1. Security Philosophy

- **Defense-in-depth**: Rely on multiple overlapping security layers rather than a single point of failure.
- **Assume Breach**: Systems and architecture are built with the mindset that networks and components may be compromised.

## 2. Password Security

- **Hashing Algorithm**: Argon2id (memory-hard, resistant to GPU cracking). Cost factor of 12.
- **Complexity**: Minimum 8 characters required.
- **Data Handling**: Passwords are never returned in API responses or written to application logs.

## 3. Session Security

- **Cookies**: Sessions are maintained using `HttpOnly`, `Secure`, and `SameSite=Lax` cookies to mitigate XSS and CSRF.
- **Storage**: Server-side Redis sessions ensure tokens cannot be manipulated by the client.
- **Audit**: A secondary session table tracks hash, IP address, user agent, and expiry for robust session auditing and invalidation.

## 4. Data Encryption

- **In Transit**: All communication requires TLS 1.3.
- **At Rest**: AES-256 encryption applied at the database level and across S3/R2 storage buckets.
- **Media Access**: Direct media access uses signed URLs with strict, short-lived expiration windows.

## 5. Rate Limiting

We utilize `@nestjs/throttler` to mitigate brute-force and DDoS attempts:

- **Login**: 5 attempts per minute.
- **OTP Requests**: 3 requests per minute.
- **Password Reset**: 3 requests per hour.
- **Death Reports**: 2 reports per day per user.
- **Export Jobs**: 1 per hour.

## 6. Input Validation

- **Backend**: Strict validation using `class-validator` and `class-transformer` on all Data Transfer Objects (DTOs). Unknown properties are stripped.
- **Frontend**: Form and API payload validation using `Zod`.
- **Database**: SQL injection is inherently prevented by relying on Prisma's parameterized queries.

## 7. CORS Configuration

- **Whitelist**: Strict origin whitelist allowing only `forafter.com.au` and `app.forafter.com.au` (along with standard localhost ports for dev).
- **Credentials**: `credentials: true` is enforced to allow the passing of secure cookies.

## 8. HTTP Security Headers

Implemented via `helmet`:
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `Strict-Transport-Security: max-age=31536000; includeSubDomains`
- `Content-Security-Policy`: Strictly configured to prevent inline scripts and unauthorized external resources.

## 9. Idempotency Keys

Critical operations (e.g., processing a death report, releasing messages) require idempotency keys.
- **Example**: Message delivery uses a composite key `messageId + recipientId + scheduleId`.
- **Benefit**: Safely prevents duplicate operations if a network request is retried.

## 10. Media Security

- **Storage Access**: Direct S3/R2 signed URLs are used with strict expiration times. No buckets have public read access.
- **Video Delivery**: Video playback is secured via signed Mux / Cloudflare tokens.

## 11. Audit Logging

An append-only `AuditLog` table records all critical actions.
- **Records include**: actor, action, entity, metadata, IP address, user agent, and timestamp.
- **Retention**: Audit logs are never deleted or mutated.

## 12. Dependency Security

- Automated `npm audit` on CI/CD.
- Scans using Snyk / Dependabot to catch vulnerabilities.
- Prisma ORM is pinned to `v7` to ensure predictable database interactions.

## 13. Admin Security

- **2FA**: Mandatory for all administrative accounts.
- **Session Lifetimes**: Significantly shorter than customer sessions.
- **Monitoring**: Active IP monitoring and anomaly detection.
- **Re-authentication**: Sensitive actions require the admin to re-enter their password and pass a 2FA check.
