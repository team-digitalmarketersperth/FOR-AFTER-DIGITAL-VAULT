import { MemoryVaultCategory } from '../../generated/prisma/client.js';
import {
  IfDefined,
  TextContent,
  Title,
} from '../../messages/dto/create-message.dto.js';
import { Category, Tags } from './create-memory-vault-item.dto.js';

// All optional. Missing = unchanged; only textContent can be cleared (null).
// tags present = the memory's whole tag set is replaced ([] removes all).
export class UpdateMemoryVaultItemDto {
  @IfDefined()
  @Title()
  title?: string;

  @IfDefined()
  @Category()
  category?: MemoryVaultCategory;

  @TextContent()
  textContent?: string | null;

  @Tags()
  tags?: string[];
}
