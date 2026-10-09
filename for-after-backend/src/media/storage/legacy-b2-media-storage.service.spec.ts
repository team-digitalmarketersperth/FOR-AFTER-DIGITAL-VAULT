import { S3ServiceException } from '@aws-sdk/client-s3';
import type { ConfigService } from '@nestjs/config';
import {
  LegacyB2MediaStorage,
  legacyB2Configured,
} from './legacy-b2-media-storage.service.js';

// Offline only: dummy credentials, presigning is local, send() is mocked.
const env: Record<string, string> = {
  OBJECT_STORAGE_REGION: 'us-east-005',
  OBJECT_STORAGE_BUCKET: 'test-bucket',
  OBJECT_STORAGE_ENDPOINT: 'https://s3.us-east-005.backblazeb2.com',
  OBJECT_STORAGE_ACCESS_KEY_ID: 'TESTKEYID',
  OBJECT_STORAGE_SECRET_ACCESS_KEY: 'test-secret-value',
};
const config = (overrides: Record<string, string | undefined> = {}) =>
  ({
    get: (key: string) => (key in overrides ? overrides[key] : env[key]),
  }) as ConfigService;
const make = (overrides: Record<string, string | undefined> = {}) =>
  new LegacyB2MediaStorage(config(overrides));

const s3Error = (name: string, status: number) =>
  new S3ServiceException({
    name,
    $fault: 'client',
    $metadata: { httpStatusCode: status },
    message: 'bucket test-bucket key users/x secret details',
  });

const mockSend = (storage: LegacyB2MediaStorage) =>
  vi.spyOn(
    (storage as unknown as { client: { send: () => unknown } }).client,
    'send',
  );

describe('LegacyB2MediaStorage (read/delete only)', () => {
  it('is optional: configured only when every bucket setting is present', () => {
    expect(legacyB2Configured(config())).toBe(true);
    expect(
      legacyB2Configured(config({ OBJECT_STORAGE_SECRET_ACCESS_KEY: '' })),
    ).toBe(false);
  });

  it('fails clearly (naming keys, never values) when built without config', () => {
    expect(() => make({ OBJECT_STORAGE_SECRET_ACCESS_KEY: '' })).toThrow(
      'Set OBJECT_STORAGE_SECRET_ACCESS_KEY in .env',
    );
    expect(() =>
      make({ OBJECT_STORAGE_REGION: 's3.us-east-005.backblazeb2.com' }),
    ).toThrow('not a hostname');
  });

  it('has no upload method: nothing new is ever stored on B2', () => {
    expect('createUploadUrl' in make()).toBe(false);
  });

  it('presigned GET uses the TTL and never contains the secret', async () => {
    const url = new URL(await make().createAccessUrl('users/u/a.jpg', 300));
    expect(url.pathname).toBe('/users/u/a.jpg');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('300');
    expect(url.href).not.toContain('test-secret-value');
  });

  it('deleteObject: 404 counts as deleted; other errors become a sanitized 503', async () => {
    const storage = make();
    const send = mockSend(storage);
    send.mockRejectedValueOnce(s3Error('NotFound', 404));
    await expect(storage.deleteObject('k')).resolves.toBeUndefined();
    send.mockRejectedValueOnce(s3Error('SignatureDoesNotMatch', 403));
    const err = await storage.deleteObject('k').catch((e: unknown) => e);
    expect(String((err as Error).message)).toBe(
      'Media storage is temporarily unavailable.',
    );
    expect(JSON.stringify(err)).not.toMatch(/Signature|bucket|secret|users/);
  });
});
