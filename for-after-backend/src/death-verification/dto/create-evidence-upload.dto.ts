import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsNotEmpty, IsString, MaxLength, Min } from 'class-validator';

// Phase 19A: the only evidence types (MIME → storage-key extension). Scoped to
// evidence: message, Memory Vault and other media allowlists are unchanged.
export const EVIDENCE_MIME_TYPES: Record<string, string> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
};

// Display name only (admins see it): control characters and any path part go,
// so a name like "../../x" or one with a newline can never mislead or inject.
const cleanFileName = ({ value }: { value: unknown }) =>
  typeof value === 'string'
    ? (value.split('').filter((c) => c >= ' ' && c !== '\x7f').join('').split(/[\\/]/).pop() ?? '').trim()
    : value;

// Only these fields: the case, report and account come from the route and the
// session, never the body (the global ValidationPipe rejects anything else).
export class CreateEvidenceUploadDto {
  @Transform(cleanFileName)
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  originalFileName: string;

  @IsIn(Object.keys(EVIDENCE_MIME_TYPES), {
    message: 'mimeType must be application/pdf, image/jpeg or image/png',
  })
  mimeType: string;

  // Expected size: the upload is capped at it, and complete checks it exactly.
  @IsInt()
  @Min(1)
  sizeBytes: number;
}
