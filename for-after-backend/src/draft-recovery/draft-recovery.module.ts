import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Module,
  Param,
  ParseEnumPipe,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { IsObject, IsString, MaxLength } from 'class-validator';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { CustomerGuard } from '../auth/guards/customer.guard.js';
import { SessionAuthGuard } from '../auth/guards/session-auth.guard.js';
import { AUTH } from '../config/swagger.js';
import { DraftRecoveryType } from '../generated/prisma/client.js';
import { UsersModule } from '../users/users.module.js';
import type { SafeUser } from '../users/users.service.js';
import { DraftRecoveryService } from './draft-recovery.service.js';

class NewDraftDto {
  // Checked per type by the service (text fields only).
  @IsObject()
  payload: Record<string, unknown>;
}

class PutDraftDto extends NewDraftDto {
  @IsString()
  @MaxLength(40)
  baseRevision: string;
}

const Type = () => new ParseEnumPipe(DraftRecoveryType);
// A message id, an issued new-message key, or a prompt key: never free-form.
class KeyPipe {
  transform(key: string) {
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(key)) throw new BadRequestException('key is not valid');
    return key;
  }
}

// ponytail: per-IP limit shared by all of a Customer's editors; autosave runs at most every ~2.5 s.
const AUTOSAVE_LIMIT = { default: { limit: 120, ttl: 60_000 } };

/**
 * Autosave and recovery for the signed-in Customer's own unsaved edits.
 * GET returns null when there is nothing to recover. Not a version, not the
 * saved item: the explicit Save does that (and clears the draft).
 */
@ApiTags('Users')
@ApiCookieAuth(AUTH.customer)
@Controller('users/me/drafts')
@UseGuards(SessionAuthGuard, CustomerGuard)
export class DraftRecoveryController {
  constructor(private readonly drafts: DraftRecoveryService) {}

  @Get('NEW_MESSAGE')
  latestNewMessage(@CurrentUser() user: SafeUser) {
    return this.drafts.latestNewMessage(user.id);
  }

  @Post('NEW_MESSAGE')
  @UseGuards(ThrottlerGuard)
  @Throttle(AUTOSAVE_LIMIT)
  createNewMessage(@CurrentUser() user: SafeUser, @Body() dto: NewDraftDto) {
    return this.drafts.createNewMessage(user.id, dto.payload);
  }

  @Get(':type/:key')
  get(
    @CurrentUser() user: SafeUser,
    @Param('type', Type()) type: DraftRecoveryType,
    @Param('key', KeyPipe) key: string,
  ) {
    return this.drafts.get(user.id, type, key);
  }

  @Put(':type/:key')
  @UseGuards(ThrottlerGuard)
  @Throttle(AUTOSAVE_LIMIT)
  put(
    @CurrentUser() user: SafeUser,
    @Param('type', Type()) type: DraftRecoveryType,
    @Param('key', KeyPipe) key: string,
    @Body() dto: PutDraftDto,
  ) {
    return this.drafts.put(user.id, type, key, dto.payload, dto.baseRevision);
  }

  @Delete(':type/:key')
  @HttpCode(204)
  discard(
    @CurrentUser() user: SafeUser,
    @Param('type', Type()) type: DraftRecoveryType,
    @Param('key', KeyPipe) key: string,
  ) {
    return this.drafts.discard(user.id, type, key);
  }
}

// UsersModule backs SessionAuthGuard.
@Module({
  imports: [UsersModule],
  controllers: [DraftRecoveryController],
  providers: [DraftRecoveryService],
})
export class DraftRecoveryModule {}
