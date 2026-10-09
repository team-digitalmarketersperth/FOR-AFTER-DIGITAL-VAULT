import { IsInt, Max, Min } from 'class-validator';

// The version the Customer was shown; only the current one is accepted.
// Nothing else (user id, time, text) is ever taken from the client.
export class AcknowledgeDisclaimerDto {
  @IsInt()
  @Min(1)
  @Max(1_000_000)
  version: number;
}
