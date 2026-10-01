import { S3ServiceException } from '@aws-sdk/client-s3';
import { ServiceUnavailableException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { S3MediaStorage } from './s3-media-storage.service.js';

// Offline only: dummy credentials, presigning is local, send() is mocked.
const env: Record<string, string> = {
  OBJECT_STORAGE_REGION: 'us-east-005',
  OBJECT_STORAGE_BUCKET: 'test-bucket',
  OBJECT_STORAGE_ENDPOINT: 'https://s3.us-east-005.backblazeb2.com',
  OBJECT_STORAGE_ACCESS_KEY_ID: 'TESTKEYID',
  OBJECT_STORAGE_SECRET_ACCESS_KEY: 'test-secret-value',
};
const make = (overrides: Record<string, string | undefined> = {}) =>
  new S3MediaStorage({
    get: (key: string) => (key in overrides ? overrides[key] : env[key]),
  } as ConfigService);

const s3Error = (name: string, status: number) =>
  new S3ServiceException({
    name,
    $fault: 'client',
    $metadata: { httpStatusCode: status },
    message: 'bucket test-bucket key users/x secret details',
  });

const mockSend = (storage: S3MediaStorage) =>
  vi.spyOn(
    (storage as unknown as { client: { send: () => unknown } }).client,
    'send',
  );

describe('S3MediaStorage', () => {
  it('fails clearly (naming keys, never values) when config is missing', () => {
    expect(() => make({ OBJECT_STORAGE_SECRET_ACCESS_KEY: '' })).toThrow(
      'Set OBJECT_STORAGE_SECRET_ACCESS_KEY in .env',
    );
    expect(() =>
      make({ OBJECT_STORAGE_REGION: 's3.us-east-005.backblazeb2.com' }),
    ).toThrow('not a hostname');
  });

  it('presigned PUT signs Content-Type, uses the TTL and never contains the secret', async () => {
    const url = new URL(
      await make().createUploadUrl('users/u/a.jpg', 'image/jpeg', 600),
    );
    expect(url.pathname).toBe('/users/u/a.jpg');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('600');
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe(
      'content-type;host',
    );
    expect(url.href).not.toContain('test-secret-value');
  });

  it('presigned GET uses its own TTL', async () => {
    const url = new URL(await make().createAccessUrl('users/u/a.jpg', 300));
    expect(url.searchParams.get('X-Amz-Expires')).toBe('300');
  });

  it('headObject maps metadata, 404 → null, other errors → sanitized 503', async () => {
    const storage = make();
    const send = mockSend(storage);
    send.mockResolvedValueOnce({ ContentLength: 42, ContentType: 'image/png' });
    expect(await storage.headObject('k')).toEqual({
      sizeBytes: 42,
      contentType: 'image/png',
    });
    send.mockRejectedValueOnce(s3Error('NotFound', 404));
    expect(await storage.headObject('k')).toBeNull();
    send.mockRejectedValueOnce(s3Error('AccessDenied', 403));
    const err = await storage.headObject('k').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect(
      JSON.stringify((err as ServiceUnavailableException).getResponse()),
    ).not.toMatch(/AccessDenied|bucket|secret|users/);
  });

  it('deleteObject errors become a sanitized 503', async () => {
    const storage = make();
    mockSend(storage).mockRejectedValueOnce(
      s3Error('SignatureDoesNotMatch', 403),
    );
    await expect(storage.deleteObject('k')).rejects.toThrow(
      'Media storage is temporarily unavailable.',
    );
  });
});
