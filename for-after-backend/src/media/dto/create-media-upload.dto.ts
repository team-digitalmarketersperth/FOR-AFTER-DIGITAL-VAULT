import { Transform } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import { trim } from '../../auth/dto/register.dto.js';
import { MediaKind } from '../../generated/prisma/client.js';

// Explicit allowlist: MIME type → the only extension used in the storage key.
// No generic image/* or audio/*, and no SVG (it can carry script).
export const MIME_TYPES = {
  [MediaKind.PHOTO]: {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
  },
  [MediaKind.AUDIO]: {
    'audio/mpeg': 'mp3',
    'audio/mp4': 'm4a',
    'audio/webm': 'webm',
    'audio/wav': 'wav',
  },
} as const;
export type UploadKind = keyof typeof MIME_TYPES;

// Only these fields are accepted; the global ValidationPipe rejects anything
// else (ownerUserId, storageKey, status, ...). Kind/MIME pairing and the
// per-kind size limit (configurable) are checked in MediaService.
export class CreateMediaUploadDto {
  @IsIn(Object.keys(MIME_TYPES), {
    message: 'kind must be PHOTO or AUDIO (VIDEO is not available yet)',
  })
  kind: UploadKind;

  // Metadata only: never used in the storage key.
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  originalFileName: string;

  @IsIn(Object.values(MIME_TYPES).flatMap((types) => Object.keys(types)), {
    message: 'mimeType is not supported',
  })
  mimeType: string;

  // Expected size; the real size is checked with a HEAD request on complete.
  @IsInt()
  @Min(1)
  sizeBytes: number;
}
