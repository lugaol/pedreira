require('dotenv').config();

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// --- Configuration ---
const MESSAGES_FILE = process.env.MESSAGES_FILE || './data/messages.jsonl';
const ALBUMS_FILE = process.env.ALBUMS_FILE || './data/albums.json';
const STATE_FILE = process.env.ALBUMS_STATE_FILE || './data/albums.state.json';
const OUTPUT_MD = process.env.ALBUMS_MD_FILE || './data/albums.md';
const OUTPUT_SPOTIFY = process.env.SPOTIFY_ALBUMS_FILE || './data/spotify_albums.json';
const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID || null;
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET || null;
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || null;

const SLEEP_MS = 150; // Be polite to APIs

// --- Helpers ---
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readJson(filePath, defaultValue = {}) {
  if (!fs.existsSync(filePath)) return defaultValue;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    console.warn(`Warning: could not read ${filePath}, starting fresh.`);
    return defaultValue;
  }
}

function writeJson(filePath, data) {
  ensureDir(filePath);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function hashLink(url) {
  return crypto.createHash('sha256').update(url).digest('hex').slice(0, 16);
}

function normalizeText(str) {
  if (!str) return '';
  return str
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function albumKey(artist, name) {
  return normalizeText(`${artist || ''} ${name || ''}`).replace(/\s+/g, ' ').trim();
}

function extractUrls(text) {
  if (!text) return [];
  const regex = /https?:\/\/[^\s<>"{}|\\^`\[\]]+/g;
  return [...text.matchAll(regex)].map((m) => m[0]);
}

function cleanUrl(url) {
  try {
    const u = new URL(url);
    // Remove common tracking params
    const keep = ['v', 'list', 'si', 't']; // for YouTube
    const search = new URLSearchParams();
    for (const [k, v] of u.searchParams) {
      if (keep.includes(k)) search.set(k, v);
    }
    return `${u.origin}${u.pathname}${search.toString() ? '?' + search.toString() : ''}`;
  } catch {
    return url;
  }
}

function classifyUrl(url) {
  const u = url.toLowerCase();
  if (u.includes('open.spotify.com') || u.includes('spotify.com')) return 'spotify';
  if (u.includes('music.youtube.com') || u.includes('youtube.com') || u.includes('youtu.be')) return 'youtube';
  if (u.includes('music.apple.com') || u.includes('itunes.apple.com')) return 'apple_music';
  if (u.includes('bandcamp.com')) return 'bandcamp';
  if (u.includes('deezer.com')) return 'deezer';
  if (u.includes('tidal.com')) return 'tidal';
  return 'unknown';
}

// --- Spotify Web API ---
let spotifyToken = null;
let spotifyTokenExpiry = 0;

async function getSpotifyToken() {
  if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET) return null;
  if (spotifyToken && Date.now() < spotifyTokenExpiry) return spotifyToken;

  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) {
    console.error('Failed to get Spotify token:', await res.text());
    return null;
  }
  const data = await res.json();
  spotifyToken = data.access_token;
  spotifyTokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  return spotifyToken;
}

async function spotifyApi(path, token) {
  const res = await fetch(`https://api.spotify.com/v1${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const text = await res.text();
    console.error(`Spotify API error ${path}:`, text.slice(0, 200));
    return null;
  }
  return res.json();
}

async function fetchSpotifyAlbumFromUrl(url) {
  const token = await getSpotifyToken();
  if (!token) return null;

  const match = url.match(/\/album\/(\w+)/);
  if (!match) return null;

  const data = await spotifyApi(`/albums/${match[1]}`, token);
  if (!data) return null;

  return {
    name: data.name,
    artist: data.artists?.map((a) => a.name).join(', '),
    spotifyUrl: data.external_urls?.spotify || url,
    image: data.images?.[0]?.url || null,
    releaseDate: data.release_date || null,
  };
}

async function searchSpotifyAlbum(query) {
  const token = await getSpotifyToken();
  if (!token) return null;

  const q = encodeURIComponent(query);
  const data = await spotifyApi(`/search?q=${q}&type=album&limit=1`, token);
  if (!data?.albums?.items?.length) return null;

  const item = data.albums.items[0];
  return {
    name: item.name,
    artist: item.artists?.map((a) => a.name).join(', '),
    spotifyUrl: item.external_urls?.spotify || `https://open.spotify.com/album/${item.id}`,
    image: item.images?.[0]?.url || null,
    releaseDate: item.release_date || null,
  };
}

async function fetchSpotifyOEmbed(url) {
  try {
    const res = await fetch(`https://open.spotify.com/oembed?url=${encodeURIComponent(url)}`);
    if (!res.ok) return null;
    return res.json();
  } catch (err) {
    return null;
  }
}

// --- YouTube / YouTube Music ---
async function fetchYouTubeOEmbed(url) {
  try {
    const res = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`);
    if (!res.ok) return null;
    return res.json();
  } catch (err) {
    return null;
  }
}

async function searchYouTube(query) {
  if (!YOUTUBE_API_KEY) return null;

  const q = encodeURIComponent(query);
  const res = await fetch(
    `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${q}&type=video&maxResults=1&key=${YOUTUBE_API_KEY}`
  );
  if (!res.ok) {
    console.error('YouTube API error:', await res.text());
    return null;
  }
  const data = await res.json();
  if (!data.items?.length) return null;
  const item = data.items[0];
  return {
    title: item.snippet.title,
    url: `https://www.youtube.com/watch?v=${item.id.videoId}`,
    thumbnail: item.snippet.thumbnails?.default?.url || null,
  };
}

// Free fallback: use ytmusicapi (Python) to search YouTube Music albums.
// Requires: .venv/bin/pip install ytmusicapi
function runPythonScript(scriptPath, args) {
  return new Promise((resolve, reject) => {
    const { spawn } = require('child_process');
    const proc = spawn('.venv/bin/python3', [scriptPath, ...args], {
      cwd: process.cwd(),
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (data) => (stdout += data.toString()));
    proc.stderr.on('data', (data) => (stderr += data.toString()));
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr || `Python script exited with code ${code}`));
      } else {
        resolve(stdout.trim());
      }
    });
  });
}

async function searchYouTubeMusic(query) {
  try {
    const output = await runPythonScript('scripts/ytmusic-search.py', [query]);
    if (!output) return null;
    const result = JSON.parse(output);
    if (!result || result.error || !result.url) return null;
    return {
      title: result.title,
      url: result.url,
      thumbnail: result.thumbnail || null,
    };
  } catch (err) {
    console.error('YouTube Music search error:', err.message);
    return null;
  }
}

// --- Generic title fetch (fallback) ---
async function fetchPageTitle(url) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) return null;
    const html = await res.text();
    const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
    return titleMatch ? titleMatch[1].trim() : null;
  } catch (err) {
    return null;
  }
}

// --- Album merging ---
function findOrCreateAlbum(albums, name, artist) {
  const key = albumKey(artist, name);
  if (!key) return null;

  let existing = albums.find((a) => a.key === key);
  if (!existing) {
    existing = {
      id: `album-${albums.length + 1}`,
      key,
      name: name || 'Unknown',
      artist: artist || 'Unknown',
      aliases: [key],
      sources: [], // { platform, url, title, date }
      spotifyUrl: null,
      youtubeUrl: null,
      appleMusicUrl: null,
      otherUrls: [],
      image: null,
      releaseDate: null,
      discoveredAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    albums.push(existing);
  } else {
    // Merge aliases
    if (!existing.aliases.includes(key)) existing.aliases.push(key);
    existing.updatedAt = new Date().toISOString();
  }
  return existing;
}

function addSource(album, platform, url, title = null) {
  if (!album.sources.find((s) => s.url === url)) {
    album.sources.push({ platform, url, title, addedAt: new Date().toISOString() });
  }

  if (platform === 'spotify' && !album.spotifyUrl) album.spotifyUrl = url;
  if (platform === 'youtube' && !album.youtubeUrl) album.youtubeUrl = url;
  if (platform === 'apple_music' && !album.appleMusicUrl) album.appleMusicUrl = url;
  if (platform === 'unknown' && !album.otherUrls.includes(url)) album.otherUrls.push(url);
}

// --- URL processing ---
async function processUrl(url, albums, state) {
  const clean = cleanUrl(url);
  const hash = hashLink(clean);
  if (state.processedLinks.includes(hash)) return;

  const platform = classifyUrl(clean);
  let album = null;

  if (platform === 'spotify') {
    const apiData = await fetchSpotifyAlbumFromUrl(clean);
    if (apiData) {
      album = findOrCreateAlbum(albums, apiData.name, apiData.artist);
      if (album) {
        addSource(album, 'spotify', apiData.spotifyUrl || clean, apiData.name);
        if (apiData.image) album.image = apiData.image;
        if (apiData.releaseDate) album.releaseDate = apiData.releaseDate;
      }
    } else {
      // Try oEmbed fallback
      const oembed = await fetchSpotifyOEmbed(clean);
      if (oembed?.title) {
        album = findOrCreateAlbum(albums, oembed.title, null);
        if (album) addSource(album, 'spotify', clean, oembed.title);
      }
    }
  } else if (platform === 'youtube') {
    const oembed = await fetchYouTubeOEmbed(clean);
    if (oembed?.title) {
      // Try to guess artist from "Artist - Title" convention
      let artist = null;
      let name = oembed.title;
      const dashMatch = oembed.title.match(/^(.+?)\s+-\s+(.+)$/);
      if (dashMatch) {
        artist = dashMatch[1].trim();
        name = dashMatch[2].trim();
      }
      album = findOrCreateAlbum(albums, name, artist);
      if (album) addSource(album, 'youtube', clean, oembed.title);
    }
  } else {
    const title = await fetchPageTitle(clean);
    album = findOrCreateAlbum(albums, title || clean, null);
    if (album) addSource(album, 'unknown', clean, title || clean);
  }

  await sleep(SLEEP_MS);
  state.processedLinks.push(hash);
}

async function batchSearchYouTubeMusic(albumsToSearch) {
  // albumsToSearch: array of { album, query }
  const queries = albumsToSearch.map((x) => x.query);
  if (!queries.length) return;

  console.log(`Batching ${queries.length} YouTube Music search(es)...`);
  try {
    const { spawn } = require('child_process');
    const proc = spawn('.venv/bin/python3', ['scripts/ytmusic-search.py', '--batch'], {
      cwd: process.cwd(),
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (data) => (stdout += data.toString()));
    proc.stderr.on('data', (data) => (stderr += data.toString()));

    const finished = new Promise((resolve, reject) => {
      proc.on('close', (code) => {
        if (code !== 0) reject(new Error(stderr || `ytmusic-search exited with ${code}`));
        else resolve();
      });
    });

    proc.stdin.write(JSON.stringify(queries));
    proc.stdin.end();

    await finished;

    const results = JSON.parse(stdout.trim());
    for (const { album, query } of albumsToSearch) {
      const result = results[query];
      if (result && !result.error && result.url) {
        album.youtubeUrl = result.url;
        addSource(album, 'youtube', result.url, `Search: ${result.title}`);
        if (result.thumbnail && !album.image) album.image = result.thumbnail;
      }
    }
  } catch (err) {
    console.error('Batch YouTube Music search failed:', err.message);
  }
}

// --- Search enrichment ---
async function enrichAlbums(albums) {
  if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET) {
    console.log('No Spotify credentials; skipping Spotify search enrichment.');
  }
  if (!YOUTUBE_API_KEY) {
    console.log('No YouTube API key; using ytmusicapi (YouTube Music) fallback.');
  }

  const youtubeMusicBatch = [];

  for (const album of albums) {
    if (!album.name || album.name === 'Unknown') continue;

    const query = `${album.artist || ''} ${album.name}`.trim();

    // Backfill Spotify metadata for albums that already have a Spotify link but no artist
    if (SPOTIFY_CLIENT_ID && SPOTIFY_CLIENT_SECRET && album.spotifyUrl && (album.artist === 'Unknown' || !album.artist)) {
      try {
        const result = await fetchSpotifyAlbumFromUrl(album.spotifyUrl);
        if (result) {
          album.name = result.name || album.name;
          album.artist = result.artist || album.artist;
          if (result.image) album.image = result.image;
          if (result.releaseDate) album.releaseDate = result.releaseDate;
        }
      } catch (err) {
        console.error('Spotify metadata fetch failed for', album.spotifyUrl, err.message);
      }
      await sleep(SLEEP_MS);
    }

    // Search Spotify if album has no Spotify link yet
    if (SPOTIFY_CLIENT_ID && SPOTIFY_CLIENT_SECRET && !album.spotifyUrl) {
      try {
        const result = await searchSpotifyAlbum(query);
        if (result) {
          album.spotifyUrl = result.spotifyUrl;
          album.name = result.name || album.name;
          album.artist = result.artist || album.artist;
          if (result.image) album.image = result.image;
          if (result.releaseDate) album.releaseDate = result.releaseDate;
          addSource(album, 'spotify', result.spotifyUrl, `Search: ${result.name}`);
        }
      } catch (err) {
        console.error('Spotify search failed for', query, err.message);
      }
      await sleep(SLEEP_MS);
    }

    // Collect YouTube Music queries for batch processing
    if (!album.youtubeUrl) {
      if (YOUTUBE_API_KEY) {
        try {
          const result = await searchYouTube(`${query} full album`);
          if (result) {
            album.youtubeUrl = result.url;
            addSource(album, 'youtube', result.url, `Search: ${result.title}`);
          }
        } catch (err) {
          console.error('YouTube API search failed for', query, err.message);
        }
        await sleep(SLEEP_MS);
      } else {
        youtubeMusicBatch.push({ album, query });
      }
    }
  }

  // Batch YouTube Music search (one Python process for all queries)
  await batchSearchYouTubeMusic(youtubeMusicBatch);
}

// --- Output generation ---
function generateMarkdown(albums) {
  const rows = albums
    .filter((a) => a.spotifyUrl || a.youtubeUrl)
    .map((a) => {
      const links = [];
      if (a.spotifyUrl) links.push(`[Spotify](${a.spotifyUrl})`);
      if (a.youtubeUrl) links.push(`[YouTube](${a.youtubeUrl})`);
      if (a.appleMusicUrl) links.push(`[Apple Music](${a.appleMusicUrl})`);
      if (a.otherUrls.length) links.push(...a.otherUrls.map((u) => `<${u}>`));
      return `| ${a.artist || ''} | ${a.name} | ${links.join('<br>')} |`;
    });

  return [
    '# Albums from chat history',
    '',
    '| Artist | Album | Links |',
    '|--------|-------|-------|',
    ...rows,
    '',
    `Total: ${rows.length} albums with links.`,
  ].join('\n');
}

function generateSpotifyAlbums(albums) {
  return albums
    .filter((a) => a.spotifyUrl)
    .map((a) => ({
      artist: a.artist,
      album: a.name,
      spotifyUrl: a.spotifyUrl,
      youtubeUrl: a.youtubeUrl,
      image: a.image,
      releaseDate: a.releaseDate,
    }));
}

// --- Main ---
async function main() {
  let state = readJson(STATE_FILE, { processedMessageIds: [], processedLinks: [] });
  let albums = readJson(ALBUMS_FILE, []);

  if (!fs.existsSync(MESSAGES_FILE)) {
    console.error(`Messages file not found: ${path.resolve(MESSAGES_FILE)}`);
    process.exit(1);
  }

  console.log(`Loading messages from ${path.resolve(MESSAGES_FILE)}...`);
  const messages = fs
    .readFileSync(MESSAGES_FILE, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));

  const newMessages = messages.filter((m) => !state.processedMessageIds.includes(m.id));
  console.log(`Found ${messages.length} total message(s), ${newMessages.length} new to process.`);

  let linkCount = 0;
  for (const msg of newMessages) {
    const urls = extractUrls(msg.text);
    for (const url of urls) {
      await processUrl(url, albums, state);
      linkCount++;
    }
    state.processedMessageIds.push(msg.id);
  }

  console.log(`Processed ${linkCount} new link(s). Enriching ${albums.length} album(s)...`);
  await enrichAlbums(albums);

  // Save state and albums
  writeJson(STATE_FILE, state);
  writeJson(ALBUMS_FILE, albums);

  // Generate outputs
  const md = generateMarkdown(albums);
  fs.writeFileSync(OUTPUT_MD, md);

  const spotifyAlbums = generateSpotifyAlbums(albums);
  writeJson(OUTPUT_SPOTIFY, spotifyAlbums);

  console.log(`\nDone.`);
  console.log(`Albums: ${path.resolve(ALBUMS_FILE)}`);
  console.log(`Markdown: ${path.resolve(OUTPUT_MD)}`);
  console.log(`Spotify-only list: ${path.resolve(OUTPUT_SPOTIFY)}`);
  console.log(`Albums with Spotify links: ${spotifyAlbums.length}`);
}

main().catch((err) => {
  console.error('Failed:', err);
  process.exit(1);
});
