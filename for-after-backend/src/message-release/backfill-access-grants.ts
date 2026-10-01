import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { MessageStatus } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { createAccessGrants } from './message-release.service.js';

/**
 * Explicit, idempotent backfill for releases made before Step 13 (no access
 * grants yet). Dry run unless `apply`. Limitation: contact details were not
 * snapshotted at the time, so grants use the Recipients' CURRENT email/mobile
 * and only still-live assignments. Never run automatically
 * (docs/recipient-portal.md). Logs ids and counts only.
 */
export async function backfillAccessGrants(
  prisma: PrismaService,
  apply: boolean,
  logger = new Logger('AccessGrantBackfill'),
): Promise<{ releases: number; created: number }> {
  const releases = await prisma.messageRelease.findMany({
    where: {
      accessGrants: { none: {} },
      message: { status: MessageStatus.RELEASED, deletedAt: null },
    },
    select: { id: true, messageId: true },
    orderBy: { releasedAt: 'asc' },
  });
  let created = 0;
  for (const release of releases) {
    const ctx = `release ${release.id} message ${release.messageId}`;
    if (!apply) {
      logger.log(`backfill_candidate ${ctx}`);
      continue;
    }
    const count = await prisma.$transaction((tx) =>
      createAccessGrants(tx, release),
    );
    created += count;
    logger.log(`backfill_grants_created ${ctx} count ${count}`);
  }
  logger.log(
    `backfill_${apply ? 'done' : 'dry_run'} releases ${releases.length} grants ${created}`,
  );
  return { releases: releases.length, created };
}

// npm run backfill:access-grants [-- --apply]   (after npm run build)
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  if (existsSync('.env')) process.loadEnvFile();
  const prisma = new PrismaService(new ConfigService());
  try {
    await backfillAccessGrants(prisma, process.argv.includes('--apply'));
  } finally {
    await prisma.$disconnect();
  }
}
