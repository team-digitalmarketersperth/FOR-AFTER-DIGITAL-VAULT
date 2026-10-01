import { IsEnum, IsOptional } from 'class-validator';
import { MemoryVaultCategory } from '../../generated/prisma/client.js';
import { TextContent, Title } from '../../messages/dto/create-message.dto.js';

export const Category = () =>
  IsEnum(MemoryVaultCategory, {
    message: `category must be one of: ${Object.values(MemoryVaultCategory).join(', ')}`,
  });

// Only these fields are accepted; the global ValidationPipe rejects anything
// else (ownerUserId, recipientIds, status, ...). Title and text follow the
// Message rules; blank text is stored as null.
export class CreateMemoryVaultItemDto {
  @Title()
  title: string;

  @Category()
  category: MemoryVaultCategory;

  @TextContent()
  textContent?: string | null;
}

// GET /memory-vault?category=FAMILY
export class MemoryVaultQueryDto {
  @IsOptional()
  @Category()
  category?: MemoryVaultCategory;
}
