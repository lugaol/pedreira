#!/usr/bin/env node
/**
 * Spotify playlist reconciler for Pedreira.
 *
 * spotify-sync.js is add-only: it never removes tracks. After the stale-export
 * incident (Oct playlist received 475 tracks belonging to September albums), the
 * extra tracks stayed forever. This script reconciles a monthly playlist to exactly
 * the track set of its expected albums in web/data.json:
 *
 *   node scripts/spotify-prune.js --month=2026-10 --dry-run   # show what would change
 *   node scripts/spotify-prune.js --month=2026-10 --execute   # remove foreign + add missing
 *
 * Expected tracks come from Spotify embed scraping (no API rate limit), the same
 * source spotify-sync.js uses. Playlist contents are read via the Web API with
 * limit=50 pagination (/items with limit=100 returns 410 on these playlists).
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');

const TOKEN_PATH = path.join(__dirname, '..', '.spotify_token.json');
const DATA_PATH = process.env.DATA_PATH || path.join(__dirname, '..', 'web', 'data.json');

function loadToken() {
  return JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
}

async function api(p, token, opts = {}) {
  const r = await fetch(`https://api.spotify.com/v1${p}`, {
    ...opts,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  if (r.status === 429) {
    const wait = parseInt(r.headers.get('Retry-After') || '5', 10);
    console.log(`  429, waiting ${wait}s...`);
    await new Promise((s) => setTimeout(s, (wait + 1) * 1000));
    return api(p, token, opts);
  }
  if (r.status === 401) throw new Error('token expired — run npm run spotify:sync once to refresh, then retry');
  if (!r.ok) throw new Error(`${p} -> ${r.status} ${await r.text()}`);
  return r.json();
}

async function fetchAlbumTracksEmbed(aid) {
  const r = await fetch(`https://open.spotify.com/embed/album/${aid}`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const txt = await r.text();
  const m = txt.match(/<script id="__NEXT_DATA__"[^>]*>(.*?)<\/script>/s);
  if (m) {
    try {
      const list = JSON.parse(m[1]).props.pageProps.state.data.entity.trackList || [];
      const tids = list.map((t) => (t.uri.match(/spotify:track:([A-Za-z0-9]+)/) || [])[1]).filter(Boolean);
      if (tids.length) return new Set(tids);
    } catch { /* fall through to regex */ }
  }
  return new Set([...txt.matchAll(/spotify:track:([A-Za-z0-9]+)/g)].map((x) => x[1]));
}

async function playlistEntries(pid, token) {
  const out = [];
  for (let off = 0; off <= 20000; off += 50) {
    const j = await api(`/playlists/${pid}/items?limit=50&offset=${off}`, token);
    for (const it of j.items || []) {
      const t = it.track || it.item;
      if (t && t.uri) out.push({ uri: t.uri, name: t.name, album: t.album && t.album.name });
    }
    if (!j.next) break;
    await new Promise((s) => setTimeout(s, 200));
  }
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  const monthArg = (args.find((a) => a.startsWith('--month=')) || '').split('=')[1];
  const execute = args.includes('--execute');
  const dryRun = !execute;
  if (!monthArg) {
    console.error('Usage: node scripts/spotify-prune.js --month=YYYY-MM [--execute]');
    process.exit(1);
  }

  const data = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
  const m = data.monthly.find((x) => x.month === monthArg);
  if (!m || !m.playlistId) {
    console.error(`No playlist for month ${monthArg} in web/data.json`);
    process.exit(1);
  }
  const albumById = new Map(data.albums.map((a) => [a.id, a]));
  const expectedAlbums = (m.albums || []).map((id) => albumById.get(id)).filter((a) => a && a.spotifyId);
  console.log(`\n=== Reconcile ${m.label} (${m.playlistId})`);
  console.log(`Expected albums: ${expectedAlbums.length} of ${m.albums.length} total`);

  const expected = new Set();
  const emptyAlbums = [];
  for (const a of expectedAlbums) {
    const tids = await fetchAlbumTracksEmbed(a.spotifyId);
    if (!tids.size) emptyAlbums.push(`${a.artist} - ${a.name}`);
    for (const t of tids) expected.add(`spotify:track:${t}`);
    await new Promise((s) => setTimeout(s, 120));
  }
  console.log(`Expected tracks: ${expected.size}`);
  if (emptyAlbums.length) console.log(`Albums with no tracks via embed (skipped):\n  - ${emptyAlbums.join('\n  - ')}`);

  const tok = loadToken();
  const entries = await playlistEntries(m.playlistId, tok.access_token);
  const inPlaylist = new Set(entries.map((e) => e.uri));
  console.log(`Playlist tracks: ${entries.length}`);

  const foreign = entries.filter((e) => !expected.has(e.uri));
  const foreignUris = [...new Set(foreign.map((e) => e.uri))];
  const missing = [...expected].filter((u) => !inPlaylist.has(u));

  console.log(`Foreign (would remove): ${foreignUris.length}`);
  if (foreignUris.length) {
    const byAlbum = new Map();
    for (const e of foreign) {
      if (!byAlbum.has(e.album)) byAlbum.set(e.album, 0);
      byAlbum.set(e.album, byAlbum.get(e.album) + 1);
    }
    for (const [album, n] of [...byAlbum].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${String(n).padStart(4)} — ${album}`);
    }
  }
  console.log(`Missing (would add): ${missing.length}`);

  if (dryRun) {
    console.log('\nDry run — no changes. Re-run with --execute to apply.');
    return;
  }

  if (foreignUris.length) {
    console.log(`\nRemoving ${foreignUris.length} tracks...`);
    for (let i = 0; i < foreignUris.length; i += 100) {
      const batch = foreignUris.slice(i, i + 100).map((uri) => ({ uri }));
      await api(`/playlists/${m.playlistId}/tracks`, tok.access_token, {
        method: 'DELETE',
        body: JSON.stringify({ tracks: batch }),
      });
      console.log(`  removed batch ${i / 100 + 1}`);
      await new Promise((s) => setTimeout(s, 500));
    }
  }
  if (missing.length) {
    console.log(`Adding ${missing.length} tracks...`);
    for (let i = 0; i < missing.length; i += 100) {
      const batch = missing.slice(i, i + 100);
      await api(`/playlists/${m.playlistId}/tracks`, tok.access_token, {
        method: 'POST',
        body: JSON.stringify({ uris: batch }),
      });
      console.log(`  added batch ${i / 100 + 1}`);
      await new Promise((s) => setTimeout(s, 500));
    }
  }
  console.log('\nReconcile complete.');
}

main().catch((e) => { console.error(e); process.exit(1); });
