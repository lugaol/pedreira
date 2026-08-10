# Pedreira WhatsApp Reader

A Node.js service that connects to WhatsApp Web via [Baileys](https://github.com/WhiskeySockets/Baileys) and reads messages from the group **"🎵 Só Pedradas — Albuns 🎷🎹🎸🥁🎧"**. It stores every matched message in a JSON Lines file, exports the member list, and continues listening for new messages live.

> **Why old messages are missing:** This is a WhatsApp limitation, not a Baileys bug. WhatsApp Web only exposes a limited recent window. No other open-source WhatsApp Web library can bypass this. To get the full archive you must use the WhatsApp mobile app itself (see below).

## What the live service does

- Scans the QR code to pair with your WhatsApp account.
- Targets the group by exact JID (`120363428621034166@g.us`).
- Exports all group members to `data/members.json` on startup.
- Writes each matched message to `data/messages.jsonl`.
- Prints messages to the console:
  - `[SYNC]` = messages synced from WhatsApp Web history on startup.
  - `[LIVE]` = new messages received while the service is running.

## Project layout

```
.
├── src/                 # Node.js scripts
├── scripts/             # Python helpers and web build/serve scripts
├── web/                 # Spotify-style web player (generated + static files)
├── data/                # Generated output files
│   ├── messages.jsonl
│   ├── members.json
│   ├── albums.json
│   ├── albums.md
│   ├── albums.state.json
│   ├── spotify_albums.json
│   └── exported/        # WhatsApp "Export chat" files
├── baileys_auth/        # WhatsApp session (created at runtime)
├── .env                 # Local configuration (copy from .env.example)
└── .venv/               # Python virtual environment
```

## Requirements

- Node.js 18+ (tested with Node 22)
- An active WhatsApp account on a phone
- You must be a member of the target group

## Setup

```bash
npm install
```

The project also installs a Python virtual environment with `whatsapp-chat-exporter` for optional backup parsing:

```bash
python3 -m venv .venv
.venv/bin/pip install whatsapp-chat-exporter
```

Copy the example environment file and edit it if needed:

```bash
cp .env.example .env
```

The example `.env` already points to the known group:

```env
TARGET_GROUP_JID=120363428621034166@g.us
TARGET_GROUP_NAME=só pedradas
```

## Run live monitoring

```bash
npm start
```

On first run a QR code is printed. Scan it with WhatsApp on your phone:

1. Open WhatsApp → Settings → Linked Devices → Link a Device.
2. Point the camera at the terminal QR code.

After pairing, the service stays connected and logs `[SYNC]`/`[LIVE]` messages for the target group.

Stop the service with `Ctrl+C`.

## Output files

Generated data files are kept in the `data/` directory.

### `data/messages.jsonl`

Each line is a JSON object:

```json
{
  "id": "message-id",
  "groupJid": "120363428621034166@g.us",
  "groupName": "🎵 Só Pedradas — Albuns 🎷🎹🎸🥁🎧",
  "senderJid": "5511999999999@s.whatsapp.net",
  "senderName": "Contact Name (5511999999999)",
  "timestamp": 1699999999,
  "type": "notify",
  "text": "hello world",
  "hasMedia": false,
  "receivedAt": "2026-08-08T11:53:15.000Z"
}
```

### `data/members.json`

Exported once when the service connects:

```json
{
  "groupJid": "120363428621034166@g.us",
  "groupName": "🎵 Só Pedradas — Albuns 🎷🎹🎸🥁🎧",
  "description": "Group description",
  "owner": "5511999999999@s.whatsapp.net",
  "createdAt": "2023-01-01T00:00:00.000Z",
  "memberCount": 68,
  "exportedAt": "2026-08-08T11:53:15.000Z",
  "members": [
    {
      "jid": "5511999999999@s.whatsapp.net",
      "number": "5511999999999",
      "role": "member",
      "name": "Contact Name"
    }
  ]
}
```

## Getting old / full history

### Option A — WhatsApp "Export chat" (easiest, recommended)

This is the official way and gives you the complete text history (with optional media):

1. Open the group in WhatsApp on your phone.
2. Group info → **Export chat**.
3. Choose **Without media** (fastest) or **Include media**.
4. Save or send the `.zip` (or extracted `.txt`) file to your computer.
5. Place the file in `data/exported/`, for example as `data/exported/chat.zip`.
6. Run:

```bash
EXPORT_FILE=./data/exported/chat.zip GROUP_NAME="🎵 Só Pedradas — Albuns 🎷🎹🎸🥁🎧" npm run parse-export
```

Both `.zip` and plain `.txt` exports are accepted (`.zip` is what WhatsApp produces by default). This converts the chat into the same `messages.jsonl` format.

### Option B — Decrypt an Android WhatsApp backup (most complete)

If you have an Android phone, you can extract the encrypted local backup:

1. On the phone, go to WhatsApp → Settings → Chats → Chat backup → End-to-end encrypted backup.
2. Enable it and copy the 64-digit encryption key.
3. Copy the backup file to your computer:
   - Location: `/sdcard/Android/media/com.whatsapp/WhatsApp/Databases/msgstore.db.crypt15`
   - Older phones: `/sdcard/WhatsApp/Databases/msgstore.db.crypt15`
4. Place `msgstore.db.crypt15` and the key file (or a text file with the 64-character key) in `data/exported/`.
5. Run:

```bash
.venv/bin/wtsexporter -a -k <key-or-key-file> -b msgstore.db.crypt15
```

This creates a `WhatsApp` folder with exported chats. You can then point `parse-export` at the generated `.txt` for this group.

For iOS/iCloud backups, use the `--ios` flag of `wtsexporter` and follow its documentation.

## Available scripts

| Script | Purpose |
|--------|---------|
| `npm start` | Live message monitoring |
| `npm run list-groups` | List all groups and highlight the target |
| `npm run fetch-history` | Attempt to collect synced history for a few minutes (rarely yields old messages) |
| `npm run parse-export` | Convert a WhatsApp-exported `.txt` chat into `messages.jsonl` |
| `npm run extract-albums` | Extract albums from links in `messages.jsonl` and find Spotify/YouTube links |

## Extract albums from chat links

The script `src/extract-albums.js` reads `messages.jsonl`, finds music links (Spotify, YouTube, Apple Music, Bandcamp, etc.), and builds a deduplicated album list.

### What it does

- Extracts URLs from every message.
- Identifies Spotify, YouTube, Apple Music, Bandcamp, Deezer, Tidal links.
- Fetches metadata from Spotify oEmbed (no API key) and Spotify Web API (if credentials are set).
- Fetches metadata from YouTube oEmbed (no API key) and YouTube Data API (if key is set).
- Searches Spotify for albums that don't already have a Spotify link.
- Searches **YouTube Music** for albums that don't already have a YouTube link via the free `ytmusicapi` Python library (no API key required).
- Searches regular YouTube via the YouTube Data API if a key is provided.
- Deduplicates albums by artist + album name.
- Keeps state so re-runs only process new messages.

### Output files

- `data/albums.json` — all discovered albums with sources and links.
- `data/albums.md` — human-readable Markdown table.
- `data/spotify_albums.json` — only albums that have a Spotify link.
- `data/albums.state.json` — internal state used to skip already processed messages/links.

### Run

With Spotify credentials (recommended — fills artist names and searches Spotify for missing albums):

```bash
npm run extract-albums
```

You only need to set `SPOTIFY_CLIENT_ID` and `SPOTIFY_CLIENT_SECRET` in `.env`. YouTube Music search works without an API key via `ytmusicapi`.

With a YouTube Data API key (optional — faster and more stable than the free fallback):

```bash
YOUTUBE_API_KEY=yyy npm run extract-albums
```

### Setup API keys

- **Spotify** (recommended): create a free app at [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard), copy the Client ID and Client Secret.
- **YouTube** (optional): create a free API key at [Google Cloud Console](https://console.cloud.google.com/) for the YouTube Data API v3. If you skip this, the script uses `ytmusicapi` (free, no key) for YouTube Music search.

Add them to `.env`:

```env
SPOTIFY_CLIENT_ID=your_id
SPOTIFY_CLIENT_SECRET=your_secret
# YOUTUBE_API_KEY=your_key  # optional
```

### Updating periodically

Whenever you add new messages to `data/messages.jsonl` (live or via `parse-export`), just run:

```bash
npm run extract-albums
```

The script reads `data/albums.state.json`, skips messages and links it already processed, and only enriches the new ones. Old albums stay in `data/albums.json`; new ones are appended.

### Notes on the "free AI browser"

There is no stable, free, unlimited "AI browser" API. This script uses:
- the official Spotify Web API for Spotify metadata and search;
- the free `ytmusicapi` Python library for YouTube Music album search (no API key);
- public oEmbed endpoints as fallbacks.

## Web player

A Spotify-style web page lets you browse every album shared in the group, play them via the official Spotify embed, and see who contributed the most albums.

The page is generated from `data/albums.json` and `data/messages.jsonl`, so run it after you have collected messages and extracted albums:

```bash
npm run web
```

This builds `web/data.json` (with sender attribution and stats) and starts a local server at:

```
http://localhost:3000
```

Open that URL in your browser. Features:

- **All albums** grid, sorted alphabetically by artist by default.
- **Sort** by artist/album name or recently shared.
- **Search** albums, artists, or senders.
- **Play** any album using the official Spotify embed player in the bottom bar.
- **Contributors** view with a chart of members who shared the most unique albums.

To rebuild the data without restarting the server:

```bash
npm run build-web
```

To serve on a different port:

```bash
PORT=8080 npm run serve-web
```

## Re-authenticating

If you get a "logged out" error or want to use a different WhatsApp account:

```bash
rm -rf baileys_auth
npm start
```

Then scan the new QR code.

## Troubleshooting

- **Group not found**: make sure `TARGET_GROUP_JID` is set in `.env`.
- **No historical messages**: this is expected for very old chats; see the explanation above.
- **QR code not showing**: run in a terminal that supports Unicode/ASCII art, or use `LOG_LEVEL=info npm start` to see more Baileys logs.
- **Export parser skips lines**: WhatsApp uses locale-dependent date formats. Edit `src/parse-export.js` if your export uses an unusual format.

## Legal / Policy Notice

Use this only on groups you participate in and are authorized to monitor. Respect WhatsApp's Terms of Service and the privacy of group members. Excessive reconnections or bulk fetching may result in rate limits or bans.
