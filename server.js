require('dotenv').config();
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const jwt = require('jsonwebtoken');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const JWT_SECRET = process.env.JWT_SECRET || 'workout-buddy-dev-secret';
const PORT = process.env.PORT || 3000;

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

// ── Per-user file helpers ─────────────────────────────────────────────────────
function userDir(userId) {
  const dir = path.join(DATA_DIR, 'users', userId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function userFile(userId, name) {
  return path.join(userDir(userId), name);
}

function loadJSON(file, defaultVal) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {}
  return defaultVal;
}

function saveJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// Validate userId — UUID, google-prefixed, or standard alphanumeric
function validUserId(id) {
  return typeof id === 'string' && /^(g_\d{5,30}|[a-zA-Z0-9-]{8,64})$/.test(id);
}

// ── Google OAuth ──────────────────────────────────────────────────────────────
if (process.env.GOOGLE_CLIENT_ID) {
  passport.use(new GoogleStrategy({
    clientID:     process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL:  process.env.GOOGLE_REDIRECT_URI || `http://localhost:${PORT}/auth/google/callback`,
  }, (accessToken, refreshToken, profile, done) => {
    done(null, {
      userId: `g_${profile.id}`,
      name:   profile.displayName,
      email:  profile.emails?.[0]?.value || '',
      avatar: profile.photos?.[0]?.value || '',
    });
  }));
  app.use(passport.initialize());
}

app.get('/auth/google', (req, res, next) => {
  if (!process.env.GOOGLE_CLIENT_ID) return res.redirect('/?auth=not-configured');
  passport.authenticate('google', { scope: ['profile', 'email'], session: false })(req, res, next);
});

app.get('/auth/google/callback',
  passport.authenticate('google', { session: false, failureRedirect: '/?auth=error' }),
  (req, res) => {
    const token = jwt.sign(req.user, JWT_SECRET, { expiresIn: '365d' });
    res.redirect(`/?token=${token}`);
  }
);

app.get('/auth/status', (req, res) => {
  const token = req.headers['x-auth-token'];
  if (!token) return res.json({ loggedIn: false, googleConfigured: !!process.env.GOOGLE_CLIENT_ID });
  try {
    const user = jwt.verify(token, JWT_SECRET);
    res.json({ loggedIn: true, user, googleConfigured: !!process.env.GOOGLE_CLIENT_ID });
  } catch {
    res.json({ loggedIn: false, googleConfigured: !!process.env.GOOGLE_CLIENT_ID });
  }
});

// Resolve userId from JWT token or fallback to direct param (backward compat)
function resolveUserId(req) {
  const token = req.headers['x-auth-token'];
  if (token) {
    try { return jwt.verify(token, JWT_SECRET).userId; } catch {}
  }
  return req.body?.userId || req.query?.userId;
}

// ── Strava helpers ────────────────────────────────────────────────────────────
const STRAVA_AUTH_URL  = 'https://www.strava.com/oauth/authorize';
const STRAVA_TOKEN_URL = 'https://www.strava.com/oauth/token';
const STRAVA_API_BASE  = 'https://www.strava.com/api/v3';

async function getStravaToken(userId) {
  const tokens = loadJSON(userFile(userId, 'tokens.json'), null);
  if (!tokens) return null;

  if (Math.floor(Date.now() / 1000) >= tokens.expires_at - 60) {
    const res = await fetch(STRAVA_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id:     process.env.STRAVA_CLIENT_ID,
        client_secret: process.env.STRAVA_CLIENT_SECRET,
        grant_type:    'refresh_token',
        refresh_token: tokens.refresh_token,
      }),
    });
    const fresh = await res.json();
    saveJSON(userFile(userId, 'tokens.json'), fresh);
    return fresh.access_token;
  }

  return tokens.access_token;
}

function stravaDistanceLabel(type, meters) {
  if (!meters) return null;
  if (type === 'swim') return `${Math.round(meters)}m`;
  return `${(meters / 1000).toFixed(1)}km`;
}

function stravaTypeMap(stravaType) {
  const map = {
    Ride: 'bike', VirtualRide: 'bike', EBikeRide: 'bike',
    Run: 'run', VirtualRun: 'run',
    Swim: 'swim',
    Walk: 'run', Hike: 'run',
  };
  return map[stravaType] || 'bike';
}

// ── System prompt ─────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are a world-class triathlon and Ironman coach who specialises in efficient, science-based training. Your methods must be grounded in endurance research and real-world elite examples.

You are coaching an Ironman athlete. Here is the full context:

---
ATHLETE PROFILE

Name: Joshua
Age: Early 20s
Weight: ~60kg
Background: Experienced triathlete with sub-13 Ironman finish (South Hokkaido, Sep 2025 — 13:28)
Best leg: Bike (134W average on race day despite mechanical issues)
Weakest leg: Swim (currently around 2:00–2:10/100m, confidence issues)

Injury history:
- Achilles in 2025
- IT band late 2025
- Current issue: bone discomfort in lower leg during runs (suspected early overload)

---
SEASON GOALS

Primary A-goal: Sub-12 Ironman at either:
- Ironman Frankfurt (June 28, 2026)
- Ironman Western Australia (December 6, 2026)

Specific goals:
- Sub-4:00 marathon off the bike in both races
- Build Zone 2 power to 180W by June
- Aim to race at 200W in Busselton

---
CURRENT FITNESS METRICS

FTP: 201W (Feb 3 FTP test)
Avg HR during FTP test: 173 bpm
Max HR: 193 bpm
Cadence: 91

Current Z2 power: ~115–130W, working toward 145W

Heart rate zones (needs to be retested):
- Zone 1: <124
- Zone 2: 124–143
- Zone 3: 144–164
- Zone 4: 165–184
- Zone 5: 185+

---
RECENT TRAINING CONTEXT (Jan 13 – Feb 8)

- Rebuilt training after 4 months off post-Ironman + IT band rehab
- Established 13-hour/week training cap (excluding s&c)
- Focused on bike fitness with 4–5 rides per week
- Completed FTP test, tempo intervals, Z2 rides, and long rides
- Returned to swimming (1–2x/week, confidence and form issues)
- Gradual run reintroduction with short Z2 and brick runs
- Attempted 1-hour long run on Feb 8 but stopped due to bone discomfort
- Max HR run test postponed
- Deload week implemented Feb 2–8 2026

---
CURRENT SITUATION (Early Feb 2026 onwards)

- Aerobic fitness feels strong
- Musculoskeletal system lagging behind aerobic fitness
- Suspected early bone or tissue overload from run ramp
- Pain does not persist while walking
- Running was paused for 5–7 days
- Aerobic load maintained through bike and swim
- Plan to reintroduce short Z2 runs once pain-free

---
COACHING PREFERENCES

- Athlete prefers structured, precise weekly plans
- Enjoys analysis using HR, power, cadence, and performance data
- Responds well to honest, direct feedback
- Deload week every third week
- Long rides on Saturday
- Long runs on Sunday once running resumes
- Preferred swim days: Monday, Wednesday, Friday
- Weekly planning should include session goals, duration, intensity zones or RPE, and key metrics

---
TRAINING STRUCTURE REQUIREMENTS

Weekly structure should include:
- 4 bike sessions
- 2–3 swim sessions
- 2–3 run sessions (when healthy)
- 2 strength and conditioning sessions

13-hour/week cap for swim, bike, and run (strength not included).
Athlete is comfortable with multiple double-session days.

---
COACHING PRINCIPLES

- Evidence-based endurance training methods
- Polarised or pyramidal intensity distribution
- Minimal junk mileage
- Emphasis on consistency and durability
- Efficient use of training time
- Only 2–3 hard sessions per week total across all disciplines

---
WHAT TO PROVIDE EACH WEEK

For each training week provide:
1. Full weekly schedule
2. Exact session descriptions
3. Duration and intensity (zones or RPE)
4. Detailed swim sets
5. Bike intervals with power or HR targets
6. Run session structure
7. Strength and conditioning exercises with sets and reps

Also include the goal of each session, key focus of the week, and how the week fits into long-term progression.

If any performance data is missing, ask before finalising the plan.

---

You are interacting with Joshua via an interactive training dashboard. Be direct, motivating, and science-based. When Joshua sends a session update, analyse the data and provide coaching feedback. When asked for a training plan, provide a complete structured week.

At the start of each conversation you will receive a TRAINING HISTORY block containing the athlete's last 4 months of logged sessions. Use this data to:
- Identify trends in power, HR, and volume
- Spot gaps or imbalances in training
- Inform your coaching advice and weekly plans
- Reference specific sessions when giving feedback`;

// ── Training history summary ──────────────────────────────────────────────────
function buildTrainingContext(userId) {
  const sessions = loadJSON(userFile(userId, 'sessions.json'), []);
  if (!sessions.length) return null;

  const fourMonthsAgo = new Date();
  fourMonthsAgo.setMonth(fourMonthsAgo.getMonth() - 4);

  const recent = sessions.filter((s) => {
    const d = new Date(s.date || s.createdAt);
    return d >= fourMonthsAgo;
  });

  if (!recent.length) return null;

  // Group by week
  const weeks = {};
  recent.forEach((s) => {
    const d = new Date(s.date || s.createdAt);
    const monday = new Date(d);
    monday.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    const key = monday.toISOString().split('T')[0];
    if (!weeks[key]) weeks[key] = { swim: [], bike: [], run: [], strength: [], brick: [] };
    const type = s.type || 'bike';
    if (weeks[key][type]) weeks[key][type].push(s);
  });

  // Build summary text
  let summary = `\n\n---\nTRAINING HISTORY (Last 4 months — ${recent.length} sessions)\n\n`;

  // Overall stats
  const byType = {};
  recent.forEach((s) => {
    const t = s.type || 'other';
    if (!byType[t]) byType[t] = { count: 0, totalMin: 0, powers: [], hrs: [] };
    byType[t].count++;
    if (s.duration) byType[t].totalMin += Number(s.duration);
    if (s.power) byType[t].powers.push(Number(s.power));
    if (s.hr) byType[t].hrs.push(Number(s.hr));
  });

  summary += `DISCIPLINE SUMMARY:\n`;
  for (const [type, data] of Object.entries(byType)) {
    const hrs = Math.round(data.totalMin / 60 * 10) / 10;
    const avgPower = data.powers.length ? Math.round(data.powers.reduce((a, b) => a + b) / data.powers.length) : null;
    const avgHr = data.hrs.length ? Math.round(data.hrs.reduce((a, b) => a + b) / data.hrs.length) : null;
    summary += `- ${type.toUpperCase()}: ${data.count} sessions, ${hrs}hrs total`;
    if (avgPower) summary += `, avg power ${avgPower}W`;
    if (avgHr) summary += `, avg HR ${avgHr}bpm`;
    summary += '\n';
  }

  // Weekly breakdown (most recent 16 weeks)
  const sortedWeeks = Object.entries(weeks).sort(([a], [b]) => b.localeCompare(a)).slice(0, 16);
  summary += `\nWEEKLY BREAKDOWN (most recent first):\n`;

  for (const [weekStart, types] of sortedWeeks) {
    const allSessions = Object.values(types).flat();
    if (!allSessions.length) continue;

    const totalMin = allSessions.reduce((sum, s) => sum + (Number(s.duration) || 0), 0);
    const totalHrs = Math.round(totalMin / 60 * 10) / 10;

    const bikePowers = types.bike.filter(s => s.power).map(s => Number(s.power));
    const avgBikePower = bikePowers.length ? Math.round(bikePowers.reduce((a, b) => a + b) / bikePowers.length) : null;

    const runHrs = types.run.filter(s => s.hr).map(s => Number(s.hr));
    const avgRunHr = runHrs.length ? Math.round(runHrs.reduce((a, b) => a + b) / runHrs.length) : null;

    summary += `Week of ${weekStart}: ${totalHrs}hrs`;
    summary += ` | Swim:${types.swim.length} Bike:${types.bike.length} Run:${types.run.length} S&C:${types.strength.length}`;
    if (avgBikePower) summary += ` | Bike avg ${avgBikePower}W`;
    if (avgRunHr) summary += ` | Run avg HR ${avgRunHr}bpm`;
    summary += '\n';
  }

  // Recent 10 individual sessions
  summary += `\nLAST 10 SESSIONS:\n`;
  recent.slice(0, 10).forEach((s) => {
    const date = s.date || s.createdAt?.split('T')[0];
    let line = `- ${date} [${(s.type || 'bike').toUpperCase()}]`;
    if (s.duration) line += ` ${s.duration}min`;
    if (s.distance) line += ` ${s.distance}`;
    if (s.power) line += ` ${s.power}W avg`;
    if (s.hr) line += ` ${s.hr}bpm avg`;
    if (s.rpe) line += ` RPE ${s.rpe}`;
    if (s.notes) line += ` — "${s.notes.slice(0, 80)}"`;
    summary += line + '\n';
  });

  summary += '---\n';
  return summary;
}

// ── Rate limiting ─────────────────────────────────────────────────────────────
const rateLimitStore = new Map(); // key → [timestamps]

function rateLimit(maxRequests, windowMs) {
  return (req, res, next) => {
    const userId = resolveUserId(req);
    const key = `${req.path}:${userId || req.ip}`;
    const now = Date.now();
    const timestamps = (rateLimitStore.get(key) || []).filter(t => now - t < windowMs);
    if (timestamps.length >= maxRequests) {
      const retryAfter = Math.ceil((timestamps[0] + windowMs - now) / 1000);
      return res.status(429).json({ error: `Too many requests. Try again in ${retryAfter}s.` });
    }
    timestamps.push(now);
    rateLimitStore.set(key, timestamps);
    next();
  };
}

// Clean up old entries every 10 minutes to prevent memory growth
setInterval(() => {
  const now = Date.now();
  for (const [key, timestamps] of rateLimitStore.entries()) {
    const fresh = timestamps.filter(t => now - t < 60 * 60 * 1000);
    if (fresh.length === 0) rateLimitStore.delete(key);
    else rateLimitStore.set(key, fresh);
  }
}, 10 * 60 * 1000);

// ── Chat (streaming SSE) ──────────────────────────────────────────────────────
app.post('/api/chat', rateLimit(20, 60 * 60 * 1000), async (req, res) => {
  const { message, apiKey } = req.body;
  const userId = resolveUserId(req);
  if (!message) return res.status(400).json({ error: 'Message required' });
  if (!validUserId(userId)) return res.status(400).json({ error: 'Invalid userId' });
  if (!apiKey) return res.status(403).json({ error: 'API key required' });

  const anthropicClient = new Anthropic({ apiKey: apiKey.trim() });

  // Load user profile to personalise the system prompt
  const profile = loadJSON(userFile(userId, 'profile.json'), {});
  const athleteName = profile.name || 'the athlete';

  const historyFile = userFile(userId, 'conversation.json');
  const history = loadJSON(historyFile, []);

  // Inject training history as context on the first message of each conversation
  const trainingContext = buildTrainingContext(userId);
  const messageWithContext = history.length === 0 && trainingContext
    ? `${message}\n\n[TRAINING HISTORY CONTEXT FOR COACH — do not quote this back verbatim, just use it to inform your response:${trainingContext}]`
    : message;

  history.push({ role: 'user', content: messageWithContext });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  let fullResponse = '';

  try {
    const systemPrompt = SYSTEM_PROMPT.replace(/Name: Joshua/g, `Name: ${athleteName}`);
    const stream = anthropicClient.messages.stream({
      model: 'claude-sonnet-4-6',
      max_tokens: 8096,
      system: systemPrompt,
      messages: history,
    });

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        fullResponse += event.delta.text;
        res.write(`data: ${JSON.stringify({ text: event.delta.text })}\n\n`);
      }
    }

    history.push({ role: 'assistant', content: fullResponse });
    saveJSON(historyFile, history);
    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();
  } catch (err) {
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    res.end();
  }
});

// ── Smart Notices ─────────────────────────────────────────────────────────────
const NOTICE_TTL_MS = 24 * 60 * 60 * 1000; // regenerate after 24 hours

app.get('/api/notices', (req, res) => {
  const userId = resolveUserId(req);
  if (!validUserId(userId)) return res.status(400).json({ error: 'Invalid userId' });
  const notice = loadJSON(userFile(userId, 'notice.json'), null);
  res.json(notice || { type: null, message: null, generatedAt: null });
});

app.post('/api/notices/generate', rateLimit(5, 60 * 60 * 1000), async (req, res) => {
  const userId = resolveUserId(req);
  const { apiKey } = req.body;
  if (!validUserId(userId)) return res.status(400).json({ error: 'Invalid userId' });
  if (!apiKey) return res.status(403).json({ error: 'API key required' });

  const sessions = loadJSON(userFile(userId, 'sessions.json'), []);
  if (!sessions.length) return res.json({ type: null, message: null });

  // Check cache — skip if fresh
  const cached = loadJSON(userFile(userId, 'notice.json'), null);
  if (cached?.generatedAt && Date.now() - new Date(cached.generatedAt).getTime() < NOTICE_TTL_MS) {
    return res.json(cached);
  }

  const anthropicClient = new Anthropic({ apiKey: apiKey.trim() });

  // Build session summary for last 4 weeks
  const fourWeeksAgo = new Date();
  fourWeeksAgo.setDate(fourWeeksAgo.getDate() - 28);
  const recent = sessions.filter(s => new Date(s.date || s.createdAt) >= fourWeeksAgo).slice(0, 20);

  const sessionSummary = recent.map(s => {
    let line = `${s.date || s.createdAt?.split('T')[0]} [${s.type?.toUpperCase()}]`;
    if (s.duration) line += ` ${s.duration}min`;
    if (s.power)    line += ` ${s.power}W`;
    if (s.hr)       line += ` ${s.hr}bpm`;
    if (s.rpe)      line += ` RPE${s.rpe}`;
    if (s.notes)    line += ` — ${s.notes.slice(0, 80)}`;
    return line;
  }).join('\n');

  const prompt = `You are an Ironman coach reviewing an athlete's recent training. Based on the sessions below, generate ONE short, important notice (1–2 sentences max) for the athlete's dashboard.

Choose the most relevant notice type:
- "warning" — injury risk, overtraining, dangerously high RPE/HR, missing key sessions
- "info" — training reminder, upcoming race prep, neutral observation
- "success" — positive progress, milestone reached, great consistency
- "danger" — active injury, must rest, immediate concern

Recent sessions (last 4 weeks):
${sessionSummary}

Respond with JSON only in this exact format:
{"type": "warning|info|success|danger", "message": "Your notice here."}

Be direct and specific. Reference actual data from the sessions. If everything looks fine, return {"type": "success", "message": "..."}.`;

  try {
    const response = await anthropicClient.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 150,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content[0].text.trim();
    const parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
    const notice = { ...parsed, generatedAt: new Date().toISOString() };
    saveJSON(userFile(userId, 'notice.json'), notice);
    res.json(notice);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Races ─────────────────────────────────────────────────────────────────────
const DEFAULT_RACES = [
  {
    id: 'frankfurt2026',
    name: 'Ironman Frankfurt',
    date: '2026-06-28',
    distance: 'Full Ironman',
    priority: 'A',
    location: 'Frankfurt, Germany',
    targets: { swim: '1:10:00', bike: '5:00:00', run: '4:00:00', total: '11:30:00', bikePower: 200, runPace: '5:41/km' },
  },
  {
    id: 'wa2026',
    name: 'Ironman Western Australia',
    date: '2026-12-06',
    distance: 'Full Ironman',
    priority: 'A',
    location: 'Busselton, WA',
    targets: { swim: '1:10:00', bike: '4:45:00', run: '3:55:00', total: '11:00:00', bikePower: 200, runPace: '5:33/km' },
  },
];

app.get('/api/races', (req, res) => {
  const userId = resolveUserId(req);
  if (!validUserId(userId)) return res.status(400).json({ error: 'Invalid userId' });
  const races = loadJSON(userFile(userId, 'races.json'), null);
  res.json(races ?? DEFAULT_RACES);
});

app.post('/api/races', (req, res) => {
  const userId = resolveUserId(req);
  const { races } = req.body;
  if (!validUserId(userId)) return res.status(400).json({ error: 'Invalid userId' });
  if (!Array.isArray(races)) return res.status(400).json({ error: 'races must be an array' });
  saveJSON(userFile(userId, 'races.json'), races);
  res.json({ success: true });
});

app.post('/api/races/opinion', rateLimit(10, 60 * 60 * 1000), async (req, res) => {
  const userId = resolveUserId(req);
  const { apiKey, race } = req.body;
  if (!validUserId(userId)) return res.status(400).json({ error: 'Invalid userId' });
  if (!apiKey) return res.status(403).json({ error: 'API key required' });

  const anthropicClient = new Anthropic({ apiKey: apiKey.trim() });
  const sessions = loadJSON(userFile(userId, 'sessions.json'), []);

  // Recent bike/run/swim averages
  const recent = sessions.slice(0, 30);
  const bikePowers = recent.filter(s => s.type === 'bike' && s.power).map(s => Number(s.power));
  const avgPower = bikePowers.length ? Math.round(bikePowers.reduce((a,b) => a+b) / bikePowers.length) : null;

  const t = race.targets || {};
  const prompt = `You are an Ironman coach. A athlete is targeting the following for ${race.name} (${race.distance}, ${race.date}):
- Swim: ${t.swim || 'not set'}
- T1: ${t.t1 || '0:05:00'}
- Bike: ${t.bike || 'not set'}
- T2: ${t.t2 || '0:03:00'}
- Run: ${t.run || 'not set'}
- Total: ${t.total || 'not set'}
- Target bike power: ${t.bikePower ? t.bikePower + 'W' : 'not set'}
- Target run pace: ${t.runPace || 'not set'}

Athlete context: FTP 201W, recent avg bike power ${avgPower ? avgPower + 'W' : 'unknown'}, sub-13hr Ironman finisher (13:28 at South Hokkaido 2025), currently rebuilding after injury.

Give a brief, direct coach opinion (3–5 sentences max) on whether these targets are realistic, which splits look too aggressive or too conservative, and one key focus area. Be specific with numbers.`;

  try {
    const response = await anthropicClient.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 300,
      messages: [{ role: 'user', content: prompt }],
    });
    res.json({ opinion: response.content[0].text.trim() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Profile ───────────────────────────────────────────────────────────────────
app.get('/api/profile', (req, res) => {
  const userId = resolveUserId(req);
  if (!validUserId(userId)) return res.status(400).json({ error: 'Invalid userId' });
  res.json(loadJSON(userFile(userId, 'profile.json'), { name: '', goal: '', avatar: '' }));
});

app.post('/api/profile', express.json({ limit: '3mb' }), (req, res) => {
  const userId = resolveUserId(req);
  const { name, goal, avatar } = req.body;
  if (!validUserId(userId)) return res.status(400).json({ error: 'Invalid userId' });
  saveJSON(userFile(userId, 'profile.json'), {
    name:   (name   || '').slice(0, 80),
    goal:   (goal   || '').slice(0, 120),
    avatar: (avatar || '').slice(0, 2 * 1024 * 1024), // 2MB cap
  });
  res.json({ success: true });
});

// ── Targets ───────────────────────────────────────────────────────────────────
const DEFAULT_TARGETS = [
  { id: 'ftp',         label: 'FTP',            unit: 'W',      current: 0,    target: 0,    autoCalc: null },
  { id: 'z2power',     label: 'Z2 Power',        unit: 'W',      current: 0,    target: 0,    autoCalc: 'z2power' },
  { id: 'racepower',   label: 'Race Power',      unit: 'W',      current: 0,    target: 0,    autoCalc: null },
  { id: 'swimpace',    label: 'Swim Pace',        unit: '/100m',  current: 0,    target: 0,    lowerIsBetter: true, autoCalc: null },
  { id: 'weeklyhours', label: 'Weekly Volume',    unit: 'hrs',    current: null, target: 0,    autoCalc: 'weeklyhours' },
];

app.get('/api/targets', (req, res) => {
  const userId = resolveUserId(req);
  if (!validUserId(userId)) return res.status(400).json({ error: 'Invalid userId' });
  const file = userFile(userId, 'targets.json');
  const targets = loadJSON(file, null);
  // Return defaults if user hasn't set any yet
  if (!targets) return res.json(DEFAULT_TARGETS);
  res.json(targets);
});

app.post('/api/targets', (req, res) => {
  const userId = resolveUserId(req);
  const { targets } = req.body;
  if (!validUserId(userId)) return res.status(400).json({ error: 'Invalid userId' });
  if (!Array.isArray(targets)) return res.status(400).json({ error: 'targets must be an array' });
  saveJSON(userFile(userId, 'targets.json'), targets);
  res.json({ success: true });
});

// ── Sessions ──────────────────────────────────────────────────────────────────
app.get('/api/sessions', (req, res) => {
  const userId = resolveUserId(req);
  if (!validUserId(userId)) return res.status(400).json({ error: 'Invalid userId' });
  res.json(loadJSON(userFile(userId, 'sessions.json'), []));
});

app.post('/api/sessions', (req, res) => {
  const userId = resolveUserId(req);
  const { userId: _uid, ...sessionData } = req.body;
  if (!validUserId(userId)) return res.status(400).json({ error: 'Invalid userId' });
  const file = userFile(userId, 'sessions.json');
  const sessions = loadJSON(file, []);
  const session = { id: Date.now(), createdAt: new Date().toISOString(), ...sessionData };
  sessions.unshift(session);
  saveJSON(file, sessions);
  res.json(session);
});

app.delete('/api/sessions/:id', (req, res) => {
  const userId = resolveUserId(req);
  if (!validUserId(userId)) return res.status(400).json({ error: 'Invalid userId' });
  const file = userFile(userId, 'sessions.json');
  const sessions = loadJSON(file, []).filter((s) => s.id !== Number(req.params.id));
  saveJSON(file, sessions);
  res.json({ success: true });
});

// ── Conversation history ──────────────────────────────────────────────────────
app.get('/api/history', (req, res) => {
  const userId = resolveUserId(req);
  if (!validUserId(userId)) return res.status(400).json({ error: 'Invalid userId' });
  res.json(loadJSON(userFile(userId, 'conversation.json'), []));
});

app.post('/api/history/clear', (req, res) => {
  const userId = resolveUserId(req);
  if (!validUserId(userId)) return res.status(400).json({ error: 'Invalid userId' });
  saveJSON(userFile(userId, 'conversation.json'), []);
  res.json({ success: true });
});

// ── Strava OAuth ──────────────────────────────────────────────────────────────
app.get('/auth/strava', (req, res) => {
  const userId = resolveUserId(req);
  if (!validUserId(userId)) return res.status(400).send('Invalid userId');
  if (!process.env.STRAVA_CLIENT_ID) return res.send('STRAVA_CLIENT_ID not set in .env');

  const redirectUri = process.env.STRAVA_REDIRECT_URI || `http://localhost:${PORT}/auth/strava/callback`;
  const params = new URLSearchParams({
    client_id:       process.env.STRAVA_CLIENT_ID,
    redirect_uri:    redirectUri,
    response_type:   'code',
    approval_prompt: 'auto',
    scope:           'activity:read_all',
    state:           userId, // pass userId through OAuth so callback knows who to save tokens for
  });
  res.redirect(`${STRAVA_AUTH_URL}?${params}`);
});

app.get('/auth/strava/callback', async (req, res) => {
  const { code, state: userId, error } = req.query;
  if (error || !code || !validUserId(userId)) return res.redirect('/?strava=error');

  try {
    const tokenRes = await fetch(STRAVA_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id:     process.env.STRAVA_CLIENT_ID,
        client_secret: process.env.STRAVA_CLIENT_SECRET,
        code,
        grant_type: 'authorization_code',
      }),
    });
    const tokens = await tokenRes.json();
    if (tokens.errors) return res.redirect('/?strava=error');
    saveJSON(userFile(userId, 'tokens.json'), tokens);
    res.redirect('/?strava=connected');
  } catch (err) {
    res.redirect('/?strava=error');
  }
});

app.get('/api/strava/status', (req, res) => {
  const userId = resolveUserId(req);
  if (!validUserId(userId)) return res.status(400).json({ error: 'Invalid userId' });
  const tokens = loadJSON(userFile(userId, 'tokens.json'), null);
  res.json({
    connected: !!tokens,
    athlete: tokens?.athlete ? {
      name:   `${tokens.athlete.firstname} ${tokens.athlete.lastname}`,
      avatar: tokens.athlete.profile_medium,
    } : null,
  });
});

app.post('/api/strava/sync', async (req, res) => {
  const userId = resolveUserId(req);
  if (!validUserId(userId)) return res.status(400).json({ error: 'Invalid userId' });

  const token = await getStravaToken(userId);
  if (!token) return res.status(401).json({ error: 'Not connected to Strava' });

  try {
    const actRes = await fetch(`${STRAVA_API_BASE}/athlete/activities?per_page=60`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const activities = await actRes.json();

    if (!Array.isArray(activities)) {
      return res.status(500).json({ error: 'Unexpected Strava response', details: activities });
    }

    const file = userFile(userId, 'sessions.json');
    const sessions = loadJSON(file, []);
    const existingIds = new Set(sessions.filter(s => s.stravaId).map(s => String(s.stravaId)));

    let imported = 0;
    for (const act of activities) {
      if (existingIds.has(String(act.id))) continue;
      const type = stravaTypeMap(act.type);
      sessions.unshift({
        id:        Date.now() + imported,
        stravaId:  act.id,
        source:    'strava',
        createdAt: act.start_date,
        date:      act.start_date_local?.split('T')[0],
        type,
        duration:  act.elapsed_time       ? Math.round(act.elapsed_time / 60)    : null,
        distance:  stravaDistanceLabel(type, act.distance),
        power:     act.average_watts      ? Math.round(act.average_watts)         : null,
        cadence:   act.average_cadence    ? Math.round(act.average_cadence)       : null,
        hr:        act.average_heartrate  ? Math.round(act.average_heartrate)     : null,
        maxHr:     act.max_heartrate      ? Math.round(act.max_heartrate)         : null,
        calories:  act.calories           ? Math.round(act.calories)              : null,
        notes:     `Strava: ${act.name}`,
      });
      imported++;
    }

    saveJSON(file, sessions);
    res.json({ imported, total: sessions.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/auth/strava/disconnect', (req, res) => {
  const userId = resolveUserId(req);
  if (!validUserId(userId)) return res.status(400).json({ error: 'Invalid userId' });
  const tokenPath = userFile(userId, 'tokens.json');
  if (fs.existsSync(tokenPath)) fs.unlinkSync(tokenPath);
  res.json({ success: true });
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🏊 Ironman Workout Buddy running at http://localhost:${PORT}\n`);
});
