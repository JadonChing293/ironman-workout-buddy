/* ── User ID (per-visitor, stored in localStorage) ──────────────────────────── */
function getUserId() {
  let id = localStorage.getItem('wbUserId');
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem('wbUserId', id);
  }
  return id;
}

/* ── API Key management ──────────────────────────────────────────────────────── */
function getApiKey() {
  return localStorage.getItem('wbApiKey') || null;
}

function saveApiKey() {
  const input = document.getElementById('api-key-input');
  const key = input?.value?.trim();
  if (!key || !key.startsWith('sk-ant-')) {
    alert('Please enter a valid Anthropic API key (starts with sk-ant-)');
    return;
  }
  localStorage.setItem('wbApiKey', key);
  hideApiKeyModal();
  updateApiKeyIndicator();
  showToast('✅ API key saved — coach chat is ready!');
}

function skipApiKey() {
  hideApiKeyModal();
}

function showApiKeyModal() {
  const modal = document.getElementById('api-key-modal');
  const input = document.getElementById('api-key-input');
  if (modal) modal.classList.remove('hidden');
  if (input) {
    const existing = getApiKey();
    input.value = existing || '';
    input.focus();
  }
}

function hideApiKeyModal() {
  const modal = document.getElementById('api-key-modal');
  if (modal) modal.classList.add('hidden');
}

function updateApiKeyIndicator() {
  const indicator = document.getElementById('api-key-settings');
  const dot = document.getElementById('api-key-status-dot');
  const label = document.getElementById('api-key-status-label');
  if (!indicator) return;
  indicator.classList.remove('hidden');
  const key = getApiKey();
  if (key) {
    dot.style.background = 'var(--green)';
    label.textContent = 'API key set';
  } else {
    dot.style.background = 'var(--amber)';
    label.textContent = 'No API key';
  }
}

function checkFirstVisit() {
  const key = getApiKey();
  const skipped = localStorage.getItem('wbApiKeySkipped');
  if (!key && !skipped) {
    // First visit — show modal after short delay
    setTimeout(showApiKeyModal, 800);
    localStorage.setItem('wbApiKeySkipped', '1');
  }
  updateApiKeyIndicator();
}

// Allow pressing Enter in the API key input
document.addEventListener('DOMContentLoaded', () => {
  const input = document.getElementById('api-key-input');
  if (input) {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') saveApiKey();
    });
  }
});

/* ── Config ──────────────────────────────────────────────────────────────────── */
const DISCIPLINE_ICONS = {
  swim: '🏊',
  bike: '🚴',
  run: '🏃',
  brick: '🔥',
  strength: '💪',
};

const DISCIPLINE_COLORS = {
  swim: '#3b82f6',
  bike: '#f59e0b',
  run: '#10b981',
  brick: '#ef4444',
  strength: '#8b5cf6',
};

let charts = {};

/* ── Init ────────────────────────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  setupNavigation();
  setTodayDate();
  loadRaces();
  loadSessions();
  loadTargets();
  loadNotice();
  loadChatHistory();
  checkFirstVisit();

  // Tab delegation for link-btns inside content
  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-tab]');
    if (t) switchTab(t.dataset.tab);
  });
});

/* ── Navigation ──────────────────────────────────────────────────────────────── */
function setupNavigation() {
  document.querySelectorAll('.nav-item, .mobile-nav-item').forEach((el) => {
    el.addEventListener('click', () => switchTab(el.dataset.tab));
  });
}

function switchTab(name) {
  document.querySelectorAll('.nav-item, .mobile-nav-item').forEach((el) => {
    el.classList.toggle('active', el.dataset.tab === name);
  });
  document.querySelectorAll('.tab-content').forEach((el) => {
    el.classList.toggle('active', el.id === `tab-${name}`);
  });
  // Scroll to top on mobile when switching tabs
  window.scrollTo(0, 0);
  if (name === 'progress') renderCharts();
}

/* ── Date / Countdown ────────────────────────────────────────────────────────── */
function setTodayDate() {
  const el = document.getElementById('overview-date');
  if (el) el.textContent = new Date().toLocaleDateString('en-GB', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}

function daysUntil(dateStr) {
  const now = new Date();
  const target = new Date(dateStr);
  now.setHours(0, 0, 0, 0);
  target.setHours(0, 0, 0, 0);
  return Math.ceil((target - now) / 86400000);
}

function renderCountdowns() {
  // Now handled dynamically by renderRaceCountdown() after races load
}

/* ── Sessions ────────────────────────────────────────────────────────────────── */
let sessions = [];

async function loadSessions() {
  try {
    const res = await fetch(`/api/sessions?userId=${getUserId()}`);
    sessions = await res.json();
    renderSessionsList();
    renderRecentSessions();
    renderTargets();
  } catch (e) {
    console.error('Failed to load sessions:', e);
  }
}

async function submitSession(e) {
  e.preventDefault();
  const btn = e.target.querySelector('[type="submit"]');
  btn.disabled = true;
  btn.textContent = 'Logging...';

  const data = {
    userId: getUserId(),
    date: document.getElementById('s-date').value,
    type: document.getElementById('s-type').value,
    duration: document.getElementById('s-duration').value || null,
    distance: document.getElementById('s-distance').value || null,
    power: document.getElementById('s-power').value || null,
    cadence: document.getElementById('s-cadence').value || null,
    hr: document.getElementById('s-hr').value || null,
    rpe: document.getElementById('s-rpe').value || null,
    notes: document.getElementById('s-notes').value || null,
  };

  const wantFeedback = document.getElementById('s-feedback').checked;

  try {
    const res = await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    const session = await res.json();
    sessions.unshift(session);
    renderSessionsList();
    renderRecentSessions();
    renderTargets();
    generateNotice();
    e.target.reset();
    setTodayDate();

    if (wantFeedback) {
      switchTab('coach');
      const summary = buildSessionSummary(session);
      setTimeout(() => quickSend(summary), 300);
    }
  } catch (err) {
    alert('Failed to log session. Is the server running?');
  }

  btn.disabled = false;
  btn.textContent = 'Log Session';
}

async function deleteSession(id) {
  if (!confirm('Delete this session?')) return;
  await fetch(`/api/sessions/${id}?userId=${getUserId()}`, { method: 'DELETE' });
  sessions = sessions.filter((s) => s.id !== id);
  renderSessionsList();
  renderRecentSessions();
}

function buildSessionSummary(s) {
  const icon = DISCIPLINE_ICONS[s.type] || '🏋️';
  let msg = `${icon} Session Update — ${s.type.toUpperCase()} on ${s.date}\n`;
  if (s.duration) msg += `Duration: ${s.duration} min\n`;
  if (s.distance) msg += `Distance: ${s.distance}\n`;
  if (s.power) msg += `Avg Power: ${s.power}W\n`;
  if (s.cadence) msg += `Avg Cadence: ${s.cadence} rpm\n`;
  if (s.hr) msg += `Avg HR: ${s.hr} bpm\n`;
  if (s.rpe) msg += `RPE: ${s.rpe}/10\n`;
  if (s.notes) msg += `\nNotes: ${s.notes}`;
  msg += '\n\nPlease analyse this session and provide coaching feedback.';
  return msg;
}

function renderSessionsList() {
  const el = document.getElementById('sessions-list');
  const countEl = document.getElementById('session-count');
  if (countEl) countEl.textContent = sessions.length;

  if (!el) return;
  if (!sessions.length) {
    el.innerHTML = '<p class="empty-state">No sessions logged yet.</p>';
    return;
  }

  el.innerHTML = sessions.slice(0, 20).map((s) => {
    const icon = DISCIPLINE_ICONS[s.type] || '🏋️';
    const stats = [
      s.duration ? `${s.duration} min` : null,
      s.distance ? s.distance : null,
      s.power ? `${s.power}W avg` : null,
      s.hr ? `${s.hr} bpm avg` : null,
      s.rpe ? `RPE ${s.rpe}` : null,
    ].filter(Boolean).join(' · ');

    return `
      <div class="session-card ${s.type}">
        <div class="session-card-header">
          <div class="session-card-type">${icon} ${capitalize(s.type)}</div>
          <div style="display:flex;align-items:center;gap:10px">
            <span class="session-card-date">${formatDate(s.date || s.createdAt)}</span>
            <button class="session-delete" onclick="deleteSession(${s.id})" title="Delete">×</button>
          </div>
        </div>
        ${stats ? `<div class="session-card-stats"><div class="stat-item"><span class="stat-val">${stats}</span></div></div>` : ''}
        ${s.notes ? `<div class="session-card-notes">${escHtml(s.notes)}</div>` : ''}
      </div>
    `;
  }).join('');
}

function renderRecentSessions() {
  const el = document.getElementById('recent-sessions-list');
  if (!el) return;
  if (!sessions.length) {
    el.innerHTML = '<p class="empty-state">No sessions logged yet. <a data-tab="log" class="link">Log your first session →</a></p>';
    return;
  }

  el.innerHTML = sessions.slice(0, 5).map((s) => {
    const icon = DISCIPLINE_ICONS[s.type] || '🏋️';
    const meta = [
      s.duration ? `${s.duration} min` : null,
      s.power ? `${s.power}W` : null,
      s.hr ? `${s.hr} bpm` : null,
    ].filter(Boolean).join(' · ');

    return `
      <div class="session-mini">
        <div class="session-mini-type ${s.type}">${icon}</div>
        <div class="session-mini-info">
          <div class="session-mini-title">${capitalize(s.type)} session</div>
          <div class="session-mini-meta">${formatDate(s.date || s.createdAt)}${meta ? ' · ' + meta : ''}</div>
        </div>
        ${s.rpe ? `<div class="session-mini-rpe">RPE ${s.rpe}</div>` : ''}
      </div>
    `;
  }).join('');
}

/* ── Training Plan ───────────────────────────────────────────────────────────── */
async function generatePlan() {
  const btn = document.getElementById('generate-plan-btn');
  const loading = document.getElementById('plan-loading');
  const content = document.getElementById('plan-content');

  btn.disabled = true;
  loading.classList.remove('hidden');
  content.innerHTML = '';

  const today = new Date().toDateString();
  const frankfurtDays = daysUntil('2026-06-28');
  const msg = `Please generate a full structured training plan for the current week. Today is ${today}. There are ${frankfurtDays} days until Ironman Frankfurt.

Include:
1. Weekly overview and key focus
2. Day-by-day schedule (Monday to Sunday)
3. Each session: goal, duration, intensity zones/power targets, exact sets
4. Swim sets with intervals
5. Bike sessions with power targets (FTP = 201W)
6. Run sessions (if appropriate given bone discomfort status — check if cleared to run first or assume cautious reintroduction)
7. Two S&C sessions with exercises, sets, and reps
8. How this week fits into the broader progression toward sub-12

Format it clearly with headers and structured tables where useful.`;

  // Switch to chat and send, but also render plan in the plan tab
  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: msg, userId: getUserId(), apiKey: getApiKey() }),
    });

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let plan = '';
    content.innerHTML = '<div class="markdown-body" id="plan-render"></div>';
    const planRender = document.getElementById('plan-render');

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value);
      for (const line of text.split('\n')) {
        if (line.startsWith('data: ')) {
          try {
            const data = JSON.parse(line.slice(6));
            if (data.text) {
              plan += data.text;
              planRender.innerHTML = marked.parse(plan);
            }
            if (data.done) break;
          } catch {}
        }
      }
    }

    // Also add to chat history
    appendChatMessage('coach', plan);
    loadChatHistory();
  } catch (err) {
    content.innerHTML = `<p class="empty-state">Failed to generate plan. Make sure the server is running and ANTHROPIC_API_KEY is set.</p>`;
  }

  btn.disabled = false;
  loading.classList.add('hidden');
}

/* ── Chat ────────────────────────────────────────────────────────────────────── */
async function loadChatHistory() {
  try {
    const res = await fetch(`/api/history?userId=${getUserId()}`);
    const history = await res.json();
    const chatWindow = document.getElementById('chat-window');
    if (!chatWindow) return;

    // Remove welcome if there are messages
    if (history.length > 0) {
      const welcome = chatWindow.querySelector('.chat-welcome');
      if (welcome) welcome.remove();
    }

    // Clear existing message nodes (keep welcome if empty)
    chatWindow.querySelectorAll('.chat-msg').forEach(el => el.remove());

    history.forEach((msg) => {
      renderChatBubble(msg.role === 'user' ? 'user' : 'coach', msg.content, false);
    });

    scrollChatToBottom();
  } catch (e) {
    console.error('Failed to load chat history:', e);
  }
}

function appendChatMessage(role, content) {
  const welcome = document.getElementById('chat-window')?.querySelector('.chat-welcome');
  if (welcome) welcome.remove();
  renderChatBubble(role, content, true);
}

function renderChatBubble(role, content, scroll = true) {
  const chatWindow = document.getElementById('chat-window');
  if (!chatWindow) return;

  const isCoach = role === 'coach' || role === 'assistant';
  const div = document.createElement('div');
  div.className = `chat-msg ${isCoach ? 'coach' : 'user'}`;

  const avatarText = isCoach ? '🏆' : 'JC';
  const senderName = isCoach ? 'Coach' : 'Joshua';
  const bubbleContent = isCoach ? marked.parse(content) : escHtml(content);

  div.innerHTML = `
    <div class="msg-avatar">${avatarText}</div>
    <div class="msg-content">
      <div class="msg-sender">${senderName}</div>
      <div class="msg-bubble">${bubbleContent}</div>
    </div>
  `;

  chatWindow.appendChild(div);
  if (scroll) scrollChatToBottom();
  return div;
}

function renderTypingIndicator() {
  const chatWindow = document.getElementById('chat-window');
  const div = document.createElement('div');
  div.className = 'chat-msg coach';
  div.id = 'typing-indicator';
  div.innerHTML = `
    <div class="msg-avatar">🏆</div>
    <div class="msg-content">
      <div class="msg-sender">Coach</div>
      <div class="msg-bubble"><div class="typing-dots"><span></span><span></span><span></span></div></div>
    </div>
  `;
  chatWindow.appendChild(div);
  scrollChatToBottom();
  return div;
}

async function sendMessage() {
  const input = document.getElementById('chat-input');
  const btn = document.getElementById('send-btn');
  const text = input.value.trim();
  if (!text) return;

  input.value = '';
  input.style.height = 'auto';

  // Remove welcome if present
  const welcome = document.getElementById('chat-window')?.querySelector('.chat-welcome');
  if (welcome) welcome.remove();

  appendChatMessage('user', text);
  btn.disabled = true;

  const typingEl = renderTypingIndicator();

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text, userId: getUserId(), apiKey: getApiKey() }),
    });

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let fullText = '';
    let coachBubble = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value);
      for (const line of chunk.split('\n')) {
        if (line.startsWith('data: ')) {
          try {
            const data = JSON.parse(line.slice(6));
            if (data.text) {
              fullText += data.text;
              if (!coachBubble) {
                typingEl.remove();
                const msgEl = renderChatBubble('coach', fullText, true);
                coachBubble = msgEl?.querySelector('.msg-bubble');
              } else {
                coachBubble.innerHTML = marked.parse(fullText);
                scrollChatToBottom();
              }
            }
            if (data.done || data.error) break;
          } catch {}
        }
      }
    }

    if (!coachBubble) typingEl.remove();
  } catch (err) {
    typingEl.remove();
    renderChatBubble('coach', `Sorry, I encountered an error: ${err.message}`, true);
  }

  btn.disabled = false;
  input.focus();
}

function quickSend(text) {
  const input = document.getElementById('chat-input');
  if (input) {
    input.value = text;
    sendMessage();
  }
}

function handleChatKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
}

async function clearHistory() {
  if (!confirm('Clear all chat history? This cannot be undone.')) return;
  await fetch('/api/history/clear', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: getUserId() }) });
  const chatWindow = document.getElementById('chat-window');
  chatWindow.innerHTML = `
    <div class="chat-welcome">
      <div class="coach-avatar">🏆</div>
      <div class="welcome-text">
        <h3>Coach is ready</h3>
        <p>Send a session update, ask for your weekly plan, or discuss your training. Your full athlete profile and history are loaded.</p>
      </div>
    </div>
  `;
}

function scrollChatToBottom() {
  const chatWindow = document.getElementById('chat-window');
  if (chatWindow) chatWindow.scrollTop = chatWindow.scrollHeight;
}

/* ── Charts ──────────────────────────────────────────────────────────────────── */
function renderCharts() {
  renderVolumeChart();
  renderTypeChart();
  renderPowerChart();
}

function renderVolumeChart() {
  const ctx = document.getElementById('volumeChart');
  if (!ctx) return;
  if (charts.volume) charts.volume.destroy();

  const weeklyData = aggregateWeeklyVolume();

  charts.volume = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: weeklyData.labels,
      datasets: [{
        label: 'Training Hours',
        data: weeklyData.values,
        backgroundColor: 'rgba(59,130,246,0.6)',
        borderColor: '#3b82f6',
        borderWidth: 1,
        borderRadius: 4,
      }],
    },
    options: chartOptions('hours'),
  });
}

function renderTypeChart() {
  const ctx = document.getElementById('typeChart');
  if (!ctx) return;
  if (charts.type) charts.type.destroy();

  const counts = {};
  sessions.forEach((s) => {
    counts[s.type] = (counts[s.type] || 0) + 1;
  });

  if (!Object.keys(counts).length) {
    counts.swim = 1; counts.bike = 1; counts.run = 1;
  }

  charts.type = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: Object.keys(counts).map(capitalize),
      datasets: [{
        data: Object.values(counts),
        backgroundColor: Object.keys(counts).map(k => DISCIPLINE_COLORS[k] || '#64748b'),
        borderColor: '#1a1f2e',
        borderWidth: 2,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { labels: { color: '#94a3b8', font: { size: 12 } } },
      },
      cutout: '65%',
    },
  });
}

function renderPowerChart() {
  const ctx = document.getElementById('powerChart');
  if (!ctx) return;
  if (charts.power) charts.power.destroy();

  const bikeSessions = sessions
    .filter((s) => (s.type === 'bike' || s.type === 'brick') && s.power)
    .sort((a, b) => new Date(a.date || a.createdAt) - new Date(b.date || b.createdAt));

  const labels = bikeSessions.map((s) => formatDate(s.date || s.createdAt));
  const values = bikeSessions.map((s) => Number(s.power));

  const len = Math.max(labels.length, 1);

  // Build target reference lines from user targets
  const z2Target    = targets.find(t => t.id === 'z2power');
  const raceTarget  = targets.find(t => t.id === 'racepower');
  const ftpTarget   = targets.find(t => t.id === 'ftp');

  const refDatasets = [];
  if (z2Target?.target)   refDatasets.push({ label: `Z2 Target (${z2Target.target}W)`,   data: Array(len).fill(z2Target.target),   borderColor: 'rgba(16,185,129,0.6)',  borderDash: [6,4], borderWidth: 1.5, pointRadius: 0, fill: false });
  if (raceTarget?.target) refDatasets.push({ label: `Race Target (${raceTarget.target}W)`, data: Array(len).fill(raceTarget.target), borderColor: 'rgba(59,130,246,0.6)',  borderDash: [6,4], borderWidth: 1.5, pointRadius: 0, fill: false });
  if (ftpTarget?.target)  refDatasets.push({ label: `FTP Target (${ftpTarget.target}W)`,   data: Array(len).fill(ftpTarget.target),  borderColor: 'rgba(139,92,246,0.6)', borderDash: [6,4], borderWidth: 1.5, pointRadius: 0, fill: false });

  charts.power = new Chart(ctx, {
    type: 'line',
    data: {
      labels: labels.length ? labels : ['No data yet'],
      datasets: [
        {
          label: 'Avg Power (W)',
          data: values.length ? values : [0],
          borderColor: '#f59e0b',
          backgroundColor: 'rgba(245,158,11,0.1)',
          borderWidth: 2,
          fill: true,
          tension: 0.3,
          pointBackgroundColor: '#f59e0b',
          pointRadius: 4,
        },
        ...refDatasets,
      ],
    },
    options: chartOptions('W'),
  });
}

function aggregateWeeklyVolume() {
  const weeks = {};
  sessions.forEach((s) => {
    const d = new Date(s.date || s.createdAt);
    const monday = new Date(d);
    monday.setDate(d.getDate() - d.getDay() + 1);
    const key = monday.toISOString().split('T')[0];
    const hrs = s.duration ? Number(s.duration) / 60 : 0;
    weeks[key] = (weeks[key] || 0) + hrs;
  });

  const sorted = Object.entries(weeks).sort(([a], [b]) => a.localeCompare(b));
  return {
    labels: sorted.map(([k]) => formatWeek(k)),
    values: sorted.map(([, v]) => Math.round(v * 10) / 10),
  };
}

function chartOptions(unit) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { labels: { color: '#94a3b8', font: { size: 12 } } },
    },
    scales: {
      x: { ticks: { color: '#64748b', font: { size: 11 } }, grid: { color: '#1e2634' } },
      y: { ticks: { color: '#64748b', font: { size: 11 } }, grid: { color: '#1e2634' } },
    },
  };
}

/* ── Helpers ─────────────────────────────────────────────────────────────────── */
function capitalize(str) {
  return str ? str.charAt(0).toUpperCase() + str.slice(1) : '';
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

function formatWeek(dateStr) {
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ── Smart Notice ────────────────────────────────────────────────────────────── */
const NOTICE_ICONS = {
  warning: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
  danger:  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`,
  info:    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>`,
  success: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>`,
};

const NOTICE_CLASSES = {
  warning: 'alert-warning',
  danger:  'alert-danger',
  info:    'alert-info',
  success: 'alert-success',
};

function renderNotice(notice) {
  const el = document.getElementById('coach-notice');
  if (!el) return;
  if (!notice?.type || !notice?.message) {
    el.className = 'hidden';
    return;
  }
  const cls   = NOTICE_CLASSES[notice.type] || 'alert-info';
  const icon  = NOTICE_ICONS[notice.type]   || NOTICE_ICONS.info;
  const age   = notice.generatedAt ? timeAgo(new Date(notice.generatedAt)) : '';
  el.className = `alert ${cls}`;
  el.innerHTML = `
    ${icon}
    <span><strong>Coach Notice:</strong> ${escHtml(notice.message)}</span>
    <span class="notice-age">${age}</span>
    <button class="alert-dismiss" onclick="this.closest('.alert').classList.add('hidden')">×</button>
  `;
}

async function loadNotice() {
  try {
    const res = await fetch(`/api/notices?userId=${getUserId()}`);
    const notice = await res.json();
    renderNotice(notice);
  } catch (e) {}
}

async function generateNotice() {
  try {
    const res = await fetch('/api/notices/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: getUserId(), apiKey: getApiKey() }),
    });
    const notice = await res.json();
    renderNotice(notice);
  } catch (e) {}
}

function timeAgo(date) {
  const mins = Math.floor((Date.now() - date) / 60000);
  if (mins < 60)    return `${mins}m ago`;
  if (mins < 1440)  return `${Math.floor(mins / 60)}h ago`;
  return `${Math.floor(mins / 1440)}d ago`;
}

/* ── Races ───────────────────────────────────────────────────────────────────── */
let races = [];

async function loadRaces() {
  try {
    const res = await fetch(`/api/races?userId=${getUserId()}`);
    races = await res.json();
    renderRaces();
    renderRaceCountdown();
  } catch (e) { console.error('Failed to load races:', e); }
}

async function saveRaces() {
  await fetch('/api/races', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: getUserId(), races }),
  });
}

function renderRaces() {
  const el = document.getElementById('races-list');
  if (!el) return;

  const upcoming = races
    .map(r => ({ ...r, _days: daysUntil(r.date) }))
    .sort((a, b) => new Date(a.date) - new Date(b.date));

  if (!upcoming.length) {
    el.innerHTML = '<p class="empty-state">No races added. Click "+ Add Race" to get started.</p>';
    return;
  }

  el.innerHTML = upcoming.map((r, i) => {
    const isPrimary = i === 0 && r._days > 0;
    const isPast    = r._days <= 0;
    const priorityColors = { A: 'badge-blue', B: 'badge-green', C: 'badge-warning' };
    const distanceIcons  = { 'Full Ironman': '🏊🚴🏃', 'Half Ironman': '⚡', 'Olympic': '🏅', 'Sprint': '💨', 'Other': '🎯' };

    const t = r.targets || {};
    const hasTargets = t.swim || t.bike || t.run || t.total || t.bikePower;

    return `
      <div class="race-entry ${isPrimary ? 'primary' : ''} ${isPast ? 'past' : ''}">
        <div class="race-entry-header">
          <div class="race-entry-left">
            <span class="race-entry-icon">${distanceIcons[r.distance] || '🎯'}</span>
            <div>
              <div class="race-entry-name">${escHtml(r.name)}</div>
              <div class="race-entry-meta">
                ${r.location ? escHtml(r.location) + ' · ' : ''}${formatDate(r.date)}
              </div>
            </div>
          </div>
          <div class="race-entry-right">
            <span class="badge ${priorityColors[r.priority] || 'badge-blue'}">${r.priority}-Race</span>
            <span class="race-entry-days">${isPast ? 'Past' : r._days + 'd'}</span>
            <button class="target-edit-btn" onclick="openEditRace('${r.id}')">✏️</button>
          </div>
        </div>
        ${hasTargets ? `
        <div class="race-entry-targets">
          ${t.swim       ? `<div class="rt-item"><span>Swim</span><span>${t.swim}</span></div>` : ''}
          ${t.bike       ? `<div class="rt-item"><span>Bike</span><span>${t.bike}</span></div>` : ''}
          ${t.run        ? `<div class="rt-item"><span>Run</span><span>${t.run}</span></div>` : ''}
          ${t.total      ? `<div class="rt-item total"><span>Total</span><span>${t.total}</span></div>` : ''}
          ${t.bikePower  ? `<div class="rt-item"><span>Bike Power</span><span>${t.bikePower}W</span></div>` : ''}
          ${t.runPace    ? `<div class="rt-item"><span>Run Pace</span><span>${t.runPace}</span></div>` : ''}
        </div>` : ''}
      </div>
    `;
  }).join('');
}

function renderRaceCountdown() {
  const pill = document.getElementById('race-countdown');
  if (!pill) return;
  const next = races
    .map(r => ({ ...r, _days: daysUntil(r.date) }))
    .filter(r => r._days > 0)
    .sort((a, b) => a._days - b._days)[0];
  if (next) {
    pill.textContent = `⏱ ${next._days} days to ${next.name}`;
  } else {
    pill.textContent = '';
  }
}

function openAddRace() {
  document.getElementById('race-modal-title').textContent = 'Add Race';
  document.getElementById('race-edit-id').value = '';
  document.getElementById('race-name').value = '';
  document.getElementById('race-date').value = '';
  document.getElementById('race-distance').value = 'Full Ironman';
  document.getElementById('race-priority').value = 'A';
  document.getElementById('race-location').value = '';
  document.getElementById('race-target-swim').value = '';
  document.getElementById('race-target-bike').value = '';
  document.getElementById('race-target-run').value = '';
  document.getElementById('race-target-total').value = '';
  document.getElementById('race-target-power').value = '';
  document.getElementById('race-target-pace').value = '';
  document.getElementById('race-delete-btn').style.display = 'none';
  document.getElementById('race-modal').classList.remove('hidden');
}

function openEditRace(id) {
  const r = races.find(r => r.id === id);
  if (!r) return;
  const t = r.targets || {};
  document.getElementById('race-modal-title').textContent = 'Edit Race';
  document.getElementById('race-edit-id').value = r.id;
  document.getElementById('race-name').value = r.name || '';
  document.getElementById('race-date').value = r.date || '';
  document.getElementById('race-distance').value = r.distance || 'Full Ironman';
  document.getElementById('race-priority').value = r.priority || 'A';
  document.getElementById('race-location').value = r.location || '';
  document.getElementById('race-target-swim').value = t.swim || '';
  document.getElementById('race-target-bike').value = t.bike || '';
  document.getElementById('race-target-run').value = t.run || '';
  document.getElementById('race-target-total').value = t.total || '';
  document.getElementById('race-target-power').value = t.bikePower || '';
  document.getElementById('race-target-pace').value = t.runPace || '';
  document.getElementById('race-delete-btn').style.display = '';
  document.getElementById('race-modal').classList.remove('hidden');
}

async function saveRace() {
  const name = document.getElementById('race-name').value.trim();
  if (!name) { alert('Please enter a race name'); return; }

  const id = document.getElementById('race-edit-id').value;
  const race = {
    id: id || name.toLowerCase().replace(/\s+/g, '') + '_' + Date.now(),
    name,
    date:     document.getElementById('race-date').value,
    distance: document.getElementById('race-distance').value,
    priority: document.getElementById('race-priority').value,
    location: document.getElementById('race-location').value.trim(),
    targets: {
      swim:      document.getElementById('race-target-swim').value.trim()  || null,
      bike:      document.getElementById('race-target-bike').value.trim()  || null,
      run:       document.getElementById('race-target-run').value.trim()   || null,
      total:     document.getElementById('race-target-total').value.trim() || null,
      bikePower: document.getElementById('race-target-power').value ? Number(document.getElementById('race-target-power').value) : null,
      runPace:   document.getElementById('race-target-pace').value.trim()  || null,
    },
  };

  if (id) {
    const idx = races.findIndex(r => r.id === id);
    if (idx !== -1) races[idx] = race; else races.push(race);
  } else {
    races.push(race);
  }

  await saveRaces();
  renderRaces();
  renderRaceCountdown();
  closeRaceModal();
}

async function deleteRace() {
  const id = document.getElementById('race-edit-id').value;
  if (!id || !confirm('Delete this race?')) return;
  races = races.filter(r => r.id !== id);
  await saveRaces();
  renderRaces();
  renderRaceCountdown();
  closeRaceModal();
}

function closeRaceModal() {
  document.getElementById('race-modal').classList.add('hidden');
}

/* ── Targets ─────────────────────────────────────────────────────────────────── */
let targets = [];

async function loadTargets() {
  try {
    const res = await fetch(`/api/targets?userId=${getUserId()}`);
    targets = await res.json();
    renderTargets();
  } catch (e) { console.error('Failed to load targets:', e); }
}

async function saveTargets() {
  await fetch('/api/targets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: getUserId(), targets }),
  });
}

function computeAutoValues() {
  const now = new Date();
  const weekStart = new Date(now);
  weekStart.setDate(now.getDate() - ((now.getDay() + 6) % 7));
  weekStart.setHours(0, 0, 0, 0);

  const thisWeek = sessions.filter(s => new Date(s.date || s.createdAt) >= weekStart);
  const weeklyHrs = Math.round(thisWeek.reduce((sum, s) => sum + (Number(s.duration) || 0), 0) / 60 * 10) / 10;

  const bikeSessions = sessions.filter(s => (s.type === 'bike' || s.type === 'brick') && s.power && s.hr);
  const z2Sessions = bikeSessions.filter(s => Number(s.hr) >= 124 && Number(s.hr) <= 143);
  const z2Power = z2Sessions.length
    ? Math.round(z2Sessions.reduce((sum, s) => sum + Number(s.power), 0) / z2Sessions.length)
    : null;

  return { weeklyhours: weeklyHrs, z2power: z2Power };
}

function renderTargets() {
  const el = document.getElementById('targets-list');
  if (!el) return;
  if (!targets.length) {
    el.innerHTML = '<p class="empty-state">No targets set. Click "+ Add Target" to get started.</p>';
    return;
  }

  const auto = computeAutoValues();

  el.innerHTML = targets.map((t) => {
    const current = t.autoCalc && auto[t.autoCalc] != null ? auto[t.autoCalc] : t.current;
    const target  = t.target;
    const hasValues = current != null && target != null;

    let pct = 0;
    let statusClass = 'neutral';
    let displayPct = '';

    if (hasValues) {
      const num = Number(current);
      const tgt = Number(target);
      if (t.lowerIsBetter) {
        pct = tgt > 0 ? Math.min(100, Math.round((tgt / num) * 100)) : 0;
      } else {
        pct = tgt > 0 ? Math.min(100, Math.round((num / tgt) * 100)) : 0;
      }
      statusClass = pct >= 90 ? 'good' : pct >= 70 ? 'warn' : 'behind';
      displayPct = `${pct}%`;
    }

    const currentDisplay = current != null
      ? (t.id === 'swimpace' ? secsToPace(current) : current)
      : '—';
    const targetDisplay = target != null
      ? (t.id === 'swimpace' ? secsToPace(target) : target)
      : '—';

    return `
      <div class="target-row">
        <div class="target-info">
          <div class="target-top">
            <span class="target-label">${escHtml(t.label)}</span>
            <span class="target-unit">${escHtml(t.unit || '')}</span>
            <button class="target-edit-btn" onclick="openEditTarget('${t.id}')">✏️</button>
          </div>
          <div class="target-values">
            <span class="target-current">
              ${currentDisplay}
              ${t.autoCalc && auto[t.autoCalc] != null ? '<span class="auto-badge">auto</span>' : ''}
            </span>
            <span class="target-arrow">→</span>
            <span class="target-goal">${targetDisplay} ${target != null ? escHtml(t.unit || '') : ''}</span>
            ${hasValues ? `<span class="target-pct ${statusClass}">${displayPct}</span>` : ''}
          </div>
        </div>
        <div class="target-bar-wrap">
          <div class="target-bar-fill ${statusClass}" style="width:${pct}%"></div>
        </div>
      </div>
    `;
  }).join('');
}

function secsToPace(secs) {
  if (!secs) return '—';
  const m = Math.floor(secs / 60);
  const s = String(secs % 60).padStart(2, '0');
  return `${m}:${s}`;
}

function openAddTarget() {
  document.getElementById('target-modal-title').textContent = 'Add Target';
  document.getElementById('target-edit-id').value = '';
  document.getElementById('target-edit-label').value = '';
  document.getElementById('target-edit-current').value = '';
  document.getElementById('target-edit-target').value = '';
  document.getElementById('target-edit-unit').value = '';
  document.getElementById('target-edit-lower').checked = false;
  document.getElementById('target-delete-btn').style.display = 'none';
  document.getElementById('target-modal').classList.remove('hidden');
}

function openEditTarget(id) {
  const t = targets.find(t => t.id === id);
  if (!t) return;
  document.getElementById('target-modal-title').textContent = 'Edit Target';
  document.getElementById('target-edit-id').value = t.id;
  document.getElementById('target-edit-label').value = t.label;
  document.getElementById('target-edit-current').value = t.current ?? '';
  document.getElementById('target-edit-target').value = t.target ?? '';
  document.getElementById('target-edit-unit').value = t.unit || '';
  document.getElementById('target-edit-lower').checked = !!t.lowerIsBetter;
  document.getElementById('target-delete-btn').style.display = '';
  document.getElementById('target-modal').classList.remove('hidden');
}

async function saveTarget() {
  const id        = document.getElementById('target-edit-id').value;
  const label     = document.getElementById('target-edit-label').value.trim();
  const current   = document.getElementById('target-edit-current').value;
  const target    = document.getElementById('target-edit-target').value;
  const unit      = document.getElementById('target-edit-unit').value.trim();
  const lower     = document.getElementById('target-edit-lower').checked;

  if (!label) { alert('Please enter a label'); return; }

  if (id) {
    const idx = targets.findIndex(t => t.id === id);
    if (idx !== -1) {
      targets[idx] = { ...targets[idx], label, current: current !== '' ? Number(current) : null, target: target !== '' ? Number(target) : null, unit, lowerIsBetter: lower };
    }
  } else {
    targets.push({
      id: label.toLowerCase().replace(/\s+/g, '') + '_' + Date.now(),
      label, unit,
      current: current !== '' ? Number(current) : null,
      target:  target  !== '' ? Number(target)  : null,
      lowerIsBetter: lower,
      autoCalc: null,
    });
  }

  await saveTargets();
  renderTargets();
  renderCharts(); // update progress chart reference lines
  closeTargetModal();
}

async function deleteTarget() {
  const id = document.getElementById('target-edit-id').value;
  if (!id || !confirm('Delete this target?')) return;
  targets = targets.filter(t => t.id !== id);
  await saveTargets();
  renderTargets();
  renderCharts();
  closeTargetModal();
}

function closeTargetModal() {
  document.getElementById('target-modal').classList.add('hidden');
}

/* ── Strava ──────────────────────────────────────────────────────────────────── */
function stravaConnect() {
  window.location.href = `/auth/strava?userId=${getUserId()}`;
}

async function checkStravaStatus() {
  try {
    const res = await fetch(`/api/strava/status?userId=${getUserId()}`);
    const data = await res.json();

    const statusText   = document.getElementById('strava-status-text');
    const actionsEl    = document.getElementById('strava-actions');
    const connectBtn   = document.getElementById('strava-connect-btn');
    const integItem    = document.getElementById('strava-integration');

    if (!statusText || !actionsEl) return;

    if (data.connected) {
      statusText.textContent = data.athlete ? `Connected as ${data.athlete.name}` : 'Connected';
      statusText.style.color = 'var(--green)';
      integItem?.classList.add('connected');

      actionsEl.innerHTML = `
        <button class="btn btn-sm btn-primary" id="strava-sync-btn" onclick="stravaSync()">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/></svg>
          Sync
        </button>
        <button class="btn btn-sm btn-ghost" onclick="stravaDisconnect()">Disconnect</button>
      `;
    } else {
      statusText.textContent = 'Not connected';
      statusText.style.color = 'var(--text3)';
    }
  } catch (e) {
    console.error('Strava status check failed:', e);
  }
}

async function stravaSync() {
  const btn = document.getElementById('strava-sync-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Syncing...'; }

  try {
    const res  = await fetch('/api/strava/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: getUserId() }) });
    const data = await res.json();

    if (data.error) {
      alert(`Sync failed: ${data.error}`);
    } else {
      await loadSessions();
      const msg = data.imported > 0
        ? `✅ Synced ${data.imported} new activit${data.imported === 1 ? 'y' : 'ies'} from Strava.`
        : '✅ Already up to date — no new activities found.';
      showToast(msg);
    }
  } catch (e) {
    alert('Sync failed. Make sure the server is running.');
  }

  if (btn) { btn.disabled = false; btn.textContent = 'Sync'; }
}

async function stravaDisconnect() {
  if (!confirm('Disconnect Strava? Your logged sessions will remain.')) return;
  await fetch('/auth/strava/disconnect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: getUserId() }) });
  checkStravaStatus();
}

/* ── Toast notification ──────────────────────────────────────────────────────── */
function showToast(message) {
  const existing = document.getElementById('toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.id = 'toast';
  toast.textContent = message;
  toast.style.cssText = `
    position: fixed; bottom: 80px; left: 50%; transform: translateX(-50%);
    background: var(--bg4); border: 1px solid var(--border); color: var(--text);
    padding: 10px 18px; border-radius: 20px; font-size: 13px; font-weight: 500;
    z-index: 999; box-shadow: 0 4px 20px rgba(0,0,0,0.4);
    animation: fadeIn 0.2s ease;
  `;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3500);
}

/* ── Check for Strava redirect params on load ────────────────────────────────── */
function handleStravaRedirect() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('strava') === 'connected') {
    showToast('✅ Strava connected! Click Sync to import your activities.');
    window.history.replaceState({}, '', '/');
  } else if (params.get('strava') === 'error') {
    showToast('❌ Strava connection failed. Check your client ID and secret.');
    window.history.replaceState({}, '', '/');
  }
}

/* ── Date field default ──────────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  const dateField = document.getElementById('s-date');
  if (dateField) dateField.value = new Date().toISOString().split('T')[0];
  checkStravaStatus();
  handleStravaRedirect();
});
