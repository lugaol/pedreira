require('dotenv').config();

const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');
const QRCode = require('qrcode-terminal');
const pino = require('pino');
const fs = require('fs');
const path = require('path');

// --- Configuration ---
// Match by exact JID is most reliable. If not set, falls back to name matching.
const TARGET_GROUP_JID =
  process.env.TARGET_GROUP_JID || '120363428621034166@g.us';
const TARGET_GROUP_NAME = normalizeGroupName(
  process.env.TARGET_GROUP_NAME || 'só pedradas'
);
const AUTH_DIR = process.env.AUTH_DIR || './baileys_auth';
const MESSAGES_FILE = process.env.MESSAGES_FILE || './data/messages.jsonl';
const MEMBERS_FILE = process.env.MEMBERS_FILE || './data/members.json';
const LOG_LEVEL = process.env.LOG_LEVEL || 'silent'; // change to 'info' for debug

// --- Helpers ---
function normalizeGroupName(name) {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

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
  const participant = metadata?.participants?.find(
    (p) => p.id === senderJid
  );
  const number = senderJid.split('@')[0];
  const name = participant?.notify || participant?.name || null;
  return name ? `${name} (${number})` : number;
}

// --- Main ---
const logger = pino({ level: LOG_LEVEL });
const groupCache = new Map(); // jid -> group metadata
let sock;
let connected = false;

async function getGroupMetadata(jid) {
  if (groupCache.has(jid)) {
    return groupCache.get(jid);
  }
  try {
    const metadata = await sock.groupMetadata(jid);
    groupCache.set(jid, metadata);
    return metadata;
  } catch (err) {
    logger.debug({ err, jid }, 'Failed to fetch group metadata');
    return null;
  }
}

function isTargetGroup(metadata) {
  if (!metadata?.id) return false;

  // Exact JID match takes priority
  if (TARGET_GROUP_JID) {
    return metadata.id === TARGET_GROUP_JID;
  }

  // Fallback: exact normalized name match
  if (metadata?.subject) {
    return normalizeGroupName(metadata.subject) === TARGET_GROUP_NAME;
  }

  return false;
}

function exportMembers(metadata) {
  ensureDir(MEMBERS_FILE);

  const members = (metadata.participants || []).map((p) => ({
    jid: p.id,
    number: p.id.split('@')[0],
    role: p.admin || 'member', // 'creator', 'admin', or 'member'
    name: p.notify || p.name || null,
  }));

  const exportData = {
    groupJid: metadata.id,
    groupName: metadata.subject,
    description: metadata.desc || null,
    owner: metadata.owner || null,
    createdAt: metadata.creation
      ? new Date(metadata.creation * 1000).toISOString()
      : null,
    memberCount: members.length,
    exportedAt: new Date().toISOString(),
    members,
  };

  fs.writeFileSync(MEMBERS_FILE, JSON.stringify(exportData, null, 2));
  console.log(`Exported ${members.length} member(s) to ${path.resolve(MEMBERS_FILE)}`);
}

async function findTargetGroups() {
  try {
    const allGroups = await sock.groupFetchAllParticipating();
    const groups = Object.values(allGroups || {});
    const matches = groups.filter((g) => isTargetGroup(g));

    const targetLabel = TARGET_GROUP_JID || `"${TARGET_GROUP_NAME}"`;

    if (matches.length === 0) {
      console.warn(`\nNo group matching ${targetLabel} was found.`);
      console.warn('Known groups:');
      for (const g of groups) {
        console.warn(`  - ${g.subject} (${g.id})`);
      }
      console.warn('');
    } else {
      console.log(`\nFound ${matches.length} group(s) matching ${targetLabel}:`);
      for (const g of matches) {
        groupCache.set(g.id, g);
        console.log(`  - ${g.subject} (${g.id})`);
        exportMembers(g);
      }
      console.log('');
    }
  } catch (err) {
    logger.error({ err }, 'Failed to list groups');
  }
}

async function handleMessages(upsert) {
  const { messages, type } = upsert; // type: 'notify' (new/live) or 'append' (sync/history)

  for (const msg of messages) {
    if (!msg.key?.remoteJid?.endsWith('@g.us')) continue;

    const metadata = await getGroupMetadata(msg.key.remoteJid);
    if (!metadata || !isTargetGroup(metadata)) continue;

    const senderJid = msg.key.participant || msg.key.remoteJid;
    const text = extractText(msg);

    const entry = {
      id: msg.key.id,
      groupJid: msg.key.remoteJid,
      groupName: metadata.subject,
      senderJid,
      senderName: formatSender(senderJid, metadata),
      timestamp: msg.messageTimestamp,
      type, // 'notify' = live, 'append' = historical/sync
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

    const when = new Date(entry.timestamp * 1000).toISOString();
    const label = type === 'notify' ? 'LIVE' : 'SYNC';
    console.log(
      `[${label}] ${when} | ${entry.groupName} | ${entry.senderName}: ${
        text || '<non-text message>'
      }`
    );
  }
}

async function connect() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    logger,
    printQRInTerminal: true,
    auth: state,
    syncFullHistory: true, // Ask WhatsApp Web to sync as much history as it will
    generateHighQualityLinkPreview: false,
  });

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('\nScan the QR code above with WhatsApp on your phone.\n');
      QRCode.generate(qr, { small: true });
    }

    if (connection === 'open') {
      connected = true;
      const targetLabel = TARGET_GROUP_JID || `"${TARGET_GROUP_NAME}"`;
      console.log(`\nWhatsApp connected. Looking for ${targetLabel}...`);
      await findTargetGroups();
      console.log('Listening for messages. Historical messages appear as [SYNC]; new ones as [LIVE].');
      console.log('Messages file:', path.resolve(MESSAGES_FILE));
      console.log('Members file:', path.resolve(MEMBERS_FILE), '\n');
    }

    if (connection === 'close') {
      connected = false;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      console.log(
        `Connection closed (reason: ${statusCode || 'unknown'}). Reconnect: ${shouldReconnect}`
      );

      if (shouldReconnect) {
        setTimeout(connect, 3000);
      } else {
        console.log('Logged out. Delete', AUTH_DIR, 'and run again to re-authenticate.');
        process.exit(0);
      }
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', (upsert) => {
    handleMessages(upsert).catch((err) => {
      logger.error({ err }, 'Error handling messages.upsert');
    });
  });

  // Phone/WhatsApp Web history-sync chunks may arrive here
  sock.ev.on('messaging-history.set', (history) => {
    const { messages } = history || {};
    if (!messages?.length) return;
    handleMessages({ messages, type: 'append' }).catch((err) => {
      logger.error({ err }, 'Error handling messaging-history.set');
    });
  });

  sock.ev.on('groups.upsert', (groups) => {
    for (const group of groups) {
      groupCache.set(group.id, group);
    }
  });

  sock.ev.on('groups.update', (updates) => {
    for (const update of updates) {
      if (update.id && groupCache.has(update.id)) {
        groupCache.set(update.id, { ...groupCache.get(update.id), ...update });
      }
    }
  });
}

// --- Graceful shutdown ---
function shutdown(signal) {
  console.log(`\nReceived ${signal}. Closing connection...`);
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
