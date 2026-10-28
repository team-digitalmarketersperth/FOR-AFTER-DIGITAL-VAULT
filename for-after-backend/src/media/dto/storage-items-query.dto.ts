import { IsEnum, IsIn, IsOptional } from 'class-validator';
import { PageQueryDto } from '../../admin/dto/admin.dto.js';
import { MediaKind } from '../../generated/prisma/client.js';
import {
  STORAGE_SOURCES,
  type StorageSource,
} from '../storage-quota.service.js';

export const STORAGE_SORTS = [
  'size_desc',
  'created_desc',
  'created_asc',
] as const;

// GET /users/me/storage/items?page=1&limit=25&type=PHOTO&source=MEMORY_VAULT&sort=size_desc
// (page/limit: the shared convention, max 100). Largest first by default.
export class StorageItemsQueryDto extends PageQueryDto {
  @IsOptional()
  @IsEnum(MediaKind, { message: 'type must be one of: PHOTO, AUDIO, VIDEO' })
  type?: MediaKind;

  @IsOptional()
  @IsIn(STORAGE_SOURCES, {
    message: `source must be one of: ${STORAGE_SOURCES.join(', ')}`,
  })
  source?: StorageSource;

  @IsOptional()
  @IsIn(STORAGE_SORTS, {
    message: `sort must be one of: ${STORAGE_SORTS.join(', ')}`,
  })
  sort: (typeof STORAGE_SORTS)[number] = 'size_desc';
}
