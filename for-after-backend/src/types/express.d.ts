import type { UserRole } from '../generated/prisma/client.js';
import type { RecipientPrincipal } from '../recipient-auth/recipient-auth.service.js';
import type { TrustedContactPrincipal } from '../trusted-contact-auth/trusted-contact-auth.service.js';
import type { SafeUser } from '../users/users.service.js';

declare module 'express-session' {
  // Minimal identity only. Never put the user object or secrets here.
  interface SessionData {
    userId: string;
    role: UserRole;
    // Admin sessions only (Step 16), epoch ms. Set after TOTP/recovery code.
    adminMfaVerifiedAt?: number;
    lastActivityAt?: number;
  }
}

declare global {
  namespace Express {
    interface Request {
      user?: SafeUser;
      // Recipient Portal only (RecipientSessionAuthGuard); never a User.
      recipient?: RecipientPrincipal;
      // Trusted Contact routes only (TrustedContactSessionAuthGuard); never a User.
      trustedContact?: TrustedContactPrincipal;
    }
  }
}
