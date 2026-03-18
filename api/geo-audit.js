/**
 * Vercel serverless: POST /api/geo-audit
 * Full GEO audit always runs. Optional AI narrative (Groq by default).
 *
 * No sign-up → AI limits use client IP (and shared IPs e.g. office Wi‑Fi count as one).
 * Env:
 *   GROQ_API_KEY — AI suggestions (default provider when GEO_AUDIT_AI=auto)
 *   GROQ_GEO_MODEL — default meta-llama/llama-3.3-70b-versatile
 *   GEO_AI_MAX_SUGGESTIONS_PER_IP — successful AI summaries per IP per window (default 1)
 *   GEO_AI_LIMIT_WINDOW_MS — default 86400000 (24h)
 *   GEO_AI_MAX_ATTEMPTS_PER_IP — max AI API tries per IP per window (default 10)
 *   GEO_AUDIT_AI=auto|groq|gemini|deepseek
 */

const { runGeoAudit } = require('../geo-audit-brain');

const DEEPSEEK_BASE = (process.env.DEEPSEEK_API_BASE || 'https://api.deepseek.com/v1').replace(/\/$/, '');
const DEEPSEEK_URL = `${DEEPSEEK_BASE}/chat/completions`;
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 8;
const AI_TIMEOUT_MS = 25000;
const STORE_MAX_ENTRIES = 5000;

const GEO_AI_WINDOW_MS = Number(process.env.GEO_AI_LIMIT_WINDOW_MS) || 86400000;
const GEO_AI_MAX_SUCCESS = Math.max(1, parseInt(process.env.GEO_AI_MAX_SUGGESTIONS_PER_IP || '1', 10));
const GEO_AI_MAX_ATTEMPTS = Math.max(1, parseInt(process.env.GEO_AI_MAX_ATTEMPTS_PER_IP || '10', 10));

let rateLimitStore = new Map();
/** ip -> { successes: number[], attempts: number[] } */
let geoAiState = new Map();

function getClientIp(req) {
  const forwarded = req.headers && (req.headers['x-forwarded-for'] || req.headers['x-real-ip']);
  if (forwarded) {
    const ip = typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : forwarded[0];
    if (ip) return ip;
  }
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

function pruneTs(arr, windowMs) {
  const c = Date.now() - windowMs;
  return arr.filter((t) => t > c);
}

function getGeoAiState(ip) {
  let s = geoAiState.get(ip);
  if (!s) {
    s = { successes: [], attempts: [] };
    geoAiState.set(ip, s);
  }
  if (geoAiState.size > STORE_MAX_ENTRIES * 0.9) {
    const now = Date.now();
    for (const [k, v] of geoAiState.entries()) {
      v.successes = pruneTs(v.successes, GEO_AI_WINDOW_MS);
      v.attempts = pruneTs(v.attempts, GEO_AI_WINDOW_MS);
      if (v.successes.length === 0 && v.attempts.length === 0) geoAiState.delete(k);
    }
  }
  return s;
}

/**
 * Without accounts, "user" ≈ network (IP). Same Wi‑Fi often shares one IP.
 */
function checkGeoAiLimit(req) {
  const ip = getClientIp(req);
  const s = getGeoAiState(ip);
  s.successes = pruneTs(s.successes, GEO_AI_WINDOW_MS);
  s.attempts = pruneTs(s.attempts, GEO_AI_WINDOW_MS);

  if (s.successes.length >= GEO_AI_MAX_SUCCESS) {
    return {
      ok: false,
      message:
        'Free AI summary limit reached for this network (we use your IP instead of sign-up—office or home Wi‑Fi often shares one). Try again after 24h, or use the full audit above anytime without AI. ',
    };
  }
  if (s.attempts.length >= GEO_AI_MAX_ATTEMPTS) {
    return {
      ok: false,
      message: 'Too many AI requests from this network. Try again tomorrow. The structured audit still works without checking AI.',
    };
  }
  return { ok: true };
}

function registerAiAttempt(req) {
  getGeoAiState(getClientIp(req)).attempts.push(Date.now());
}

function recordAiSuccess(req) {
  getGeoAiState(getClientIp(req)).successes.push(Date.now());
}

function checkRateLimit(req) {
  if (rateLimitStore.size > STORE_MAX_ENTRIES * 0.9) {
    const now = Date.now();
    for (const [k, v] of rateLimitStore.entries()) {
      if (v.resetAt < now) rateLimitStore.delete(k);
    }
  }
  const id = getClientIp(req);
  const now = Date.now();
  let entry = rateLimitStore.get(id);
  if (!entry || entry.resetAt < now) {
    entry = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
    rateLimitStore.set(id, entry);
  }
  entry.count += 1;
  const allowed = entry.count <= RATE_LIMIT_MAX;
  const remaining = Math.max(0, RATE_LIMIT_MAX - entry.count);
  const resetInMs = Math.max(0, entry.resetAt - now);
  return { allowed, remaining, resetInMs, limit: RATE_LIMIT_MAX };
}

function isBlockedUserAgent(ua) {
  if (ua == null || typeof ua !== 'string') return true;
  const s = String(ua).trim();
  if (s.length < 10) return true;
  const blocked = [/^curl\//i, /^python-requests/i, /^node\s/i, /^axios\//i, /^go-http-client/i, /^postman/i, /^insomnia/i, /^wget\//i, /^java\s/i, /headless/i, /phantom/i, /^bot$/i, /^crawler$/i, /^spider$/i, /^scraper$/i];
  return blocked.some((re) => re.test(s));
}

function compactAuditForPrompt(audit) {
  if (!audit.ok) return JSON.stringify({ error: audit.error });
  return JSON.stringify({
    score: audit.scoring,
    robotsSummary: audit.robots.crawlers
      .filter((c) => c.blocked || c.status === 'wildcard_blocked')
      .map((c) => ({ bot: c.label, detail: c.detail })),
    llmsTxt: audit.llmsTxt.present,
    xRobots: audit.headers.xRobotsNoIndex,
    html: audit.page && !audit.page.error
      ? {
          titleLen: audit.page.title.length,
          descLen: audit.page.metaDescription.length,
          h1Count: audit.page.headingStructure.h1Count,
          jsonLd: audit.page.jsonLdTypes,
          issues: audit.page.issues,
        }
      : null,
    bullets: audit.summaryBullets,
  });
}

const GEO_SYSTEM_PROMPT =
  'You are a GEO (Generative Engine Optimization) consultant. Given JSON audit facts only, write a concise report in Markdown: (1) Executive summary 2–3 sentences, (2) Top 5 prioritized actions with bullet points, (3) One paragraph on robots.txt / AI crawlers if relevant. Do not invent URLs or scores not in the data. If data is thin, say what to check manually. No hype.';

function getGroqKey() {
  const k = process.env.GROQ_API_KEY || process.env.GROQ_API_KEY_V2 || '';
  return typeof k === 'string' ? k.trim() : '';
}

function getDeepSeekKey() {
  const k =
    process.env.DEEPSEEK_API_KEY || process.env.DEEPSEEK_KEY || process.env.DEEPSEEK_API_TOKEN || '';
  return typeof k === 'string' ? k.trim() : '';
}

function getGeminiKey() {
  const k =
    process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_AI_API_KEY ||
    process.env.GOOGLE_GENERATIVE_AI_API_KEY ||
    '';
  return typeof k === 'string' ? k.trim() : '';
}

async function openAiStyleChat(url, headers, body) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(t);
    const text = await res.text();
    return { res, text };
  } catch (e) {
    clearTimeout(t);
    throw e;
  }
}

async function groqAnalysis(audit) {
  const key = getGroqKey();
  if (!key) return { narrative: null, source: 'skipped' };
  const model = process.env.GROQ_GEO_MODEL || 'meta-llama/llama-3.3-70b-versatile';
  const payload = compactAuditForPrompt(audit);
  try {
    const { res, text } = await openAiStyleChat(
      GROQ_URL,
      { Authorization: `Bearer ${key}` },
      {
        model,
        max_tokens: 900,
        temperature: 0.35,
        messages: [
          { role: 'system', content: GEO_SYSTEM_PROMPT },
          {
            role: 'user',
            content: `GEO audit facts (JSON):\n${payload}\n\nRespond with practical recommendations only.`,
          },
        ],
      }
    );
    if (!res.ok) {
      let hint = 'Groq API error.';
      try {
        const j = JSON.parse(text);
        const msg = j.error && (j.error.message || j.error);
        if (typeof msg === 'string') hint = msg.slice(0, 200);
      } catch {
        /* ignore */
      }
      if (res.status === 429) hint = 'Groq rate limit (429). Try again in a few minutes.';
      if (res.status === 401) hint = 'Invalid GROQ_API_KEY.';
      return { narrative: null, source: 'error', error: hint };
    }
    const data = JSON.parse(text);
    const out =
      data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content
        ? String(data.choices[0].message.content).trim()
        : '';
    return { narrative: out || null, source: out ? 'groq' : 'empty' };
  } catch (e) {
    if (e.name === 'AbortError') return { narrative: null, source: 'timeout', error: 'AI analysis timed out.' };
    console.error('groqAnalysis', e);
    return { narrative: null, source: 'error', error: 'Groq request failed.' };
  }
}

async function geminiAnalysis(audit) {
  const key = getGeminiKey();
  if (!key) return { narrative: null, source: 'skipped' };
  const model = (process.env.GEMINI_MODEL || 'gemini-2.0-flash').replace(/^models\//, '');
  const payload = compactAuditForPrompt(audit);
  const userText = `GEO audit facts (JSON):\n${payload}\n\nRespond with practical recommendations only.`;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: GEO_SYSTEM_PROMPT }] },
        contents: [{ role: 'user', parts: [{ text: userText }] }],
        generationConfig: { maxOutputTokens: 900, temperature: 0.35 },
      }),
      signal: controller.signal,
    });
    clearTimeout(t);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = (data.error && data.error.message) || JSON.stringify(data.error || '').slice(0, 200);
      return { narrative: null, source: 'error', error: `Gemini (${res.status}): ${msg}` };
    }
    const parts = data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts;
    const text = parts && parts[0] && parts[0].text ? String(parts[0].text).trim() : '';
    return { narrative: text || null, source: text ? 'gemini' : 'empty' };
  } catch (e) {
    clearTimeout(t);
    if (e.name === 'AbortError') return { narrative: null, source: 'timeout', error: 'AI analysis timed out.' };
    return { narrative: null, source: 'error', error: 'Gemini request failed.' };
  }
}

async function deepSeekAnalysis(audit) {
  const key = getDeepSeekKey();
  if (!key) return { narrative: null, source: 'skipped' };
  const model = process.env.DEEPSEEK_MODEL || 'deepseek-chat';
  const payload = compactAuditForPrompt(audit);
  try {
    const { res, text: errText } = await openAiStyleChat(
      DEEPSEEK_URL,
      { Authorization: `Bearer ${key}` },
      {
        model,
        max_tokens: 900,
        temperature: 0.35,
        messages: [
          { role: 'system', content: GEO_SYSTEM_PROMPT },
          {
            role: 'user',
            content: `GEO audit facts (JSON):\n${payload}\n\nRespond with practical recommendations only.`,
          },
        ],
      }
    );
    if (!res.ok) {
      let hint = 'DeepSeek error.';
      try {
        const j = JSON.parse(errText);
        const msg = (j.error && (j.error.message || j.error)) || '';
        if (typeof msg === 'string') hint = msg.slice(0, 200);
      } catch {
        /* ignore */
      }
      if (res.status === 402) hint = 'DeepSeek: insufficient balance (402).';
      return { narrative: null, source: 'error', error: hint };
    }
    const data = JSON.parse(errText);
    const out =
      data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content
        ? String(data.choices[0].message.content).trim()
        : '';
    return { narrative: out || null, source: out ? 'deepseek' : 'empty' };
  } catch (e) {
    if (e.name === 'AbortError') return { narrative: null, source: 'timeout', error: 'AI analysis timed out.' };
    return { narrative: null, source: 'error', error: 'DeepSeek failed.' };
  }
}

function pickAiFn() {
  const mode = (process.env.GEO_AUDIT_AI || 'auto').toLowerCase();
  if (mode === 'groq' && getGroqKey()) return groqAnalysis;
  if (mode === 'gemini' && getGeminiKey()) return geminiAnalysis;
  if (mode === 'deepseek' && getDeepSeekKey()) return deepSeekAnalysis;
  if (mode === 'auto') {
    if (getGroqKey()) return groqAnalysis;
    if (getGeminiKey()) return geminiAnalysis;
    if (getDeepSeekKey()) return deepSeekAnalysis;
  }
  return null;
}

function hasAnyAiKey() {
  return Boolean(getGroqKey() || getGeminiKey() || getDeepSeekKey());
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const ua = (req.headers && req.headers['user-agent']) || '';
  if (isBlockedUserAgent(ua)) {
    res.status(429).json({ error: 'Please use a normal browser to run the audit.' });
    return;
  }

  const rl = checkRateLimit(req);
  res.setHeader('X-RateLimit-Limit', String(rl.limit));
  res.setHeader('X-RateLimit-Remaining', String(rl.remaining));
  if (!rl.allowed) {
    res.setHeader('Retry-After', String(Math.ceil(rl.resetInMs / 1000)));
    res.status(429).json({
      error: 'Too many audits. Please try again in a minute.',
      retryAfterSeconds: Math.ceil(rl.resetInMs / 1000),
    });
    return;
  }

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
  } catch {
    res.status(400).json({ error: 'Invalid JSON.' });
    return;
  }

  const url = (body.url || '').trim();
  if (!url) {
    res.status(400).json({ error: 'Enter a website URL to audit.' });
    return;
  }

  try {
    const audit = await runGeoAudit(url);
    if (!audit.ok) {
      res.status(400).json({ ok: false, error: audit.error, normalizedUrl: audit.normalizedUrl });
      return;
    }

    const includeAi = Boolean(body.includeAiAnalysis);
    let ai = { narrative: null, source: 'skipped' };

    if (includeAi) {
      const lim = checkGeoAiLimit(req);
      if (!lim.ok) {
        ai = { narrative: null, source: 'limit', error: lim.message };
      } else {
        const fn = pickAiFn();
        if (!fn) {
          ai = {
            narrative: null,
            source: 'skipped',
            error: undefined,
          };
        } else {
          registerAiAttempt(req);
          ai = await fn(audit);
          if (ai.narrative && typeof ai.narrative === 'string' && ai.narrative.length > 0) {
            recordAiSuccess(req);
          }
        }
      }
    }

    const payload = {
      ok: true,
      audit,
      aiAnalysis: ai.narrative,
      aiAnalysisSource: ai.source,
      aiAnalysisError: ai.error || undefined,
    };
    if (includeAi && ai.source === 'skipped' && !hasAnyAiKey()) {
      payload.aiSetupHint =
        'Set GROQ_API_KEY (or GEMINI_API_KEY / DEEPSEEK_API_KEY) on Vercel and redeploy for optional AI text. The score, robots table, and HTML checks work without it.';
    }
    res.status(200).json(payload);
  } catch (err) {
    console.error('geo-audit error', err);
    res.status(500).json({ error: 'Audit failed. Try again or check the URL.' });
  }
};
