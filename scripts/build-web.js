const fs = require('fs');
const path = require('path');
require('dotenv').config();

const ALBUMS_FILE = process.env.ALBUMS_FILE || './data/albums.json';
const MESSAGES_FILE = process.env.MESSAGES_FILE || './data/messages.jsonl';
const OUTPUT_DIR = path.join(__dirname, '..', 'web');
const OUTPUT_FILE = path.join(OUTPUT_DIR, 'data.json');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function extractUrls(text) {
  if (!text) return [];
  const regex = /https?:\/\/[^\s<>"{}|\\^`\[\]]+/g;
  return [...text.matchAll(regex)].map((m) => m[0]);
}

function normalizeUrl(url) {
  try {
    const u = new URL(url);
    // For Spotify, only the path matters for matching album IDs.
    // For YouTube, keep v and list params.
    const keep = new Set(['v', 'list']);
    const search = new URLSearchParams();
    for (const [k, v] of u.searchParams) {
      if (keep.has(k)) search.set(k, v);
    }
    return `${u.origin}${u.pathname}${search.toString() ? '?' + search.toString() : ''}`;
  } catch {
    return url;
  }
}

function extractSpotifyId(url) {
  try {
    const u = new URL(url);
    const match = u.pathname.match(/\/album\/(\w+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

function extractYoutubeId(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    if (host === 'youtu.be' || host.endsWith('.youtu.be')) {
      return u.pathname.split('/').filter(Boolean)[0] || null;
    }
    if (host.includes('youtube.com')) {
      const v = u.searchParams.get('v');
      if (v) return v;
      const match = u.pathname.match(/\/(embed|shorts|live)\/([\w-]+)/);
      if (match) return match[2];
    }
    return null;
  } catch {
    return null;
  }
}

function extractYoutubeList(url) {
  try {
    const u = new URL(url);
    if (!u.hostname.toLowerCase().includes('youtube.com')) return null;
    if (!u.pathname.startsWith('/playlist')) return null;
    return u.searchParams.get('list');
  } catch {
    return null;
  }
}

// Only albums actually shared via Spotify or YouTube belong in the album grid.
// Anything else (Instagram, Facebook, Deezer, share links...) goes to Social media.
function hasDirectMusicSource(album) {
  return (album.sources || []).some(
    (s) =>
      !String(s.title).startsWith('Search:') &&
      (s.platform === 'spotify' || s.platform === 'youtube')
  );
}

function parseArtistTitle(raw) {
  const title = String(raw).trim();
  // Try "Artist - Title" convention first.
  const dashMatch = title.match(/^(.+?)\s+-\s+(.+)$/);
  if (dashMatch) {
    return {
      artist: dashMatch[1].trim(),
      title: dashMatch[2].trim(),
    };
  }
  return { artist: '', title };
}

function classifyUrl(url) {
  try {
    const u = new URL(url).hostname.toLowerCase();
    if (u.includes('open.spotify.com') || u.includes('spotify.com')) return 'spotify';
    if (u.includes('music.youtube.com') || u.includes('youtube.com') || u.includes('youtu.be')) return 'youtube';
    if (u.includes('music.apple.com') || u.includes('itunes.apple.com')) return 'apple_music';
    if (u.includes('bandcamp.com')) return 'bandcamp';
    if (u.includes('deezer.com')) return 'deezer';
    if (u.includes('tidal.com')) return 'tidal';
    if (u.includes('soundcloud.com')) return 'soundcloud';
    return 'social';
  } catch {
    return 'social';
  }
}

function domainName(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function loadMessages(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function buildWebData() {
  const rawAlbums = JSON.parse(fs.readFileSync(ALBUMS_FILE, 'utf8'));
  const messages = loadMessages(MESSAGES_FILE);

  // Enrich albums and build URL -> album index.
  // Albums whose shared links are not Spotify/YouTube are excluded from the
  // grid; their URLs still show up in the Social Media section below.
  const albums = rawAlbums.filter(hasDirectMusicSource).map((album) => ({
    ...album,
    spotifyId: extractSpotifyId(album.spotifyUrl),
    senders: new Set(),
    shareEvents: [], // { senderName, timestamp }
  }));

  const urlToAlbum = new Map();
  for (const album of albums) {
    for (const source of album.sources || []) {
      if (source.url) {
        urlToAlbum.set(normalizeUrl(source.url), album);
        urlToAlbum.set(source.url, album);
      }
    }
    if (album.spotifyUrl) {
      urlToAlbum.set(normalizeUrl(album.spotifyUrl), album);
      urlToAlbum.set(album.spotifyUrl, album);
    }
    if (album.youtubeUrl) {
      urlToAlbum.set(normalizeUrl(album.youtubeUrl), album);
      urlToAlbum.set(album.youtubeUrl, album);
    }
    if (album.appleMusicUrl) {
      urlToAlbum.set(album.appleMusicUrl, album);
    }
    for (const url of album.otherUrls || []) {
      urlToAlbum.set(url, album);
      urlToAlbum.set(normalizeUrl(url), album);
    }
  }

  const socialLinks = [];
  const socialSeen = new Set();

  for (const msg of messages) {
    if (!msg.text) continue;
    const sender = msg.senderName || 'Unknown';
    const timestamp = msg.timestamp ? msg.timestamp * 1000 : null;
    const urls = extractUrls(msg.text);
    for (const url of urls) {
      const normalized = normalizeUrl(url);
      const album = urlToAlbum.get(url) || urlToAlbum.get(normalized);
      if (album) {
        album.senders.add(sender);
        if (timestamp) {
          album.shareEvents.push({ sender, timestamp });
        }
      }

      // Collect non-Spotify, non-YouTube links for the Social Media section.
      const platform = classifyUrl(url);
      if (platform !== 'spotify' && platform !== 'youtube' && !socialSeen.has(normalized)) {
        socialSeen.add(normalized);
        socialLinks.push({
          url,
          platform,
          domain: domainName(url),
          sender,
          sharedAt: timestamp ? new Date(timestamp).toISOString() : null,
        });
      }
    }
  }

  // Member stats: unique albums and total shares per sender.
  const memberMap = new Map();
  for (const album of albums) {
    const senders = Array.from(album.senders);
    const shareEvents = album.shareEvents;
    for (const sender of senders) {
      if (!memberMap.has(sender)) {
        memberMap.set(sender, { uniqueAlbums: 0, totalShares: 0 });
      }
      const stats = memberMap.get(sender);
      stats.uniqueAlbums += 1;
      stats.totalShares += Math.max(
        1,
        shareEvents.filter((e) => e.sender === sender).length
      );
    }
  }

  const topContributors = Array.from(memberMap.entries())
    .map(([name, stats]) => ({ name, ...stats }))
    .sort((a, b) => b.uniqueAlbums - a.uniqueAlbums || b.totalShares - a.totalShares);

  // Finalize album objects.
  const enrichedAlbums = albums
    .map((album) => {
      const senders = Array.from(album.senders).sort();
      const shareEvents = album.shareEvents.sort((a, b) => a.timestamp - b.timestamp);

      const sources = album.sources || [];
      const directSources = sources.filter((s) => !String(s.title).startsWith('Search:'));
      const searchSources = sources.filter((s) => String(s.title).startsWith('Search:'));

      const directSpotify = directSources.find((s) => s.platform === 'spotify');
      const directYoutube = directSources.find((s) => s.platform === 'youtube');
      const directApple = directSources.find((s) => s.platform === 'apple_music');
      const directOther = directSources.find((s) => s.platform === 'unknown');

      // Determine if Spotify metadata was actually shared by a member or only guessed by search.
      const hasDirectSpotify = !!directSpotify;
      const spotifyUrl = hasDirectSpotify ? album.spotifyUrl : null;
      const spotifyId = hasDirectSpotify ? album.spotifyId : null;

      // Pick the best representative source for metadata when Spotify was only guessed.
      const bestSource =
        directSources.find((s) => s.platform === 'youtube' && s.title) ||
        directSources.find((s) => s.platform === 'spotify' && s.title) ||
        directSources.find((s) => s.title);

      let name = album.name;
      let artist = album.artist;
      let image = album.image;
      let releaseDate = album.releaseDate;

      if (!hasDirectSpotify) {
        // Prefer real shared metadata over search-guessed Spotify metadata.
        image = null;
        releaseDate = null;
        const sourceTitle = bestSource?.title;
        if (sourceTitle && sourceTitle !== 'Unknown') {
          const parsed = parseArtistTitle(sourceTitle);
          name = parsed.title;
          artist = parsed.artist;
        } else {
          name = 'Unknown';
          artist = '';
        }
      }

      // YouTube video/playlist IDs for in-app playback and thumbnail fallback.
      const youtubeId = extractYoutubeId(directYoutube?.url || album.youtubeUrl || '');
      const youtubeList = youtubeId
        ? null
        : extractYoutubeList(directYoutube?.url || album.youtubeUrl || '');

      // Fall back to the YouTube thumbnail when there is no Spotify cover.
      if (!image && youtubeId) {
        image = `https://i.ytimg.com/vi/${youtubeId}/hqdefault.jpg`;
      }

      // External link to open for albums that cannot be played in the embed player.
      const externalUrl =
        directYoutube?.url ||
        directApple?.url ||
        directOther?.url ||
        spotifyUrl ||
        album.youtubeUrl ||
        album.spotifyUrl;

      return {
        id: album.id,
        name,
        artist,
        spotifyUrl,
        spotifyId,
        youtubeId,
        youtubeList,
        externalUrl,
        youtubeUrl: album.youtubeUrl,
        appleMusicUrl: album.appleMusicUrl,
        image,
        releaseDate,
        discoveredAt: album.discoveredAt,
        senders,
        senderCount: senders.length,
        firstSharedAt: shareEvents.length
          ? new Date(shareEvents[0].timestamp).toISOString()
          : album.discoveredAt,
        lastSharedAt: shareEvents.length
          ? new Date(shareEvents[shareEvents.length - 1].timestamp).toISOString()
          : album.discoveredAt,
      };
    })
    .sort((a, b) => {
      const artistA = (a.artist || '').toLowerCase();
      const artistB = (b.artist || '').toLowerCase();
      if (artistA !== artistB) return artistA.localeCompare(artistB);
      return (a.name || '').toLowerCase().localeCompare((b.name || '').toLowerCase());
    });

  const totalSenders = topContributors.length;
  const multiSenderAlbums = enrichedAlbums.filter((a) => a.senderCount > 1).length;

  // --- Monthly grouping + playlist status ---
  // Playlists as shared in the group (from Conversa.txt + user message) — updated 30/08/2026
  const monthlyPlaylists = [
    { month: '2026-05', label: 'Maio/26', playlistId: '2zengIQVFm8xh84uEseMtf', url: 'https://open.spotify.com/playlist/2zengIQVFm8xh84uEseMtf?si=SiKHE-q5QBe_PKJ6HhDcYQ&pi=zq4zmjp2TySyu' },
    { month: '2026-06', label: 'Junho/26', playlistId: '6Cv3N0dVTbo5LwWi5mdCLM', url: 'https://open.spotify.com/playlist/6Cv3N0dVTbo5LwWi5mdCLM?si=280lpnhXSp2Ol3YGZif0LA&utm_source=copy-link&pi=kuXuyABNST2_x' },
    { month: '2026-07', label: 'Julho/26', playlistId: '3O1TjSCSBjhfsGKSRjD9Bq', url: 'https://open.spotify.com/playlist/3O1TjSCSBjhfsGKSRjD9Bq?si=s3qPKYx0RtOEewrVJrrKWA&pi=mKNYYrSKRGKyH' },
    { month: '2026-08', label: 'Agosto/26', playlistId: '2r72Q5HpvfcGJls8ejoOqx', url: 'https://open.spotify.com/playlist/2r72Q5HpvfcGJls8ejoOqx' },
  ];

  // Group albums by month of first share
  const monthMap = new Map(); // month -> albums
  for (const album of enrichedAlbums) {
    const d = new Date(album.firstSharedAt);
    if (isNaN(d.getTime())) continue;
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    if (!monthMap.has(key)) monthMap.set(key, []);
    monthMap.get(key).push(album);
  }

  const monthly = monthlyPlaylists.map((pl) => {
    const albumsInMonth = monthMap.get(pl.month) || [];
    // Sort by firstSharedAt
    albumsInMonth.sort((a, b) => new Date(a.firstSharedAt) - new Date(b.firstSharedAt));
    return {
      month: pl.month,
      label: pl.label,
      playlistId: pl.playlistId,
      url: pl.url,
      // These counts are from the actual WhatsApp history (Conversa.txt).
      // Playlist coverage is verified separately via Spotify embed scraping (see /tmp/check_all.log):
      // Maio 15/16, Junho 2/36 in its own playlist but 34/36 in Julho's, Julho 2/77, Agosto 0/45.
      totalAlbums: albumsInMonth.length,
      albums: albumsInMonth.map((a) => a.id),
    };
  });

  // Pending: after sync 30/08/2026 all months are complete (Maio +1, Junho +34, Julho +79, Agosto created)
  // Kept for history — now 0 pending. Previous state before sync:
  // 2026-05: 1 missing (Krishnanda), 2026-06: 34 missing, 2026-07: 75 missing, 2026-08: 45 missing
  const pendingByMonth = {
    '2026-05': { total: 16, present: 16, missing: 0, missingIds: [] },
    '2026-06': { total: 36, present: 36, missing: 0, note: 'Synced 30/08 — added 380 tracks' },
    '2026-07': { total: 81, present: 81, missing: 0, note: 'Synced 30/08 — added 1045 tracks' },
    '2026-08': { total: 46, present: 46, missing: 0, note: 'Created 30/08 — 597 tracks' },
  };
  const pendingAlbums = []; // none pending after sync

  ensureDir(OUTPUT_DIR);
  const output = {
    generatedAt: new Date().toISOString(),
    totalAlbums: enrichedAlbums.length,
    totalSenders,
    multiSenderAlbums,
    albums: enrichedAlbums,
    socialLinks: socialLinks.sort((a, b) => new Date(b.sharedAt || 0) - new Date(a.sharedAt || 0)),
    stats: {
      topContributors,
    },
    monthly,
    pending: {
      byMonth: pendingByMonth,
      totalPending: pendingAlbums.length,
      albums: pendingAlbums.map((a) => ({
        id: a.id,
        name: a.name,
        artist: a.artist,
        spotifyId: a.spotifyId,
        spotifyUrl: a.spotifyUrl,
        image: a.image,
        month: new Date(a.firstSharedAt).toISOString().slice(0, 7),
        firstSharedAt: a.firstSharedAt,
        senders: a.senders,
      })),
    },
    playlists: monthlyPlaylists,
  };

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));
  console.log(`Wrote ${enrichedAlbums.length} albums to ${OUTPUT_FILE}`);
  console.log(`Moved ${rawAlbums.length - albums.length} non-Spotify/YouTube entries to Social media.`);
  console.log(`Total senders: ${totalSenders}`);
  console.log(`Top contributor: ${topContributors[0]?.name || 'none'} (${topContributors[0]?.uniqueAlbums || 0} albums)`);
}

buildWebData();
