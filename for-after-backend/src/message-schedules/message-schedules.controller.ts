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
import { CreateMessageScheduleDto } from './dto/create-message-schedule.dto.js';
import { UpdateMessageScheduleDto } from './dto/update-message-schedule.dto.js';
import {
  MessageSchedulesService,
  type ScheduleResponse,
} from './message-schedules.service.js';

// One schedule per message. Ownership is enforced through the Message in the service.
@Controller('messages/:messageId/schedule')
@UseGuards(SessionAuthGuard, CustomerGuard)
export class MessageSchedulesController {
  constructor(private readonly schedules: MessageSchedulesService) {}

  @Post()
  create(
    @CurrentUser() user: SafeUser,
    @Param('messageId', ParseUUIDPipe) messageId: string,
    @Body() dto: CreateMessageScheduleDto,
  ): Promise<ScheduleResponse> {
    return this.schedules.create(user.id, messageId, dto);
  }

  @Get()
  findOne(
    @CurrentUser() user: SafeUser,
    @Param('messageId', ParseUUIDPipe) messageId: string,
  ): Promise<ScheduleResponse> {
    return this.schedules.findForMessage(user.id, messageId);
  }

  @Patch()
  update(
    @CurrentUser() user: SafeUser,
    @Param('messageId', ParseUUIDPipe) messageId: string,
    @Body() dto: UpdateMessageScheduleDto,
  ): Promise<ScheduleResponse> {
    return this.schedules.update(user.id, messageId, dto);
  }

  @Delete()
  @HttpCode(204)
  remove(
    @CurrentUser() user: SafeUser,
    @Param('messageId', ParseUUIDPipe) messageId: string,
  ): Promise<void> {
    return this.schedules.remove(user.id, messageId);
  }
}
