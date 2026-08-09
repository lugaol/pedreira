require('dotenv').config();

const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');
const QRCode = require('qrcode-terminal');
const pino = require('pino');

const AUTH_DIR = process.env.AUTH_DIR || './baileys_auth';
const TARGET_GROUP_JID =
  process.env.TARGET_GROUP_JID || '120363428621034166@g.us';
const TARGET_GROUP_NAME = (
  process.env.TARGET_GROUP_NAME || 'só pedradas'
)
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .trim();

const logger = pino({ level: process.env.LOG_LEVEL || 'silent' });

function normalizeGroupName(name) {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

async function connect() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    logger,
    printQRInTerminal: true,
    auth: state,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      QRCode.generate(qr, { small: true });
    }

    if (connection === 'open') {
      try {
        const allGroups = await sock.groupFetchAllParticipating();
        const groups = Object.values(allGroups || {});

        console.log(`\nYou participate in ${groups.length} group(s):\n`);
        for (const g of groups) {
          const matches =
            g.id === TARGET_GROUP_JID ||
            normalizeGroupName(g.subject) === TARGET_GROUP_NAME;
          const marker = matches ? ' <-- TARGET' : '';
          console.log(`  ${g.subject}`);
          console.log(`    JID:   ${g.id}`);
          console.log(`    Members: ${g.participants?.length || 0}${marker}\n`);
        }

        if (groups.length === 0) {
          console.log('No groups found. You may not be a member of any groups yet.');
        }
      } catch (err) {
        console.error('Failed to fetch groups:', err.message);
      } finally {
        await sock.end(undefined).catch(() => {});
        setTimeout(() => process.exit(0), 500);
      }
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      if (statusCode === DisconnectReason.loggedOut) {
        console.log('Logged out. Delete', AUTH_DIR, 'and run again.');
      }
      process.exit(0);
    }
  });
}

connect().catch((err) => {
  console.error('Failed to start:', err.message);
  process.exit(1);
});
