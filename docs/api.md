# For After â€” API Reference

This document outlines the API endpoints, authentication mechanisms, response formats, and error handling for the For After platform.

## 1. Base URL

- **Production**: `https://api.forafter.com.au/api/v1`
- **Development**: `http://localhost:4000/api/v1`

## 2. Authentication

The API uses **Session-based authentication** with `HttpOnly` cookies. 
All authenticated endpoints require a valid session cookie. 
When making requests from the frontend, ensure you include `credentials: 'include'` in your fetch/axios configuration.

## 3. Response Format

All responses are returned in JSON format. The standard error format includes the status code, a message, and optional error details.

```json
{
  "statusCode": 400,
  "message": "Validation failed",
  "error": "Bad Request",
  "details": ["email must be an email"]
}
```

## 4. Complete Endpoint Reference

### Auth Endpoints
| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `POST` | `/auth/register` | Create account (body: `email`, `password`, `firstName`, `lastName`) |
| `POST` | `/auth/login` | Login, returns session cookie |
| `POST` | `/auth/logout` | Invalidate session |
| `GET` | `/auth/me` | Current user profile |
| `POST` | `/auth/verify-email` | Verify email token |
| `POST` | `/auth/resend-verification` | Resend activation |
| `POST` | `/auth/forgot-password` | Request reset email |
| `POST` | `/auth/reset-password` | Execute password reset |
| `POST` | `/auth/2fa/setup` | Generate TOTP secret & QR code |
| `POST` | `/auth/2fa/confirm` | Enable 2FA with first code |
| `POST` | `/auth/2fa/verify` | Verify TOTP during login |
| `POST` | `/auth/2fa/disable` | Disable 2FA |

### Recipient Auth (OTP)
| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `POST` | `/recipient-auth/request-code` | Dispatch 6-digit OTP (email or SMS) |
| `POST` | `/recipient-auth/verify-code` | Validate OTP, create scoped session |
| `POST` | `/recipient-auth/logout` | Clear recipient session |

### Users
| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `GET` | `/users` | List users (admin) |
| `POST` | `/users` | Create user (admin) |
| `GET` | `/users/:id` | Get user details |
| `PATCH` | `/users/:id` | Update user |

### Recipients (People I Love)
| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `GET` | `/recipients` | List loved ones |
| `POST` | `/recipients` | Create recipient (body: `firstName`, `lastName`, `relationship`, `email`, `mobile`) |
| `GET` | `/recipients/:id` | Get recipient |
| `PATCH` | `/recipients/:id` | Update recipient |
| `DELETE`| `/recipients/:id` | Remove recipient (soft delete, 204) |

"People I Love" = `Recipient`. All five routes require a session **and** the `CUSTOMER` role (others get 403).
Every query is scoped to the session user's id (`ownerUserId`), which is never accepted from the body.
A recipient that is missing, deleted or owned by someone else gives the same `404 Recipient not found.`
Body fields: `firstName` (required), `lastName`, `relationship`, `email`, `mobile`, `birthday` (`YYYY-MM-DD`), `privateNote` (max 2000).
In `PATCH`, all are optional and optional fields accept `null` to clear. Any other field returns 400. A non-UUID `:id` returns 400.
Responses never include `ownerUserId` or `deletedAt`.

### Trusted Contacts
| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `GET` | `/trusted-contacts` | List trusted contacts |
| `POST` | `/trusted-contacts` | Add trusted contact (no invite is sent yet) |
| `GET` | `/trusted-contacts/:id` | Get trusted contact |
| `PATCH` | `/trusted-contacts/:id` | Update trusted contact |
| `DELETE`| `/trusted-contacts/:id` | Remove trusted contact (soft delete, 204) |

Same rules as Recipients: all five routes require a session **and** the `CUSTOMER` role (others get 403).
Every query is scoped to the session user's id, which is never accepted from the body.
A contact that is missing, deleted or owned by someone else gives the same `404 Trusted contact not found.`
A non-UUID `:id` returns 400, and responses never include `ownerUserId` or `deletedAt`.
Body fields: `firstName` (required), `lastName`, `relationship`, `email`, `mobile`.
**At least one of `email` / `mobile` is required, and must remain after any PATCH**: clearing the last one returns 400.
A trusted contact is not a login account and gets no access to the owner's content.
There is no maximum per customer yet; the PRD says "1 or 2", but PROJECT_OVERVIEW §58 lists this as open.

### Messages
| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `GET` | `/messages` | List user messages |
| `POST` | `/messages` | Create draft (body: `title`, `type`, `description`) |
| `GET` | `/messages/:id` | Get message |
| `PATCH` | `/messages/:id` | Update message |
| `DELETE`| `/messages/:id` | Soft delete message |
| `POST` | `/messages/:id/recipients` | Associate recipients |
| `POST` | `/messages/:id/schedule` | Set release schedule |

### Media
| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `POST` | `/media/upload-url` | Generate signed upload URL (Mux/S3) |

### Recipient Portal
| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `GET` | `/recipient/vault` | View released messages (requires recipient auth) |

### Death Verification
| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `POST` | `/death-verifications/report` | Report death with evidence |
| `POST` | `/death-verifications/:id/confirm` | Second contact confirmation |
| `GET` | `/admin/death-verifications` | Admin queue |
| `POST` | `/admin/death-verifications/:id/approve` | Admin approval |
| `POST` | `/admin/death-verifications/:id/reject` | Admin rejection |

### Subscriptions
| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `POST` | `/subscriptions/checkout` | Stripe checkout session |

### Webhooks
| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `POST` | `/webhooks/stripe` | Stripe lifecycle events |
| `POST` | `/webhooks/mux` | Video transcode completion |

---

## 5. Request/Response Examples

### Register
**Request:**
```json
POST /auth/register
{
  "email": "user@example.com",
  "password": "SecurePassword123!",
  "firstName": "John",
  "lastName": "Doe"
}
```
**Response:**
```json
{
  "message": "Registration successful. Please check your email to verify your account."
}
```

### Login
**Request:**
```json
POST /auth/login
{
  "email": "user@example.com",
  "password": "SecurePassword123!"
}
```
**Response:**
```json
{
  "message": "Login successful",
  "user": {
    "id": "uuid-here",
    "email": "user@example.com",
    "firstName": "John",
    "lastName": "Doe",
    "role": "CUSTOMER"
  }
}
```
*(Includes `Set-Cookie` header with the session token)*

### Create Message
**Request:**
```json
POST /messages
{
  "title": "My Life Story",
  "type": "VIDEO",
  "description": "A brief overview of my life lessons."
}
```
**Response:**
```json
{
  "id": "msg-uuid",
  "title": "My Life Story",
  "type": "VIDEO",
  "status": "DRAFT",
  "createdAt": "2026-09-23T10:00:00Z"
}
```

### Create Recipient
**Request:**
```json
POST /recipients
{
  "firstName": "Jane",
  "lastName": "Doe",
  "relationship": "Spouse",
  "email": "jane.doe@example.com",
  "mobile": "+61400000000",
  "birthday": "1970-06-01",
  "privateNote": "Fictional example note."
}
```

### Report Death
**Request:**
```json
POST /death-verifications/report
{
  "userId": "uuid-of-customer",
  "evidenceUrl": "https://s3.forafter.../certificate.pdf",
  "notes": "Attached is the certificate from the hospital."
}
```

---

## 6. Error Codes

- `400 Bad Request`: Validation errors, missing fields, invalid format.
- `401 Unauthorized`: Missing or invalid session cookie, authentication required.
- `403 Forbidden`: Authenticated, but lacks required role or permissions.
- `404 Not Found`: Resource does not exist.
- `409 Conflict`: Resource already exists (e.g., duplicate email).
- `429 Too Many Requests`: Rate limit exceeded.
- `500 Internal Server Error`: Unexpected server-side fault.

---

## 7. Rate Limiting

The API employs rate limiting on critical endpoints to prevent abuse:

- **Login**: 5 attempts per minute
- **OTP Requests**: 3 requests per minute
- **Password Reset**: 3 requests per hour
- **Death Reports**: 2 reports per day per user
