import {
  ConflictException,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import argon2 from 'argon2';
import { randomBytes } from 'node:crypto';
import { UserStatus } from '../generated/prisma/client.js';
import { SafeUser, UsersService } from '../users/users.service.js';
import { LoginDto } from './dto/login.dto.js';
import { RegisterDto } from './dto/register.dto.js';

const INVALID_CREDENTIALS = 'Invalid email or password.';

@Injectable()
export class AuthService {
  // Verified against when the email is unknown, so "no such user" costs the
  // same time as "wrong password" and timing does not reveal which emails exist.
  private readonly dummyHash = argon2.hash(randomBytes(32), {
    type: argon2.argon2id,
  });

  constructor(private readonly users: UsersService) {}

  async register(dto: RegisterDto): Promise<SafeUser> {
    if (await this.users.findByEmail(dto.email)) {
      throw new ConflictException('An account with this email already exists.');
    }
    return this.users.createUser({
      email: dto.email,
      passwordHash: await argon2.hash(dto.password, { type: argon2.argon2id }),
      firstName: dto.firstName,
      lastName: dto.lastName,
    });
  }

  async validateLogin(dto: LoginDto): Promise<SafeUser> {
    const found = await this.users.findByEmail(dto.email);
    const valid = await argon2.verify(
      found?.passwordHash ?? (await this.dummyHash),
      dto.password,
    );
    if (!found || !valid) throw new UnauthorizedException(INVALID_CREDENTIALS);

    const { passwordHash: _omit, ...user } = found;
    // Status is checked only after the password, so it cannot be probed without it.
    // Deny by default: only ACTIVE may sign in. PASSED access is an open
    // business decision, so it is refused alongside SUSPENDED and DELETED.
    if (user.status !== UserStatus.ACTIVE) {
      throw new ForbiddenException('This account cannot sign in.');
    }
    return user;
  }
}
