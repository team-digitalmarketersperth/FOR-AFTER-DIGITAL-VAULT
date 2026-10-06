import { Body, Controller, Patch, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { CustomerGuard } from '../auth/guards/customer.guard.js';
import { SessionAuthGuard } from '../auth/guards/session-auth.guard.js';
import { UpdateProfileDto } from './dto/update-profile.dto.js';
import { type SafeUser, UsersService } from './users.service.js';
import { AUTH } from '../config/swagger.js';

/**
 * The signed-in Customer's own profile (phase 08). Read it with GET /auth/me;
 * this returns the same shape. Admins 403; Recipient/Trusted Contact 401.
 */
@ApiTags('Account')
@ApiCookieAuth(AUTH.customer)
@Controller('users/me')
@UseGuards(SessionAuthGuard, CustomerGuard)
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Patch()
  update(
    @CurrentUser() user: SafeUser,
    @Body() dto: UpdateProfileDto,
  ): Promise<SafeUser> {
    return this.users.updateProfile(user.id, dto);
  }
}
