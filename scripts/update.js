#!/usr/bin/env node
/**
 * Pedreira — One-command updater
 * Usage:
 *   npm run update                          # uses /Users/noname/Downloads/Conversa/Conversa.txt if exists, else data/exported/*
 *   npm run update -- /path/to/chat.txt    # explicit file
 *   npm run update -- --no-playlists       # skip Spotify sync
 *   npm run update -- --deploy             # also git push main+gh-pages
 *   npm run update -- --help
 *
 * What it does:
 *   1. Parse WhatsApp export -> data/messages.jsonl (955 msgs)
 *   2. Extract albums -> data/albums.json (via embed, no API rate-limit)
 *   3. Fix missing covers -> data/albums.json
 *   4. Build web -> web/data.json (271 albums, monthly recent-first, no imageless)
 *   5. Sync Spotify monthly playlists (if .spotify_token.json exists, else dry-run)
 *   6. Optionally deploy to GitHub Pages (with --deploy)
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EXPORT_CANDIDATES = [
  '/Users/noname/Downloads/Conversa/Conversa.txt',
  path.join(ROOT, 'data/exported/chat.txt'),
  path.join(ROOT, 'data/exported/chat.zip'),
];
const GROUP_JID = '120363428621034166@g.us';
const GROUP_NAME = '🎵 Só Pedradas — Albuns 🎷🎹🎸🥁🎧';

function log(msg) { console.log(`\n▶ ${msg}`); }
function run(cmd, args, opts = {}) {
  console.log(`  $ ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: ROOT, ...opts });
  if (r.status !== 0) throw new Error(`${cmd} failed with ${r.status}`);
}
function exists(p) { try { return fs.existsSync(p); } catch { return false; } }

function findExport(explicit) {
  if (explicit && exists(explicit)) return path.resolve(explicit);
  for (const p of EXPORT_CANDIDATES) if (exists(p)) return p;
  return null;
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
Usage:
  npm run update                          # auto-find Conversa.txt
  npm run update -- /path/to/chat.txt    # explicit file
  npm run update -- --no-playlists       # skip Spotify
  npm run update -- --deploy             # also git push

Steps:
  1. Parse export -> data/messages.jsonl
  2. Update albums (embed, no rate-limit) -> data/albums.json
  3. Fix covers -> data/albums.json
  4. Build web -> web/data.json
  5. Sync Spotify (if token, else dry-run)
  6. Deploy (if --deploy)
`);
    process.exit(0);
  }
  const explicit = args.find(a => !a.startsWith('--') && (a.endsWith('.txt') || a.endsWith('.zip')));
  const noPlaylists = args.includes('--no-playlists');
  const deploy = args.includes('--deploy');
  const exportFile = findExport(explicit);

  console.log('┌─────────────────────────────────────────┐');
  console.log('│  Pedreira — one-command updater         │');
  console.log('└─────────────────────────────────────────┘');

  // 1. Parse
  if (exportFile) {
    log(`1/6 Parse WhatsApp export: ${exportFile}`);
    const env = { ...process.env, EXPORT_FILE: exportFile, GROUP_JID, GROUP_NAME, GROUP_NAME_ESC: GROUP_NAME };
    // Use parse-export via node with env
    run('node', ['src/parse-export.js'], { env: { ...process.env, EXPORT_FILE: exportFile, GROUP_JID, GROUP_NAME } });
    // Also ensure messages.jsonl has correct JID (parse-export uses GROUP_JID)
  } else {
    log('1/6 Parse skipped — no export file found. Using existing data/messages.jsonl');
    console.log(`   Tried: ${EXPORT_CANDIDATES.join(', ')}`);
    if (explicit) console.log(`   Explicit not found: ${explicit}`);
  }

  // 2-3. Update albums + fix covers (embed, no rate-limit)
  // The data/albums.json was already updated incrementally via the previous run (305 albums)
  // For new Conversa files, the parse step above updated messages.jsonl, and the incremental
  // updater will add any new Spotify albums via embed (see scripts/update_albums.py if present).
  // We keep this step idempotent: if no new albums, it just verifies.
  log('2/6 Update albums + covers (embed, incremental)');
  try {
    const msgs = fs.readFileSync(path.join(ROOT, 'data/messages.jsonl'), 'utf8').split('\n').filter(Boolean).length;
    const albums = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/albums.json'), 'utf8'));
    console.log(`   messages: ${msgs}, albums: ${albums.length}`);
    // If we have a Python updater, run it; otherwise just log that albums are assumed up-to-date
    // The updater is idempotent and will add any missing Spotify albums from the new messages
    const updater = path.join(ROOT, 'scripts/update_albums.py');
    if (exists(updater)) {
      run('python3', [updater]);
    } else {
      console.log('   (no updater script, assuming albums up-to-date — run npm run extract-albums if needed)');
    }
  } catch (e) {
    console.log(`   (check failed: ${e.message}, continuing)`);
  }
  log('3/6 Fix missing covers (already handled in step 2)');

  // 4. Build web
  log('4/6 Build web (monthly recent-first, no imageless)');
  run('node', ['scripts/build-web.js']);

  // Verify
  try {
    const web = JSON.parse(fs.readFileSync(path.join(ROOT, 'web/data.json'), 'utf8'));
    console.log(`   web: ${web.totalAlbums} albums, monthly ${web.monthly.map(m=>m.label).join(', ')}, pending ${web.pending.totalPending}`);
    const noImg = web.albums.filter(a=>!a.image).length;
    if (noImg) console.log(`   ⚠️  ${noImg} albums still without image (will be hidden)`);
  } catch {}

  // 5. Spotify
  if (noPlaylists) {
    log('5/6 Spotify sync SKIPPED (--no-playlists)');
  } else {
    log('5/6 Sync Spotify playlists');
    const tokenExists = exists(path.join(ROOT, '.spotify_token.json'));
    if (!tokenExists) {
      console.log('   No token — dry-run only. To enable writes:');
      console.log('   npm run spotify:auth   # then rerun npm run update');
      run('node', ['scripts/spotify-sync.js', '--dry-run']);
    } else {
      run('node', ['scripts/spotify-sync.js']);
    }
  }

  // 6. Deploy
  if (deploy) {
    log('6/6 Deploy to GitHub (main + gh-pages)');
    // Commit main
    const hasChanges = spawnSync('git', ['status', '--porcelain'], { cwd: ROOT }).stdout.toString().trim();
    if (hasChanges) {
      run('git', ['add', 'web/data.json', 'web/app.js', 'web/index.html', 'web/styles.css', 'scripts/build-web.js', 'data/albums.json']);
      // data/albums.json is gitignored, so force add if needed
      spawnSync('git', ['add', '-f', 'data/albums.json'], { cwd: ROOT });
      run('git', ['commit', '-m', 'chore: update from Conversa (auto)']);
    } else {
      console.log('   (no changes to commit on main)');
    }
    run('git', ['push', 'origin', 'main']);
    // Deploy gh-pages
    run('git', ['checkout', 'gh-pages']);
    // Use bash -c to avoid zsh redirection truncation
    run('bash', ['-c', 'git show main:web/app.js > app.js; git show main:web/data.json > data.json; git show main:web/index.html > index.html; git show main:web/styles.css > styles.css; git show main:web/stone.svg > stone.svg']);
    run('git', ['add', 'app.js', 'data.json', 'index.html', 'styles.css', 'stone.svg']);
    const gpChanges = spawnSync('git', ['status', '--porcelain'], { cwd: ROOT }).stdout.toString().trim();
    if (gpChanges) {
      run('git', ['commit', '-m', 'deploy: update from Conversa (auto)']);
      run('git', ['push', 'origin', 'gh-pages']);
    } else {
      console.log('   (gh-pages already up-to-date)');
    }
    run('git', ['checkout', 'main']);
    console.log('   Live: https://lugaol.github.io/pedreira/ (CDN 10 min)');
  } else {
    log('6/6 Deploy SKIPPED (use --deploy to push to GitHub)');
    console.log('   To deploy: npm run update -- --deploy');
    console.log('   Or manually: git push origin main && git checkout gh-pages && ...');
  }

  console.log('\n✓ Update complete!');
  console.log('  Preview locally: npm run web  -> http://localhost:3000');
  console.log('  Live: https://lugaol.github.io/pedreira/');
}

try { main(); } catch (e) { console.error('\n✗ Failed:', e.message); process.exit(1); }
