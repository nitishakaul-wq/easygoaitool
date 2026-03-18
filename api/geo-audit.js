/**
 * Vercel serverless: POST /api/geo-audit
 * Body: { "url": "https://example.com", "includeAiAnalysis": true }
 * Returns: full GEO audit + optional DeepSeek narrative.
 * Env: DEEPSEEK_API_KEY (optional). DEEPSEEK_MODEL default deepseek-chat.
 */

const { runGeoAudit } = require('../geo-audit-brain');

const DEEPSEEK_URL = 'https://api.deepseek.com/v1/chat/completions';
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 8;
const AI_TIMEOUT_MS = 25000;
const STORE_MAX_ENTRIES = 5000;

let rateLimitStore = new Map();

function getClientIp(req) {
  const forwarded = req.headers && (req.headers['x-forwarded-for'] || req.headers['x-real-ip']);
  if (forwarded) {
    const ip = typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : forwarded[0];
    if (ip) return ip;
  }
  return (req.socket && req.socket.remoteAddress) || 'unknown';
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

function getDeepSeekKey() {
  const k =
    process.env.DEEPSEEK_API_KEY ||
    process.env.DEEPSEEK_KEY ||
    process.env.DEEPSEEK_API_TOKEN ||
    '';
  return typeof k === 'string' ? k.trim() : '';
}

async function deepSeekAnalysis(audit) {
  const key = getDeepSeekKey();
  if (!key) return { narrative: null, source: 'skipped' };
  const model = process.env.DEEPSEEK_MODEL || 'deepseek-chat';
  const payload = compactAuditForPrompt(audit);
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
  try {
    const res = await fetch(DEEPSEEK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model,
        max_tokens: 900,
        temperature: 0.35,
        messages: [
          {
            role: 'system',
            content:
              'You are a GEO (Generative Engine Optimization) consultant. Given JSON audit facts only, write a concise report in Markdown: (1) Executive summary 2–3 sentences, (2) Top 5 prioritized actions with bullet points, (3) One paragraph on robots.txt / AI crawlers if relevant. Do not invent URLs or scores not in the data. If data is thin, say what to check manually. No hype.',
          },
          {
            role: 'user',
            content: `GEO audit facts (JSON):\n${payload}\n\nRespond with practical recommendations only.`,
          },
        ],
      }),
      signal: controller.signal,
    });
    clearTimeout(t);
    if (!res.ok) {
      const err = await res.text();
      console.error('DeepSeek geo-audit', res.status, err.slice(0, 500));
      return { narrative: null, source: 'error', error: 'AI analysis unavailable.' };
    }
    const data = await res.json();
    const text =
      data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content
        ? String(data.choices[0].message.content).trim()
        : '';
    return { narrative: text || null, source: text ? 'deepseek' : 'empty' };
  } catch (e) {
    clearTimeout(t);
    if (e.name === 'AbortError') return { narrative: null, source: 'timeout', error: 'AI analysis timed out.' };
    console.error('deepSeekAnalysis', e);
    return { narrative: null, source: 'error', error: 'AI analysis failed.' };
  }
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
      const hasKey = Boolean(getDeepSeekKey());
      console.log('[geo-audit] includeAi=true, DEEPSEEK key visible to function:', hasKey);
      ai = await deepSeekAnalysis(audit);
    }

    const payload = {
      ok: true,
      audit,
      aiAnalysis: ai.narrative,
      aiAnalysisSource: ai.source,
      aiAnalysisError: ai.error || undefined,
    };
    if (includeAi && ai.source === 'skipped') {
      payload.aiSetupHint =
        'Vercel injects env vars only after a new deployment. Open Deployments → … on latest → Redeploy (do not use a cached-only refresh).';
    }
    res.status(200).json(payload);
  } catch (err) {
    console.error('geo-audit error', err);
    res.status(500).json({ error: 'Audit failed. Try again or check the URL.' });
  }
};
