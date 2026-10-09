/**
 * Regression test for the "older export silently destroyed newer history" bug.
 *
 * parse-export.js used to `rm` messages.jsonl unconditionally. Running it with a
 * stale export (e.g. `npm run update -- --deploy` falling back to data/exported/chat.txt)
 * truncated messages.jsonl from 1159 messages ending 2026-10-08 down to 796 ending
 * 2026-08-08. The site kept 350 albums but September/October monthly grouping showed 0
 * albums, because their share events no longer existed in messages.jsonl.
 *
 * Run: node scripts/test-parse-export.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PARSE = path.join(ROOT, 'src', 'parse-export.js');

function exportText(messages) {
  return messages
    .map((m) => `${m.date} - ${m.sender}: ${m.text}`)
    .join('\n') + '\n';
}

function runParse(exportPath, outPath) {
  const r = spawnSync('node', [PARSE], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      EXPORT_FILE: exportPath,
      MESSAGES_FILE: outPath,
      GROUP_JID: 'test@g.us',
      GROUP_NAME: 'test',
    },
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function readOut(outPath) {
  if (!fs.existsSync(outPath)) return [];
  return fs
    .readFileSync(outPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function lastTs(msgs) {
  return msgs.reduce((max, m) => Math.max(max, m.timestamp || 0), 0);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pedreira-parse-'));
const outFile = path.join(tmp, 'messages.jsonl');

const NEW = [
  { date: '05/09/2026 12:00', sender: 'Ana', text: 'https://open.spotify.com/album/AAAAAAAAAAAAAA' },
  { date: '08/10/2026 12:00', sender: 'Ana', text: 'https://open.spotify.com/album/BBBBBBBBBBBBBB' },
];
const OLD = [{ date: '08/05/2026 12:00', sender: 'Ana', text: 'https://open.spotify.com/album/CCCCCCCCCCCCCC' }];

const newExport = path.join(tmp, 'new.txt');
const oldExport = path.join(tmp, 'old.txt');
fs.writeFileSync(newExport, exportText(NEW));
fs.writeFileSync(oldExport, exportText(OLD));

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ok — ${name}`);
  } catch (e) {
    failures++;
    console.log(`  FAIL — ${name}\n         ${e.message}`);
  }
}

console.log('\nparse-export staleness guard\n');

// Seed with the new export (as if we already updated).
let r = runParse(newExport, outFile);
assert.strictEqual(r.status, 0, `seed parse failed: ${r.stderr}`);
const seeded = readOut(outFile);
assert.strictEqual(seeded.length, 2, `seed should have 2 messages, got ${seeded.length}`);
const seededLast = lastTs(seeded);

check('rejects an export older than existing messages.jsonl', () => {
  const r2 = runParse(oldExport, outFile);
  assert.notStrictEqual(r2.status, 0, 'stale parse should exit non-zero');
  assert.match(r2.stdout + r2.stderr, /older|stale|newer/i, 'should explain the staleness');
});

check('leaves messages.jsonl untouched after a rejected stale parse', () => {
  const after = readOut(outFile);
  assert.strictEqual(after.length, 2, `messages.jsonl shrank to ${after.length}`);
  assert.strictEqual(lastTs(after), seededLast, 'newest timestamp changed');
});

check('re-parsing the same export succeeds (idempotent, not a regression)', () => {
  const r3 = runParse(newExport, outFile);
  assert.strictEqual(r3.status, 0, `re-parse failed: ${r3.stderr}`);
  assert.strictEqual(readOut(outFile).length, 2);
});

check('rejects a stale export that shares the same newest timestamp', () => {
  // Rebuild a 2-message history, then feed an export with the same newest timestamp but
  // fewer messages. Date comparison alone would pass this; the count check must catch it.
  runParse(newExport, outFile);
  const truncated = [
    { date: '05/09/2026 12:00', sender: 'Ana', text: 'https://open.spotify.com/album/AAAAAAAAAAAAAA' },
    { date: '08/10/2026 12:00', sender: 'Ana', text: 'https://open.spotify.com/album/BBBBBBBBBBBBBB' },
  ];
  const partialExport = path.join(tmp, 'partial.txt');
  fs.writeFileSync(partialExport, exportText([truncated[0]]));
  const r5 = runParse(partialExport, outFile);
  assert.notStrictEqual(r5.status, 0, 'partial export should be rejected');
  assert.strictEqual(readOut(outFile).length, 2, 'messages.jsonl should not shrink');
});

check('a newer export is accepted', () => {
  const newer = [
    ...NEW,
    { date: '09/10/2026 12:00', sender: 'Ana', text: 'https://open.spotify.com/album/DDDDDDDDDDDDDD' },
  ];
  const newerExport = path.join(tmp, 'newer.txt');
  fs.writeFileSync(newerExport, exportText(newer));
  const r4 = runParse(newerExport, outFile);
  assert.strictEqual(r4.status, 0, `newer parse failed: ${r4.stderr}`);
  assert.strictEqual(readOut(outFile).length, 3);
  assert.ok(lastTs(readOut(outFile)) > seededLast, 'newest timestamp should advance');
});

fs.rmSync(tmp, { recursive: true, force: true });

console.log(failures ? `\n${failures} failing\n` : '\nall passing\n');
process.exit(failures ? 1 : 0);