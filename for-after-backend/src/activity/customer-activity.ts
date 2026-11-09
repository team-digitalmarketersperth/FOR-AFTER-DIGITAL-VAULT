import { Logger } from '@nestjs/common';
import type { CustomerActivityType, Prisma } from '../generated/prisma/client.js';
import type { PrismaService } from '../prisma/prisma.service.js';

export type ActivityInput = {
  userId: string;
  type: CustomerActivityType;
  /** The item's id (a prompt key for My Story / My Wishes). Never content. */
  entityId?: string | null;
};

const logger = new Logger('CustomerActivity');

/**
 * Records one "Recent changes" row. Inside the caller's transaction it is
 * atomic with the change it describes (written after the change succeeded, in
 * the same transaction), like writeAuditLog.
 */
export const recordActivity = (db: Prisma.TransactionClient | PrismaService, input: ActivityInput) =>
  db.customerActivity.create({ data: { ...input, entityId: input.entityId ?? null } });

/**
 * For a change already committed outside a transaction: record it, best
 * effort. A history row that fails to write never fails (or repeats) the
 * Customer's change; the failure is logged by type only.
 */
export async function noteActivity(prisma: PrismaService, input: ActivityInput) {
  try {
    await recordActivity(prisma, input);
  } catch {
    logger.warn(`customer_activity_not_recorded ${input.type}`);
  }
}
