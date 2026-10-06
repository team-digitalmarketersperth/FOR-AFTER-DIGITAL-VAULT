import {
  type ArgumentsHost,
  Catch,
  HttpException,
  type HttpServer,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import type { TracerService } from '@nestjs/observe';
import { errorCode } from '../prisma/prisma.service.js';

/**
 * Last error boundary for HTTP. Every HttpException (400–503, validation,
 * throttling, ownership 404s) and every 4xx http-error keeps Nest's own
 * response. Anything else becomes the same minimal 500 in every environment,
 * plus the Observe trace id when tracing is on, so support can find it.
 * Logged with the error class, a safe code and stack frames only: the message
 * can hold hosts, SQL or provider text, so it is never logged or returned.
 */
@Catch()
export class GlobalExceptionFilter extends BaseExceptionFilter {
  private readonly logger = new Logger('ExceptionsHandler');

  constructor(
    private readonly http: HttpServer,
    private readonly tracer: Pick<TracerService, 'currentTraceId'> | null,
  ) {
    super(http);
  }

  catch(exception: unknown, host: ArgumentsHost): void {
    if (
      exception instanceof HttpException ||
      // http-errors from body-parser (bad JSON 400, too large 413), as Nest
      // already recognises them.
      (this.isHttpError(exception) && exception.statusCode < 500) ||
      host.getType() !== 'http'
    ) {
      return super.catch(exception, host);
    }
    const traceId = this.tracer?.currentTraceId() ?? undefined;
    const name = exception instanceof Error ? exception.name : typeof exception;
    // Frames only: the first stack line repeats the message.
    const frames =
      exception instanceof Error
        ? (exception.stack ?? '')
            .split('\n')
            .filter((line) => line.trimStart().startsWith('at '))
            .join('\n')
        : undefined;
    this.logger.error(
      `unhandled_exception ${name} (code: ${errorCode(exception)})${traceId ? ` trace ${traceId}` : ''}`,
      frames,
    );
    const status = HttpStatus.INTERNAL_SERVER_ERROR;
    this.http.reply(
      host.switchToHttp().getResponse(),
      { statusCode: status, message: 'Internal server error', traceId },
      status,
    );
  }
}
