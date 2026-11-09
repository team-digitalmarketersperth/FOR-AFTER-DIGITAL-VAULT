import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateEvidenceUploadDto } from './create-evidence-upload.dto.js';

const body = { originalFileName: 'certificate.pdf', mimeType: 'application/pdf', sizeBytes: 1000 };
const check = async (patch: object) => {
  const dto = plainToInstance(CreateEvidenceUploadDto, { ...body, ...patch });
  const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
  return { dto, fields: errors.map((e) => e.property) };
};

describe('CreateEvidenceUploadDto (Phase 19A)', () => {
  it.each(['application/pdf', 'image/jpeg', 'image/png'])('accepts %s', async (mimeType) => {
    expect((await check({ mimeType })).fields).toEqual([]);
  });

  it.each([
    ['mimeType', { mimeType: 'image/webp' }],
    ['mimeType', { mimeType: 'image/svg+xml' }],
    ['mimeType', { mimeType: 'text/html' }],
    ['mimeType', { mimeType: 'application/zip' }],
    ['mimeType', { mimeType: 'application/msword' }],
    ['mimeType', { mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }],
    ['mimeType', { mimeType: 'application/x-msdownload' }],
    ['mimeType', { mimeType: 'video/mp4' }],
    ['sizeBytes', { sizeBytes: 0 }],
    ['sizeBytes', { sizeBytes: 1.5 }],
    ['originalFileName', { originalFileName: '   ' }],
    ['originalFileName', { originalFileName: 'x'.repeat(256) }],
    // Everything else is derived on the server, never taken from the body.
    ['caseId', { caseId: '00000000-0000-4000-8000-000000000000' }],
    ['deathReportId', { deathReportId: '00000000-0000-4000-8000-000000000000' }],
    ['ownerUserId', { ownerUserId: '00000000-0000-4000-8000-000000000000' }],
    ['trustedContactId', { trustedContactId: '00000000-0000-4000-8000-000000000000' }],
    ['storageKey', { storageKey: '/for-after/users/x/evil.pdf' }],
    ['status', { status: 'READY' }],
  ])('rejects %s in %o', async (field, patch) => {
    expect((await check(patch)).fields).toContain(field);
  });

  it('keeps only a clean display name: no path parts or control characters', async () => {
    expect((await check({ originalFileName: '../../etc/pass\nwd.pdf' })).dto.originalFileName).toBe('passwd.pdf');
    expect((await check({ originalFileName: 'C:\\Users\\x\\Death cert.pdf' })).dto.originalFileName).toBe('Death cert.pdf');
    expect((await check({ originalFileName: 'a/b/' })).fields).toContain('originalFileName');
  });
});
