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
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { CustomerGuard } from '../auth/guards/customer.guard.js';
import { SessionAuthGuard } from '../auth/guards/session-auth.guard.js';
import type { SafeUser } from '../users/users.service.js';
import { CreateMessageDto } from './dto/create-message.dto.js';
import { UpdateMessageDto } from './dto/update-message.dto.js';
import { type MessageResponse, MessagesService } from './messages.service.js';
import { AUTH } from '../config/swagger.js';

// The owner is always the session user; ownership is enforced in the service.
@ApiTags('Messages')
@ApiCookieAuth(AUTH.customer)
@Controller('messages')
@UseGuards(SessionAuthGuard, CustomerGuard)
export class MessagesController {
  constructor(private readonly messages: MessagesService) {}

  @Post()
  create(
    @CurrentUser() user: SafeUser,
    @Body() dto: CreateMessageDto,
  ): Promise<MessageResponse> {
    return this.messages.create(user.id, dto);
  }

  @Get()
  findAll(@CurrentUser() user: SafeUser): Promise<MessageResponse[]> {
    return this.messages.findAllForOwner(user.id);
  }

  @Get(':id')
  findOne(
    @CurrentUser() user: SafeUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<MessageResponse> {
    return this.messages.findOwnedById(user.id, id);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: SafeUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateMessageDto,
  ): Promise<MessageResponse> {
    return this.messages.update(user.id, id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  remove(
    @CurrentUser() user: SafeUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.messages.remove(user.id, id);
  }
}
