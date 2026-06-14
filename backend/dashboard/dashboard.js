const API = 'http://localhost:8000';
let token = null;
localStorage.removeItem('fg_dash_token');
localStorage.removeItem('fg_dash_user');
let isLogin = true;
let charts = {};

// ── AUTH ─────────────────────────────────────
function dswitch(tab) {
  isLogin = tab === 'login';
  document.querySelectorAll('.ltab').forEach((b,i) => b.classList.toggle('active', (i===0) === isLogin));
  document.getElementById('reg-name-wrap').classList.toggle('show', !isLogin);
  document.getElementById('d-submit').textContent = isLogin ? 'Login' : 'Create Account';
  document.getElementById('d-msg').textContent = '';
  document.getElementById('d-alert').innerHTML = '';
}

async function dSubmit() {
  const email = document.getElementById('d-email').value.trim();
  const pass  = document.getElementById('d-pass').value;
  const name  = document.getElementById('d-name')?.value.trim();
  const msgEl = document.getElementById('d-msg');
  const btn   = document.getElementById('d-submit');

  if (!email || !pass) { msgEl.textContent = 'Please fill all fields'; return; }
  if (!isLogin && !name) { msgEl.textContent = 'Name is required'; return; }
  if (!isLogin && pass.length < 6) { msgEl.textContent = 'Password min 6 characters'; return; }

  btn.disabled = true; btn.textContent = 'Please wait...';
  msgEl.textContent = '';

  try {
    const endpoint = isLogin ? '/api/auth/login' : '/api/auth/register';
    const body = isLogin ? { email, password: pass } : { name, email, password: pass };
    const res  = await fetch(`${API}${endpoint}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'Auth failed');

    token = data.token;
    localStorage.setItem('fg_dash_token', token);
    localStorage.setItem('fg_dash_user', JSON.stringify(data.user));

    document.getElementById('login-gate').style.display = 'none';
    document.getElementById('dashboard').style.display = 'block';
    loadDashboard(data.user);
  } catch(err) {
    msgEl.textContent = err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = isLogin ? 'Login' : 'Create Account';
  }
}

function logout() {
  localStorage.removeItem('fg_dash_token');
  localStorage.removeItem('fg_dash_user');
  token = null;
  document.getElementById('dashboard').style.display = 'none';
  document.getElementById('login-gate').style.display = 'flex';
  document.getElementById('d-email').value = '';
  document.getElementById('d-pass').value = '';
}

async function authFetch(url) {
  const res = await fetch(`${API}${url}`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  if (res.status === 401) { logout(); throw new Error('Session expired'); }
  return res.json();
}

// ── LOAD DASHBOARD ────────────────────────────
async function loadDashboard(user) {
  // Set nav
  document.getElementById('nav-name').textContent  = user?.name  || 'User';
  document.getElementById('nav-email').textContent = user?.email || '';
  document.getElementById('dash-date').textContent =
    'Last updated: ' + new Date().toLocaleString();

  try {
    const [analytics, gamification] = await Promise.all([
      authFetch('/api/analytics'),
      authFetch('/api/gamification')
    ]);
    renderStats(analytics.summary, gamification);
    renderLevel(gamification);
    renderDailyChart(analytics.daily_blocks);
    renderHourlyChart(analytics.hourly_pattern);
    renderPieChart(analytics.summary);
    renderTopDomains(analytics.top_domains);
    renderBadges(gamification.badges);
  } catch(err) {
    document.getElementById('dash-alert').innerHTML =
      `<div class="alert error">Failed to load data: ${err.message}. Make sure the backend is running.</div>`;
  }
}

// ── STATS ─────────────────────────────────────
function renderStats(summary, gamification) {
  document.getElementById('s-blocks').textContent = gamification.total_blocks || 0;
  document.getElementById('s-focus').textContent  = gamification.total_focus_min || 0;
  document.getElementById('s-streak').textContent = gamification.streak || 0;
  document.getElementById('s-points').textContent = gamification.points || 0;
}

// ── LEVEL ─────────────────────────────────────
function renderLevel(g) {
  const lv = g.level;
  document.getElementById('lv-icon').textContent = lv.icon;
  document.getElementById('lv-name').textContent = lv.name;
  document.getElementById('lv-pts').textContent  = `${g.points} focus points`;
  if (lv.next) {
    const pct = Math.min(100, Math.round((lv.current / lv.next) * 100));
    document.getElementById('lv-next').textContent = `${lv.current} / ${lv.next} pts`;
    document.getElementById('lv-fill').style.width = pct + '%';
  } else {
    document.getElementById('lv-next').textContent = 'Max Level! 🏆';
    document.getElementById('lv-fill').style.width = '100%';
  }
}

// ── DAILY CHART ───────────────────────────────
function renderDailyChart(data) {
  const ctx = document.getElementById('chart-daily').getContext('2d');
  if (charts.daily) charts.daily.destroy();
  charts.daily = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: data.map(d => {
        const dt = new Date(d.date);
        return dt.toLocaleDateString('en', { weekday: 'short', month: 'short', day: 'numeric' });
      }),
      datasets: [{
        label: 'Sites Blocked',
        data: data.map(d => d.blocks),
        backgroundColor: 'rgba(255,77,109,0.7)',
        borderColor: '#ff4d6d',
        borderWidth: 1,
        borderRadius: 6,
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: true,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: '#5a5a7a', font: { size: 10 } }, grid: { color: '#1e1e2e' } },
        y: { ticks: { color: '#5a5a7a', font: { size: 10 }, stepSize: 1 }, grid: { color: '#1e1e2e' }, beginAtZero: true }
      }
    }
  });
}

// ── HOURLY CHART ──────────────────────────────
function renderHourlyChart(data) {
  const ctx = document.getElementById('chart-hourly').getContext('2d');
  if (charts.hourly) charts.hourly.destroy();
  const labels = data.map(d => {
    const h = d.hour;
    return h === 0 ? '12am' : h < 12 ? `${h}am` : h === 12 ? '12pm' : `${h-12}pm`;
  });
  charts.hourly = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: 'Distractions',
        data: data.map(d => d.blocks),
        borderColor: '#ff9f43',
        backgroundColor: 'rgba(255,159,67,0.1)',
        borderWidth: 2,
        fill: true,
        tension: 0.4,
        pointRadius: 3,
        pointBackgroundColor: '#ff9f43',
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: true,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: '#5a5a7a', font: { size: 9 }, maxRotation: 45 }, grid: { color: '#1e1e2e' } },
        y: { ticks: { color: '#5a5a7a', font: { size: 10 }, stepSize: 1 }, grid: { color: '#1e1e2e' }, beginAtZero: true }
      }
    }
  });
}

// ── PIE CHART ─────────────────────────────────
function renderPieChart(summary) {
  const ctx = document.getElementById('chart-pie').getContext('2d');
  if (charts.pie) charts.pie.destroy();
  const blocked    = summary.total_blocks || 0;
  const total      = summary.total_logs   || 0;
  const productive = Math.max(0, total - blocked);
  charts.pie = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: ['Productive', 'Distracting'],
      datasets: [{
        data: [productive, blocked],
        backgroundColor: ['rgba(0,212,170,0.8)', 'rgba(255,77,109,0.8)'],
        borderColor: ['#00d4aa', '#ff4d6d'],
        borderWidth: 2,
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: true,
      plugins: {
        legend: {
          position: 'bottom',
          labels: { color: '#e8e8f0', font: { size: 11 }, padding: 16 }
        }
      }
    }
  });
}

// ── TOP DOMAINS ───────────────────────────────
function renderTopDomains(domains) {
  const el  = document.getElementById('domain-list');
  if (!domains || domains.length === 0) {
    el.innerHTML = '<div style="color:var(--muted);font-size:12px;">No blocked sites yet</div>';
    return;
  }
  const max = domains[0].count;
  el.innerHTML = domains.map(d => `
    <div class="domain-row">
      <div class="domain-name">⛔ ${d.domain}</div>
      <div class="domain-bar-wrap"><div class="domain-bar" style="width:${Math.round((d.count/max)*100)}%"></div></div>
      <div class="domain-count">${d.count}</div>
    </div>
  `).join('');
}

// ── BADGES ────────────────────────────────────
function renderBadges(badges) {
  const el = document.getElementById('badges-grid');
  el.innerHTML = badges.map(b => `
    <div class="badge-item ${b.earned ? 'earned' : 'locked'}">
      <div class="badge-icon">${b.icon}</div>
      <div class="badge-name">${b.name}</div>
      <div class="badge-desc">${b.desc}</div>
      <div class="badge-status">${b.earned ? '✅ Earned' : '🔒 Locked'}</div>
    </div>
  `).join('');
}

// ── INIT ─────────────────────────────────────


// Enter key
document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && document.getElementById('login-gate').style.display !== 'none') dSubmit();
});