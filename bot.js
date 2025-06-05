/*
  WhatsApp Duplicate‑Message Bot (Playwright + Node.js)
  ====================================================
  תקציר בעברית
  -------------
  מטרה: לעזור למתנדבי צפון אמריקה לזהות פונים חוזרים ששלחו הודעה
          מאז חצות (שעון ישראל).
  דרך הפעולה: הבוט מאזין לערוץ ייעודי (מוגדר בקובץ .env); כאשר הוא מזהה הודעה
          בת מילה אחת עד שלוש מילים שחוזרת על עצמה מאז חצות הלילה האחרון
          (לפי שעון ישראל) – הוא מתריע על כך עם רשימת השעות (שעון ישראל)
          שבהן הופיעה ההודעה קודם לכן באותו היום.

  PURPOSE (English)
  -----------------
  Watches a single WhatsApp Web group (specified in .env). Tracks 1- to 3-word
  messages that have occurred since the last local midnight in Israel.
  If a duplicate of such a message appears within the same Israel day,
  the bot replies in Hebrew, listing the Israel timestamps of its previous occurrences
  on that day.
*/

// Core Node.js modules
const fs = require('fs');
// Playwright for browser automation
const { chromium } = require('playwright');
// dotenv for loading environment variables from a .env file
require('dotenv').config();

// --- Configuration ---
// These settings are loaded from the .env file or use default values.

// The exact name of the WhatsApp group the bot should monitor.
const GROUP_NAME      = process.env.GROUP_NAME;
// Path to the directory where Playwright will store user data (cookies, session info).
// This helps maintain the WhatsApp Web session across bot restarts, avoiding frequent QR scans.
const USER_DATA       = process.env.USER_DATA || './wadata';
// How often (in milliseconds) the bot should check for new messages.
const CHECK_EVERY_MS  = Number(process.env.CHECK_EVERY_MS) || 4000; // Default: 4 seconds
// Which browser Playwright should use ('chromium', 'firefox', 'webkit').
const BROWSER_CHANNEL = process.env.BROWSER_CHANNEL || 'chromium';
// Whether to run the browser in headless mode (no visible UI).
// Set to 'false' for debugging or initial QR code scan.
const HEADLESS        = process.env.HEADLESS === 'false' ? false : true;
// Path to the JSON file used to persist message history.
const PERSIST_PATH    = './history.json';
// Constant for milliseconds in a day (24 hours) - currently not used as logic is "since midnight"
// const DAY_MS          = 24 * 60 * 60 * 1000;

/**
 * getIsraelMidnight()
 * --------------------
 * Calculates and returns the timestamp (milliseconds since epoch) for the
 * beginning of the current day (00:00:00) in Israel local time (Asia/Jerusalem).
 * This is used as the cutoff for message history.
 */
function getIsraelMidnight() {
  const now = new Date();
  // Get the current date string formatted for Israel timezone
  const dateString = now.toLocaleDateString('en-US', { timeZone: 'Asia/Jerusalem' });
  // Parse the date string (assuming MM/DD/YYYY format from en-US)
  const [month, day, year] = dateString.split('/');
  // Create a new Date object for midnight in Israel. Month is 0-indexed.
  return new Date(Number(year), Number(month) - 1, Number(day), 0, 0, 0, 0).getTime();
}

// --- In-memory Stores ---

// Stores the timestamp of the last midnight for which pruning was done.
// Initialized to the current day's Israel midnight.
let lastPruneMidnight = getIsraelMidnight();

// `history`: A Map to store message history for the current day.
// Key: Lowercased message text (string).
// Value: Array of Date objects, representing timestamps of occurrences.
const history = new Map();

// `processedIds`: A Set to keep track of WhatsApp message IDs already processed
// in the current session for the current day. This prevents re-processing the same message
// if the polling interval catches it multiple times before it's visually "old".
// Cleared daily by `midnightPrune`.
const processedIds = new Set();

// --- History Persistence ---

// Load existing history from disk on startup.
try {
  if (fs.existsSync(PERSIST_PATH)) {
    const rawData = fs.readFileSync(PERSIST_PATH, 'utf-8');
    const parsedData = JSON.parse(rawData);
    // Convert ISO string timestamps back to Date objects
    for (const [key, timestampsArray] of Object.entries(parsedData)) {
      history.set(key, timestampsArray.map(ts => new Date(ts)));
    }
    console.log(`Loaded ${history.size} entries from ${PERSIST_PATH}`);
  }
} catch (e) {
  console.warn(`Could not load ${PERSIST_PATH}, starting fresh. Error:`, e.message);
}

// Perform an initial prune on startup to ensure history is clean for the current day.
midnightPrune();

/**
 * persist()
 * ---------
 * Serializes the current `history` Map to a JSON file on disk.
 * Date objects are converted to ISO 8601 string format for JSON compatibility.
 */
function persist() {
  try {
    const historyObject = Object.fromEntries(
      [...history.entries()].map(([key, timestampsArray]) => 
        [key, timestampsArray.map(date => date.toISOString())]
      )
    );
    fs.writeFileSync(PERSIST_PATH, JSON.stringify(historyObject));
    // console.log(`DEBUG: persist() called. History size: ${history.size}`); // Optional debug log
  } catch (e) {
    console.error('Persist failed:', e.message);
  }
}

/**
 * midnightPrune()
 * ---------------
 * Clears out old messages from the `history` Map.
 * It removes all entries whose timestamps are older than the current day's
 * Israel midnight. This function is intended to run once daily.
 * It also clears the `processedIds` Set.
 */
function midnightPrune() {
  const cutoffTimestamp = getIsraelMidnight(); // Midnight of the current day in Israel

  for (const [messageKey, timestamps] of history) {
    // Filter to keep only timestamps that are on or after the cutoff
    const recentTimestamps = timestamps.filter(t => t.getTime() >= cutoffTimestamp);
    if (recentTimestamps.length > 0) {
      history.set(messageKey, recentTimestamps);
    } else {
      // If no recent timestamps, remove the message entry entirely
      history.delete(messageKey);
      console.log(`Deleted stale history for message key: "${messageKey}"`);
    }
  }
  persist(); // Save the pruned history to disk
  processedIds.clear(); // Clear the set of processed message IDs for the new day
  lastPruneMidnight = cutoffTimestamp; // Update the last prune time
  console.log(`Completed midnightPrune; history size=${history.size}, processedIds cleared.`);
}

/**
 * buildReply(msg, times)
 * -----------------------
 * Constructs the Hebrew reply message indicating a duplicate.
 * @param {string} msg - The duplicate message text.
 * @param {number[]} times - Array of timestamps (ms since epoch) of previous occurrences.
 * @returns {string} - The formatted reply message in Hebrew.
 */
function buildReply(msg, times) {
  // Format timestamps to HH:MM in Israel time
  const formattedTimes = times
    .sort((a, b) => a - b) // Sort chronologically
    .map(timestamp => new Date(timestamp).toLocaleTimeString('en-US', { // Using en-US for HH:MM format
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: 'Asia/Jerusalem'
    }))
    .join(', '); // Join timestamps with a comma and space

  return `⚠️ ההודעה "${msg}" הופיעה היום גם בשעות: ${formattedTimes}`;
}

// --- Main Bot Logic (Immediately Invoked Function Expression - IIFE) ---
(async () => {
  // Validate that GROUP_NAME is set
  if (!GROUP_NAME) {
    console.error('CRITICAL: GROUP_NAME environment variable is not set. Exiting.');
    process.exit(1); // Exit if group name is missing
  }

  console.log(`Bot starting. Headless: ${HEADLESS}, Group: "${GROUP_NAME}"`);

  // Launch the browser with a persistent context
  const context = await chromium.launchPersistentContext(USER_DATA, {
    headless: HEADLESS,
    channel: BROWSER_CHANNEL,
    timezoneId: 'Asia/Jerusalem', // Set timezone for the browser context
    viewport: { width: 1280, height: 900 }, // Define browser window size
    // slowMo: HEADLESS ? undefined : 50, // Optional: Slow down operations for easier debugging when not headless
  });
  const page = await context.newPage(); // Open a new page in the browser

  let chatInputLocator; // Will store the Playwright locator for the chat input box

  // --- Initialization Block: Navigate, Log In (if needed), Open Group ---
  try {
    console.log('Navigating to WhatsApp Web...');
    await page.goto('https://web.whatsapp.com', { timeout: 90000, waitUntil: 'domcontentloaded' });
    console.log('WhatsApp Web page loaded.');

    // Wait for a general sign that the WhatsApp UI is ready (e.g., a contenteditable field)
    const initialReadySelector = 'div[contenteditable="true"][data-tab]';
    console.log(`Waiting for WhatsApp interface to be ready (using selector: ${initialReadySelector})...`);
    await page.waitForSelector(initialReadySelector, { timeout: 60000, state: 'visible' }); // 1 minute timeout
    console.log('WhatsApp interface appears ready (found a contenteditable element).');

    console.log(`Attempting to select group: "${GROUP_NAME}"`);

    // Attempt to find the chat search box using various selectors
    let searchBox;
    const searchBoxTitleEN = "Search or start new chat"; // Common English title/placeholder
    const searchBoxTitleHE = "חיפוש או התחלת צ׳אט חדש"; // Common Hebrew title/placeholder
    
    try {
        // Try specific selectors first (title attribute or data-testid)
        searchBox = page.locator(
            `div[contenteditable="true"][title="${searchBoxTitleEN}"], ` +
            `div[contenteditable="true"][title="${searchBoxTitleHE}"], ` +
            `div[data-testid="chat-list-search"]` // Common data-testid for the search input
        ).first(); // Take the first match
        await searchBox.waitFor({ state: 'visible', timeout: 10000 });
        console.log('Search box found using specific title or data-testid.');
    } catch (e) {
        // Fallback: If specific selectors fail, use the general contenteditable selector
        // This was the method used in the original working script.
        console.warn(`Could not find search box by common titles or data-testid. Falling back to original script's method (first contenteditable field). Details: ${e.message}`);
        searchBox = page.locator(initialReadySelector).first();
        await searchBox.waitFor({ state: 'visible', timeout: 5000 });
        console.log('Using the first contenteditable field as the search box (fallback).');
    }

    await searchBox.click({timeout: 5000}); // Click to ensure focus
    await searchBox.fill(GROUP_NAME);      // Type the group name
    console.log(`Filled search box with: "${GROUP_NAME}"`);

    // Locate the group in the search results using its exact name (text content)
    // This looks for a list item containing a span with the exact group name.
    const groupListItemLocator = page.locator(`div[role="listitem"]:has(span:text-is("${GROUP_NAME}"))`).first();
    console.log(`Waiting for group named "${GROUP_NAME}" to appear in search results...`);
    await groupListItemLocator.waitFor({ state: 'visible', timeout: 20000 });
    console.log(`Search result for "${GROUP_NAME}" found. Attempting to click it.`);
    await groupListItemLocator.click({timeout: 10000}); // Click the search result
    console.log(`Clicked on group: "${GROUP_NAME}"`);

    // After clicking the group, wait for the chat's message input box to be ready
    console.log('Waiting for chat input box to be ready...');
    const originalChatInputSelector = 'div[contenteditable="true"][data-tab="10"]'; // Used in original script to type
    const dataTestIdChatInputSelector = 'div[data-testid="conversation-compose-box-input"]'; // Common data-testid

    try {
        // Prefer data-testid if available
        chatInputLocator = page.locator(dataTestIdChatInputSelector);
        await chatInputLocator.waitFor({ state: 'visible', timeout: 20000 }); 
        console.log(`Chat input box found using data-testid: "${dataTestIdChatInputSelector}"`);
    } catch (e) {
        // Fallback to the selector used in the original script
        console.warn(`Chat input box with data-testid "${dataTestIdChatInputSelector}" not found or timed out. Trying original selector: "${originalChatInputSelector}". Details: ${e.message}`);
        try {
            chatInputLocator = page.locator(originalChatInputSelector);
            await chatInputLocator.waitFor({ state: 'visible', timeout: 10000 });
            console.log(`Chat input box found using original selector: "${originalChatInputSelector}"`);
        } catch (e2) {
            // If both methods fail, the bot cannot send replies.
            console.error(`CRITICAL ERROR: Could not find the chat input box after opening group "${GROUP_NAME}".`); 
            console.error(`DETAILS for data-testid attempt: ${e.message}`);
            console.error(`DETAILS for original selector attempt: ${e2.message}`);
            await context.close(); process.exit(1);
        }
    }
    console.log(`Successfully opened and focused group chat: "${GROUP_NAME}" (compose box identified).`);

  } catch (initError) {
      // Catch-all for errors during the initialization phase
      console.error('Failed during bot initialization:', initError.message); 
      if (initError.message.includes('page.pause()')) { // Specific message if paused for debug
        console.log("Script was paused for debugging. If you closed the inspector, this is expected.");
      } else {
        if (HEADLESS) console.log("Try running with HEADLESS=false in your .env to diagnose (e.g., for QR scan).");
      }
      await context.close(); process.exit(1); // Exit on initialization failure
  }

  // --- Polling Loop ---
  // This loop runs repeatedly to check for new messages.
  let consecutiveFailures = 0; // Counter for consecutive errors in the loop
  const MAX_CONSECUTIVE_FAILURES = 10; // Threshold to exit if loop consistently fails

  console.log("\n--- STARTING POLLING LOOP ---");
  setInterval(async () => {
    try {
      // Check if it's time for the daily history prune
      const nowMid = getIsraelMidnight();
      if (nowMid > lastPruneMidnight) {
        console.log("Performing daily midnight prune...");
        midnightPrune();
      }

      // Fetch all message row elements using the selector that worked in the original script
      const messageRowSelector = 'div[data-id]';
      const rows = await page.$$(messageRowSelector);
      
      if (!rows.length) { // If no message elements are found
        consecutiveFailures = 0; // Reset counter, as this can be normal in an inactive group
        return; // Skip the rest of this interval
      }

      const lastMessageElement = rows[rows.length - 1]; // Get the last message element
      const messageId = await lastMessageElement.getAttribute('data-id'); // Get its WhatsApp ID

      if (!messageId) { // If the message has no ID (unlikely for user messages)
        consecutiveFailures = 0;
        return;
      }
      if (processedIds.has(messageId)) { // If this message ID has already been processed today
        consecutiveFailures = 0;
        return;
      }
      processedIds.add(messageId); // Mark this message ID as processed

      // Attempt to find the text content of the message using a list of potential selectors
      const textNodeSelectors = [ 
        'span.selectable-text.copyable-text > span[dir="ltr"]', // Specific selectors for text spans
        'span.selectable-text.copyable-text > span[dir="rtl"]',
        'div.copyable-text[data-message-text]',
        'span.selectable-text', // General selector used in original script
        'span[dir="auto"]'      // Another general selector from original script
      ];
      let textNode = null;
      for (const selector of textNodeSelectors) {
        textNode = await lastMessageElement.$(selector);
        if (textNode) break; // Found a text node, stop searching
      }
      
      if (!textNode) { // If no text content element was found (e.g., image, sticker, system message)
        consecutiveFailures = 0;
        return;
      }

      const messageText = (await textNode.innerText()).trim(); // Get and trim the text
      // Split into words and filter out empty strings (from multiple spaces)
      const words = messageText.split(/\s+/).filter(word => word.length > 0); 

      // Filter messages: must be 1 to 3 words long and not empty.
      if (words.length === 0 || words.length > 3 || messageText.length === 0) {
        consecutiveFailures = 0;
        return;
      }

      // Message meets criteria, process it for history
      const historyKey = messageText.toLowerCase(); // Use lowercased text as the history key
      const previousTimestamps = history.get(historyKey) || []; // Get existing occurrences
      const currentTimestamp = new Date(); // Timestamp for this occurrence

      if (previousTimestamps.length > 0) { // If this message has appeared before today
        const replyMessage = buildReply(messageText, previousTimestamps.map(d => d.getTime()));
        // Send the reply if the chat input box is available
        if (chatInputLocator && await chatInputLocator.isVisible()) {
          await chatInputLocator.fill(replyMessage);
          await page.keyboard.press('Enter');
          console.log(`Replied to duplicate: "${messageText}"`);
        } else {
          console.warn(`Chat input box not available to send reply for "${messageText}".`);
        }
      }

      // Add/update the message in history with the new timestamp
      history.set(historyKey, [...previousTimestamps, currentTimestamp]);
      persist(); // Save the updated history to disk

      consecutiveFailures = 0; // Reset failure counter on successful processing
    } catch (err) {
      // Handle errors within the polling loop
      console.error('Error in polling loop:', err.message);
      console.error(err.stack); // Log the full error stack for debugging
      consecutiveFailures++;
      console.log(`Consecutive failures: ${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}`);
      // If too many consecutive errors, exit the bot to prevent problematic behavior
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        console.error(`Max consecutive failures reached. This might indicate a persistent issue (e.g., session lost, major UI change). Bot will exit.`);
        await context.close();
        process.exit(1);
      }
    }
  }, CHECK_EVERY_MS); // Run this loop at the configured interval
})();