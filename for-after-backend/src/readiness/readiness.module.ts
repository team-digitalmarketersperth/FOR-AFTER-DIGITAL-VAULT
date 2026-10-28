import { Controller, Get, Module, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { CustomerGuard } from '../auth/guards/customer.guard.js';
import { SessionAuthGuard } from '../auth/guards/session-auth.guard.js';
import { AUTH } from '../config/swagger.js';
import { UsersModule } from '../users/users.module.js';
import type { SafeUser } from '../users/users.service.js';
import { type Readiness, ReadinessService } from './readiness.service.js';

// The signed-in Customer's own setup progress (dashboard); never anyone else's.
@ApiTags('Users')
@ApiCookieAuth(AUTH.customer)
@Controller('users/me/readiness')
@UseGuards(SessionAuthGuard, CustomerGuard)
export class ReadinessController {
  constructor(private readonly readiness: ReadinessService) {}

  @Get()
  get(@CurrentUser() user: SafeUser): Promise<Readiness> {
    return this.readiness.getForUser(user.id);
  }
}

// UsersModule backs SessionAuthGuard.
@Module({
  imports: [UsersModule],
  controllers: [ReadinessController],
  providers: [ReadinessService],
})
export class ReadinessModule {}
