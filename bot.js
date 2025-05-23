/*
  WhatsApp Duplicate‑Message Bot (Playwright + Node.js)
  ====================================================
  תקציר בעברית
  -------------
  מטרה: לעזור למתנדבי צפון אמריקה לזהות פונים חוזרים ששלחו הודעה
          במהלך 24 השעות האחרונות.
  דרך הפעולה: הבוט מאזין לערוץ "ערן Offline"; כאשר הוא מזהה הודעה
          בת מילה אחת עד שלוש מילים שחוזרת על עצמה ב־24 השעות
          האחרונות – הוא מתריע על כך עם השעות (שעון **ET**) שבהן
          הופיעה קודם.

  PURPOSE (English)
  -----------------
  Watches a single WhatsApp Web group. Tracks **1‑ to 3‑word**
  messages for 24 hours. If a duplicate appears, replies in Hebrew
  with all previous times (annotated **ET**). Falls back to installed
  Chrome if bundled Chromium is missing under the service account.

  NEW IN THIS VERSION (2025‑05‑20)
  -------------------------------
  • Flat‑file persistence (`history.json`).
  • Matches 1–3‑word messages.
  • `processedIds` Set to avoid DOM re‑render duplicates.
  • **Times in reply end with "(ET)"**.
  • **Browser fallback**: if bundled Chromium isn’t found (under SYSTEM),
    automatically switch to the local Chrome channel.

  QUICK START
  -----------
    npm i playwright dotenv
    npx playwright install chromium

  .env example:
      GROUP_NAME="My Group"
      USER_DATA="./wadata"
      CHECK_EVERY_MS=4000
      BROWSER_CHANNEL=chromium   # auto‑fallback to chrome if needed

  ------------------------------------------------------------------- */

const fs = require('fs');
const { chromium } = require('playwright');
require('dotenv').config();

const GROUP_NAME      = process.env.GROUP_NAME;
const USER_DATA       = process.env.USER_DATA || './wadata';
const CHECK_EVERY_MS  = Number(process.env.CHECK_EVERY_MS) || 4000;
const BROWSER_CHANNEL = process.env.BROWSER_CHANNEL || 'chromium';
const DAY_MS          = 24 * 60 * 60 * 1000;
const PERSIST_PATH    = './history.json';
// –––––– New env toggle for headless mode ––––––
const HEADLESS        = process.env.HEADLESS === 'false' ? false : true;

if (!GROUP_NAME) {
  console.error('Missing GROUP_NAME in .env');
  process.exit(1);
}

// ----------------------- history Map with persistence ----------------------
const history = new Map();
try {
  if (fs.existsSync(PERSIST_PATH)) {
    const raw = JSON.parse(fs.readFileSync(PERSIST_PATH, 'utf-8'));
    for (const [k, arr] of Object.entries(raw)) {
      history.set(k, arr.map(ts => new Date(ts)));
    }
    console.log(`Loaded ${history.size} keys from history.json`);
  }
} catch (e) {
  console.warn('Could not read history.json, starting fresh', e);
}

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

// ----------------------------- helpers -----------------------------
let lastSeenId = null;
const processedIds = new Set();
const MAX_IDS      = 2000;
const nowStr = () => new Date().toLocaleTimeString('he-IL', { hour12: false });

function buildReply(msg, times) {
  const formatted = times
    .sort((a, b) => b - a)
    .map(t => t.toLocaleTimeString('he-IL', {
      hour: '2-digit', minute: '2-digit', hour12: false,
      timeZone: 'Asia/Jerusalem'   // display in Israel time (ILT)
    }))
    .join(' וב');
  return `ההודעה <${msg}> הופיעה ביממה האחרונה בשעות ${formatted} (ILT)`;
}

function prune() {
  const cutoff = Date.now() - DAY_MS;
  for (const [k, arr] of history) {
    const left = arr.filter(t => t.getTime() >= cutoff);
    if (left.length) history.set(k, left);
    else history.delete(k);
  }
  persist();
  if (processedIds.size > MAX_IDS) {
    const excess = processedIds.size - MAX_IDS;
    processedIds.forEach(id => {
      if (excess <= 0) return;
      processedIds.delete(id);
    });
  }
}

// ----------------------------- main --------------------------------
(async () => {
  let browser;
  try {
    browser = await chromium.launchPersistentContext(USER_DATA, {
      headless: HEADLESS,
      channel: BROWSER_CHANNEL !== 'chromium' ? BROWSER_CHANNEL : undefined,
      locale: 'he-IL',                // format in Hebrew locale
      timezoneId: 'Asia/Jerusalem',   // ensure browser uses Israeli time zone
      viewport: { width: 1280, height: 900 },
    });
  } catch (err) {
    if (err.message.includes("Executable doesn't exist")) {
      console.warn(`[${nowStr()}] Bundled Chromium missing; falling back to Chrome channel`);
      browser = await chromium.launchPersistentContext(USER_DATA, {
        headless: HEADLESS,                    // run headless when falling back as well
        channel: 'chrome',
        locale: 'he-IL',                    // ensure Hebrew locale
        timezoneId: 'Asia/Jerusalem',      // ensure Israel time zone
        viewport: { width: 1280, height: 900 }
      });
    } else throw err;
  }
  const [page] = browser.pages();
  await page.goto('https://web.whatsapp.com');
  console.log(`[${nowStr()}] WhatsApp ready — scan QR if required.`);

  const searchSel = 'div[contenteditable="true"][data-tab]';
  await page.waitForSelector(searchSel, { timeout: 90000 });
  const sb = (await page.$$(searchSel))[0];
  await sb.fill(GROUP_NAME);
  await page.waitForTimeout(800);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  console.log(`[${nowStr()}] Group opened: ${GROUP_NAME}`);

  // Wait for existing chat messages or fallback to the message input box
try {
  await page.waitForSelector('div[data-id]', { timeout: 60000 });
} catch {
  console.warn(`[${nowStr()}] No chat messages detected within 60s; proceeding to listen for new messages.`);
}
// Ensure the compose box is ready before starting the loop
await page.waitForSelector('div[contenteditable="true"][data-tab="10"]', { timeout: 60000 });

  setInterval(async () => {
    try {
      const rows = await page.$$('div[data-id]');
      if (!rows.length) return;
      const last = rows[rows.length - 1];
      const msgId = await last.getAttribute('data-id');
      if (!msgId || processedIds.has(msgId)) return;
      processedIds.add(msgId);
      lastSeenId = msgId;

      const textNode = await last.$('span.selectable-text') || await last.$('span[dir="auto"]');
      if (!textNode) return;
      const msgText = (await textNode.innerText()).trim();

      const words = msgText.split(/\s+/);
      if (words.length === 0 || words.length > 3) return;

      const dpp = await last.getAttribute('data-pre-plain-text');
      let msgDate = new Date();
      if (dpp) {
        const m = dpp.match(/\[(\d{2}):(\d{2})/);
        if (m) {
          const [h, mn] = m.slice(1).map(Number);
          const now = new Date();
          msgDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, mn);
        }
      }

      prune();

      const key  = msgText.toLowerCase();
      const prev = history.get(key) || [];
      history.set(key, [...prev, msgDate]);
      persist();
      console.log(`[${nowStr()}] Stored "${msgText}" (prev=${prev.length})`);

      if (prev.length) {
        console.log(`[${nowStr()}] Match found for "${msgText}"`);
        const reply = buildReply(msgText, prev);
        const input = await page.$('div[contenteditable="true"][data-tab="10"]');
        if (input) {
          await input.type(reply);
          await input.press('Enter');
          console.log(`[${nowStr()}] Replied with summary`);
        }
      }
    } catch (err) {
      console.error(`[${nowStr()}] Loop error`, err);
    }
  }, CHECK_EVERY_MS);
})();
