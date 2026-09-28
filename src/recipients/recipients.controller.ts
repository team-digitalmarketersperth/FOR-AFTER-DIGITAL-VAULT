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
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { CustomerGuard } from '../auth/guards/customer.guard.js';
import { SessionAuthGuard } from '../auth/guards/session-auth.guard.js';
import type { SafeUser } from '../users/users.service.js';
import { CreateRecipientDto } from './dto/create-recipient.dto.js';
import { UpdateRecipientDto } from './dto/update-recipient.dto.js';
import {
  type RecipientResponse,
  RecipientsService,
} from './recipients.service.js';

// The owner is always the session user; ownership is enforced in the service.
@Controller('recipients')
@UseGuards(SessionAuthGuard, CustomerGuard)
export class RecipientsController {
  constructor(private readonly recipients: RecipientsService) {}

  @Post()
  create(
    @CurrentUser() user: SafeUser,
    @Body() dto: CreateRecipientDto,
  ): Promise<RecipientResponse> {
    return this.recipients.create(user.id, dto);
  }

  @Get()
  findAll(@CurrentUser() user: SafeUser): Promise<RecipientResponse[]> {
    return this.recipients.findAllForOwner(user.id);
  }

  @Get(':id')
  findOne(
    @CurrentUser() user: SafeUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<RecipientResponse> {
    return this.recipients.findOwnedById(user.id, id);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: SafeUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateRecipientDto,
  ): Promise<RecipientResponse> {
    return this.recipients.update(user.id, id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  remove(
    @CurrentUser() user: SafeUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.recipients.remove(user.id, id);
  }
}
