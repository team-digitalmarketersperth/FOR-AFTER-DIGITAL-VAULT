import { Transform } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsString,
  Matches,
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
  // Phase 12: message media only (Memory Vault stays PHOTO/AUDIO). Formats a
  // browser <video> plays as uploaded; webm is what the browser records.
  [MediaKind.VIDEO]: {
    'video/mp4': 'mp4',
    'video/webm': 'webm',
  },
} as const;
export type UploadKind = keyof typeof MIME_TYPES;

// Only these fields are accepted; the global ValidationPipe rejects anything
// else (ownerUserId, storageKey, status, ...). Kind/MIME pairing and the
// per-kind size limit (configurable) are checked in MediaService.
export class CreateMediaUploadDto {
  @IsIn(Object.keys(MIME_TYPES), {
    message: 'kind must be PHOTO, AUDIO or VIDEO',
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

  // Expected size: the upload is capped at it, and complete checks it exactly.
  @IsInt()
  @Min(1)
  sizeBytes: number;
}

// complete: the id ImageKit returned to the browser. Only a lookup hint: the
// file it names must sit at this asset's own server-chosen path.
export class CompleteMediaUploadDto {
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{1,100}$/, {
    message: 'providerFileId is not valid',
  })
  providerFileId: string;
}
