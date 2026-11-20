/**
 * Every PostgreSQL table holding stored media files (Prisma delegate names).
 * They share the stored-file columns (storageKey, storageProvider,
 * providerFileId, status, deletedAt, storageDeletedAt, createdAt, updatedAt),
 * so cleanup and the reconciliation report treat them alike. Neutral module:
 * no service imports, so a script can use it without the Nest graph.
 */
export const MEDIA_TABLES = [
  'mediaAsset',
  'memoryVaultMediaAsset',
  'recipientPhoto',
  'myStoryMediaAsset',
  'myWishMediaAsset',
  'deathVerificationEvidence',
] as const;
export type MediaTable = (typeof MEDIA_TABLES)[number];
