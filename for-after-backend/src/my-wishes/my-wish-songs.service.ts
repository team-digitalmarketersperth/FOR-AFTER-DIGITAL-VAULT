import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { MyWishSongMoment, Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  SONGS_MAX,
  type CreateMyWishSongDto,
  type UpdateMyWishSongDto,
} from './dto/save-my-wish-song.dto.js';
import { normaliseSongLink, SONG_LINK_INVALID } from './song-link.js';

// ownerUserId never leaves the API; position is the list order.
const songSelect = {
  id: true,
  title: true,
  link: true,
  moment: true,
  momentOther: true,
  note: true,
  position: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.MyWishSongSelect;

export type WishSong = Prisma.MyWishSongGetPayload<{
  select: typeof songSelect;
}>;

// Same message for a missing song and another Customer's.
export const SONG_NOT_FOUND = 'Song not found.';
export const SONGS_FULL = `You can add up to ${SONGS_MAX} songs.`;
export const SONGS_CHANGED =
  'Your song list has changed. Reload the page and try again.';

const link = (raw: string | null | undefined) => {
  if (raw == null) return raw;
  const normalised = normaliseSongLink(raw);
  if (!normalised) throw new BadRequestException(SONG_LINK_INVALID);
  return normalised;
};

/**
 * Songs a Customer would like played at their funeral (My Wishes). Private
 * like every wish: only the session user's own rows are read or written, and
 * saving never creates a Message, schedule, notification or release. Links
 * are validated by parsing only, never fetched.
 */
@Injectable()
export class MyWishSongsService {
  constructor(private readonly prisma: PrismaService) {}

  // Serialises one Customer's list changes, so the cap and the order hold (as in SupportService.create).
  private lockOwner(tx: Prisma.TransactionClient, ownerUserId: string) {
    return tx.$queryRaw`SELECT 1 FROM "User" WHERE id = ${ownerUserId}::uuid FOR UPDATE`;
  }

  list(ownerUserId: string): Promise<WishSong[]> {
    return this.prisma.myWishSong.findMany({
      where: { ownerUserId },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
      select: songSelect,
    });
  }

  /** Added at the end of the list. */
  create(ownerUserId: string, dto: CreateMyWishSongDto): Promise<WishSong> {
    const moment = dto.moment ?? null;
    const data = {
      title: dto.title,
      link: link(dto.link) ?? null,
      moment,
      momentOther:
        moment === MyWishSongMoment.OTHER ? (dto.momentOther ?? null) : null,
      note: dto.note ?? null,
    };
    return this.prisma.$transaction(async (tx) => {
      await this.lockOwner(tx, ownerUserId);
      const { _count, _max } = await tx.myWishSong.aggregate({
        where: { ownerUserId },
        _count: true,
        _max: { position: true },
      });
      if (_count >= SONGS_MAX) throw new BadRequestException(SONGS_FULL);
      return tx.myWishSong.create({
        data: { ownerUserId, ...data, position: (_max.position ?? -1) + 1 },
        select: songSelect,
      });
    });
  }

  /** Omitted fields stay as they are; null clears an optional one. */
  update(
    ownerUserId: string,
    id: string,
    dto: UpdateMyWishSongDto,
  ): Promise<WishSong> {
    const newLink = link(dto.link);
    return this.prisma.$transaction(async (tx) => {
      const current = await tx.myWishSong.findFirst({
        where: { id, ownerUserId },
        select: { moment: true, momentOther: true },
      });
      if (!current) throw new NotFoundException(SONG_NOT_FOUND);
      const moment = dto.moment === undefined ? current.moment : dto.moment;
      const momentOther =
        moment === MyWishSongMoment.OTHER
          ? dto.momentOther === undefined
            ? current.momentOther
            : dto.momentOther
          : null;
      return tx.myWishSong.update({
        where: { id, ownerUserId },
        data: {
          title: dto.title,
          link: newLink,
          moment,
          momentOther,
          note: dto.note,
        },
        select: songSelect,
      });
    });
  }

  async remove(ownerUserId: string, id: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await this.lockOwner(tx, ownerUserId);
      const { count } = await tx.myWishSong.deleteMany({
        where: { id, ownerUserId },
      });
      if (count === 0) throw new NotFoundException(SONG_NOT_FOUND);
    });
  }

  /**
   * songIds must be exactly the Customer's current songs (validated in the
   * same transaction). Anything else, including another Customer's id or a
   * list made before a song was added or removed, is a 409 and nothing moves.
   */
  reorder(ownerUserId: string, songIds: string[]): Promise<WishSong[]> {
    return this.prisma.$transaction(async (tx) => {
      await this.lockOwner(tx, ownerUserId);
      const own = await tx.myWishSong.findMany({
        where: { ownerUserId },
        select: { id: true },
      });
      const ids = new Set(own.map((s) => s.id));
      const wanted = songIds.map((id) => id.toLowerCase());
      if (wanted.length !== ids.size || !wanted.every((id) => ids.has(id))) {
        throw new ConflictException(SONGS_CHANGED);
      }
      for (const [position, id] of wanted.entries()) {
        await tx.myWishSong.update({
          where: { id, ownerUserId },
          data: { position },
        });
      }
      return tx.myWishSong.findMany({
        where: { ownerUserId },
        orderBy: { position: 'asc' },
        select: songSelect,
      });
    });
  }
}
