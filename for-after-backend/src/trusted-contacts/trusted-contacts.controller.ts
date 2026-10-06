import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import type { Request } from 'express';
import { EmailTokenDto } from '../auth/dto/account-token.dto.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { CustomerGuard } from '../auth/guards/customer.guard.js';
import { SessionAuthGuard } from '../auth/guards/session-auth.guard.js';
import type { SafeUser } from '../users/users.service.js';
import { CreateTrustedContactDto } from './dto/create-trusted-contact.dto.js';
import { UpdateTrustedContactDto } from './dto/update-trusted-contact.dto.js';
import {
  type InvitationView,
  SEND_FAILED,
  TrustedContactInvitationsService,
} from './trusted-contact-invitations.service.js';
import {
  type TrustedContactResponse,
  TrustedContactsService,
} from './trusted-contacts.service.js';
import { AUTH } from '../config/swagger.js';

const meta = (req: Request) => ({
  ip: req.ip,
  userAgent: req.headers['user-agent'],
});

// The owner is always the session user; ownership is enforced in the service.
@ApiTags('Trusted Contacts')
@ApiCookieAuth(AUTH.customer)
@Controller('trusted-contacts')
@UseGuards(SessionAuthGuard, CustomerGuard)
export class TrustedContactsController {
  constructor(
    private readonly trustedContacts: TrustedContactsService,
    private readonly invitations: TrustedContactInvitationsService,
  ) {}

  // 409 once two active contacts exist (Phase 10). With an email, the
  // invitation is sent too; see `invitation.status` in the response.
  @Post()
  create(
    @CurrentUser() user: SafeUser,
    @Body() dto: CreateTrustedContactDto,
    @Req() req: Request,
  ): Promise<TrustedContactResponse> {
    return this.trustedContacts.create(user.id, dto, meta(req));
  }

  // Send or resend the email invitation (supersedes any pending link). At most
  // 3 per contact per hour (429). No email → 409; already accepted → 409.
  @Post(':id/invitation')
  @HttpCode(200)
  async invite(
    @CurrentUser() user: SafeUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
  ): Promise<TrustedContactResponse> {
    const sent = await this.invitations.send(user.id, id, meta(req));
    if (!sent) throw new ServiceUnavailableException(SEND_FAILED);
    return this.trustedContacts.findOwnedById(user.id, id);
  }

  @Get()
  findAll(@CurrentUser() user: SafeUser): Promise<TrustedContactResponse[]> {
    return this.trustedContacts.findAllForOwner(user.id);
  }

  @Get(':id')
  findOne(
    @CurrentUser() user: SafeUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<TrustedContactResponse> {
    return this.trustedContacts.findOwnedById(user.id, id);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: SafeUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTrustedContactDto,
  ): Promise<TrustedContactResponse> {
    return this.trustedContacts.update(user.id, id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  remove(
    @CurrentUser() user: SafeUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.trustedContacts.remove(user.id, id);
  }
}

/**
 * Phase 10: the invitation page. No session of any kind: the emailed token is
 * the only credential, and it can only view, accept or decline that one
 * invitation. Accepting signs no one in (Trusted Contacts sign in by email
 * OTP). POST with the token in the body, so it never lands in access logs.
 */
@ApiTags('Trusted Contact invitations')
@Controller('trusted-contact/invitation')
@UseGuards(ThrottlerGuard)
@Throttle({ default: { limit: 10, ttl: 60_000 } })
export class TrustedContactInvitationController {
  constructor(private readonly invitations: TrustedContactInvitationsService) {}

  @Post('view')
  @HttpCode(200)
  view(@Body() dto: EmailTokenDto): Promise<InvitationView> {
    return this.invitations.view(dto.token);
  }

  @Post('accept')
  @HttpCode(200)
  accept(
    @Body() dto: EmailTokenDto,
    @Req() req: Request,
  ): Promise<InvitationView> {
    return this.invitations.respond(dto.token, 'ACCEPTED', meta(req));
  }

  @Post('decline')
  @HttpCode(200)
  decline(
    @Body() dto: EmailTokenDto,
    @Req() req: Request,
  ): Promise<InvitationView> {
    return this.invitations.respond(dto.token, 'DECLINED', meta(req));
  }
}
