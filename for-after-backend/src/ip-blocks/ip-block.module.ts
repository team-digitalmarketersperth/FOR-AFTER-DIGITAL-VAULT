import { type MiddlewareConsumer, Module, type NestModule, RequestMethod } from '@nestjs/common';
import { IpBlockMiddleware } from './ip-block.middleware.js';
import { IpBlockService } from './ip-block.service.js';

/** API only: the worker serves no HTTP, so it neither loads nor polls blocks. */
@Module({ providers: [IpBlockService], exports: [IpBlockService] })
export class IpBlockModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(IpBlockMiddleware).forRoutes({ path: '{*splat}', method: RequestMethod.ALL });
  }
}
