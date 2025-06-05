/*
  WhatsApp Duplicate‑Message Bot (Playwright + Node.js)
  ====================================================
  תקציר בעברית
  -------------
  מטרה: לעזור למתנדבי צפון אמריקה לזהות פונים חוזרים ששלחו הודעה
          במהלך 24 השעות האחרונות.
  דרך הפעולה: הבוט מאזין לערוץ "ערן Offline"; כאשר הוא מזהה הודעה
          בת מילה אחת עד שלוש מילים שחוזרת על עצמה ב־24 השעות
          האחרונות – הוא מתריע על כך עם השעות (שעון ישראל) שבהן
          הופיעה ההודעה קודם.

  PURPOSE (English)
  -----------------
  Watches a single WhatsApp Web group. Tracks **1- to 3-word**
  messages for 24 hours (based on Israel local date). If a duplicate
<<<<<<< HEAD
  appears, replies in Hebrew with the timestamp list in Israel time. 
=======
  appears, replies in Hebrew with the timestamp list in Israel time.
>>>>>>> 0cd96b3b2858b0071ef3054feea271710bfcec75
*/

const fs = require('fs');
const { chromium } = require('playwright');
require('dotenv').config();

// Configuration
const GROUP_NAME      = process.env.GROUP_NAME;
const USER_DATA       = process.env.USER_DATA || './wadata';
const CHECK_EVERY_MS  = Number(process.env.CHECK_EVERY_MS) || 4000;
const BROWSER_CHANNEL = process.env.BROWSER_CHANNEL || 'chromium';
const HEADLESS        = process.env.HEADLESS === 'false' ? false : true;
const PERSIST_PATH    = './history.json';
const DAY_MS          = 24 * 60 * 60 * 1000;

/**
 * getIsraelMidnight()
 * --------------------
 * Returns the timestamp (ms since epoch) for today at 00:00 in Israel time.
 */
function getIsraelMidnight() {
  const now = new Date();
  const dateString = now.toLocaleDateString('en-US', { timeZone: 'Asia/Jerusalem' });
  const [month, day, year] = dateString.split('/');
  return new Date(Number(year), Number(month) - 1, Number(day), 0, 0, 0, 0).getTime();
}

// Track the last-pruned midnight timestamp (ms)
let lastPruneMidnight = getIsraelMidnight();

// In-memory stores
const history = new Map();         // Map<string, Date[]>
const processedIds = new Set();    // Set<string>

// Load existing history from disk
try {
  if (fs.existsSync(PERSIST_PATH)) {
    const raw = JSON.parse(fs.readFileSync(PERSIST_PATH, 'utf-8'));
    for (const [key, arr] of Object.entries(raw)) {
      history.set(key, arr.map(ts => new Date(ts)));
    }
    console.log(`Loaded ${history.size} entries from history.json`);
  }
} catch (e) {
  console.warn('Could not load history.json, starting fresh', e);
}

// Option A: Prune immediately on startup to remove any stale entries before today
midnightPrune();

/**
 * persist()
 * ---------
 * Serializes `history` to JSON on disk, converting Dates to ISO strings.
 */
function persist() {
  try {
    const obj = Object.fromEntries(
      [...history.entries()].map(([k, arr]) => [k, arr.map(d => d.toISOString())])
    );
    fs.writeFileSync(PERSIST_PATH, JSON.stringify(obj));
  } catch (e) {
    console.error('Persist failed', e);
  }
}

/**
 * midnightPrune()
 * ---------------
 * Removes all history entries older than Israel local midnight of today,
 * then persists and clears processedIds. Intended to run once per day.
 */
function midnightPrune() {
  const cutoff = getIsraelMidnight();
  for (const [key, timestamps] of history) {
    const kept = timestamps.filter(t => t.getTime() >= cutoff);
    if (kept.length) {
      history.set(key, kept);
    } else {
      history.delete(key);
      console.log(
        `Deleted history for message key: "${key}"`
      );
    }
  }
  persist();
  processedIds.clear();
  lastPruneMidnight = cutoff;
  console.log(`Completed midnightPrune; history size=${history.size}`);
}

/**
 * buildReply(msg, times)
 * -----------------------
 * Returns the user-preferred Hebrew reply.
 */
function buildReply(msg, times) {
  const formatted = times
    .sort((a, b) => a - b)
    .map(t => new Date(t).toLocaleTimeString('en-US', {
      hour: '2-digit', minute: '2-digit', hour12: false,
      timeZone: 'Asia/Jerusalem'
    }))
    .join(', ');
  return `⚠️ ההודעה "${msg}" הופיעה ביממה האחרונה בשעות (${formatted})`;
}

(async () => {
  // Launch a persistent context to preserve WhatsApp session and avoid re-scanning QR
  const context = await chromium.launchPersistentContext(USER_DATA, {
    headless: HEADLESS,
    channel: BROWSER_CHANNEL,
    timezoneId: 'Asia/Jerusalem',
    viewport: { width: 1280, height: 900 }
  });
  const page = await context.newPage();

  await page.goto('https://web.whatsapp.com');
  console.log('WhatsApp ready — scan QR if required.');

  // Open target group
  await page.waitForSelector('div[contenteditable="true"][data-tab]', { timeout: 90000 });
  const sb = (await page.$$('div[contenteditable="true"][data-tab]'))[0];
  await sb.fill(GROUP_NAME);
  await page.waitForTimeout(800);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  console.log(`Group opened: ${GROUP_NAME}`);

  // Polling loop
  setInterval(async () => {
    try {
      // Daily prune check
      const nowMid = getIsraelMidnight();
      if (nowMid > lastPruneMidnight) midnightPrune();

      const rows = await page.$$('div[data-id]');
      if (!rows.length) return;
      const last = rows[rows.length - 1];
      const msgId = await last.getAttribute('data-id');
      if (!msgId || processedIds.has(msgId)) return;
      processedIds.add(msgId);

      const textNode = await last.$('span.selectable-text') || await last.$('span[dir="auto"]');
      if (!textNode) return;
      const msgText = (await textNode.innerText()).trim();
      const words = msgText.split(/\s+/);
      if (words.length === 0 || words.length > 3) return;

      const key = msgText.toLowerCase();
      const prev = history.get(key) || [];
      history.set(key, [...prev, new Date()]);
      persist();

      if (prev.length) {
        const reply = buildReply(msgText, prev.map(d => d.getTime()));
        const input = await page.$('div[contenteditable="true"][data-tab="10"]');
        if (input) {
          await input.type(reply);
          await input.press('Enter');
        }
      }
    } catch (err) {
      console.error('Loop error', err);
    }
  }, CHECK_EVERY_MS);
})();