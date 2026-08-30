#!/usr/bin/env node
/**
 * Spotify monthly playlist sync for Pedreira
 * - Reads web/data.json (monthly grouping) and checks existing playlists via spclient
 * - For missing months (Agosto) creates new playlist, for existing adds missing tracks
 * - Requires user OAuth token with playlist-modify-public scope
 *
 * Usage:
 *   node scripts/spotify-sync.js --dry-run   # just print what would be done
 *   node scripts/spotify-sync.js --auth      # start OAuth flow and cache token to .spotify_token.json
 *   node scripts/spotify-sync.js             # sync using cached token (requires --auth first)
 *
 * Token cache: .spotify_token.json (gitignored)
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { exec } = require('child_process');

const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const REDIRECT_URI = process.env.SPOTIFY_REDIRECT_URI || 'http://localhost:8888/callback';
const TOKEN_PATH = path.join(__dirname, '..', '.spotify_token.json');
const DATA_PATH = path.join(__dirname, '..', 'web', 'data.json');

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Missing SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET in .env');
  process.exit(1);
}

const SCOPES = 'playlist-modify-public playlist-modify-private playlist-read-private';

function loadToken() {
  if (!fs.existsSync(TOKEN_PATH)) return null;
  try { return JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8')); } catch { return null; }
}
function saveToken(tok) { fs.writeFileSync(TOKEN_PATH, JSON.stringify(tok, null, 2)); console.log(`Saved token to ${TOKEN_PATH}`); }

async function authFlow() {
  const state = crypto.randomBytes(12).toString('hex');
  const authUrl = `https://accounts.spotify.com/authorize?client_id=${encodeURIComponent(CLIENT_ID)}&response_type=code&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=${encodeURIComponent(SCOPES)}&state=${state}`;

  console.log('\n=== Spotify OAuth ===');
  console.log(`1. Opening browser to authorize:\n   ${authUrl}\n`);
  console.log(`2. Make sure "${REDIRECT_URI}" is added as Redirect URI in https://developer.spotify.com/dashboard\n`);
  // Try to open browser
  exec(`open "${authUrl}"`, () => {});
  exec(`xdg-open "${authUrl}"`, () => {});

  const code = await new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://localhost:8888`);
      if (url.pathname === '/callback') {
        const c = url.searchParams.get('code');
        const s = url.searchParams.get('state');
        const err = url.searchParams.get('error');
        if (err) {
          res.writeHead(400, { 'Content-Type': 'text/html' });
          res.end(`<h1>Error: ${err}</h1>`);
          server.close();
          reject(new Error(err));
          return;
        }
        if (s !== state) {
          res.writeHead(400, { 'Content-Type': 'text/html' });
          res.end('<h1>State mismatch</h1>');
          server.close();
          reject(new Error('state mismatch'));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<h1>Authorized! You can close this window and return to terminal.</h1>');
        server.close();
        resolve(c);
      } else {
        res.writeHead(404); res.end();
      }
    });
    server.listen(8888, () => console.log('Waiting for callback on http://localhost:8888/callback ...'));
    server.on('error', reject);
  });

  console.log(`\nGot code ${code.slice(0,20)}..., exchanging for token...`);
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
  });
  const r = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });
  if (!r.ok) {
    console.error('Token exchange failed', await r.text());
    process.exit(1);
  }
  const tok = await r.json();
  tok.obtained_at = Date.now();
  // tok has access_token, refresh_token, expires_in
  saveToken(tok);
  console.log('Auth success. Access token expires in', tok.expires_in);
  return tok;
}

async function refreshToken(tok) {
  if (!tok.refresh_token) return tok;
  // Check if expired (with 60s buffer)
  if (Date.now() < tok.obtained_at + (tok.expires_in - 60) * 1000) return tok;
  console.log('Refreshing token...');
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: tok.refresh_token,
  });
  const r = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });
  if (!r.ok) {
    console.error('Refresh failed', await r.text());
    return tok;
  }
  const nt = await r.json();
  tok.access_token = nt.access_token;
  tok.expires_in = nt.expires_in;
  tok.obtained_at = Date.now();
  if (nt.refresh_token) tok.refresh_token = nt.refresh_token;
  saveToken(tok);
  return tok;
}

async function api(path, token, opts = {}) {
  const r = await fetch(`https://api.spotify.com/v1${path}`, {
    ...opts,
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  if (r.status === 429) {
    const wait = parseInt(r.headers.get('Retry-After') || '5', 10);
    console.log(`429 rate limited, waiting ${wait}s...`);
    await new Promise((res) => setTimeout(res, (wait + 1) * 1000));
    return api(path, token, opts);
  }
  return r;
}

// For reading playlist tracks without user token, use spclient (anonymous)
async function getEmbedToken(pid) {
  const r = await fetch(`https://open.spotify.com/embed/playlist/${pid}`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const txt = await r.text();
  const m = txt.match(/"accessToken"\s*:\s*"([^"]+)"/);
  return m ? m[1] : null;
}
async function fetchSpclientTracks(pid) {
  const tok = await getEmbedToken(pid);
  if (!tok) return new Set();
  const r = await fetch(`https://spclient.wg.spotify.com/playlist/v2/playlist/${pid}`, { headers: { 'Authorization': `Bearer ${tok}`, 'app-platform': 'WebPlayer' } });
  if (!r.ok) return new Set();
  const buf = Buffer.from(await r.arrayBuffer());
  const tracks = [...buf.toString('latin1').matchAll(/spotify:track:([A-Za-z0-9]+)/g)].map((m) => m[1]);
  return new Set(tracks);
}
// Fetch album tracks via embed scraping (avoids API rate limit)
async function fetchAlbumTracksEmbed(aid) {
  const r = await fetch(`https://open.spotify.com/embed/album/${aid}`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const txt = await r.text();
  const m = txt.match(/<script id="__NEXT_DATA__"[^>]*>(.*?)<\/script>/s);
  if (!m) {
    // fallback regex
    const tracks = [...txt.matchAll(/spotify:track:([A-Za-z0-9]+)/g)].map((x) => x[1]);
    return new Set(tracks);
  }
  try {
    const data = JSON.parse(m[1]);
    const entity = data.props.pageProps.state.data.entity;
    const list = entity.trackList || [];
    const tids = list.map((t) => (t.uri.match(/spotify:track:([A-Za-z0-9]+)/)||[])[1]).filter(Boolean);
    return new Set(tids);
  } catch {
    const tracks = [...txt.matchAll(/spotify:track:([A-Za-z0-9]+)/g)].map((x) => x[1]);
    return new Set(tracks);
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--auth')) {
    await authFlow();
    return;
  }
  const dryRun = args.includes('--dry-run');
  const data = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
  const monthly = data.monthly || [];
  const pending = data.pending || {};

  // Build albumId -> album
  const albumById = new Map(data.albums.map((a) => [a.id, a]));
  // For pending, we have simplified but we can use data.albums for full
  console.log(`\n=== Pedreira monthly sync ===`);
  console.log(`Total albums ${data.totalAlbums}, monthly groups ${monthly.length}, pending ${pending.totalPending}`);

  // For each month, determine which albums should be in playlist
  // Use monthly[].albums (list of album ids) as source of truth (from messages)
  // For verification, fetch actual playlist tracks via spclient and compare
  for (const m of monthly) {
    const albumIds = m.albums || [];
    // Resolve to spotify album IDs
    const spotifyAlbums = albumIds.map((id) => albumById.get(id)).filter((a) => a && a.spotifyId).map((a) => a.spotifyId);
    console.log(`\n${m.label} ${m.month}: ${spotifyAlbums.length} spotify albums (of ${albumIds.length} total)`);
    if (m.url) console.log(`  Existing playlist: ${m.url}`);
    else console.log(`  No playlist yet — would create "${m.label}"`);
    // If dryRun, just show first 3
    if (spotifyAlbums.length) {
      console.log(`  Sample: ${spotifyAlbums.slice(0,3).join(', ')}`);
    }
    if (!m.playlistId) {
      if (dryRun) {
        console.log(`  [dry-run] Would create playlist "${m.label}" with ${spotifyAlbums.length} albums -> ~${spotifyAlbums.length*10} tracks`);
      } else {
        console.log(`  -> Need to create new playlist for ${m.label} (run with --auth and without --dry-run to execute)`);
      }
      continue;
    }
    // For existing, check what's missing
    const pTracks = await fetchSpclientTracks(m.playlistId);
    console.log(`  Playlist has ${pTracks.size} tracks`);
    let missingAlbums = 0;
    for (const aid of spotifyAlbums) {
      const atracks = await fetchAlbumTracksEmbed(aid);
      const inter = [...atracks].some((t) => pTracks.has(t));
      if (!inter) missingAlbums++;
      // small delay to be polite
      await new Promise((r) => setTimeout(r, 120));
    }
    console.log(`  Missing in playlist: ${missingAlbums}/${spotifyAlbums.length}`);
    if (missingAlbums > 0) {
      console.log(`  -> Would add ${missingAlbums} albums' tracks to ${m.label}`);
      if (!dryRun) console.log(`     (requires --auth token to write)`);
    }
    // polite delay between months
    await new Promise((r) => setTimeout(r, 500));
  }

  if (dryRun) {
    console.log('\nDry run done. To actually sync, run:');
    console.log('  node scripts/spotify-sync.js --auth   # one-time login');
    console.log('  node scripts/spotify-sync.js           # sync all months');
    return;
  }

  // Need token for write
  let tok = loadToken();
  if (!tok) {
    console.log('\nNo token found. Run with --auth first to login.');
    console.log('  node scripts/spotify-sync.js --auth');
    return;
  }
  tok = await refreshToken(tok);
  const access = tok.access_token;

  // Get user id
  const meR = await api('/me', access);
  if (!meR.ok) {
    console.error('Failed to get user', await meR.text());
    return;
  }
  const me = await meR.json();
  console.log(`\nAuthenticated as ${me.display_name} (${me.id})`);

  for (const m of monthly) {
    const albumIds = m.albums || [];
    const spotifyAlbums = albumIds.map((id) => albumById.get(id)).filter((a) => a && a.spotifyId);
    if (!spotifyAlbums.length) continue;

    let playlistId = m.playlistId;
    if (!playlistId) {
      console.log(`\nCreating playlist for ${m.label}...`);
      const r = await api(`/me/playlists`, access, {
        method: 'POST',
        body: JSON.stringify({
          name: `Só Pedradas - Álbuns - ${m.label}`,
          description: `Álbuns compartilhados no grupo "Só Pedradas — Albuns" em ${m.label}. Gerado automaticamente.`,
          public: true,
        }),
      });
      if (!r.ok) {
        console.error(`Failed to create ${m.label}`, await r.text());
        continue;
      }
      const pl = await r.json();
      playlistId = pl.id;
      console.log(`Created ${pl.name}: ${pl.external_urls.spotify}`);
      // Update data.json locally? For now just log
    }

    // Fetch current tracks to avoid duplicates
    const pTracks = await fetchSpclientTracks(playlistId);
    const toAdd = [];
    for (const alb of spotifyAlbums) {
      const atracks = await fetchAlbumTracksEmbed(alb.spotifyId);
      const existing = [...atracks].some((t) => pTracks.has(t));
      if (!existing) {
        // Add all tracks from this album
        for (const t of atracks) toAdd.push(`spotify:track:${t}`);
      }
      await new Promise((r) => setTimeout(r, 80));
    }
    if (!toAdd.length) {
      console.log(`${m.label}: nothing to add, already complete`);
      continue;
    }
    console.log(`${m.label}: adding ${toAdd.length} tracks from ${toAdd.length/10|0} albums to ${playlistId}...`);
    // Add in batches of 100 — use /items (new) with fallback to /tracks
    for (let i = 0; i < toAdd.length; i += 100) {
      const batch = toAdd.slice(i, i + 100);
      let r = await api(`/playlists/${playlistId}/items`, access, {
        method: 'POST',
        body: JSON.stringify({ uris: batch, position: 0 }),
      });
      if (!r.ok && r.status === 404) {
        // fallback for older API
        r = await api(`/playlists/${playlistId}/tracks`, access, {
          method: 'POST',
          body: JSON.stringify({ uris: batch }),
        });
      }
      if (!r.ok) {
        console.error(`Failed to add batch ${i}`, await r.text());
      } else {
        console.log(`  added batch ${i/100 + 1} (${batch.length} tracks)`);
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  console.log('\nSync complete.');
}

main().catch((e) => { console.error(e); process.exit(1); });
