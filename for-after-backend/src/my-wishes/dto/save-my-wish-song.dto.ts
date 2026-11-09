import { applyDecorators } from '@nestjs/common';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';
import { MyWishSongMoment } from '../../generated/prisma/client.js';
import {
  IfDefined,
  trimToNull,
} from '../../messages/dto/create-message.dto.js';
import { SONG_LINK_MAX } from '../song-link.js';

// Implementation limits (no product decision), mirrored in the frontend.
export const SONG_TITLE_MAX = 200;
export const SONG_MOMENT_OTHER_MAX = 100;
export const SONG_NOTE_MAX = 1000;
export const SONGS_MAX = 50;

// Plain text, stored as written (not trimmed), must not be blank.
const Title = () =>
  applyDecorators(
    IsString(),
    Matches(/\S/, { message: 'title must not be blank' }),
    MaxLength(SONG_TITLE_MAX),
  );
// Optional text: omitted = unchanged, null/blank = cleared.
const OptionalText = (max: number) =>
  applyDecorators(IsOptional(), Transform(trimToNull), IsString(), MaxLength(max));

// No artist, album or account fields: unknown fields (ownerUserId, position,
// ...) are 400 through the global ValidationPipe. The link is checked and
// normalised by the service (normaliseSongLink).
export class CreateMyWishSongDto {
  @Title()
  title!: string;

  @OptionalText(SONG_LINK_MAX)
  link?: string | null;

  @IsOptional()
  @IsEnum(MyWishSongMoment, {
    message: `moment must be one of: ${Object.values(MyWishSongMoment).join(', ')}`,
  })
  moment?: MyWishSongMoment | null;

  // Kept only with moment OTHER.
  @OptionalText(SONG_MOMENT_OTHER_MAX)
  momentOther?: string | null;

  @OptionalText(SONG_NOTE_MAX)
  note?: string | null;
}

// PATCH: every field optional; the title can change but never be cleared.
export class UpdateMyWishSongDto {
  @IfDefined()
  @Title()
  title?: string;

  @OptionalText(SONG_LINK_MAX)
  link?: string | null;

  @IsOptional()
  @IsEnum(MyWishSongMoment, {
    message: `moment must be one of: ${Object.values(MyWishSongMoment).join(', ')}`,
  })
  moment?: MyWishSongMoment | null;

  @OptionalText(SONG_MOMENT_OTHER_MAX)
  momentOther?: string | null;

  @OptionalText(SONG_NOTE_MAX)
  note?: string | null;
}

// PUT /my-wishes/songs/order: every one of the Customer's songs, once, in the
// new order.
export class ReorderMyWishSongsDto {
  @IsArray()
  @ArrayMaxSize(SONGS_MAX)
  @IsUUID('all', { each: true })
  @ArrayUnique((id: unknown) => String(id).toLowerCase(), {
    message: 'songIds must not contain duplicates',
  })
  songIds!: string[];
}
