import { ConflictException, Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
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

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  findById(id: string): Promise<SafeUser | null> {
    return this.prisma.user.findUnique({
      where: { id },
      select: safeUserSelect,
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
