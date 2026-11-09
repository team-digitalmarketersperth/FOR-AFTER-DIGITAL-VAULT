import { GUARDS_METADATA } from '@nestjs/common/constants.js';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CustomerGuard } from '../auth/guards/customer.guard.js';
import { SessionAuthGuard } from '../auth/guards/session-auth.guard.js';
import {
  CreateMyWishSongDto,
  ReorderMyWishSongsDto,
  UpdateMyWishSongDto,
} from './dto/save-my-wish-song.dto.js';
import { MyWishSongsController } from './my-wishes.controller.js';
import { normaliseSongLink, SONG_LINK_MAX } from './song-link.js';

// Fictional ids in the right shape; nothing here is ever fetched.
const YT = 'AbCdEfGhIjK';
const SP = 'A1b2C3d4E5f6G7h8I9j0K1';

describe('normaliseSongLink', () => {
  it.each([
    [`https://www.youtube.com/watch?v=${YT}`, `https://www.youtube.com/watch?v=${YT}`],
    [`https://youtube.com/watch?v=${YT}&feature=share&si=x`, `https://www.youtube.com/watch?v=${YT}`],
    [`https://m.youtube.com/watch?v=${YT}&t=90s`, `https://www.youtube.com/watch?v=${YT}&t=90s`],
    [`https://WWW.YouTube.com/watch?list=PL1&v=${YT}&t=1m30s`, `https://www.youtube.com/watch?v=${YT}&t=1m30s`],
    [`https://youtu.be/${YT}?si=tracking`, `https://youtu.be/${YT}`],
    [`https://youtu.be/${YT}?t=42`, `https://youtu.be/${YT}?t=42`],
    [`https://music.youtube.com/watch?v=${YT}&si=x`, `https://music.youtube.com/watch?v=${YT}`],
    [`https://open.spotify.com/track/${SP}?si=abc`, `https://open.spotify.com/track/${SP}`],
    [`https://open.spotify.com/intl-de/track/${SP}`, `https://open.spotify.com/track/${SP}`],
    [`  https://open.spotify.com/track/${SP}/  `, `https://open.spotify.com/track/${SP}`],
  ])('accepts %s', (raw, expected) => {
    expect(normaliseSongLink(raw)).toBe(expected);
  });

  it('drops an unrecognised start time instead of passing it through', () => {
    expect(normaliseSongLink(`https://youtu.be/${YT}?t=<script>`)).toBe(`https://youtu.be/${YT}`);
  });

  it.each([
    `http://www.youtube.com/watch?v=${YT}`,
    `javascript:alert(1)//https://youtu.be/${YT}`,
    'data:text/html,<script>alert(1)</script>',
    'file:///etc/passwd',
    `ftp://youtu.be/${YT}`,
    `https://user:pass@www.youtube.com/watch?v=${YT}`,
    `https://user@youtu.be/${YT}`,
    `https://www.youtube.com:8443/watch?v=${YT}`,
    `https://youtube.com.evil.example/watch?v=${YT}`,
    `https://evil.example/watch?v=${YT}&youtube.com`,
    `https://www.youtube.com.@evil.example/watch?v=${YT}`,
    `https://notyoutube.com/watch?v=${YT}`,
    `https://youtu.be.evil.example/${YT}`,
    `https://open.spotify.com.evil.example/track/${SP}`,
    `https://spotify.com/track/${SP}`,
    `https://www.youtube.com/watch?v=short`,
    `https://www.youtube.com/watch`,
    `https://www.youtube.com/channel/${YT}`,
    `https://www.youtube.com/playlist?list=PL1`,
    `https://youtu.be/${YT}/extra`,
    `https://open.spotify.com/album/${SP}`,
    `https://open.spotify.com/playlist/${SP}`,
    `https://open.spotify.com/track/not-an-id`,
    `https://example.com/song.mp3`,
    'not a url',
    '',
    `https://www.youtube.com/watch?v=${YT}&x=${'a'.repeat(SONG_LINK_MAX)}`,
  ])('rejects %s', (raw) => {
    expect(normaliseSongLink(raw)).toBeNull();
  });
});

describe('song DTOs', () => {
  const errorsOf = async (cls: new () => object, body: object) =>
    (await validate(plainToInstance(cls, body), { whitelist: true, forbidNonWhitelisted: true })).map(
      (e) => e.property,
    );

  it('needs only a title; no artist, owner or position is accepted', async () => {
    expect(await errorsOf(CreateMyWishSongDto, { title: 'Song' })).toEqual([]);
    expect(await errorsOf(CreateMyWishSongDto, {})).toEqual(['title']);
    expect(await errorsOf(CreateMyWishSongDto, { title: '   ' })).toEqual(['title']);
    expect(await errorsOf(CreateMyWishSongDto, { title: 'x'.repeat(201) })).toEqual(['title']);
    for (const extra of ['artist', 'album', 'ownerUserId', 'position']) {
      expect(await errorsOf(CreateMyWishSongDto, { title: 'Song', [extra]: 'x' })).toEqual([extra]);
    }
  });

  it('bounds the optional fields and the timing', async () => {
    expect(await errorsOf(CreateMyWishSongDto, { title: 'S', note: 'x'.repeat(1001) })).toEqual(['note']);
    expect(await errorsOf(CreateMyWishSongDto, { title: 'S', momentOther: 'x'.repeat(101) })).toEqual([
      'momentOther',
    ]);
    expect(await errorsOf(CreateMyWishSongDto, { title: 'S', moment: 'FAREWELL', note: null, link: null })).toEqual(
      [],
    );
    expect(await errorsOf(CreateMyWishSongDto, { title: 'S', moment: 'farewell' })).toEqual(['moment']);
    expect(await errorsOf(UpdateMyWishSongDto, {})).toEqual([]);
    expect(await errorsOf(UpdateMyWishSongDto, { title: null })).toEqual(['title']);
  });

  it('reorder takes unique UUIDs only', async () => {
    const id = '7d6f1d8e-3c55-4a3a-9f1e-2b9a8f0e4c11';
    expect(await errorsOf(ReorderMyWishSongsDto, { songIds: [id] })).toEqual([]);
    expect(await errorsOf(ReorderMyWishSongsDto, { songIds: [id, id.toUpperCase()] })).toEqual(['songIds']);
    expect(await errorsOf(ReorderMyWishSongsDto, { songIds: ['1'] })).toEqual(['songIds']);
  });

  it('the controller needs a Customer session', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, MyWishSongsController)).toEqual([
      SessionAuthGuard,
      CustomerGuard,
    ]);
  });
});
