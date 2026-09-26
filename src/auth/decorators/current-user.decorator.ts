import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { SafeUser } from '../../users/users.service.js';

/** The user loaded by SessionAuthGuard. Only use on guarded routes. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): SafeUser =>
    ctx.switchToHttp().getRequest<Request>().user!,
);
