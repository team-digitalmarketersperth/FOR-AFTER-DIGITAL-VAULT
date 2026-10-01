import { MemoryVaultCategory } from '../../generated/prisma/client.js';
import {
  IfDefined,
  TextContent,
  Title,
} from '../../messages/dto/create-message.dto.js';
import { Category } from './create-memory-vault-item.dto.js';

// All optional. Missing = unchanged; only textContent can be cleared (null).
export class UpdateMemoryVaultItemDto {
  @IfDefined()
  @Title()
  title?: string;

  @IfDefined()
  @Category()
  category?: MemoryVaultCategory;

  @TextContent()
  textContent?: string | null;
}
