const fs = require('fs');
const path = require('path');

const INPUT_FILE = process.env.EXPORT_FILE || './data/exported/chat.txt';
const OUTPUT_FILE = process.env.MESSAGES_FILE || './data/messages.jsonl';
const GROUP_NAME = process.env.GROUP_NAME || 'WhatsApp Export';
const GROUP_JID = process.env.GROUP_JID || 'unknown@g.us';

const MEDIA_MARKERS = [
  'media omitted',
  'imagem ocultada',
  'mídia oculta',
  'mídia omitida',
  'áudio ocultado',
  'vídeo ocultado',
  'arquivo ocultado',
  'media oculta',
  '<mídia omitida>',
  '<media omitted>',
];

const MEDIA_RE = new RegExp(MEDIA_MARKERS.join('|'), 'i');

function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function appendMessage(entry) {
  ensureDir(OUTPUT_FILE);
  fs.appendFileSync(OUTPUT_FILE, JSON.stringify(entry) + '\n');
}

function stripZeroWidth(str) {
  // WhatsApp exports sometimes prefix continuation lines with U+200B
  return str.replace(/[\u200B\u200C\u200D\uFEFF]/g, '');
}

function parseTimestamp(datePart, timePart) {
  // WhatsApp Portuguese (BR) export: "28/05/2026 19:09" (DD/MM/YYYY HH:MM)
  // Other common variants: "05/28/2026 7:09 PM" (MM/DD/YYYY), "2026/05/28 19:09" (YYYY/MM/DD)

  const datePartClean = datePart.replace(/,/g, '').trim();
  const timePartClean = timePart.trim();

  // Detect order by part sizes
  const dateParts = datePartClean.split(/[\/\-]/);
  if (dateParts.length === 3) {
    let [p1, p2, p3] = dateParts.map((p) => parseInt(p, 10));

    let year, month, day;
    if (p3 > 31) {
      // DD/MM/YYYY or MM/DD/YYYY
      year = p3;
      if (p1 > 12) {
        // p1 must be day
        day = p1;
        month = p2;
      } else if (p2 > 12) {
        // p2 must be day
        day = p2;
        month = p1;
      } else {
        // Ambiguous: default to DD/MM/YYYY (Brazilian format)
        day = p1;
        month = p2;
      }
    } else if (p1 > 31) {
      // YYYY/MM/DD
      year = p1;
      month = p2;
      day = p3;
    } else {
      // Ambiguous, default to DD/MM/YYYY
      day = p1;
      month = p2;
      year = p3;
    }

    const timeParts = timePartClean.split(/[:\s]/).filter(Boolean);
    let hours = parseInt(timeParts[0], 10) || 0;
    const minutes = parseInt(timeParts[1], 10) || 0;
    let seconds = parseInt(timeParts[2], 10) || 0;

    // Handle AM/PM
    const ampm = timePartClean.match(/([AP])\.?M\.?/i);
    if (ampm) {
      const isPm = ampm[1].toLowerCase() === 'p';
      if (isPm && hours < 12) hours += 12;
      if (!isPm && hours === 12) hours = 0;
    }

    const date = new Date(year, month - 1, day, hours, minutes, seconds);
    if (!isNaN(date.getTime())) {
      return date;
    }
  }

  // Fallback to native Date parsing
  const candidates = [
    `${datePartClean} ${timePartClean}`,
    `${datePartClean.replace(/\//g, '-')} ${timePartClean}`,
  ];

  for (const candidate of candidates) {
    const parsed = new Date(candidate);
    if (!isNaN(parsed.getTime())) {
      return parsed;
    }
  }

  return null;
}

// Match a new message line. Examples:
// 28/05/2026 19:09 - As mensagens e ligações são protegidas...
// 28/05/2026 19:09 - Gabriel Olivia: Hello world
// [20/08/2023, 14:32:45] ~ user: message
// 20/08/2023, 14:32 - user: message
const MESSAGE_LINE_RE =
  /^(?:\[(?<date1>[^\]]+?)\]\s*(?:~\s*)?|\s*(?<date2>\d{1,4}[\/\-]\d{1,2}[\/\-]\d{1,4})\s+(?<time2>\d{1,2}:\d{2}(?::\d{2})?(?:\s*[APap]\.?M\.?)?)\s*-\s*)(?<body>.*)$/;

function parseNewMessage(line) {
  const m = MESSAGE_LINE_RE.exec(line);
  if (!m) return null;

  let datePart = '';
  let timePart = '';

  if (m.groups.date1) {
    // Bracketed format: [20/08/2023, 14:32:45]
    const parts = m.groups.date1.split(/,\s*/);
    datePart = parts[0].trim();
    timePart = parts.slice(1).join(', ').trim();
  } else if (m.groups.date2 && m.groups.time2) {
    datePart = m.groups.date2.trim();
    timePart = m.groups.time2.trim();
  }

  const body = stripZeroWidth(m.groups.body || '').trim();
  if (!datePart || !body) return null;

  let sender = 'system';
  let text = body;

  // Split on first colon to separate sender from message text.
  // System messages (no colon) stay as sender = 'system'.
  const colonIdx = body.indexOf(': ');
  if (colonIdx > 0) {
    sender = body.substring(0, colonIdx).trim();
    text = body.substring(colonIdx + 2).trim();
  }

  const date = parseTimestamp(datePart, timePart);

  return {
    sender,
    text,
    date,
    timestamp: date ? Math.floor(date.getTime() / 1000) : null,
  };
}

function parseExport() {
  if (!fs.existsSync(INPUT_FILE)) {
    console.error(`Export file not found: ${path.resolve(INPUT_FILE)}`);
    console.error('Place your WhatsApp exported chat .txt file here and run:');
    console.error(`EXPORT_FILE=./data/exported/chat.txt node src/parse-export.js`);
    process.exit(1);
  }

  console.log(`Parsing ${path.resolve(INPUT_FILE)}...`);

  // Remove old output to avoid duplicates
  if (fs.existsSync(OUTPUT_FILE)) {
    fs.rmSync(OUTPUT_FILE);
  }

  const raw = fs.readFileSync(INPUT_FILE, 'utf8');
  const lines = raw.split(/\r?\n/);

  let parsedCount = 0;
  let skippedCount = 0;
  let currentMessage = null;

  function flushCurrent() {
    if (!currentMessage) return;

    const entry = {
      id: `export-${parsedCount + 1}`,
      groupJid: GROUP_JID,
      groupName: GROUP_NAME,
      senderJid: null,
      senderName: currentMessage.sender,
      timestamp: currentMessage.timestamp,
      type: 'export',
      text: currentMessage.text,
      hasMedia: MEDIA_RE.test(currentMessage.text),
      receivedAt: currentMessage.date ? currentMessage.date.toISOString() : null,
    };

    appendMessage(entry);
    parsedCount++;
    currentMessage = null;
  }

  for (let i = 0; i < lines.length; i++) {
    const line = stripZeroWidth(lines[i]).trimEnd();

    // Blank lines that are not continuations are skipped
    if (!line.trim()) {
      continue;
    }

    const parsed = parseNewMessage(line);

    if (parsed) {
      // This line starts a new message
      flushCurrent();
      currentMessage = parsed;
    } else if (currentMessage) {
      // Continuation of the previous message
      currentMessage.text += '\n' + line.trim();
    } else {
      // No current message and line doesn't match — skip
      skippedCount++;
    }
  }

  flushCurrent();

  console.log(`\nParsed ${parsedCount} message(s).`);
  console.log(`Skipped ${skippedCount} line(s).`);
  console.log(`Output: ${path.resolve(OUTPUT_FILE)}`);
}

parseExport();
