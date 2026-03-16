/**
 * Vercel serverless: POST /api/emi-recommendation
 * Body: { loan, rate, tenure, emi, totalInterest, totalPayment, extraEMI?, yearlyPrepayment?, interestSaved?, monthsSaved? }
 * Returns: { recommendation } — personalized short suggestion from Grok (xAI).
 * Set XAI_API_KEY in environment. If missing, returns a fallback rule-based suggestion.
 *
 * Protection: rate limit by IP, block empty/suspicious User-Agent, validate body early, timeout on Grok call.
 */

const XAI_URL = 'https://api.x.ai/v1/chat/completions';
const MODEL = process.env.XAI_MODEL || 'grok-2-latest';
const RATE_LIMIT_WINDOW_MS = 60 * 1000;  // 1 minute
const RATE_LIMIT_MAX = 10;                // max requests per IP per window
const GROK_TIMEOUT_MS = 15000;            // 15s so we don't hang
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
    while (rateLimitStore.size > STORE_MAX_ENTRIES) {
      const first = rateLimitStore.keys().next().value;
      if (first !== undefined) rateLimitStore.delete(first);
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
  for (let i = 0; i < blocked.length; i++) {
    if (blocked[i].test(s)) return true;
  }
  return false;
}

function formatNum(x) {
  if (x >= 100000) return (x / 100000).toFixed(2) + ' L';
  return String(Math.round(x));
}

function fallbackRecommendation(body) {
  const loan = body.loan || 0;
  const rate = body.rate || 0;
  const tenure = body.tenure || 0;
  const emi = body.emi || 0;
  const totalInterest = body.totalInterest || 0;
  const extraEMI = body.extraEMI || 0;
  const yearlyPrepayment = body.yearlyPrepayment || 0;
  const interestSaved = body.interestSaved || 0;
  const monthsSaved = body.monthsSaved || 0;

  if (loan <= 0 || tenure <= 0) {
    return 'Enter your loan amount, interest rate, and tenure above to get a personalised recommendation.';
  }

  const parts = [];
  parts.push(`For a loan of ₹${formatNum(loan)} at ${rate}% for ${tenure} years, your EMI is ₹${formatNum(emi)} and total interest is ₹${formatNum(totalInterest)}.`);
  if (extraEMI > 0 || yearlyPrepayment > 0) {
    if (interestSaved > 0) parts.push(`With your prepayment you save ₹${formatNum(interestSaved)} and finish ${Math.round(monthsSaved / 12)} years earlier.`);
    parts.push('Consider maintaining this habit—even small extra amounts reduce interest significantly.');
  } else {
    const suggested = Math.max(1000, Math.round(emi * 0.1 / 1000) * 1000);
    parts.push(`Adding ₹${formatNum(suggested)} extra per month can cut total interest and shorten your tenure. Use the prepayment simulator above to try different amounts.`);
  }
  parts.push('Check with your lender for prepayment rules and any charges. This is not financial advice.');
  return parts.join(' ');
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  // 1) Bot check – block missing or scripted User-Agent to reduce abuse
  const ua = (req.headers && req.headers['user-agent']) || '';
  if (isBlockedUserAgent(ua)) {
    res.status(429).json({ error: 'Too many requests or invalid client. Please use a browser.' });
    return;
  }

  // 2) Rate limit by IP – no extra load, fast in-memory check
  const rl = checkRateLimit(req);
  res.setHeader('X-RateLimit-Limit', String(rl.limit));
  res.setHeader('X-RateLimit-Remaining', String(rl.remaining));
  if (!rl.allowed) {
    res.setHeader('Retry-After', String(Math.ceil(rl.resetInMs / 1000)));
    res.status(429).json({
      error: 'Too many requests. Please try again in a minute.',
      retryAfterSeconds: Math.ceil(rl.resetInMs / 1000),
    });
    return;
  }

  // 3) Parse and validate body early – fail fast, no API call if invalid
  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
  } catch (e) {
    res.status(400).json({ error: 'Invalid JSON body.' });
    return;
  }

  const loan = Number(body.loan) || 0;
  const tenure = Number(body.tenure) || 0;
  if (loan <= 0 || tenure <= 0 || tenure > 30) {
    res.status(200).json({
      recommendation: fallbackRecommendation(body),
      source: 'rule-based',
    });
    return;
  }

  try {
    const rate = Number(body.rate) || 0;
    const emi = Number(body.emi) || 0;
    const totalInterest = Number(body.totalInterest) || 0;
    const totalPayment = Number(body.totalPayment) || 0;
    const extraEMI = Number(body.extraEMI) || 0;
    const yearlyPrepayment = Number(body.yearlyPrepayment) || 0;
    const interestSaved = Number(body.interestSaved) || 0;
    const monthsSaved = Number(body.monthsSaved) || 0;

    const apiKey = process.env.XAI_API_KEY || process.env.XAI_API_KEY_V2;

    if (!apiKey) {
      res.status(200).json({ recommendation: fallbackRecommendation(body), source: 'rule-based' });
      return;
    }

    const summary = `Loan: ₹${formatNum(loan)} | Rate: ${rate}% p.a. | Tenure: ${tenure} years | EMI: ₹${formatNum(emi)} | Total interest: ₹${formatNum(totalInterest)} | Total payment: ₹${formatNum(totalPayment)}. Extra monthly payment: ₹${formatNum(extraEMI)}. Yearly lump-sum prepayment: ₹${formatNum(yearlyPrepayment)}. Interest saved with prepayment: ₹${formatNum(interestSaved)}. Months saved: ${monthsSaved}.`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), GROK_TIMEOUT_MS);

    const response = await fetch(XAI_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: MODEL,
        stream: false,
        max_tokens: 400,
        temperature: 0.5,
        messages: [
          {
            role: 'system',
            content: 'You are a helpful Indian personal-finance assistant. Give a short, practical recommendation (2–4 sentences) in plain English for someone using an EMI calculator. Mention only their numbers (loan, EMI, interest, prepayment if any). Do not give generic advice. Do not recommend specific products or banks. Say "Check with your lender for prepayment rules" and "This is not financial advice." Be concise and friendly.',
          },
          {
            role: 'user',
            content: `Based on this EMI summary, give one short personalised recommendation: ${summary}`,
          },
        ],
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errText = await response.text();
      console.error('xAI API error', response.status, errText);
      res.status(200).json({ recommendation: fallbackRecommendation(body), source: 'rule-based' });
      return;
    }

    const data = await response.json();
    const text = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content
      ? String(data.choices[0].message.content).trim()
      : fallbackRecommendation(body);

    res.status(200).json({ recommendation: text || fallbackRecommendation(body), source: 'ai' });
  } catch (err) {
    if (err.name === 'AbortError') {
      res.status(504).json({ error: 'Request timed out. Please try again.' });
      return;
    }
    console.error('emi-recommendation error', err);
    res.status(200).json({ recommendation: fallbackRecommendation(body), source: 'rule-based' });
  }
};
