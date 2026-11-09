import { Module } from '@nestjs/common';
import { UsersModule } from '../users/users.module.js';
import { CommunicationPreferencesController, UnsubscribeController } from './communications.controller.js';
import { CommunicationsService } from './communications.service.js';

// Step 7: optional-email consent and unsubscribe. UsersModule backs SessionAuthGuard.
@Module({
  imports: [UsersModule],
  controllers: [CommunicationPreferencesController, UnsubscribeController],
  providers: [CommunicationsService],
})
export class CommunicationsModule {}
