import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { WishSong, WishSongInput } from '@/lib/api/prompts';
import { normaliseSongLink } from '@/lib/song-link';
import { json, renderWithClient, routeFetch, router } from '@/test/utils';
import { WishSongs } from './wish-songs';
import { PromptList } from './prompts';

vi.mock('next/navigation', () => ({ useRouter: () => router, usePathname: () => '/my-wishes' }));

// Fictional ids; nothing is fetched from YouTube or Spotify.
const YT = 'AbCdEfGhIjK';
const SP = 'A1b2C3d4E5f6G7h8I9j0K1';
const song = (id: string, title: string, over: Partial<WishSong> = {}): WishSong => ({
  id,
  title,
  link: null,
  moment: null,
  momentOther: null,
  note: null,
  position: 0,
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-01T00:00:00Z',
  ...over,
});

/** A small in-memory /my-wishes/songs API (the server's own rules are tested in the backend). */
function fakeSongsApi(initial: WishSong[] = [], { failReorder = false, failCreate = false } = {}) {
  let songs = initial.map((s, position) => ({ ...s, position }));
  const routes: Record<string, (body: unknown) => Response> = {
    'GET /my-wishes/songs': () => json(200, songs),
    'POST /my-wishes/songs': (body) => {
      if (failCreate) return json(500, { message: 'Something went wrong. Please try again.' });
      const created = song(`s${songs.length + 1}`, '', { ...(body as WishSongInput), position: songs.length });
      songs = [...songs, created];
      return json(201, created);
    },
    'PUT /my-wishes/songs/order': (body) => {
      if (failReorder) return json(409, { message: 'Your song list has changed. Reload the page and try again.' });
      const ids = (body as { songIds: string[] }).songIds;
      songs = ids.map((id, position) => ({ ...songs.find((s) => s.id === id)!, position }));
      return json(200, songs);
    },
  };
  for (const s of initial) {
    routes[`PATCH /my-wishes/songs/${s.id}`] = (body) => {
      songs = songs.map((x) => (x.id === s.id ? { ...x, ...(body as object) } : x));
      return json(200, songs.find((x) => x.id === s.id));
    };
    routes[`DELETE /my-wishes/songs/${s.id}`] = () => {
      songs = songs.filter((x) => x.id !== s.id);
      return json(204);
    };
  }
  return { api: routeFetch(routes), current: () => songs };
}

const titlesShown = () =>
  within(screen.getByRole('list', { name: 'Your songs' }))
    .getAllByRole('listitem')
    .map((li) => li.querySelector('p')!.textContent);

describe('My Wishes: Music I’d like remembered', () => {
  it('empty state; step 1 checks the title, Continue never saves; Skip and save sends only the song', async () => {
    const { api } = fakeSongsApi();
    renderWithClient(<WishSongs />);
    expect(await screen.findByRole('heading', { name: 'Music I’d like remembered' })).toBeInTheDocument();
    expect(screen.getByText(/Add the songs you’d like played, with a link or a note/)).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'No songs added yet.' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Add a song' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add a song' });
    expect(dialog).toHaveAccessibleDescription('Keep the music that matters to you.');
    await waitFor(() => expect(within(dialog).getByLabelText('Song title')).toHaveFocus());
    expect(within(dialog).getByText('Step 1 of 2')).toBeInTheDocument();
    expect(within(dialog).getByText('Your song').closest('li')).toHaveAttribute('aria-current', 'step');
    expect(within(dialog).getByText('Only you can see your songs. Saving won’t share them.')).toBeInTheDocument();
    expect(within(dialog).getByText('Add a YouTube or Spotify link. No account connection needed.')).toBeInTheDocument();
    expect(within(dialog).getByLabelText(/Song link/)).toHaveAccessibleName(/^Song link\s*\(optional\)$/);
    // No fictional values, no artist, no account.
    expect(within(dialog).getByLabelText('Song title')).toHaveValue('');
    expect(within(dialog).getByLabelText(/Song link/)).toHaveValue('');
    expect(within(dialog).queryByLabelText(/artist/i)).not.toBeInTheDocument();
    expect(within(dialog).queryByText(/album|connect your|sign in to/i)).not.toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Close' })).toBeInTheDocument();
    // Optional details live on step 2 only.
    expect(within(dialog).queryByLabelText(/Personal note/)).not.toBeInTheDocument();

    await userEvent.click(within(dialog).getByRole('button', { name: 'Continue' }));
    expect(await within(dialog).findByText('Enter a song title.')).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Song title')).toHaveAttribute('aria-invalid', 'true');
    expect(within(dialog).getByText('Step 1 of 2')).toBeInTheDocument();

    await userEvent.type(within(dialog).getByLabelText('Song title'), 'Amazing Grace');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Continue' }));
    expect(await within(dialog).findByText('Step 2 of 2')).toBeInTheDocument();
    expect(within(dialog).getByRole('list', { name: 'Progress' }).children[0]).toHaveTextContent(/Your song\s*\(completed\)/);
    expect(within(dialog).getByText('Personal details', { selector: 'span' }).closest('li')).toHaveAttribute(
      'aria-current',
      'step',
    );
    expect(within(dialog).getByText('Amazing Grace')).toBeInTheDocument();
    expect(within(dialog).getByText('You can leave these details blank.')).toBeInTheDocument();
    await waitFor(() => expect(within(dialog).getByRole('heading', { name: 'Personal details' })).toHaveFocus());
    expect(api.called('POST', '/my-wishes/songs')).toHaveLength(0);

    await userEvent.click(within(dialog).getByRole('button', { name: 'Skip and save' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(api.called('POST', '/my-wishes/songs').map((c) => c.body)).toEqual([
      { title: 'Amazing Grace', link: null, moment: null, momentOther: null, note: null },
    ]);
    expect(await screen.findByText('Amazing Grace')).toBeInTheDocument();
    // Saving touched nothing but the songs API.
    expect(new Set(api.calls.map((c) => c.path))).toEqual(new Set(['/my-wishes/songs']));
  });

  it('Enter on step 1 moves on (or shows errors) and never saves', async () => {
    const { api } = fakeSongsApi();
    renderWithClient(<WishSongs />);
    await userEvent.click(await screen.findByRole('button', { name: 'Add a song' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add a song' });
    await userEvent.type(within(dialog).getByLabelText('Song title'), '{Enter}');
    expect(await within(dialog).findByText('Enter a song title.')).toBeInTheDocument();
    await userEvent.type(within(dialog).getByLabelText('Song title'), 'Hymn{Enter}');
    expect(await within(dialog).findByText('Step 2 of 2')).toBeInTheDocument();
    expect(api.called('POST', '/my-wishes/songs')).toHaveLength(0);
  });

  it('checks the link before step 2; Back keeps every value; saves timing, Other detail and note once', async () => {
    const { api } = fakeSongsApi();
    renderWithClient(<WishSongs />);
    await userEvent.click(await screen.findByRole('button', { name: 'Add a song' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add a song' });
    await userEvent.type(within(dialog).getByLabelText('Song title'), 'Song two');
    const link = within(dialog).getByLabelText(/Song link/);
    await userEvent.type(link, `https://youtube.com.evil.example/watch?v=${YT}`);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Continue' }));
    expect(await within(dialog).findByText('Paste a YouTube or Spotify song link (https://…).')).toBeInTheDocument();
    expect(link).toHaveAttribute('aria-invalid', 'true');
    expect(within(dialog).getByText('Step 1 of 2')).toBeInTheDocument();

    await userEvent.clear(link);
    await userEvent.type(link, `https://open.spotify.com/track/${SP}?si=x`);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Continue' }));
    const timing = await within(dialog).findByRole('group', { name: /When to play/ });
    expect(within(timing).getAllByRole('radio').map((r) => r.closest('label')!.textContent)).toEqual([
      'Not set',
      'Arrival',
      'Reflection',
      'Farewell',
      'Other',
    ]);
    expect(within(timing).getByRole('radio', { name: 'Not set' })).toBeChecked();
    await userEvent.click(within(timing).getByRole('radio', { name: 'Other' }));
    await userEvent.type(within(dialog).getByLabelText(/When would you like it played/), 'At the wake');
    await userEvent.type(within(dialog).getByLabelText(/Personal note/), 'The live version.');
    expect(within(dialog).getByText('Why it matters, or the version you love.')).toBeInTheDocument();
    // Details entered: no skip that could drop them.
    expect(within(dialog).queryByRole('button', { name: 'Skip and save' })).not.toBeInTheDocument();

    await userEvent.click(within(dialog).getByRole('button', { name: 'Back' }));
    expect(await within(dialog).findByText('Step 1 of 2')).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Song title')).toHaveValue('Song two');
    expect(within(dialog).getByLabelText(/Song link/)).toHaveValue(`https://open.spotify.com/track/${SP}?si=x`);
    await waitFor(() => expect(within(dialog).getByLabelText('Song title')).toHaveFocus());
    await userEvent.click(within(dialog).getByRole('button', { name: 'Continue' }));
    expect(await within(dialog).findByRole('radio', { name: 'Other' })).toBeChecked();
    expect(within(dialog).getByLabelText(/When would you like it played/)).toHaveValue('At the wake');
    expect(within(dialog).getByLabelText(/Personal note/)).toHaveValue('The live version.');
    expect(api.called('POST', '/my-wishes/songs')).toHaveLength(0);

    // A double click sends one request.
    await userEvent.dblClick(within(dialog).getByRole('button', { name: 'Save song' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(api.called('POST', '/my-wishes/songs').map((c) => c.body)).toEqual([
      {
        title: 'Song two',
        link: `https://open.spotify.com/track/${SP}?si=x`,
        moment: 'OTHER',
        momentOther: 'At the wake',
        note: 'The live version.',
      },
    ]);
  });

  it('a failed save keeps the dialog, the step and what was typed', async () => {
    fakeSongsApi([], { failCreate: true });
    renderWithClient(<WishSongs />);
    await userEvent.click(await screen.findByRole('button', { name: 'Add a song' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add a song' });
    await userEvent.type(within(dialog).getByLabelText('Song title'), 'Kept');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Continue' }));
    await userEvent.type(await within(dialog).findByLabelText(/Personal note/), 'Also kept');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save song' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Your song wasn’t saved');
    expect(within(dialog).getByLabelText(/Personal note/)).toHaveValue('Also kept');
    expect(within(dialog).getByRole('button', { name: 'Save song' })).toBeEnabled();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Back' }));
    expect(within(dialog).getByLabelText('Song title')).toHaveValue('Kept');
  });

  it('shows timing and note; Open song is a safe external link; stored markup stays text', async () => {
    fakeSongsApi([
      song('s1', '<img src=x onerror=alert(1)>', {
        link: `https://www.youtube.com/watch?v=${YT}&t=30`,
        moment: 'FAREWELL',
        note: '<b>not bold</b>',
      }),
      song('s2', 'Unsafe stored link', { link: 'javascript:alert(1)' }),
    ]);
    const { container } = renderWithClient(<WishSongs />);
    expect(await screen.findByText('<img src=x onerror=alert(1)>')).toBeInTheDocument();
    expect(container.querySelector('img, b')).toBeNull();
    expect(screen.getByText('When to play it: Farewell')).toBeInTheDocument();
    const open = screen.getByRole('link', { name: /Open song/ });
    expect(open).toHaveAccessibleName(/^Open song\s*\(opens YouTube in a new tab\)$/);
    expect(open).toHaveAttribute('href', `https://www.youtube.com/watch?v=${YT}&t=30`);
    expect(open).toHaveAttribute('target', '_blank');
    expect(open).toHaveAttribute('rel', 'noopener noreferrer');
    // A link that fails the check is never rendered as a link.
    expect(screen.getAllByRole('link')).toHaveLength(1);
  });

  it('edits one song across both steps, keeping stored details; Cancel discards changes', async () => {
    const { api } = fakeSongsApi([song('s1', 'First', { moment: 'ARRIVAL', note: 'Keep me' }), song('s2', 'Second')]);
    renderWithClient(<WishSongs />);
    await userEvent.click(await screen.findByRole('button', { name: 'Edit First' }));
    let dialog = await screen.findByRole('dialog', { name: 'Edit song' });
    const title = within(dialog).getByLabelText('Song title');
    await userEvent.clear(title);
    await userEvent.type(title, 'Changed');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(api.called('PATCH', '/my-wishes/songs/s1')).toHaveLength(0);
    expect(screen.getByText('First')).toBeInTheDocument();
    // Focus returns to the control that opened the dialog.
    expect(screen.getByRole('button', { name: 'Edit First' })).toHaveFocus();

    await userEvent.click(screen.getByRole('button', { name: 'Edit First' }));
    dialog = await screen.findByRole('dialog', { name: 'Edit song' });
    expect(within(dialog).getByText('Step 1 of 2')).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Song title')).toHaveValue('First');
    await userEvent.clear(within(dialog).getByLabelText('Song title'));
    await userEvent.type(within(dialog).getByLabelText('Song title'), 'Renamed');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Continue' }));
    expect(await within(dialog).findByRole('radio', { name: 'Arrival' })).toBeChecked();
    expect(within(dialog).getByLabelText(/Personal note/)).toHaveValue('Keep me');
    // Editing never offers a skip that could clear stored details.
    expect(within(dialog).queryByRole('button', { name: 'Skip and save' })).not.toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save song' }));
    await waitFor(() => expect(api.called('PATCH', '/my-wishes/songs/s1')).toHaveLength(1));
    expect(api.called('PATCH', '/my-wishes/songs/s1')[0].body).toMatchObject({
      title: 'Renamed',
      moment: 'ARRIVAL',
      note: 'Keep me',
    });
    expect(api.called('POST', '/my-wishes/songs')).toHaveLength(0);
    expect(await screen.findByText('Renamed')).toBeInTheDocument();
    expect(screen.getByText('Second')).toBeInTheDocument();
  });

  it('removes only the chosen song, after confirming', async () => {
    const { api } = fakeSongsApi([song('s1', 'First'), song('s2', 'Second')]);
    renderWithClient(<WishSongs />);
    await userEvent.click(await screen.findByRole('button', { name: 'Remove Second' }));
    const dialog = await screen.findByRole('dialog', { name: 'Remove this song?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove song' }));
    await waitFor(() => expect(screen.queryByText('Second')).not.toBeInTheDocument());
    expect(api.called('DELETE', '/my-wishes/songs/s2')).toHaveLength(1);
    expect(api.called('DELETE', '/my-wishes/songs/s1')).toHaveLength(0);
    expect(screen.getByText('First')).toBeInTheDocument();
  });

  it('Move up / Move down reorder with the keyboard, announce, and keep focus', async () => {
    const { api } = fakeSongsApi([song('s1', 'First'), song('s2', 'Second'), song('s3', 'Third')]);
    renderWithClient(<WishSongs />);
    expect(await screen.findByRole('button', { name: 'Move First up' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move Third down' })).toBeDisabled();

    screen.getByRole('button', { name: 'Move First down' }).focus();
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(titlesShown()).toEqual(['Second', 'First', 'Third']));
    expect(api.called('PUT', '/my-wishes/songs/order')[0].body).toEqual({ songIds: ['s2', 's1', 's3'] });
    expect(await screen.findByText('First moved to position 2 of 3.')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Move First down' })).toHaveFocus());
  });

  it('a failed reorder says so and shows the saved order again', async () => {
    fakeSongsApi([song('s1', 'First'), song('s2', 'Second')], { failReorder: true });
    renderWithClient(<WishSongs />);
    await userEvent.click(await screen.findByRole('button', { name: 'Move Second up' }));
    expect(await screen.findByText('The new order wasn’t saved')).toBeInTheDocument();
    await waitFor(() => expect(titlesShown()).toEqual(['First', 'Second']));
  });

  it('appears on My Wishes (All and Music & readings), not on other filters', async () => {
    const routes = {
      'GET /my-wishes/disclaimer': json(200, { version: 1, text: 'Notice.' }),
      'GET /my-wishes/prompts': json(200, []),
      'GET /my-wishes/songs': json(200, []),
    };
    routeFetch(routes);
    const { unmount } = renderWithClient(<PromptList area="my-wishes" />);
    expect(await screen.findByRole('heading', { name: 'Music I’d like remembered' })).toBeInTheDocument();
    unmount();
    routeFetch(routes);
    renderWithClient(<PromptList area="my-wishes" category="CEREMONY" />);
    await screen.findByText('Notice.');
    expect(screen.queryByRole('heading', { name: 'Music I’d like remembered' })).not.toBeInTheDocument();
  });
});

describe('normaliseSongLink (browser mirror)', () => {
  it.each([
    [`https://youtu.be/${YT}?si=x`, `https://youtu.be/${YT}`],
    [`https://music.youtube.com/watch?v=${YT}`, `https://music.youtube.com/watch?v=${YT}`],
    [`https://open.spotify.com/track/${SP}`, `https://open.spotify.com/track/${SP}`],
  ])('accepts %s', (raw, expected) => expect(normaliseSongLink(raw)).toBe(expected));

  it.each([
    'javascript:alert(1)',
    'data:text/html,x',
    `http://youtu.be/${YT}`,
    `https://youtube.com.evil.example/watch?v=${YT}`,
    `https://a:b@youtu.be/${YT}`,
    'https://example.com/song',
  ])('rejects %s', (raw) => expect(normaliseSongLink(raw)).toBeNull());
});
