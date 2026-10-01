import {
  ContentType,
  IfDefined,
  RecipientIds,
  type SupportedContentType,
  TextContent,
  Title,
} from './create-message.dto.js';

// All optional. Only textContent can be cleared (null); status and ownership
// are not editable. Changing contentType never touches attached media.
// recipientIds, when present, replaces the whole assignment list.
export class UpdateMessageDto {
  @IfDefined()
  @Title()
  title?: string;

  @ContentType()
  contentType?: SupportedContentType;

  @TextContent()
  textContent?: string | null;

  @IfDefined()
  @RecipientIds()
  recipientIds?: string[];
}
