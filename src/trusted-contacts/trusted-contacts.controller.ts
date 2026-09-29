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
import { CreateTrustedContactDto } from './dto/create-trusted-contact.dto.js';
import { UpdateTrustedContactDto } from './dto/update-trusted-contact.dto.js';
import {
  type TrustedContactResponse,
  TrustedContactsService,
} from './trusted-contacts.service.js';

// The owner is always the session user; ownership is enforced in the service.
@Controller('trusted-contacts')
@UseGuards(SessionAuthGuard, CustomerGuard)
export class TrustedContactsController {
  constructor(private readonly trustedContacts: TrustedContactsService) {}

  @Post()
  create(
    @CurrentUser() user: SafeUser,
    @Body() dto: CreateTrustedContactDto,
  ): Promise<TrustedContactResponse> {
    return this.trustedContacts.create(user.id, dto);
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
