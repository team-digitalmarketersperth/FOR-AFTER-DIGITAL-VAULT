import {
  BadRequestError,
  InternalServerError,
  NotFoundError,
} from '@imagekit/nodejs';
import { Logger, ServiceUnavailableException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { createHmac } from 'node:crypto';
import {
  IMAGEKIT_UPLOAD_URL,
  ImageKitMediaStorage,
  signUploadToken,
} from './imagekit-media-storage.service.js';

// Offline only: dummy keys; every SDK call is replaced by a stub, so no
// request ever reaches ImageKit.
const PRIVATE_KEY = 'private_test_key_value';
const env: Record<string, string> = {
  IMAGEKIT_PUBLIC_KEY: 'public_test_key',
  IMAGEKIT_PRIVATE_KEY: PRIVATE_KEY,
  IMAGEKIT_URL_ENDPOINT: 'https://ik.imagekit.io/test-account',
};
const KEY = '/for-after/users/u1/messages/m1/photo/a1.jpg';
const ref = (over: object = {}) => ({
  storageKey: KEY,
  storageProvider: 'IMAGEKIT' as const,
  providerFileId: 'file1',
  ...over,
});

const make = (overrides: Record<string, string | undefined> = {}) => {
  const storage = new ImageKitMediaStorage({
    get: (key: string) => (key in overrides ? overrides[key] : env[key]),
  } as ConfigService);
  const client = (storage as unknown as { client: Record<string, object> })
    .client;
  const files = { get: vi.fn(), delete: vi.fn().mockResolvedValue(undefined) };
  const assets = { list: vi.fn().mockResolvedValue([]) };
  client.files = files;
  client.assets = assets;
  return { storage, files, assets };
};

const notFound = () =>
  new NotFoundError(404, {}, 'file x not found', new Headers());
const decode = (part: string) =>
  JSON.parse(Buffer.from(part, 'base64url').toString()) as Record<
    string,
    unknown
  >;

describe('ImageKitMediaStorage', () => {
  let error: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    error = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it('fails clearly (naming keys, never values) when config is missing', () => {
    expect(() => make({ IMAGEKIT_PRIVATE_KEY: '' })).toThrow(
      'Set IMAGEKIT_PRIVATE_KEY in .env',
    );
  });

  it('upload: a V2 JWT (HS256, kid = public key) fixing path, privacy, no overwrite and size', async () => {
    const { storage } = make();
    const target = await storage.createUpload(KEY, 'image/jpeg', 12_345, 600);
    expect(target.url).toBe(IMAGEKIT_UPLOAD_URL);
    const { token, ...fields } = target.fields;
    expect(fields).toEqual({
      fileName: 'a1.jpg',
      folder: '/for-after/users/u1/messages/m1/photo/',
      isPrivateFile: 'true',
      useUniqueFileName: 'false',
      overwriteFile: 'false',
      checks: '"file.size" <= 12345',
    });
    const [header, payload, signature] = token.split('.');
    expect(decode(header)).toEqual({
      alg: 'HS256',
      typ: 'JWT',
      kid: 'public_test_key',
    });
    const body = decode(payload);
    // Every form field is in the signed payload, so none can be changed.
    expect(body).toMatchObject(fields);
    expect(body.exp).toBe((body.iat as number) + 600);
    expect(signature).toBe(
      createHmac('sha256', PRIVATE_KEY)
        .update(`${header}.${payload}`)
        .digest('base64url'),
    );
    expect(JSON.stringify(target)).not.toContain(PRIVATE_KEY);
  });

  it('upload token lifetime is capped at ImageKit’s one hour', () => {
    const token = signUploadToken({}, 'pk', 'sk', 7200, 1_000_000);
    const body = decode(token.split('.')[1]);
    expect(body).toEqual({ iat: 1000, exp: 4600 });
  });

  it('verify: the file must sit at exactly this key; otherwise null (never someone else’s)', async () => {
    const { storage, files } = make();
    files.get.mockResolvedValueOnce({
      fileId: 'file1',
      filePath: KEY,
      size: 42,
      mime: 'image/jpeg',
      isPrivateFile: true,
    });
    expect(await storage.verifyUpload(KEY, 'file1')).toEqual({
      sizeBytes: 42,
      contentType: 'image/jpeg',
      isPrivate: true,
      providerFileId: 'file1',
    });
    files.get.mockResolvedValueOnce({
      fileId: 'file2',
      filePath: '/for-after/users/u2/x.jpg',
    });
    expect(await storage.verifyUpload(KEY, 'file2')).toBeNull();
    files.get.mockRejectedValueOnce(notFound());
    expect(await storage.verifyUpload(KEY, 'gone')).toBeNull();
    files.get.mockRejectedValueOnce(
      new BadRequestError(400, {}, 'bad id', new Headers()),
    );
    expect(await storage.verifyUpload(KEY, 'bad')).toBeNull();
  });

  it('provider errors become a generic 503; the log has only the error class and status', async () => {
    const { storage, files } = make();
    files.get.mockRejectedValueOnce(
      new InternalServerError(
        500,
        { message: `path ${KEY}` },
        `key ${PRIVATE_KEY}`,
        new Headers(),
      ),
    );
    const err = await storage
      .verifyUpload(KEY, 'file1')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect(
      JSON.stringify((err as ServiceUnavailableException).getResponse()),
    ).not.toMatch(/for-after|private|InternalServer/);
    const logged = error.mock.calls.flat().join(' ');
    expect(logged).toContain('InternalServerError, HTTP 500');
    expect(logged).not.toMatch(/for-after|private_test/);
  });

  it('access: a signed, expiring URL of the private original (orig-true)', async () => {
    const { storage } = make();
    const url = new URL(await storage.createAccessUrl(ref(), 300));
    expect(url.origin + url.pathname).toMatch(
      /^https:\/\/ik\.imagekit\.io\/test-account\/.*orig-true.*a1\.jpg$|^https:\/\/ik\.imagekit\.io\/test-account\/for-after\/.*a1\.jpg$/,
    );
    expect(url.href).toContain('orig-true');
    expect(url.searchParams.get('ik-s')).toMatch(/^[0-9a-f]{40}$/);
    const expires = Number(url.searchParams.get('ik-t'));
    expect(expires - Date.now() / 1000).toBeGreaterThan(290);
    expect(expires - Date.now() / 1000).toBeLessThanOrEqual(301);
    expect(url.href).not.toContain(PRIVATE_KEY);
  });

  it('legacy B2 rows: served by the legacy adapter, or a 503 when it is not configured', async () => {
    const { storage } = make();
    await expect(
      storage.createAccessUrl(
        ref({ storageProvider: 'B2', storageKey: 'users/u/a.jpg' }),
        300,
      ),
    ).rejects.toThrow(ServiceUnavailableException);
    await expect(
      storage.deleteObject(
        ref({ storageProvider: 'B2', storageKey: 'users/u/a.jpg' }),
      ),
    ).rejects.toThrow(ServiceUnavailableException);
  });

  it('delete: by file id; already gone succeeds', async () => {
    const { storage, files } = make();
    await storage.deleteObject(ref());
    expect(files.delete).toHaveBeenCalledWith('file1');
    files.delete.mockRejectedValueOnce(notFound());
    await expect(storage.deleteObject(ref())).resolves.toBeUndefined();
  });

  it('delete without a file id finds the file at its own path, or deletes nothing', async () => {
    const { storage, files, assets } = make();
    assets.list.mockResolvedValueOnce([
      {
        fileId: 'other',
        filePath: '/for-after/users/u1/messages/m1/photo/b2.jpg',
      },
      { fileId: 'mine', filePath: KEY },
    ]);
    await storage.deleteObject(ref({ providerFileId: null }));
    expect(assets.list).toHaveBeenCalledWith({
      path: '/for-after/users/u1/messages/m1/photo',
      type: 'file',
    });
    expect(files.delete).toHaveBeenCalledWith('mine');
    files.delete.mockClear();
    await storage.deleteObject(ref({ providerFileId: null }));
    expect(files.delete).not.toHaveBeenCalled();
  });

  it('readStart reads only the first bytes through a short signed URL', async () => {
    const { storage } = make();
    const cancel = vi.fn();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      body: {
        getReader: () => ({
          read: async () => ({ value: new Uint8Array([1, 2, 3, 4, 5]) }),
          cancel,
        }),
      },
    } as unknown as Response);
    expect(await storage.readStart(ref(), 3)).toEqual(
      new Uint8Array([1, 2, 3]),
    );
    const [url, init] = fetchMock.mock.calls[0];
    expect(url as string).toContain('ik-s=');
    expect(init).toEqual({ headers: { Range: 'bytes=0-2' } });
    expect(cancel).toHaveBeenCalled();
  });
});
