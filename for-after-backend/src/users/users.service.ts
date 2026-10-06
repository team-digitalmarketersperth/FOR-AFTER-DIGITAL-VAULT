import { ConflictException, Injectable } from '@nestjs/common';
import { type AuditActor, writeAuditLog } from '../audit/audit-log.service.js';
import { AuditEventType, Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

// The only User fields that may leave the API. passwordHash is never selected
// here, so anything built from this cannot leak it.
const safeUserSelect = {
  id: true,
  email: true,
  firstName: true,
  lastName: true,
  role: true,
  status: true,
  emailVerifiedAt: true,
  twoFactorEnabled: true,
  createdAt: true,
} satisfies Prisma.UserSelect;

export type SafeUser = Prisma.UserGetPayload<{ select: typeof safeUserSelect }>;

export interface CreateUserInput {
  email: string;
  passwordHash: string;
  firstName: string;
  lastName: string;
}

// The only fields a Customer may change on their own account (Step 22).
export type ProfileInput = { firstName?: string; lastName?: string };

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  /** For SessionAuthGuard, which strips the two revocation times before req.user. */
  findById(id: string): Promise<
    | (SafeUser & {
        passwordChangedAt: Date | null;
        emailChangedAt: Date | null;
      })
    | null
  > {
    return this.prisma.user.findUnique({
      where: { id },
      select: {
        ...safeUserSelect,
        passwordChangedAt: true,
        emailChangedAt: true,
      },
    });
  }

  /** For re-authentication only; never returned to a client. */
  async findPasswordHash(id: string): Promise<string | null> {
    const found = await this.prisma.user.findUnique({
      where: { id },
      select: { passwordHash: true },
    });
    return found?.passwordHash ?? null;
  }

  updateProfile(id: string, input: ProfileInput): Promise<SafeUser> {
    return this.prisma.user.update({
      where: { id },
      data: { firstName: input.firstName, lastName: input.lastName },
      select: safeUserSelect,
    });
  }

  /**
   * New hash + passwordChangedAt (which ends every older session, see
   * SessionAuthGuard) + PASSWORD_CHANGED audit row, all or nothing.
   */
  async updatePassword(
    id: string,
    passwordHash: string,
    actor: AuditActor,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id },
        data: { passwordHash, passwordChangedAt: new Date() },
        select: { id: true },
      });
      await writeAuditLog(tx, {
        eventType: AuditEventType.PASSWORD_CHANGED,
        actor,
        subjectType: 'User',
        subjectId: id,
      });
    });
  }

  /** For credential checks only; callers must strip passwordHash before responding. */
  findByEmail(
    email: string,
  ): Promise<(SafeUser & { passwordHash: string }) | null> {
    return this.prisma.user.findUnique({
      where: { email },
      select: { ...safeUserSelect, passwordHash: true },
    });
  }

  // Role and status are deliberately not inputs: DB defaults (CUSTOMER/ACTIVE) apply.
  async createUser(input: CreateUserInput): Promise<SafeUser> {
    try {
      return await this.prisma.user.create({
        data: {
          email: input.email,
          passwordHash: input.passwordHash,
          firstName: input.firstName,
          lastName: input.lastName,
        },
        select: safeUserSelect,
      });
    } catch (err) {
      // Unique-email race between the caller's existence check and this insert.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new ConflictException(
          'An account with this email already exists.',
        );
      }
      throw err;
    }
  }
}
