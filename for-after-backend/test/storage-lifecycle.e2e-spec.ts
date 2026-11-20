import { ConfigModule } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import session from 'express-session';
import request from 'supertest';
import { AuthModule } from '../src/auth/auth.module.js';
import { configureApp } from '../src/config/app.setup.js';
import { MediaCleanup, UPLOAD_EXPIRED } from '../src/media/media-cleanup.service.js';
import { MalwareScanner } from '../src/media/scanner/malware-scanner.service.js';
import type { StoredRef } from '../src/media/storage/media-storage.service.js';
import { MediaStorage } from '../src/media/storage/media-storage.service.js';
import { PrismaModule } from '../src/prisma/prisma.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { RecipientsModule } from '../src/recipients/recipients.module.js';
import { FakeMalwareScanner } from './fake-malware-scanner.js';
import { FakeMediaStorage } from './fake-media-storage.js';

/**
 * Like ImageKit: a delete with a file id removes that one file; without one,
 * whatever is at the path (the list lookup). The shared fake deletes by path
 * either way, which would hide a re-upload made with an old token.
 */
class ImageKitLikeStorage extends FakeMediaStorage {
  override deleteObject = vi.fn(async (ref: StoredRef) => {
    if (ref.providerFileId) {
      this.files.delete(ref.providerFileId);
      return;
    }
    for (const [id, file] of this.files) {
      if (file.key === ref.storageKey) this.files.delete(id);
    }
  });
}

// Storage lifecycle (2026-11-10): token reuse after a delete/failure, cleanup
// retries, scan lease vs retirement, quota reservations under concurrency and
// transaction rollback. Real PostgreSQL (the isolated test database), fake
// provider and scanner, fictional users removed afterwards. Recipient photos
// stand in for every media table: they share MediaCleanup and StorageQuota.
describe('Storage lifecycle (e2e, PostgreSQL, fake provider)', () => {
  const LIMIT = 5000;
  const PNG = 'image/png';
  const storage = new ImageKitLikeStorage();
  const scanner = new FakeMalwareScanner();
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let cleanup: MediaCleanup;
  let ada: ReturnType<typeof request.agent>;
  let adaId: string;
  const run = Date.now();
  const email = `ada.storage.${run}@example.test`;
  const password = 'StrongPassword123!';
  const minutes = (m: number) => m * 60_000;
  const filesAt = (key: string) =>
    [...storage.files.values()].filter((f) => f.key === key).length;

  beforeAll(async () => {
    process.env.STORAGE_LIMIT_BYTES = String(LIMIT);
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        AuthModule,
        RecipientsModule,
      ],
    })
      .overrideProvider(MediaStorage)
      .useValue(storage)
      .overrideProvider(MalwareScanner)
      .useValue(scanner)
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    configureApp(app, new session.MemoryStore());
    await app.init();
    prisma = app.get(PrismaService);
    cleanup = app.get(MediaCleanup);
    await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ email, password, firstName: 'Ada', lastName: 'Test' })
      .expect(201);
    ada = request.agent(app.getHttpServer());
    await ada.post('/api/v1/auth/login').send({ email, password }).expect(200);
    adaId = (await prisma.user.findUniqueOrThrow({ where: { email } })).id;
  });

  afterAll(async () => {
    delete process.env.STORAGE_LIMIT_BYTES;
    await prisma?.user.deleteMany({ where: { email } });
    await app?.close();
  });

  const newRecipient = async () =>
    (await ada.post('/api/v1/recipients').send({ firstName: 'Sofia' }).expect(201)).body.id as string;
  const photoUrl = (rid: string, path = '') => `/api/v1/recipients/${rid}/photo${path}`;
  const requestUpload = (rid: string, sizeBytes = 100) =>
    ada.post(photoUrl(rid, '/upload-url')).send({ kind: 'PHOTO', originalFileName: 'p.png', mimeType: PNG, sizeBytes });
  const rowOf = (id: string) => prisma.recipientPhoto.findUniqueOrThrow({ where: { id } });
  const refOf = async (id: string) => {
    const r = await rowOf(id);
    return { id: r.id, storageKey: r.storageKey, storageProvider: r.storageProvider, providerFileId: r.providerFileId, createdAt: r.createdAt };
  };
  // Live reservations of this customer only (no other suite's rows).
  const reserved = async () =>
    (await prisma.recipientPhoto.aggregate({
      where: { ownerUserId: adaId, deletedAt: null, status: { in: ['READY', 'PENDING_UPLOAD'] } },
      _sum: { sizeBytes: true },
    }))._sum.sizeBytes ?? 0;
  const clearReservations = () =>
    prisma.recipientPhoto.updateMany({ where: { ownerUserId: adaId, deletedAt: null }, data: { deletedAt: new Date() } });

  it('concurrent reservations never exceed the limit: exactly the uploads that fit are signed', async () => {
    await clearReservations();
    const rid = await newRecipient();
    // 8 × 1000 bytes against a 5000-byte limit, all at once.
    const results = await Promise.all(Array.from({ length: 8 }, () => requestUpload(rid, 1000)));
    const statuses = results.map((r) => r.status).sort((a, b) => a - b);
    expect(statuses).toEqual([201, 201, 201, 201, 201, 409, 409, 409]);
    expect(await reserved()).toBe(LIMIT);
    expect(storage.createUpload).toHaveBeenCalledTimes(5);
    await clearReservations();
  });

  it('transaction rollback: a signing failure leaves no row and no reservation', async () => {
    await clearReservations();
    const rid = await newRecipient();
    storage.createUpload.mockRejectedValueOnce(new Error('signing failed'));
    const res = await requestUpload(rid, 4000);
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(await prisma.recipientPhoto.count({ where: { recipientId: rid } })).toBe(0);
    expect(await reserved()).toBe(0);
    // The whole allowance is still available.
    await requestUpload(rid, LIMIT).expect(201);
    await clearReservations();
  });

  it('token reuse after a failed upload: the re-uploaded file is found by path once settled, then recorded', async () => {
    const rid = await newRecipient();
    const target = (await requestUpload(rid, 100).expect(201)).body;
    const id = target.mediaAssetId as string;
    // Wrong size → FAILED; the known file is deleted at once, the row stays unmarked.
    const first = storage.upload(target.upload, { sizeBytes: 99, contentType: PNG });
    await ada.post(photoUrl(rid, `/${id}/complete`)).send({ providerFileId: first }).expect(400);
    const { storageKey } = await rowOf(id);
    expect(storage.files.has(first)).toBe(false);
    expect((await rowOf(id)).storageDeletedAt).toBeNull();

    // The same (still valid) token puts a file at the path again.
    const again = storage.upload(target.upload, { sizeBytes: 100, contentType: PNG });
    expect(filesAt(storageKey)).toBe(1);
    // It can never become READY: the row is FAILED for good.
    await ada.post(photoUrl(rid, `/${id}/complete`)).send({ providerFileId: again }).expect(409);

    // Before settling, a cleanup pass deletes by id only and records nothing.
    const ref = await refOf(id);
    expect(await cleanup.purge('recipientPhoto', [ref], new Date(ref.createdAt.getTime() + minutes(30)))).toEqual({
      purged: 0,
      failed: 0,
      deferred: 1,
    });
    expect(filesAt(storageKey)).toBe(1);
    // Settled (token 10 min + upload in flight 60 min): the path is checked.
    const settledAt = new Date(ref.createdAt.getTime() + minutes(71));
    expect(await cleanup.purge('recipientPhoto', [ref], settledAt)).toEqual({ purged: 1, failed: 0, deferred: 0 });
    expect(filesAt(storageKey)).toBe(0);
    expect((await rowOf(id)).storageDeletedAt).toEqual(settledAt);
  });

  it('cleanup retries: a provider failure on the path check leaves the row unmarked until a later pass succeeds', async () => {
    const rid = await newRecipient();
    const target = (await requestUpload(rid, 100).expect(201)).body;
    const id = target.mediaAssetId as string;
    const fileId = storage.upload(target.upload, { sizeBytes: 100, contentType: PNG });
    await ada.post(photoUrl(rid, `/${id}/complete`)).send({ providerFileId: fileId }).expect(200);
    await ada.delete(photoUrl(rid, `/${id}`)).expect(204);
    expect(storage.files.has(fileId)).toBe(false);
    // A re-upload with the old token, then the provider fails on the first settled pass.
    storage.upload(target.upload, { sizeBytes: 100, contentType: PNG });
    const ref = await refOf(id);
    const settledAt = new Date(ref.createdAt.getTime() + minutes(71));
    storage.deleteObject.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('list API down'));
    expect(await cleanup.purge('recipientPhoto', [ref], settledAt)).toEqual({ purged: 0, failed: 1, deferred: 0 });
    expect((await rowOf(id)).storageDeletedAt).toBeNull();
    expect(filesAt(ref.storageKey)).toBe(1);
    expect(await cleanup.purge('recipientPhoto', [ref], settledAt)).toEqual({ purged: 1, failed: 0, deferred: 0 });
    expect(filesAt(ref.storageKey)).toBe(0);
    expect((await rowOf(id)).storageDeletedAt).not.toBeNull();
  });

  it('a scan in progress is never retired; an upload retired first is never scanned', async () => {
    const rid = await newRecipient();
    const target = (await requestUpload(rid, 100).expect(201)).body;
    const id = target.mediaAssetId as string;
    const fileId = storage.upload(target.upload, { sizeBytes: 100, contentType: PNG });
    // Still inside its completion window (24 h) when complete starts; past it by the time cleanup runs.
    const old = new Date(Date.now() - minutes(24 * 60 - 2));
    await prisma.recipientPhoto.update({ where: { id }, data: { createdAt: old, updatedAt: old } });

    // The scan starts (claims the row), then waits while the cleanup runs.
    let finish!: () => void;
    const gate = new Promise<void>((r) => (finish = r));
    scanner.scan.mockImplementationOnce(async (file) => {
      for await (const _ of file) void _;
      await gate;
      return 'CLEAN';
    });
    const completing = ada.post(photoUrl(rid, `/${id}/complete`)).send({ providerFileId: fileId });
    const pending = completing.then((r) => r);
    await vi.waitFor(() => expect(scanner.scan).toHaveBeenCalled());
    await cleanup.reconcile(new Date(Date.now() + minutes(5)));
    expect((await rowOf(id)).deletedAt).toBeNull();
    finish();
    expect((await pending).status).toBe(200);
    expect((await rowOf(id)).status).toBe('READY');

    // Reverse order: retired before anyone asks to complete → never scanned.
    const t2 = (await requestUpload(rid, 100).expect(201)).body;
    const id2 = t2.mediaAssetId as string;
    const file2 = storage.upload(t2.upload, { sizeBytes: 100, contentType: PNG });
    // Past the window and the scan lease (12 min): retired.
    const abandoned = new Date(Date.now() - minutes(24 * 60 + 13));
    await prisma.recipientPhoto.update({ where: { id: id2 }, data: { createdAt: abandoned, updatedAt: abandoned } });
    await cleanup.reconcile();
    expect((await rowOf(id2)).deletedAt).not.toBeNull();
    scanner.scan.mockClear();
    await ada.post(photoUrl(rid, `/${id2}/complete`)).send({ providerFileId: file2 }).expect(404);
    expect(scanner.scan).not.toHaveBeenCalled();
    // A recent upload (inside its settle time) is left alone by the same run.
    const t3 = (await requestUpload(rid, 100).expect(201)).body;
    await cleanup.reconcile();
    expect((await rowOf(t3.mediaAssetId)).deletedAt).toBeNull();
  });

  it('a backgrounded tab confirming hours later still completes; past the window it gets an explicit 410', async () => {
    const rid = await newRecipient();
    // Uploaded, then the tab froze before confirming: 3 h later (past the old 82-min retirement).
    const t1 = (await requestUpload(rid, 100).expect(201)).body;
    const f1 = storage.upload(t1.upload, { sizeBytes: 100, contentType: PNG });
    const threeHours = new Date(Date.now() - minutes(180));
    await prisma.recipientPhoto.update({ where: { id: t1.mediaAssetId }, data: { createdAt: threeHours, updatedAt: threeHours } });
    await cleanup.reconcile();
    expect((await rowOf(t1.mediaAssetId)).deletedAt).toBeNull();
    await ada.post(photoUrl(rid, `/${t1.mediaAssetId}/complete`)).send({ providerFileId: f1 }).expect(200);
    expect((await rowOf(t1.mediaAssetId)).status).toBe('READY');

    // Past the completion window but not retired yet: 410 with the reason, never scanned.
    const t2 = (await requestUpload(rid, 100).expect(201)).body;
    const f2 = storage.upload(t2.upload, { sizeBytes: 100, contentType: PNG });
    const expired = new Date(Date.now() - minutes(24 * 60 + 1));
    await prisma.recipientPhoto.update({ where: { id: t2.mediaAssetId }, data: { createdAt: expired } });
    scanner.scan.mockClear();
    const res = await ada.post(photoUrl(rid, `/${t2.mediaAssetId}/complete`)).send({ providerFileId: f2 }).expect(410);
    expect(res.body.message).toBe(UPLOAD_EXPIRED);
    expect(scanner.scan).not.toHaveBeenCalled();
    expect((await rowOf(t2.mediaAssetId)).status).toBe('PENDING_UPLOAD');
  });

  it('settled purge: a file deleted only after settling needs no path lookup; earlier deletes still get one', async () => {
    const rid = await newRecipient();
    const target = (await requestUpload(rid, 100).expect(201)).body;
    const id = target.mediaAssetId as string;
    const fileId = storage.upload(target.upload, { sizeBytes: 100, contentType: PNG });
    await ada.post(photoUrl(rid, `/${id}/complete`)).send({ providerFileId: fileId }).expect(200);
    // Uploaded 2 h ago (settled at 70 min), deleted now: the file sat at its path until now.
    const twoHours = new Date(Date.now() - minutes(120));
    await prisma.recipientPhoto.update({ where: { id }, data: { createdAt: twoHours } });
    storage.deleteObject.mockClear();
    await ada.delete(photoUrl(rid, `/${id}`)).expect(204);
    expect(storage.deleteObject.mock.calls).toEqual([[expect.objectContaining({ providerFileId: fileId })]]);
    const row = await rowOf(id);
    expect(storage.files.has(fileId)).toBe(false);
    expect(row.storageDeletedAt).not.toBeNull();
  });

  it('recipient delete is one transaction: a failure keeps both; success removes both, files after commit', async () => {
    const rid = await newRecipient();
    const target = (await requestUpload(rid, 100).expect(201)).body;
    const id = target.mediaAssetId as string;
    const fileId = storage.upload(target.upload, { sizeBytes: 100, contentType: PNG });
    await ada.post(photoUrl(rid, `/${id}/complete`)).send({ providerFileId: fileId }).expect(200);

    // Fail the photo update inside the real transaction.
    const real = prisma.$transaction.bind(prisma) as (fn: (tx: object) => Promise<unknown>) => Promise<unknown>;
    const spy = vi.spyOn(prisma, '$transaction').mockImplementationOnce(((fn: (tx: object) => Promise<unknown>) =>
      real((tx) =>
        fn(
          new Proxy(tx, {
            get: (t, k) =>
              k === 'recipientPhoto'
                ? { updateManyAndReturn: () => Promise.reject(new Error('photo update failed')) }
                : (t as Record<string | symbol, unknown>)[k],
          }),
        ),
      )) as never);
    await ada.delete(`/api/v1/recipients/${rid}`).expect(500);
    spy.mockRestore();
    expect((await prisma.recipient.findUniqueOrThrow({ where: { id: rid } })).deletedAt).toBeNull();
    expect((await rowOf(id)).deletedAt).toBeNull();
    expect(storage.files.has(fileId)).toBe(true);

    await ada.delete(`/api/v1/recipients/${rid}`).expect(204);
    const recipient = await prisma.recipient.findUniqueOrThrow({ where: { id: rid } });
    const photo = await rowOf(id);
    expect(recipient.deletedAt).not.toBeNull();
    expect(photo.deletedAt).toEqual(recipient.deletedAt);
    expect(storage.files.has(fileId)).toBe(false);
  });

  it('photo uploads racing a recipient delete never leave a live photo behind', async () => {
    for (let i = 0; i < 6; i++) {
      const rid = await newRecipient();
      const [upload, del] = await Promise.all([requestUpload(rid, 50), ada.delete(`/api/v1/recipients/${rid}`)]);
      expect(del.status).toBe(204);
      expect([201, 404]).toContain(upload.status);
      expect(await prisma.recipientPhoto.count({ where: { recipientId: rid, deletedAt: null } })).toBe(0);
    }
  });
});
