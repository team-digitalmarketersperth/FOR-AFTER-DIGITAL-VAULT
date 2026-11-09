import { Body, Controller, Get, HttpCode, Post, Put, Req, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { IsBoolean, IsString, Matches, MaxLength } from 'class-validator';
import type { Request } from 'express';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { CustomerGuard } from '../auth/guards/customer.guard.js';
import { SessionAuthGuard } from '../auth/guards/session-auth.guard.js';
import { AUTH } from '../config/swagger.js';
import { AuditActorType } from '../generated/prisma/client.js';
import type { SafeUser } from '../users/users.service.js';
import { CommunicationsService } from './communications.service.js';

export class ProductNewsDto {
  @IsBoolean()
  productNews: boolean;
}

export class UnsubscribeDto {
  @IsString()
  @MaxLength(512)
  @Matches(/^[\w-]+\.[\w-]+$/, { message: 'token is not valid' })
  token: string;
}

/** The signed-in Customer's own email preferences (optional product news only; service email is not optional). */
@ApiTags('Account')
@ApiCookieAuth(AUTH.customer)
@Controller('users/me/communication-preferences')
@UseGuards(SessionAuthGuard, CustomerGuard)
export class CommunicationPreferencesController {
  constructor(private readonly communications: CommunicationsService) {}

  @Get()
  get(@CurrentUser() user: SafeUser) {
    return this.communications.preferences(user.id);
  }

  @Put()
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  set(@CurrentUser() user: SafeUser, @Body() dto: ProductNewsDto, @Req() req: Request) {
    return this.communications.setProductNews(user.id, dto.productNews, {
      type: AuditActorType.CUSTOMER,
      userId: user.id,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
  }
}

/** Public: the link in every announcement email. POST only, so link scanners opening the page change nothing. */
@ApiTags('Account')
@Controller('communications')
export class UnsubscribeController {
  constructor(private readonly communications: CommunicationsService) {}

  @Post('unsubscribe')
  @HttpCode(200)
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  unsubscribe(@Body() dto: UnsubscribeDto) {
    return this.communications.unsubscribe(dto.token);
  }
}
