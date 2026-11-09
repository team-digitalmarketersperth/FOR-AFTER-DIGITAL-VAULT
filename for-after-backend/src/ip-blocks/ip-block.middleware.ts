import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { IpBlockService } from './ip-block.service.js';

// Load balancer health checks and the signature-verified Stripe webhook keep their own
// controls. Exact routes only; case-insensitive because Express routing is.
const EXEMPT = /^\/health(\/|$)|^\/api\/v1\/webhooks\/stripe\/?$/i;

@Injectable()
export class IpBlockMiddleware implements NestMiddleware {
  constructor(private readonly blocks: IpBlockService) {}

  use(req: Request, res: Response, next: NextFunction) {
    if (EXEMPT.test(req.originalUrl.split('?', 1)[0]!) || !this.blocks.isBlocked(req.ip)) return next();
    res.status(403).json({ statusCode: 403, message: 'Access from this network is temporarily unavailable.' });
  }
}
