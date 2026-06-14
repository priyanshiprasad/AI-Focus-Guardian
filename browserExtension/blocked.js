// ============================================================
// blocked.js — AI Focus Guardian
// Reads stats from chrome.storage.local (user-specific)
// NOT from localStorage (which is shared across all users)
// ============================================================

const BACKEND = "https://ai-focus-guardian-backend.onrender.com";

// ── BLOCKED URL DISPLAY ──────────────────────────────────────
const params = new URLSearchParams(window.location.search);
const site   = params.get('site') || 'Distracting site';
document.getElementById('blocked-url').textContent = '⛔ ' + site;

document.getElementById('go-back-link').addEventListener('click', (e) => {
  e.preventDefault();
  window.history.back();
});

// ── TOAST ────────────────────────────────────────────────────
function showToast(msg) {
  let toast = document.querySelector('.toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.className = 'toast';
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.classList.add('show');
  clearTimeout(toast._timeout);
  toast._timeout = setTimeout(() => toast.classList.remove('show'), 2800);
}

// ── STATS — read from chrome.storage.local ───────────────────
// This is user-specific and synced by background.js
// background.js writes fg_stats to chrome.storage.local
// We must NOT use localStorage here — it's shared across users

const today = new Date().toDateString();

function loadStats() {
  chrome.storage.local.get(['fg_stats', 'fg_user'], (data) => {
    const s    = data.fg_stats || {};
    const user = data.fg_user  || {};

    // Only use today's stats — if date mismatch, show 0
    const isToday = s.date === today;
    const blocks   = isToday ? (s.blocks   || 0) : 0;
    const focusMin = isToday ? (s.focusMin || 0) : 0;

    document.getElementById('block-count').textContent  = blocks;
    document.getElementById('focus-streak').textContent = focusMin;
  });
}

// Load stats immediately on page open
loadStats();

// Poll every 5 seconds so stats update in real time
// (background.js keeps writing to chrome.storage.local as blocks happen)
setInterval(loadStats, 5000);

// ── POMODORO TIMER ───────────────────────────────────────────
const CIRCUMFERENCE = 2 * Math.PI * 70;

let totalSecs    = 25 * 60;
let remainSecs   = totalSecs;
let running      = false;
let timerInterval = null;
let currentMode  = 'Focus';

const ringEl         = document.getElementById('ring');
const timerDisplayEl = document.getElementById('timer-display');
const timerModeEl    = document.getElementById('timer-mode');
const startBtn       = document.getElementById('start-btn');
const resetBtn       = document.getElementById('reset-btn');

function formatTime(secs) {
  const m = String(Math.floor(secs / 60)).padStart(2, '0');
  const s = String(secs % 60).padStart(2, '0');
  return `${m}:${s}`;
}

function updateRing() {
  const progress = remainSecs / totalSecs;
  ringEl.style.strokeDashoffset = CIRCUMFERENCE * (1 - progress);
  if (progress > 0.5)      ringEl.style.stroke = '#00d4aa';
  else if (progress > 0.2) ringEl.style.stroke = '#ff9f43';
  else                     ringEl.style.stroke = '#ff4d6d';
  timerDisplayEl.textContent = formatTime(remainSecs);
}

function startTimer() {
  running = true;
  startBtn.textContent = '⏸ Pause';
  timerModeEl.textContent = currentMode;

  timerInterval = setInterval(() => {
    if (remainSecs <= 0) {
      clearInterval(timerInterval);
      running = false;
      startBtn.textContent = '▶ Start';
      timerModeEl.textContent = '✅ Done!';

      if (currentMode === 'Focus') {
        const mins = Math.floor(totalSecs / 60);

        // ── Update chrome.storage.local (same store as background.js) ──
        chrome.storage.local.get('fg_stats', (data) => {
          let s = data.fg_stats || {};
          if (s.date !== today) s = { date: today, blocks: 0, focusMin: 0, streak: 0, recent: [] };
          s.focusMin = (s.focusMin || 0) + mins;
          chrome.storage.local.set({ fg_stats: s });
          document.getElementById('focus-streak').textContent = s.focusMin;
        });

        // ── Also sync to backend so gamification points update ──
        chrome.storage.local.get('fg_token', (data) => {
          const token = data.fg_token;
          if (!token) return;
          fetch(`${BACKEND}/api/focus`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ focus_minutes: mins })
          }).catch(() => {});
        });

        showToast(`🎉 Focus session complete! +${mins} minutes`);
      } else {
        showToast('⏰ Break is over! Time to focus.');
      }

      ringEl.classList.add('done-pulse');
      setTimeout(() => ringEl.classList.remove('done-pulse'), 2000);

      try {
        const audio = document.getElementById('timer-done-sound');
        audio.volume = 0.4;
        audio.play().catch(() => {});
      } catch(e) {}

      return;
    }
    remainSecs--;
    updateRing();
  }, 1000);
}

function pauseTimer() {
  clearInterval(timerInterval);
  running = false;
  startBtn.textContent = '▶ Resume';
}

startBtn.addEventListener('click', () => {
  if (running) pauseTimer();
  else startTimer();
});

resetBtn.addEventListener('click', () => {
  clearInterval(timerInterval);
  running = false;
  remainSecs = totalSecs;
  startBtn.textContent = '▶ Start';
  timerModeEl.textContent = currentMode;
  ringEl.style.stroke = '#00d4aa';
  updateRing();
  showToast('Timer reset');
});

document.querySelectorAll('.mode-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    clearInterval(timerInterval);
    running = false;
    currentMode = btn.dataset.label;
    totalSecs   = parseInt(btn.dataset.mins) * 60;
    remainSecs  = totalSecs;
    startBtn.textContent    = '▶ Start';
    timerModeEl.textContent = currentMode;
    ringEl.style.stroke     = '#00d4aa';
    updateRing();
    showToast(`Switched to ${currentMode} (${btn.dataset.mins} min)`);
  });
});

updateRing();

// ── QUOTES ───────────────────────────────────────────────────
const quotes = [
  { text: "The secret of getting ahead is getting started.", author: "Mark Twain" },
  { text: "It always seems impossible until it's done.", author: "Nelson Mandela" },
  { text: "Don't watch the clock; do what it does. Keep going.", author: "Sam Levenson" },
  { text: "Success is the sum of small efforts, repeated day in and day out.", author: "Robert Collier" },
  { text: "The expert in anything was once a beginner.", author: "Helen Hayes" },
  { text: "Discipline is the bridge between goals and accomplishment.", author: "Jim Rohn" },
  { text: "You don't have to be great to start, but you have to start to be great.", author: "Zig Ziglar" },
  { text: "Focus on being productive instead of busy.", author: "Tim Ferriss" },
  { text: "Either you run the day or the day runs you.", author: "Jim Rohn" },
  { text: "Code is like humor. When you have to explain it, it's bad.", author: "Cory House" },
  { text: "Programs must be written for people to read, and only incidentally for machines to execute.", author: "Harold Abelson" },
  { text: "The best time to plant a tree was 20 years ago. The second best time is now.", author: "Chinese Proverb" },
  { text: "Hard work beats talent when talent doesn't work hard.", author: "Tim Notke" },
  { text: "The only way to do great work is to love what you do.", author: "Steve Jobs" },
];

let lastQuoteIdx = -1;

function newQuote() {
  let idx;
  do { idx = Math.floor(Math.random() * quotes.length); } while (idx === lastQuoteIdx);
  lastQuoteIdx = idx;
  const q  = quotes[idx];
  const el = document.getElementById('quote-text');
  el.classList.remove('animate');
  void el.offsetWidth;
  el.classList.add('animate');
  el.textContent = `"${q.text}"`;
  document.getElementById('quote-author').textContent = `— ${q.author}`;
}

document.getElementById('quote-refresh-btn').addEventListener('click', newQuote);
newQuote();

// ── DSA CHALLENGES ───────────────────────────────────────────
const challenges = [
  { q: "Given an array of integers, return indices of the two numbers such that they add up to a specific target. Each input has exactly one solution and you may not use the same element twice.", tags: ["Array","Hash Map"], diff:"easy", link:"https://leetcode.com/problems/two-sum/" },
  { q: "Given a string, find the length of the longest substring without repeating characters.", tags: ["Sliding Window","String"], diff:"medium", link:"https://leetcode.com/problems/longest-substring-without-repeating-characters/" },
  { q: "Given a linked list, detect if it has a cycle in it. Can you do it using O(1) extra space?", tags: ["Linked List","Two Pointers"], diff:"easy", link:"https://leetcode.com/problems/linked-list-cycle/" },
  { q: "Given an m×n matrix, if an element is 0, set its entire row and column to 0. Do it in-place without using extra space.", tags: ["Matrix","Array"], diff:"medium", link:"https://leetcode.com/problems/set-matrix-zeroes/" },
  { q: "Implement a function to check if a binary tree is height-balanced.", tags: ["Tree","DFS","Recursion"], diff:"medium", link:"https://leetcode.com/problems/balanced-binary-tree/" },
  { q: "Given n non-negative integers representing an elevation map, compute how much water it can trap after raining.", tags: ["Two Pointers","DP"], diff:"hard", link:"https://leetcode.com/problems/trapping-rain-water/" },
  { q: "Find the kth largest element in an unsorted array.", tags: ["Heap","Quick Select"], diff:"medium", link:"https://leetcode.com/problems/kth-largest-element-in-an-array/" },
  { q: "Given a string containing just brackets, determine if the input string is valid.", tags: ["Stack","String"], diff:"easy", link:"https://leetcode.com/problems/valid-parentheses/" },
  { q: "Given the head of a singly linked list, reverse the list and return the reversed list.", tags: ["Linked List","Recursion"], diff:"easy", link:"https://leetcode.com/problems/reverse-linked-list/" },
  { q: "There is an integer array nums sorted in ascending order that has been rotated. Find a target value in O(log n) time.", tags: ["Binary Search"], diff:"medium", link:"https://leetcode.com/problems/search-in-rotated-sorted-array/" },
  { q: "Given two sorted arrays, return the median of the two sorted arrays in O(log(m+n)) time.", tags: ["Binary Search","Array"], diff:"hard", link:"https://leetcode.com/problems/median-of-two-sorted-arrays/" },
  { q: "Given a grid filled with non-negative numbers, find a path from top left to bottom right which minimizes the sum.", tags: ["DP","Matrix"], diff:"medium", link:"https://leetcode.com/problems/minimum-path-sum/" },
  { q: "Given an integer array, find the contiguous subarray which has the largest sum and return its sum.", tags: ["Array","DP","Kadane's"], diff:"easy", link:"https://leetcode.com/problems/maximum-subarray/" },
  { q: "Given a binary tree, return the level order traversal of its nodes' values.", tags: ["BFS","Tree","Queue"], diff:"medium", link:"https://leetcode.com/problems/binary-tree-level-order-traversal/" },
  { q: "Given n pairs of parentheses, write a function to generate all combinations of well-formed parentheses.", tags: ["Backtracking","String"], diff:"medium", link:"https://leetcode.com/problems/generate-parentheses/" },
];

let lastChallengeIdx = -1;

function newChallenge() {
  let idx;
  do { idx = Math.floor(Math.random() * challenges.length); } while (idx === lastChallengeIdx);
  lastChallengeIdx = idx;
  const c   = challenges[idx];
  const qEl = document.getElementById('challenge-q');
  qEl.classList.add('fade');
  setTimeout(() => {
    qEl.textContent = c.q;
    qEl.classList.remove('fade');
    const badge = document.getElementById('diff-badge');
    badge.textContent = c.diff.charAt(0).toUpperCase() + c.diff.slice(1);
    badge.className   = `difficulty ${c.diff}`;
    document.getElementById('challenge-tags').innerHTML = c.tags.map(t => `<span class="tag">${t}</span>`).join('');
    document.getElementById('solve-link').href = c.link;
  }, 300);
}

document.getElementById('new-q-btn').addEventListener('click', () => {
  newChallenge();
  showToast('New challenge loaded!');
});

newChallenge();
