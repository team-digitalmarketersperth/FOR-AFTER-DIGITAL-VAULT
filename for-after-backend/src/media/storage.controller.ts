import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { CustomerGuard } from '../auth/guards/customer.guard.js';
import { SessionAuthGuard } from '../auth/guards/session-auth.guard.js';
import { AUTH } from '../config/swagger.js';
import type { SafeUser } from '../users/users.service.js';
import { StorageQuota, type StorageUsage } from './storage-quota.service.js';

// Phase 12C: the signed-in Customer's own storage use; never anyone else's.
@ApiTags('Media')
@ApiCookieAuth(AUTH.customer)
@Controller('users/me/storage')
@UseGuards(SessionAuthGuard, CustomerGuard)
export class StorageController {
  constructor(private readonly quota: StorageQuota) {}

  @Get()
  usage(@CurrentUser() user: SafeUser): Promise<StorageUsage> {
    return this.quota.usage(user.id);
  }
}
