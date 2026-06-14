
const BACKEND = "https://ai-focus-guardian-backend.onrender.com";
const today   = new Date().toDateString();
let isActive  = true;
let authToken = null;

function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.remove('show');
  void t.offsetWidth;
  t.classList.add('show');
  clearTimeout(t._t);
  t._t = setTimeout(() => t.classList.remove('show'), 2500);
}

// ── STATS ─────────────────────────────────────
// Renders stats by combining local storage (blocks, streak, recent)
// with the backend's authoritative focus minutes — same source as the dashboard.
async function renderStats() {
  chrome.storage.local.get('fg_stats', async (data) => {
    const s       = data.fg_stats || {};
    const isToday = s.date === today;

    document.getElementById('stat-blocks').textContent = isToday ? (s.blocks || 0) : 0;
    document.getElementById('stat-streak').textContent = isToday ? (s.streak || 0) : 0;

    // Fetch focus minutes from the backend so the popup and dashboard always agree
    let focusMin = isToday ? (s.focusMin || 0) : 0;
    if (authToken) {
      try {
        const res  = await fetch(`${BACKEND}/api/gamification`, {
          headers: { 'Authorization': `Bearer ${authToken}` }
        });
        if (res.ok) {
          const gData = await res.json();
          // Use the same total_focus_min field the dashboard reads from
          focusMin = gData.total_focus_min ?? focusMin;
          // Keep local storage in sync so offline reads are also correct
          if (isToday) {
            s.focusMin = focusMin;
            chrome.storage.local.set({ fg_stats: s });
          }
        }
      } catch {
        // Backend unreachable — use local value as fallback
      }
    }
    document.getElementById('stat-focus').textContent = focusMin;

    const list   = document.getElementById('block-list');
    const recent = isToday ? (s.recent || []).slice(-4).reverse() : [];
    list.innerHTML = recent.length === 0
      ? '<div class="empty-msg">No blocks yet today 🎉</div>'
      : recent.map(r => `<div class="block-item"><span class="block-domain">⛔ ${r.domain}</span><span class="block-time">${r.time}</span></div>`).join('');
  });
}

function clearStats() {
  chrome.storage.local.remove('fg_stats', () => {
    renderStats();
    showToast('Stats cleared');
  });
}

setInterval(renderStats, 3000);

function toggleGuardian() {
  isActive = !isActive;
  chrome.storage.local.set({ fg_paused: !isActive });
  const btn    = document.getElementById('main-toggle');
  const banner = document.getElementById('status-banner');
  if (isActive) {
    btn.classList.add('active'); banner.classList.remove('paused');
    document.getElementById('toggle-label').textContent = 'Active';
    document.getElementById('status-text').textContent  = 'Guardian is Active';
    document.getElementById('status-sub').textContent   = 'AI is watching your tabs';
    showToast('✅ Guardian activated');
  } else {
    btn.classList.remove('active'); banner.classList.add('paused');
    document.getElementById('toggle-label').textContent = 'Paused';
    document.getElementById('status-text').textContent  = 'Guardian is Paused';
    document.getElementById('status-sub').textContent   = 'All sites temporarily allowed';
    showToast('⏸ Guardian paused');
  }
}

async function authFetch(url, opts = {}) {
  return fetch(url, {
    ...opts,
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}`, ...(opts.headers || {}) }
  });
}

async function loadWhitelist() {
  try {
    const res  = await authFetch(`${BACKEND}/api/whitelist`);
    const data = await res.json();
    const wl   = data.whitelist || [];
    localStorage.setItem('fg_whitelist', JSON.stringify(wl));
    renderWhitelist(wl);
    chrome.runtime.sendMessage({ type: 'WHITELIST_UPDATE', whitelist: wl, token: authToken });
  } catch {
    renderWhitelist(JSON.parse(localStorage.getItem('fg_whitelist') || '[]'));
  }
}

function renderWhitelist(wl) {
  document.getElementById('whitelist-items').innerHTML = wl.map(d =>
    `<div class="wl-tag">${d}<button class="wl-remove" onclick="removeWhitelist('${d}')">×</button></div>`
  ).join('');
}

async function addWhitelist() {
  const input  = document.getElementById('domain-input');
  const addBtn = document.getElementById('add-btn');
  let val = input.value.trim().toLowerCase().replace(/^https?:\/\//,'').replace(/^www\./,'').split('/')[0];
  if (!val) return;
  const wl = JSON.parse(localStorage.getItem('fg_whitelist') || '[]');
  if (wl.includes(val)) { showToast(`${val} already whitelisted`); return; }
  wl.push(val);
  localStorage.setItem('fg_whitelist', JSON.stringify(wl));
  renderWhitelist(wl);
  input.value = '';
  chrome.runtime.sendMessage({ type: 'WHITELIST_UPDATE', whitelist: wl, token: authToken });
  addBtn.textContent = '...';
  try {
    await authFetch(`${BACKEND}/api/whitelist`, { method: 'POST', body: JSON.stringify({ domain: val }) });
    showToast(`✅ ${val} whitelisted`);
  } catch { showToast(`✅ ${val} saved locally`); }
  finally { addBtn.textContent = '+ Add'; }
}

async function removeWhitelist(domain) {
  const wl = JSON.parse(localStorage.getItem('fg_whitelist') || '[]').filter(d => d !== domain);
  localStorage.setItem('fg_whitelist', JSON.stringify(wl));
  renderWhitelist(wl);
  chrome.runtime.sendMessage({ type: 'WHITELIST_UPDATE', whitelist: wl, token: authToken });
  try {
    await authFetch(`${BACKEND}/api/whitelist`, { method: 'DELETE', body: JSON.stringify({ domain }) });
    showToast(`🗑 ${domain} removed`);
  } catch { showToast(`🗑 ${domain} removed locally`); }
}

function logout() {
  chrome.storage.local.remove(
    ['fg_token', 'fg_user', 'fg_whitelist', 'fg_paused', 'fg_stats', 'fg_last_active'],
    () => window.location.replace(chrome.runtime.getURL('auth.html'))
  );
}

// ── INIT ─────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  document.querySelector('.logout-btn').addEventListener('click', logout);
  document.getElementById('main-toggle').addEventListener('click', toggleGuardian);
  document.getElementById('add-btn').addEventListener('click', addWhitelist);
  document.querySelector('.clear-btn').addEventListener('click', clearStats);
  document.getElementById('dash-btn').addEventListener('click', () => {
    chrome.storage.local.get('fg_token', (data) => {
      window.open(`http://localhost:8000/dashboard?token=${data.fg_token}`);
    });
  });

  chrome.storage.local.get(['fg_token', 'fg_user', 'fg_paused'], (data) => {
    if (!data.fg_token) { window.location.replace(chrome.runtime.getURL('auth.html')); return; }
    authToken = data.fg_token;
    const user = data.fg_user || {};
    document.getElementById('user-name').textContent = user.name || user.email || 'User';
    isActive = !data.fg_paused;
    if (!isActive) {
      document.getElementById('main-toggle').classList.remove('active');
      document.getElementById('status-banner').classList.add('paused');
      document.getElementById('toggle-label').textContent = 'Paused';
      document.getElementById('status-text').textContent  = 'Guardian is Paused';
      document.getElementById('status-sub').textContent   = 'All sites temporarily allowed';
    }
    renderStats();
    loadWhitelist();
  });
});
