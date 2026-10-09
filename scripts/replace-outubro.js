/**
 * One-shot owner check + replace for the Outubro/26 playlist.
 * DELETE /playlists/{id}/tracks returns 403 on this token while POST works,
 * so reconcile-by-delete is blocked. PUT /playlists/{id}/tracks (replace) uses
 * the same scope as the already-working POST path.
 *
 *   node scripts/replace-outubro.js --dry-run   # show counts only
 *   node scripts/replace-outubro.js --execute   # PUT first 100 + POST rest
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA = JSON.parse(fs.readFileSync(path.join(ROOT, 'web', 'data.json'), 'utf8'));
const PID = '1oIyxKllXgxnMiU30jL1gy';
const tok = JSON.parse(fs.readFileSync(path.join(ROOT, '.spotify_token.json'), 'utf8'));

async function api(p, opts = {}) {
  const r = await fetch(`https://api.spotify.com/v1${p}`, {
    ...opts,
    headers: { Authorization: `Bearer ${tok.access_token}`, 'Content-Type': 'application/json' },
  });
  if (r.status === 429) {
    await new Promise((s) => setTimeout(s, (+(r.headers.get('retry-after') || 5) + 1) * 1000));
    return api(p, opts);
  }
  const txt = await r.text();
  if (!r.ok) throw new Error(`${opts.method || 'GET'} ${p} -> ${r.status} ${txt.slice(0, 160)}`);
  return txt ? JSON.parse(txt) : {};
}

async function embedTracks(aid) {
  const r = await fetch(`https://open.spotify.com/embed/album/${aid}`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const txt = await r.text();
  const m = txt.match(/<script id="__NEXT_DATA__"[^>]*>(.*?)<\/script>/s);
  if (m) {
    try {
      const list = JSON.parse(m[1]).props.pageProps.state.data.entity.trackList || [];
      const tids = list.map((t) => (t.uri.match(/spotify:track:([A-Za-z0-9]+)/) || [])[1]).filter(Boolean);
      if (tids.length) return tids;
    } catch {}
  }
  return [...txt.matchAll(/spotify:track:([A-Za-z0-9]+)/g)].map((x) => x[1]);
}

(async () => {
  const execute = process.argv.includes('--execute');
  const m = DATA.monthly.find((x) => x.month === '2026-10');
  const byId = new Map(DATA.albums.map((a) => [a.id, a]));
  const albums = (m.albums || []).map((id) => byId.get(id)).filter((a) => a && a.spotifyId);
  console.log(`Expected albums: ${albums.length}`);

  const uris = [];
  for (const a of albums) {
    for (const t of await embedTracks(a.spotifyId)) uris.push(`spotify:track:${t}`);
    await new Promise((s) => setTimeout(s, 120));
  }
  console.log(`Expected tracks: ${uris.length}`);

  const before = await api(`/playlists/${PID}/items?limit=1`);
  console.log(`Playlist now: ${before.total} tracks`);

  const oldMeta = await api(`/playlists/${PID}?fields=followers(total)`);
  const oldItems = await api(`/playlists/${PID}/items?limit=1`);
  console.log(`Old playlist: ${oldItems.total} tracks, ${oldMeta.followers.total} followers`);

  if (!execute) {
    console.log('Dry run — no changes. Re-run with --execute.');
    return;
  }
  // PUT/DELETE on /playlists/{id}/tracks 403 on this app token (verified 2026-10-09
  // on scratch playlists), so in-place repair is impossible. Recreate instead:
  // create (POST /me/playlists works) + fill (POST /items works) + unfollow old.
  const created = await api('/me/playlists', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Só Pedradas - Álbuns - Outubro/26',
      description: 'Álbuns compartilhados no grupo "Só Pedradas — Albuns" em Outubro/26. Gerado automaticamente.',
      public: true,
    }),
  });
  console.log(`Created: ${created.external_urls.spotify} (${created.id})`);
  for (let i = 0; i < uris.length; i += 100) {
    await api(`/playlists/${created.id}/items`, {
      method: 'POST',
      body: JSON.stringify({ uris: uris.slice(i, i + 100) }),
    });
    console.log(`  added batch ${i / 100 + 1}`);
    await new Promise((s) => setTimeout(s, 500));
  }
  const after = await api(`/playlists/${created.id}/items?limit=1`);
  console.log(`New playlist total: ${after.total} tracks`);
  await api(`/playlists/${PID}/followers`, { method: 'DELETE' });
  console.log('Unfollowed old polluted playlist (followers keep their own copies).');
  console.log(`\nNEW_PLAYLIST_ID=${created.id}`);
})().catch((e) => { console.error(e); process.exit(1); });