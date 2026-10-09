import { NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { MediaStorage } from '../media/storage/media-storage.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { RecipientMessagesController } from './recipient-messages.controller.js';
import { RecipientMessagesService } from './recipient-messages.service.js';

const SOFIA = 'sofia@example.com';
const MSG = '11111111-1111-4111-8111-111111111111';
const MSG2 = '22222222-2222-4222-8222-222222222222';
const MEDIA = '33333333-3333-4333-8333-333333333333';
const EARLY = new Date('2030-01-01T00:00:00Z');
const LATE = new Date('2030-06-01T00:00:00Z');

const grant = (id = MSG, releasedAt = EARLY, media = 0) => ({
  messageRelease: { releasedAt },
  message: {
    id,
    title: 'For Sofia',
    contentType: 'TEXT',
    textContent: 'Fictional released text.',
    _count: { mediaAssets: media },
  },
});

const setup = () => {
  const prisma = {
    recipientMessageAccessGrant: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
    },
    mediaAsset: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
    },
  };
  const storage = {
    createAccessUrl: vi.fn(async () => 'https://storage.test/signed-get'),
  };
  const service = new RecipientMessagesService(
    prisma as unknown as PrismaService,
    storage as unknown as MediaStorage,
    new ConfigService({ MEDIA_ACCESS_URL_TTL_SECONDS: '300' }),
  );
  return { prisma, storage, service };
};

// The only authorization filter: this email's grant, RELEASED, not deleted.
const eligible = {
  recipientEmailNormalized: SOFIA,
  message: { status: 'RELEASED', deletedAt: null },
};
const visibleMedia = {
  status: 'READY',
  deletedAt: null,
  kind: { in: ['PHOTO', 'AUDIO', 'VIDEO'] },
};

describe('RecipientMessagesService', () => {
  it('lists only granted, released, live messages, newest release first', async () => {
    const { prisma, service } = setup();
    prisma.recipientMessageAccessGrant.findMany.mockResolvedValue([
      grant(MSG2, LATE, 2),
      grant(MSG, EARLY),
    ]);
    expect(await service.findAll(SOFIA)).toEqual([
      {
        id: MSG2,
        title: 'For Sofia',
        contentType: 'TEXT',
        releasedAt: LATE,
        hasMedia: true,
      },
      {
        id: MSG,
        title: 'For Sofia',
        contentType: 'TEXT',
        releasedAt: EARLY,
        hasMedia: false,
      },
    ]);
    const args = prisma.recipientMessageAccessGrant.findMany.mock.calls[0][0];
    expect(args.where).toEqual(eligible);
    expect(args.orderBy[0]).toEqual({ messageRelease: { releasedAt: 'desc' } });
  });

  it('a message granted twice to the same email (two Recipient rows) is listed once', async () => {
    const { prisma, service } = setup();
    prisma.recipientMessageAccessGrant.findMany.mockResolvedValue([
      grant(),
      grant(),
    ]);
    expect(await service.findAll(SOFIA)).toHaveLength(1);
  });

  it('never selects owner, schedule, status, recipients, grant ids or storage keys', async () => {
    const { prisma, service } = setup();
    prisma.recipientMessageAccessGrant.findFirst.mockResolvedValue(grant());
    await service.findAll(SOFIA);
    await service.findOne(SOFIA, MSG);
    await service.findMedia(SOFIA, MSG);
    const selects = JSON.stringify([
      prisma.recipientMessageAccessGrant.findMany.mock.calls[0][0].select,
      prisma.recipientMessageAccessGrant.findFirst.mock.calls[0][0].select,
      prisma.mediaAsset.findMany.mock.calls[0][0].select,
    ]);
    expect(selects).not.toMatch(
      /ownerUserId|owner"|schedule|scheduledFor|afterDeathDays|recipients|recipientId|storageKey|deletedAt":true|"status":true|"id":true,"messageReleaseId/,
    );
  });

  it('detail: returns released text for a matching grant', async () => {
    const { prisma, service } = setup();
    prisma.recipientMessageAccessGrant.findFirst.mockResolvedValue(grant());
    expect(await service.findOne(SOFIA, MSG)).toEqual({
      id: MSG,
      title: 'For Sofia',
      contentType: 'TEXT',
      textContent: 'Fictional released text.',
      releasedAt: EARLY,
      hasMedia: false,
    });
    expect(
      prisma.recipientMessageAccessGrant.findFirst.mock.calls[0][0].where,
    ).toEqual({ ...eligible, messageId: MSG });
  });

  it('no grant (draft, scheduled, deleted, guessed, someone else’s) → 404, never 403', async () => {
    const { service } = setup();
    for (const call of [
      () => service.findOne(SOFIA, MSG),
      () => service.findMedia(SOFIA, MSG),
      () => service.createMediaAccessUrl(SOFIA, MSG, MEDIA),
    ]) {
      await expect(call()).rejects.toBeInstanceOf(NotFoundException);
    }
  });

  it('media list: READY, live PHOTO/AUDIO/VIDEO of this message only, after the grant check', async () => {
    const { prisma, service } = setup();
    prisma.recipientMessageAccessGrant.findFirst.mockResolvedValue(grant());
    await service.findMedia(SOFIA, MSG);
    expect(prisma.mediaAsset.findMany).toHaveBeenCalledWith({
      where: { messageId: MSG, ...visibleMedia },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        kind: true,
        originalFileName: true,
        mimeType: true,
        sizeBytes: true,
        uploadedAt: true,
      },
    });
  });

  it('access URL: signed only after grant + READY media checks, never stored', async () => {
    const { prisma, storage, service } = setup();
    prisma.recipientMessageAccessGrant.findFirst.mockResolvedValue(grant());
    const file = {
      storageKey: 'k/1.jpg',
      storageProvider: 'IMAGEKIT',
      providerFileId: 'f1',
    };
    prisma.mediaAsset.findFirst.mockResolvedValue(file);
    const res = await service.createMediaAccessUrl(SOFIA, MSG, MEDIA);
    expect(res.url).toBe('https://storage.test/signed-get');
    expect(res.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(prisma.mediaAsset.findFirst).toHaveBeenCalledWith({
      where: { id: MEDIA, messageId: MSG, ...visibleMedia },
      select: { storageKey: true, storageProvider: true, providerFileId: true },
    });
    expect(storage.createAccessUrl).toHaveBeenCalledWith(file, 300);
    // Nothing written anywhere.
    expect(Object.keys(prisma.mediaAsset)).toEqual(['findMany', 'findFirst']);
  });

  it('access URL: pending, failed, deleted or foreign media → 404 and nothing signed', async () => {
    const { prisma, storage, service } = setup();
    prisma.recipientMessageAccessGrant.findFirst.mockResolvedValue(grant());
    await expect(
      service.createMediaAccessUrl(SOFIA, MSG, MEDIA),
    ).rejects.toBeInstanceOf(NotFoundException);
    // No grant: media is never even looked up.
    prisma.recipientMessageAccessGrant.findFirst.mockResolvedValue(null);
    await expect(
      service.createMediaAccessUrl(SOFIA, MSG, MEDIA),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.mediaAsset.findFirst).toHaveBeenCalledTimes(1);
    expect(storage.createAccessUrl).not.toHaveBeenCalled();
  });

  it('the controller is read-only (GET routes only)', () => {
    const proto = RecipientMessagesController.prototype as unknown as Record<
      string,
      () => unknown
    >;
    const methods = Object.getOwnPropertyNames(proto)
      .filter((name) => name !== 'constructor')
      .map((name) => Reflect.getMetadata('method', proto[name]) as number);
    // RequestMethod.GET = 0
    expect(methods).toEqual([0, 0, 0, 0]);
  });
});
