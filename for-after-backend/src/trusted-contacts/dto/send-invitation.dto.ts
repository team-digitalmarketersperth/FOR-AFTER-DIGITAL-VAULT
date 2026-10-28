import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import type { InvitationChannel } from '../trusted-contact-invitations.service.js';

// Omitted → EMAIL (the original behaviour). No address field: the destination
// is always the contact's stored email or mobile, never one from the request.
export class SendInvitationDto {
  @ApiPropertyOptional({ enum: ['EMAIL', 'SMS'], default: 'EMAIL' })
  @IsOptional()
  @IsIn(['EMAIL', 'SMS'])
  channel?: InvitationChannel;
}
