require('dotenv').config();

const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const path = require('path');

// --- Configuration ---
const TARGET_GROUP_JID =
  process.env.TARGET_GROUP_JID || '120363428621034166@g.us';
const AUTH_DIR = process.env.AUTH_DIR || './baileys_auth';
const MESSAGES_FILE = process.env.MESSAGES_FILE || './data/messages.jsonl';
const FETCH_MINUTES = parseInt(process.env.FETCH_MINUTES || '3', 10);
const LOG_LEVEL = process.env.LOG_LEVEL || 'silent';

// --- Helpers ---
function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function appendMessage(entry) {
  ensureDir(MESSAGES_FILE);
  fs.appendFileSync(MESSAGES_FILE, JSON.stringify(entry) + '\n');
}

function extractText(msg) {
  return (
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    msg.message?.imageMessage?.caption ||
    msg.message?.videoMessage?.caption ||
    msg.message?.documentMessage?.caption ||
    null
  );
}

function formatSender(senderJid, metadata) {
  const participant = metadata?.participants?.find((p) => p.id === senderJid);
  const number = senderJid.split('@')[0];
  const name = participant?.notify || participant?.name || null;
  return name ? `${name} (${number})` : number;
}

// --- Main ---
const logger = pino({ level: LOG_LEVEL });
const groupCache = new Map();
let sock;
let connected = false;
let matchedMessages = 0;
let syncChunks = 0;
let timer;

async function getGroupMetadata(jid) {
  if (groupCache.has(jid)) return groupCache.get(jid);
  try {
    const metadata = await sock.groupMetadata(jid);
    groupCache.set(jid, metadata);
    return metadata;
  } catch (err) {
    logger.debug({ err, jid }, 'Failed to fetch group metadata');
    return null;
  }
}

async function handleMessages(upsert) {
  const { messages, type } = upsert;
  for (const msg of messages) {
    if (!msg.key?.remoteJid?.endsWith('@g.us')) continue;
    if (msg.key.remoteJid !== TARGET_GROUP_JID) continue;

    const metadata = await getGroupMetadata(msg.key.remoteJid);
    const senderJid = msg.key.participant || msg.key.remoteJid;
    const text = extractText(msg);

    const entry = {
      id: msg.key.id,
      groupJid: msg.key.remoteJid,
      groupName: metadata?.subject || TARGET_GROUP_JID,
      senderJid,
      senderName: formatSender(senderJid, metadata),
      timestamp: msg.messageTimestamp,
      type,
      text,
      hasMedia: !!(
        msg.message?.imageMessage ||
        msg.message?.videoMessage ||
        msg.message?.audioMessage ||
        msg.message?.documentMessage ||
        msg.message?.stickerMessage
      ),
      receivedAt: new Date().toISOString(),
    };

    appendMessage(entry);
    matchedMessages++;

    const when = new Date(entry.timestamp * 1000).toISOString();
    const label = type === 'notify' ? 'LIVE' : 'SYNC';
    console.log(
      `[${label}] ${when} | ${entry.senderName}: ${text || '<non-text message>'}`
    );
  }
}

async function connect() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    logger,
    printQRInTerminal: false, // use saved auth; do not show QR
    auth: state,
    syncFullHistory: true,
    generateHighQualityLinkPreview: false,
  });

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === 'open') {
      connected = true;
      console.log('\nConnected. Aggressively collecting history...');
      console.log(`Target: ${TARGET_GROUP_JID}`);
      console.log(`Will listen for ${FETCH_MINUTES} minute(s).`);

      const metadata = await getGroupMetadata(TARGET_GROUP_JID);
      if (metadata) {
        console.log(
          `Group: ${metadata.subject} | members: ${metadata.participants?.length || 0}\n`
        );
      } else {
        console.log('Could not fetch group metadata.\n');
      }

      timer = setTimeout(() => {
        console.log(
          `\nTime is up. Matched ${matchedMessages} message(s) from ${syncChunks} history-sync chunk(s).`
        );
        console.log('Saved to:', path.resolve(MESSAGES_FILE));
        if (sock && connected) {
          sock.end(undefined).catch(() => {});
        }
        setTimeout(() => process.exit(0), 1000);
      }, FETCH_MINUTES * 60 * 1000);
    }

    if (connection === 'close') {
      connected = false;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      if (statusCode === DisconnectReason.loggedOut) {
        console.log('Logged out. Delete', AUTH_DIR, 'and run again.');
      } else if (statusCode !== undefined) {
        console.log(`Connection closed (reason: ${statusCode}). Reconnecting...`);
        setTimeout(connect, 3000);
      }
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', (upsert) => {
    handleMessages(upsert).catch((err) => {
      logger.error({ err }, 'Error handling messages.upsert');
    });
  });

  sock.ev.on('messaging-history.set', (history) => {
    syncChunks++;
    const count = history.messages?.length || 0;
    console.log(
      `[history chunk #${syncChunks}] ${count} message(s) | isLatest=${history.isLatest} | progress=${history.progress}`
    );
    if (count) {
      handleMessages({ messages: history.messages, type: 'append' }).catch(
        (err) => {
          logger.error({ err }, 'Error handling messaging-history.set');
        }
      );
    }
  });

  sock.ev.on('messaging-history.status', (status) => {
    console.log(
      '[history status]',
      status.syncType,
      status.status,
      status.explicit ? '(explicit)' : '(inferred)'
    );
  });
}

// --- Graceful shutdown ---
function shutdown(signal) {
  console.log(`\nReceived ${signal}. Closing...`);
  clearTimeout(timer);
  if (sock && connected) {
    sock.end(undefined).catch(() => {});
  }
  setTimeout(() => process.exit(0), 1000);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

connect().catch((err) => {
  logger.error({ err }, 'Failed to start');
  process.exit(1);
});
