import type { UserRole } from '../generated/prisma/client.js';
import type { SafeUser } from '../users/users.service.js';

declare module 'express-session' {
  // Minimal identity only. Never put the user object or secrets here.
  interface SessionData {
    userId: string;
    role: UserRole;
  }
}

declare global {
  namespace Express {
    interface Request {
      user?: SafeUser;
    }
  }
}
