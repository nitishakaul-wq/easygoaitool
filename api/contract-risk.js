/**
 * Vercel serverless: POST /api/contract-risk
 * Body: { "contractText": "..." }
 * Returns: { risk_score, detected_clauses, summary, recommendations }
 */

const MAX_LENGTH = 20000;

const CLAUSES = [
  {
    id: 'indemnification',
    name: 'Indemnification Clause',
    risk_level: 'High',
    severity: 8,
    patterns: [/\bindemnif(y|ies)\b/i, /\bhold\s+harmless\b/i, /\bdefend\s+and\s+indemnif/i],
    explanation: 'You may be agreeing to pay for the other party\'s losses, legal fees, or claims. This can expose you to significant financial risk.',
  },
  {
    id: 'non-compete',
    name: 'Non-Compete Clause',
    risk_level: 'High',
    severity: 8,
    patterns: [/\bnon[- ]?compete\b/i, /\bnon[- ]?competition\b/i, /\bcovenant\s+not\s+to\s+compete\b/i],
    explanation: 'Restricts your ability to work for competitors or start a similar business after the contract ends. Scope and duration matter.',
  },
  {
    id: 'automatic-renewal',
    name: 'Automatic Renewal',
    risk_level: 'Moderate',
    severity: 6,
    patterns: [/\bautomatic\s+renewal\b/i, /\bauto[- ]?renewal\b/i, /\bautomatically\s+renew\b/i, /\bevergreen\b/i],
    explanation: 'The contract renews automatically unless you cancel by a specific date. You may be locked in for another term if you miss the notice window.',
  },
  {
    id: 'arbitration',
    name: 'Arbitration Clause',
    risk_level: 'Moderate',
    severity: 5,
    patterns: [/\bbinding\s+arbitration\b/i, /\barbitration\s+shall\s+be\s+(?:the\s+)?exclusive\b/i, /\bwaive\s+(?:right\s+to\s+)?(?:jury\s+)?trial\b/i],
    explanation: 'Disputes must be resolved by arbitration instead of court. You may give up the right to a jury trial or class action.',
  },
  {
    id: 'ip-assignment',
    name: 'Intellectual Property Assignment',
    risk_level: 'High',
    severity: 9,
    patterns: [/\bintellectual\s+property\s+assignment\b/i, /\bwork\s+for\s+hire\b/i, /\bassign\s+all\s+rights\b/i, /\ball\s+inventions?\s+shall\s+be\s+owned\b/i],
    explanation: 'Work you create (including ideas and inventions) may belong to the other party. Check if prior work and side projects are excluded.',
  },
  {
    id: 'liability-limitation',
    name: 'Liability Limitation',
    risk_level: 'Moderate',
    severity: 6,
    patterns: [/\blimitation\s+of\s+liability\b/i, /\bnot\s+liable\s+for\s+(?:indirect|consequential)\s+damages\b/i, /\bliability\s+cap(?:ped)?\b/i],
    explanation: 'The other party\'s liability may be capped or exclude certain types of damages. You might have limited recourse if something goes wrong.',
  },
  {
    id: 'exclusivity',
    name: 'Exclusivity Clause',
    risk_level: 'High',
    severity: 7,
    patterns: [/\bexclusive\s+rights?\b/i, /\bexclusivity\b/i, /\bsole\s+(?:provider|contractor)\b/i],
    explanation: 'You may be barred from working with other clients or offering similar services elsewhere during or after the term.',
  },
  {
    id: 'termination-penalties',
    name: 'Termination Penalties',
    risk_level: 'High',
    severity: 8,
    patterns: [/\btermination\s+fee\b/i, /\bearly\s+termination\s+(?:fee|penalty)\b/i, /\bliquidated\s+damages\s+upon\s+termination\b/i],
    explanation: 'Exiting the contract early may trigger fees or require paying the remaining term. Check notice periods and buyout options.',
  },
];

function extractSnippet(text, matchIndex, maxLen = 160) {
  const start = Math.max(0, matchIndex - 40);
  const end = Math.min(text.length, matchIndex + maxLen);
  let s = text.slice(start, end);
  if (start > 0) s = '…' + s;
  if (end < text.length) s = s + '…';
  return s.replace(/\s+/g, ' ').trim();
}

function detectClauses(text) {
  const normalized = text.replace(/\s+/g, ' ');
  const out = [];
  const seen = new Set();
  for (const c of CLAUSES) {
    if (seen.has(c.id)) continue;
    for (const re of c.patterns) {
      const m = normalized.match(re);
      if (m) {
        const idx = normalized.search(re);
        out.push({
          name: c.name,
          risk_level: c.risk_level,
          snippet: extractSnippet(normalized, idx),
          explanation: c.explanation,
        });
        seen.add(c.id);
        break;
      }
    }
  }
  return out;
}

function computeScore(clauses) {
  if (clauses.length === 0) return 0;
  const severities = clauses.map((c) => {
    const def = CLAUSES.find((d) => d.name === c.name);
    return def ? def.severity : 5;
  });
  const avg = severities.reduce((a, b) => a + b, 0) / severities.length;
  const countBonus = Math.min(clauses.length * 0.5, 3);
  return Math.min(10, Math.round(avg * 0.5 + countBonus));
}

function getRiskBand(score) {
  if (score <= 2) return 'Low';
  if (score <= 6) return 'Moderate';
  return 'High';
}

function buildSummary(score, band, count) {
  if (count === 0) {
    return 'No high-risk clause patterns were detected. This does not mean the contract is risk-free—always read the full document and consider a lawyer for important agreements.';
  }
  return `We detected ${count} type(s) of clauses that often need attention. Overall risk score: ${score}/10 (${band}). Review each item below and consider clarifying or negotiating before signing.`;
}

function buildRecommendations(clauses) {
  const recs = [];
  const names = clauses.map((c) => c.name);
  if (names.some((n) => n.includes('Indemnification'))) recs.push('Ask whether indemnification can be limited or mutual.');
  if (names.some((n) => n.includes('Automatic Renewal'))) recs.push('Note the deadline and process for giving notice to avoid auto-renewal.');
  if (names.some((n) => n.includes('Intellectual Property'))) recs.push('Clarify what counts as work product and whether prior work is excluded.');
  if (names.some((n) => n.includes('Arbitration'))) recs.push('Be aware you may be waiving the right to a jury trial or class action.');
  recs.push('Consider having a lawyer review the contract before signing.');
  recs.push('Keep a signed copy and note any side agreements in writing.');
  return recs;
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
    const contractText = (body.contractText || '').trim();
    if (!contractText) {
      res.status(400).json({ error: 'Please paste contract text to analyze.' });
      return;
    }
    if (contractText.length > MAX_LENGTH) {
      res.status(400).json({ error: `Contract text must be under ${MAX_LENGTH.toLocaleString()} characters. Paste key sections only.` });
      return;
    }
    const detected_clauses = detectClauses(contractText);
    const risk_score = computeScore(detected_clauses);
    const band = getRiskBand(risk_score);
    const summary = buildSummary(risk_score, band, detected_clauses.length);
    const recommendations = buildRecommendations(detected_clauses);
    res.status(200).json({
      risk_score,
      detected_clauses,
      summary,
      recommendations,
    });
  } catch (err) {
    console.error('contract-risk error', err);
    res.status(500).json({ error: 'Analysis failed. Please try again.' });
  }
};
