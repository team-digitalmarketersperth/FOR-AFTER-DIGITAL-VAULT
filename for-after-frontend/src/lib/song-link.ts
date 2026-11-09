// Mirror of the backend check (for-after-backend/src/my-wishes/song-link.ts)
// for early feedback; the API stays authoritative and stores the canonical
// link. Keep the two in step.

export const SONG_LINK_MAX = 500;
export const SONG_LINK_INVALID =
  'Paste a YouTube or Spotify song link (https://…).';

const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com']);
const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
const SPOTIFY_ID = /^[A-Za-z0-9]{22}$/;
// YouTube start times: "90", "90s" or "1h2m3s".
const START_TIME = /^(\d{1,6}s?|(\d{1,2}h)?(\d{1,3}m)?(\d{1,6}s)?)$/;

/**
 * The canonical form of a supported song link, or null if it is not one.
 * Tracking parameters (si, feature, pp, list, ...) are dropped; a YouTube
 * start time is kept.
 */
export function normaliseSongLink(raw: string): string | null {
  if (raw.length > SONG_LINK_MAX) return null;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) {
    return null;
  }
  const host = url.hostname.toLowerCase();
  const path = url.pathname.replace(/\/+$/, '');
  const t = url.searchParams.get('t');
  const time = t && START_TIME.test(t) ? t : null;

  if (YOUTUBE_HOSTS.has(host) || host === 'music.youtube.com') {
    const id = url.searchParams.get('v');
    if (path !== '/watch' || !id || !YOUTUBE_ID.test(id)) return null;
    const canonicalHost =
      host === 'music.youtube.com' ? host : 'www.youtube.com';
    return `https://${canonicalHost}/watch?v=${id}${time ? `&t=${time}` : ''}`;
  }
  if (host === 'youtu.be') {
    const id = path.slice(1);
    if (!YOUTUBE_ID.test(id)) return null;
    return `https://youtu.be/${id}${time ? `?t=${time}` : ''}`;
  }
  if (host === 'open.spotify.com') {
    // Optional locale prefix: /intl-de/track/<id>.
    const m = /^(?:\/intl-[a-z]{2}(?:-[a-z]{2})?)?\/track\/([^/]+)$/i.exec(path);
    if (!m || !SPOTIFY_ID.test(m[1])) return null;
    return `https://open.spotify.com/track/${m[1]}`;
  }
  return null;
}
