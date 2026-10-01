import { Module } from '@nestjs/common';
import { DeathVerificationModule } from '../death-verification/death-verification.module.js';
import { TrustedContactAuthModule } from '../trusted-contact-auth/trusted-contact-auth.module.js';
import { TrustedContactPortalController } from './trusted-contact-portal.controller.js';
import { TrustedContactPortalService } from './trusted-contact-portal.service.js';

@Module({
  // TrustedContactAuthModule provides the Trusted Contact guard.
  imports: [TrustedContactAuthModule, DeathVerificationModule],
  controllers: [TrustedContactPortalController],
  providers: [TrustedContactPortalService],
})
export class TrustedContactPortalModule {}
