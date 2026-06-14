const BACKEND = "https://ai-focus-guardian-backend.onrender.com";

// ── Tab switching ─────────────────────────────
function switchTab(tab) {
  document.getElementById('login-form').classList.toggle('form-hidden', tab !== 'login');
  document.getElementById('register-form').classList.toggle('form-hidden', tab !== 'register');
  document.getElementById('forgot-form').classList.toggle('form-hidden', tab !== 'forgot');
  document.getElementById('tab-login').classList.toggle('active', tab === 'login');
  document.getElementById('tab-register').classList.toggle('active', tab === 'register');
  // Hide tabs and google button when on forgot view; show otherwise
  const onForgot = tab === 'forgot';
  document.querySelector('.tabs').style.display = onForgot ? 'none' : '';
  document.querySelector('.google-btn-wrap').style.display = onForgot ? 'none' : '';
  document.getElementById('signup-nudge').style.display = (tab === 'login') ? '' : 'none';
  clearAll();
}

function clearAll() {
  ['login-email-err','login-pass-err','reg-name-err','reg-email-err','reg-pass-err','forgot-email-err']
    .forEach(id => { const el = document.getElementById(id); if (el) el.textContent = ''; });
  ['login-email','login-password','reg-name','reg-email','reg-password','forgot-email']
    .forEach(id => { const el = document.getElementById(id); if (el) el.classList.remove('error-input'); });
  document.getElementById('server-error').classList.remove('show');
  document.getElementById('server-success').classList.remove('show');
  document.getElementById('resend-wrap').classList.remove('show');
}

function showError(msg) {
  const el = document.getElementById('server-error');
  el.textContent = msg; el.classList.add('show');
}

function showSuccess(msg) {
  const el = document.getElementById('server-success');
  el.textContent = msg; el.classList.add('show');
}

function setLoading(btnId, loading) {
  const btn = document.getElementById(btnId);
  btn.disabled = loading;
  if (btnId === 'login-btn')   btn.textContent = loading ? 'Please wait...' : 'Login';
  else if (btnId === 'reg-btn')   btn.textContent = loading ? 'Please wait...' : 'Create Account';
  else if (btnId === 'forgot-btn') btn.textContent = loading ? 'Sending...' : 'Send Reset Link';
}

function goToPopup() {
  window.location.replace(chrome.runtime.getURL('pop.html'));
}

// Clear all previous user data so a new user starts fresh
function clearPreviousUserData(callback) {
  chrome.storage.local.remove(
    ['fg_stats','fg_whitelist','fg_paused','fg_last_active'], callback
  );
}

function saveAndGo(token, user) {
  clearPreviousUserData(() => {
    chrome.storage.local.set({ fg_token: token, fg_user: user }, goToPopup);
  });
}

// ── LOGIN ─────────────────────────────────────
async function handleLogin() {
  clearAll();
  const email    = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;
  let valid = true;

  if (!email) {
    document.getElementById('login-email-err').textContent = 'Email is required';
    document.getElementById('login-email').classList.add('error-input');
    valid = false;
  }
  if (!password) {
    document.getElementById('login-pass-err').textContent = 'Password is required';
    document.getElementById('login-password').classList.add('error-input');
    valid = false;
  }
  if (!valid) return;

  setLoading('login-btn', true);
  try {
    const res  = await fetch(`${BACKEND}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email.toLowerCase(), password })
    });
    const data = await res.json();

    if (!res.ok) {
      // If unverified — show resend option
      if (res.status === 403) {
        showError('❌ ' + data.detail);
        document.getElementById('resend-wrap').classList.add('show');
      } else {
        showError('❌ ' + (data.detail || 'Login failed'));
      }
      return;
    }
    saveAndGo(data.token, data.user);
  } catch {
    showError('❌ Unable to reach the server. Please check your internet connection and try again.');
  } finally {
    setLoading('login-btn', false);
  }
}

// ── REGISTER ──────────────────────────────────
async function handleRegister() {
  clearAll();
  const name     = document.getElementById('reg-name').value.trim();
  const email    = document.getElementById('reg-email').value.trim();
  const password = document.getElementById('reg-password').value;
  let valid = true;

  if (!name) {
    document.getElementById('reg-name-err').textContent = 'Name is required';
    document.getElementById('reg-name').classList.add('error-input');
    valid = false;
  }
  if (!email || !/\S+@\S+\.\S+/.test(email)) {
    document.getElementById('reg-email-err').textContent = 'Valid email is required';
    document.getElementById('reg-email').classList.add('error-input');
    valid = false;
  }
  if (!password || password.length < 6) {
    document.getElementById('reg-pass-err').textContent = 'Minimum 6 characters';
    document.getElementById('reg-password').classList.add('error-input');
    valid = false;
  }
  if (!valid) return;

  setLoading('reg-btn', true);
  try {
    const res  = await fetch(`${BACKEND}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email: email.toLowerCase(), password })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'Registration failed');

    // Show success — do NOT auto-login, user must verify email first
    showSuccess(
      '✅ Account created! A verification email has been sent to ' + email +
      '. Please check your inbox and click the link before logging in.'
    );
    // Switch to login tab after 3 seconds
    setTimeout(() => switchTab('login'), 3000);
  } catch (err) {
    showError('❌ ' + (err.message || 'Unable to reach the server. Please check your internet connection and try again.'));
  } finally {
    setLoading('reg-btn', false);
  }
}

// ── RESEND VERIFICATION EMAIL ─────────────────
async function handleResend() {
  const email    = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;
  if (!email) { showError('❌ Enter your email first'); return; }

  document.getElementById('resend-btn').textContent = 'Sending...';
  try {
    const res  = await fetch(`${BACKEND}/api/auth/resend-verification`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email.toLowerCase(), password: password || 'x' })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail);
    document.getElementById('server-error').classList.remove('show');
    showSuccess('✅ Verification email resent! Check your inbox.');
    document.getElementById('resend-wrap').classList.remove('show');
  } catch (err) {
    showError('❌ ' + (err.message || 'Failed to resend'));
  } finally {
    document.getElementById('resend-btn').textContent = 'Resend verification email';
  }
}

// ── FORGOT PASSWORD ───────────────────────────
async function handleForgotPassword() {
  clearAll();
  const email = document.getElementById('forgot-email').value.trim();
  if (!email || !/\S+@\S+\.\S+/.test(email)) {
    document.getElementById('forgot-email-err').textContent = 'Valid email is required';
    document.getElementById('forgot-email').classList.add('error-input');
    return;
  }
  setLoading('forgot-btn', true);
  try {
    const res  = await fetch(`${BACKEND}/api/auth/forgot-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email.toLowerCase() })
    });
    const data = await res.json();
    if (!res.ok) {
      showError('❌ ' + (data.detail || 'Something went wrong'));
    } else {
      showSuccess('✅ ' + data.message);
      document.getElementById('forgot-email').value = '';
    }
  } catch {
    showError('❌ Unable to reach the server. Please check your internet connection and try again.');
  } finally {
    setLoading('forgot-btn', false);
  }
}

// ── GOOGLE LOGIN ──────────────────────────────
// This function is called automatically by Google's SDK after user selects account
async function handleGoogleLogin(response) {
  clearAll();
  try {
    const res  = await fetch(`${BACKEND}/api/auth/google`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id_token_str: response.credential })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'Google login failed');
    saveAndGo(data.token, data.user);
  } catch (err) {
    showError('❌ Google login failed: ' + err.message);
  }
}

// ── ENTER KEY ─────────────────────────────────
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  if (!document.getElementById('login-form').classList.contains('form-hidden'))   handleLogin();
  else if (!document.getElementById('register-form').classList.contains('form-hidden')) handleRegister();
  else if (!document.getElementById('forgot-form').classList.contains('form-hidden'))   handleForgotPassword();
});

// ── INIT ─────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('tab-login').addEventListener('click',    () => switchTab('login'));
  document.getElementById('tab-register').addEventListener('click', () => switchTab('register'));
  document.getElementById('login-btn').addEventListener('click',    handleLogin);
  document.getElementById('reg-btn').addEventListener('click',      handleRegister);
  document.getElementById('resend-btn').addEventListener('click',   handleResend);
  document.getElementById('forgot-link').addEventListener('click',  () => switchTab('forgot'));
  document.getElementById('back-to-login').addEventListener('click',() => switchTab('login'));
  document.getElementById('forgot-btn').addEventListener('click',   handleForgotPassword);
  document.getElementById('goto-register').addEventListener('click',() => switchTab('register'));

  // Already logged in? Go straight to popup
  chrome.storage.local.get(['fg_token'], (r) => {
    if (r.fg_token) goToPopup();
  });
});
