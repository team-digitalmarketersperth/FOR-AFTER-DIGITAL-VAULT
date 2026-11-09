import { Module } from '@nestjs/common';
import { UsersModule } from '../users/users.module.js';
import { AdminSupportController, SupportController } from './support.controller.js';
import { SupportService } from './support.service.js';

// Step 7 in-app support (docs/support.md). UsersModule backs SessionAuthGuard.
@Module({
  imports: [UsersModule],
  controllers: [SupportController, AdminSupportController],
  providers: [SupportService],
})
export class SupportModule {}
