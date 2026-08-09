const puppeteer = require('puppeteer');
const express = require('express');
const path = require('path');

const PORT = 3456;
const app = express();
app.use(express.static(path.join(__dirname, '..', 'web')));

function log(message) {
  const ts = new Date().toISOString().split('T')[1].split('.')[0];
  console.log(`[${ts}] ${message}`);
}

async function run() {
  const server = app.listen(PORT, () => {
    log(`Server running at http://localhost:${PORT}`);
  });

  const browser = await puppeteer.launch({ headless: 'new' });
  const page = await browser.newPage();

  const errors = [];
  page.on('console', (msg) => {
    const text = msg.text();
    const type = msg.type();
    if (type === 'error' || text.includes('error') || text.includes('Error')) {
      // Ignore missing favicon — not a real bug.
      if (!text.includes('favicon') && !text.includes('404')) {
        errors.push(`[${type}] ${text}`);
      }
    }
    log(`console ${type}: ${text.slice(0, 200)}`);
  });
  page.on('pageerror', (err) => {
    errors.push(`[pageerror] ${err.message}`);
    log(`pageerror: ${err.message}`);
  });

  log('Opening page...');
  await page.goto(`http://localhost:${PORT}`);
  await new Promise((r) => setTimeout(r, 2000));

  async function checkState(label) {
    const state = await page.evaluate(() => {
      const iframe = document.getElementById('spotify-embed');
      const playerBar = document.getElementById('player-bar');
      const app = document.querySelector('.app');
      return {
        iframeExists: !!iframe,
        iframeSrc: iframe ? iframe.src : null,
        iframeHeight: iframe ? iframe.getAttribute('height') : null,
        iframeParent: iframe && iframe.parentNode ? iframe.parentNode.id || iframe.parentNode.className : null,
        playerBarClass: playerBar ? playerBar.className : null,
        appClass: app ? app.className : null,
        activeView: document.querySelector('.nav-item.active')?.dataset.view || null,
      };
    });
    log(`${label}: ${JSON.stringify(state)}`);
    return state;
  }

  await checkState('initial');

  // Click the first album that has a Spotify ID (index 54 in the sorted list).
  log('Clicking first playable album card...');
  const cards = await page.$$('.album-card');
  if (cards[54]) {
    await cards[54].click();
  } else {
    log('No playable card found, clicking first card');
    await page.click('.album-card');
  }
  await new Promise((r) => setTimeout(r, 3000));
  await checkState('after album click');

  log('Clicking Player nav...');
  await page.click('[data-view="player"]');
  await new Promise((r) => setTimeout(r, 2000));
  await checkState('after Player nav');

  log('Clicking All albums nav...');
  await page.click('[data-view="albums"]');
  await new Promise((r) => setTimeout(r, 2000));
  await checkState('after All albums nav');

  log('Clicking Social nav...');
  await page.click('[data-view="social"]');
  await new Promise((r) => setTimeout(r, 2000));
  await checkState('after Social nav');

  log('Clicking Contributors nav...');
  await page.click('[data-view="contributors"]');
  await new Promise((r) => setTimeout(r, 2000));
  await checkState('after Contributors nav');

  log('Clicking Player nav again...');
  await page.click('[data-view="player"]');
  await new Promise((r) => setTimeout(r, 2000));
  await checkState('after Player nav 2');

  log('Switching back to All albums before expand test...');
  await page.click('[data-view="albums"]');
  await new Promise((r) => setTimeout(r, 2000));

  log('Clicking expand button...');
  await page.click('#player-expand');
  await new Promise((r) => setTimeout(r, 2000));
  await checkState('after expand');

  log('Clicking close overlay...');
  await page.click('#player-overlay-close');
  await new Promise((r) => setTimeout(r, 2000));
  await checkState('after close overlay');

  await browser.close();
  server.close();

  if (errors.length) {
    console.log('\nErrors found:');
    errors.forEach((e) => console.log(' -', e));
    process.exit(1);
  } else {
    console.log('\nNo errors detected.');
    process.exit(0);
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
