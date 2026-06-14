console.log("🚀 AI Focus Guardian Running");

const BACKEND_URL  = "https://ai-focus-guardian-backend.onrender.com";
const BLOCKED_PAGE = chrome.runtime.getURL("blocked.html");
const AUTH_PAGE    = chrome.runtime.getURL("auth.html");

const classificationCache = {};
let dynamicWhitelist = [];
let authToken = null;

const ALWAYS_ALLOW_PREFIXES = ["chrome://", "chrome-extension://", "about:", "edge://", "file://", "https://www.bing.com", "https://www.google.com"];
const DEFAULT_WHITELIST = ["google.com", "bing.com", "chatgpt.com", "claude.ai", "gemini.google.com", "github.com"];

// ── INIT ─────────────────────────────────────
chrome.storage.local.get(['fg_whitelist', 'fg_paused', 'fg_token'], (data) => {
  authToken        = data.fg_token || null;
  dynamicWhitelist = data.fg_whitelist || [...DEFAULT_WHITELIST];
  Object.keys(classificationCache).forEach(k => delete classificationCache[k]);
  console.log("✅ Auth token:", authToken ? "present" : "missing");
  console.log("✅ Whitelist loaded:", dynamicWhitelist);
});

// ── MESSAGES FROM POPUP ───────────────────────
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'WHITELIST_UPDATE') {
    dynamicWhitelist = msg.whitelist;
    if (msg.token) authToken = msg.token;
    chrome.storage.local.set({ fg_whitelist: dynamicWhitelist });
  }
});

// ── HELPERS ───────────────────────────────────
function extractDomain(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); }
  catch { return url; }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function isPaused() {
  return new Promise(r => chrome.storage.local.get('fg_paused', d => r(!!d.fg_paused)));
}

function getToken() {
  return new Promise(r => chrome.storage.local.get('fg_token', d => r(d.fg_token || null)));
}

// ── STATS ─────────────────────────────────────
function recordBlock(domain) {
  const today = new Date().toDateString();
  chrome.storage.local.get('fg_stats', (data) => {
    let s = data['fg_stats'] || {};
    if (s.date !== today) s = { date: today, blocks: 0, focusMin: 0, streak: 0, recent: [] };
    s.blocks = (s.blocks || 0) + 1;
    s.recent = s.recent || [];
    s.recent.push({ domain, time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) });
    if (s.recent.length > 20) s.recent = s.recent.slice(-20);
    chrome.storage.local.set({ fg_stats: s });
  });
}

// ── LOG TO MONGODB (with JWT) ─────────────────
async function logToBackend(domain, isDistraction, token) {
  if (!token) return;
  try {
    const now = new Date();
    await fetch(`${BACKEND_URL}/api/logs`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
      body: JSON.stringify({
        session_id: "session_" + now.toDateString().replace(/ /g, '_'),
        domain, duration: 0,
        timestamp: Math.floor(now.getTime() / 1000),
        hour: now.getHours(), day_of_week: now.getDay(),
        is_distracting: isDistraction ? 1 : 0
      })
    });
  } catch (err) {
    console.warn("⚠️ Log failed:", err.message);
  }
}

// ── AI CLASSIFICATION (with JWT) ─────────────
async function classifyWithAI(domain) {
  if (classificationCache[domain] !== undefined) {
    console.log(`📦 Cache hit: ${domain} → ${classificationCache[domain] ? "BLOCK" : "ALLOW"}`);
    return classificationCache[domain];
  }

  const token = await getToken();
  if (!token) {
    console.warn("⚠️ No auth token — skipping classification");
    return false;
  }

  console.log(`🤖 Classifying: ${domain}`);
  try {
    const response = await fetch(`${BACKEND_URL}/api/classify`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
      body: JSON.stringify({ domain })
    });

    if (response.status === 401) {
      console.warn("🔒 Token expired — redirecting to login");
      chrome.storage.local.remove(['fg_token', 'fg_user']);
      return false;
    }

    if (!response.ok) { console.warn("⚠️ Backend error:", response.status); return false; }

    const data        = await response.json();
    const verdict     = data.verdict?.trim().toUpperCase();
    const shouldBlock = verdict === "BLOCK";

    console.log(`🤖 Verdict for "${domain}": ${verdict}`);
    classificationCache[domain] = shouldBlock;
    logToBackend(domain, shouldBlock, token);
    return shouldBlock;

  } catch (err) {
    console.error("❌ Classify failed:", err.message);
    return false;
  }
}

// ── SHOULD BLOCK? ─────────────────────────────
async function shouldBlock(url) {
  if (!url) return false;
  if (ALWAYS_ALLOW_PREFIXES.some(p => url.startsWith(p))) return false;
  if (await isPaused()) return false;

  const domain = extractDomain(url);
  if (!domain) return false;

  const wl = dynamicWhitelist.length > 0 ? dynamicWhitelist : DEFAULT_WHITELIST;
  if (wl.some(allowed => domain.includes(allowed))) return false;

  return await classifyWithAI(domain);
}

// ── NOTIFICATIONS ─────────────────────────────
function showNotification() {
  chrome.notifications.create({
    type: "basic", iconUrl: chrome.runtime.getURL("icon.png"),
    title: "Focus Guardian 🧠",
    message: "Distracting site blocked by AI! Stay focused 🚀",
    priority: 2
  });
}

// ── BLOCK ─────────────────────────────────────
function blockTab(tabId, url) {
  const domain = extractDomain(url);
  chrome.tabs.update(tabId, { url: BLOCKED_PAGE + "?site=" + encodeURIComponent(domain) });
  showNotification();
  recordBlock(domain);
}

// ── FOCUS TIMER ───────────────────────────────
setInterval(async () => {
  if (await isPaused()) return;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url) return;

  // Only count focus time if current tab is NOT blocked
  const isBlockedPage = tab.url.startsWith(chrome.runtime.getURL('blocked.html'));
  if (!isBlockedPage) {
    const today = new Date().toDateString();
    chrome.storage.local.get('fg_stats', (data) => {
      let s = data.fg_stats || {};
      if (s.date !== today) s = { date: today, blocks: 0, focusMin: 0, streak: 0, recent: [] };
      s.focusMin = (s.focusMin || 0) + 1;
      if (s.focusMin === 1) updateStreak();
      chrome.storage.local.set({ fg_stats: s });
    });

    // SYNC TO BACKEND 
    const token = await getToken();
    if (token) {
      fetch(`${BACKEND_URL}/api/focus`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ focus_minutes: 1 })
      }).catch(err => console.warn('⚠️ Focus sync failed:', err.message));
    }
  }
}, 60000);

function updateStreak() {
  const today = new Date().toDateString();
  const yesterday = new Date(Date.now() - 86400000).toDateString();

  chrome.storage.local.get(['fg_stats', 'fg_last_active'], (data) => {
    let s = data.fg_stats || {};
    const lastActive = data.fg_last_active;

    if (lastActive === yesterday) {
      // Continued streak
      s.streak = (s.streak || 0) + 1;
    } else if (lastActive !== today) {
      // Streak broken
      s.streak = 1;
    }
    // If lastActive === today, streak stays the same

    chrome.storage.local.set({ fg_stats: s, fg_last_active: today });
  });
}

// ── LISTENERS ─────────────────────────────────
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" && tab.url) {
    if (await shouldBlock(tab.url)) blockTab(tabId, tab.url);
  }
});

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  try {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    if (tab.url && await shouldBlock(tab.url)) blockTab(tab.id, tab.url);
  } catch (err) { console.log("Tab error:", err.message); }
});

chrome.runtime.onStartup.addListener(checkAllTabs);
chrome.runtime.onInstalled.addListener(checkAllTabs);

async function checkAllTabs() {
  console.log("🔎 Checking tabs...");
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (tab.url && await shouldBlock(tab.url)) blockTab(tab.id, tab.url);
    await sleep(2500);
  }
}
