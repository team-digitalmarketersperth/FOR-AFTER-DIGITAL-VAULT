import { OmitType } from '@nestjs/swagger';
import { IfDefined } from '../../messages/dto/create-message.dto.js';
import {
  CreateMessageScheduleDto,
  SupportedTrigger,
} from './create-message-schedule.dto.js';

// Partial input; the service merges it with the stored schedule and validates
// the result as a whole. Changing triggerType drops fields the new type does
// not use unless they are sent again.
export class UpdateMessageScheduleDto extends OmitType(
  CreateMessageScheduleDto,
  ['triggerType'] as const,
) {
  @IfDefined()
  @SupportedTrigger()
  triggerType?: SupportedTrigger;
}
