/**
 * GEO (Generative Engine Optimization) audit core logic.
 * Fetches public URLs only (SSRF-hardened), analyzes robots.txt, HTML, llms.txt.
 */

const MAX_REDIRECTS = 5;
const MAX_BODY_BYTES = 450000;
const FETCH_TIMEOUT_MS = 12000;
const AI_CRAWLERS = [
  { id: 'gptbot', label: 'OpenAI GPTBot', tokens: ['gptbot'] },
  { id: 'chatgpt-user', label: 'ChatGPT-User', tokens: ['chatgpt-user'] },
  { id: 'oai-searchbot', label: 'OpenAI Search (OAI-SearchBot)', tokens: ['oai-searchbot'] },
  { id: 'google-extended', label: 'Google-Extended', tokens: ['google-extended'] },
  { id: 'anthropic', label: 'Anthropic (Claude)', tokens: ['anthropic-ai', 'claudebot', 'claude-web'] },
  { id: 'perplexity', label: 'PerplexityBot', tokens: ['perplexitybot'] },
  { id: 'apple-extended', label: 'Applebot-Extended', tokens: ['applebot-extended'] },
  { id: 'ccbot', label: 'CCBot (Common Crawl)', tokens: ['ccbot'] },
  { id: 'bytespider', label: 'Bytespider', tokens: ['bytespider'] },
  { id: 'meta', label: 'Meta-ExternalAgent', tokens: ['meta-externalagent'] },
];

function normalizeInputUrl(input) {
  const raw = String(input || '').trim();
  if (!raw) return { error: 'Please enter a URL.' };
  let withScheme = raw;
  if (!/^https?:\/\//i.test(withScheme)) withScheme = 'https://' + withScheme;
  let u;
  try {
    u = new URL(withScheme);
  } catch {
    return { error: 'Invalid URL format.' };
  }
  if (!['http:', 'https:'].includes(u.protocol)) return { error: 'Only http and https URLs are allowed.' };
  const port = u.port || (u.protocol === 'https:' ? '443' : '80');
  if (port !== '443' && port !== '80') return { error: 'Only standard ports (80/443) are supported.' };
  u.hash = '';
  return { url: u.href.replace(/\/$/, '') || u.origin, origin: u.origin, hostname: u.hostname.toLowerCase() };
}

function isPrivateOrBlockedHost(hostname) {
  const h = hostname.replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h === '0.0.0.0') return true;
  if (h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (h === '127.0.0.1' || h === '::1' || h === '0000:0000:0000:0000:0000:0000:0000:0001') return true;
  if (h === '169.254.169.254' || h.startsWith('169.254.')) return true;
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (ipv4) {
    const a = +ipv4[1];
    const b = +ipv4[2];
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 127) return true;
    if (a === 0) return true;
  }
  return false;
}

function assertUrlSafe(href) {
  let u;
  try {
    u = new URL(href);
  } catch {
    return false;
  }
  if (!['http:', 'https:'].includes(u.protocol)) return false;
  const port = u.port || (u.protocol === 'https:' ? '443' : '80');
  if (port !== '443' && port !== '80') return false;
  if (isPrivateOrBlockedHost(u.hostname.toLowerCase())) return false;
  return true;
}

async function safeFetchBuffer(url, { method = 'GET', headers = {} } = {}) {
  if (!assertUrlSafe(url)) throw new Error('Blocked URL (SSRF protection).');
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let current = url;
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const res = await fetch(current, {
        method: hop === 0 ? method : 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'User-Agent': 'EasyGoGEO-Audit/1.0 (+https://easygoaitool.online/tools/geo-audit.html)',
          Accept: method === 'HEAD' ? '*/*' : 'text/html,application/xhtml+xml,text/plain,*/*;q=0.8',
          ...headers,
        },
      });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        if (!loc) return { res, finalUrl: current, error: 'Redirect without Location' };
        const next = new URL(loc, current).href;
        if (!assertUrlSafe(next)) throw new Error('Redirect to blocked host.');
        current = next;
        continue;
      }
      return { res, finalUrl: current };
    }
    throw new Error('Too many redirects.');
  } finally {
    clearTimeout(t);
  }
}

async function readBodyCapped(res, maxBytes) {
  const reader = res.body && res.body.getReader();
  if (!reader) {
    const t = await res.text();
    return t.slice(0, maxBytes);
  }
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.length;
      if (total > maxBytes) {
        chunks.push(value.slice(0, value.length - (total - maxBytes)));
        reader.cancel().catch(() => {});
        break;
      }
      chunks.push(value);
    }
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Parse robots.txt into groups: { agents: string[], lines: { type, value }[] }
 */
function parseRobotsGroups(text) {
  const groups = [];
  let cur = null;
  const lines = String(text || '').split(/\r?\n/);
  for (const line of lines) {
    const t = line.split('#')[0].trim();
    if (!t) continue;
    const ua = /^User-agent:\s*(.+)$/i.exec(t);
    if (ua) {
      if (cur && cur.agents.length) groups.push(cur);
      cur = { agents: ua[1].split(/\s+/).map((s) => s.trim().toLowerCase()).filter(Boolean), rules: [] };
      continue;
    }
    if (!cur) cur = { agents: ['*'], rules: [] };
    const dis = /^Disallow:\s*(.*)$/i.exec(t);
    if (dis) {
      cur.rules.push({ type: 'disallow', path: dis[1].trim() });
      continue;
    }
    const all = /^Allow:\s*(.*)$/i.exec(t);
    if (all) cur.rules.push({ type: 'allow', path: all[1].trim() });
  }
  if (cur && cur.agents.length) groups.push(cur);
  return groups;
}

function agentMatches(groupAgents, crawlerToken) {
  const tok = crawlerToken.toLowerCase();
  return groupAgents.some((a) => a === '*' || a === tok || a.includes(tok));
}

/** Rough check: is path / disallowed for this crawler (longest-match style simplified) */
function rootPathLikelyBlocked(rules) {
  let bestDisallow = '';
  let bestAllow = '';
  for (const r of rules) {
    const p = r.path || '';
    if (r.type === 'disallow') {
      if (p === '') continue; // RFC: empty Disallow = allow all
      if (p === '/') return { blocked: true, reason: 'Disallow: /' };
      if (p.startsWith('/')) {
        if (p.length >= bestDisallow.length) bestDisallow = p;
      }
    }
    if (r.type === 'allow' && p.startsWith('/')) {
      if (p.length >= bestAllow.length) bestAllow = p;
    }
  }
  if (bestDisallow === '/' || bestDisallow === '') {
    if (bestAllow === '/' || bestAllow.startsWith('/')) return { blocked: false, reason: 'Explicit Allow overrides' };
    return { blocked: true, reason: 'Disallow on /' };
  }
  return { blocked: false, reason: 'No full-site Disallow for this bot' };
}

function analyzeRobotsForCrawlers(robotsText) {
  const groups = parseRobotsGroups(robotsText);
  const starRules = groups.filter((g) => g.agents.includes('*')).flatMap((g) => g.rules);
  const results = AI_CRAWLERS.map((c) => {
    const specific = groups.filter((g) => c.tokens.some((tok) => agentMatches(g.agents, tok)));
    let status = 'not_listed';
    let detail = 'No dedicated User-agent block in robots.txt.';
    let blocked = false;

    if (specific.length) {
      const merged = specific.flatMap((g) => g.rules);
      const r = rootPathLikelyBlocked(merged);
      blocked = r.blocked;
      status = blocked ? 'blocked' : 'allowed';
      detail = blocked ? `Dedicated rules: ${r.reason}` : `Dedicated rules: ${r.reason}`;
    } else if (starRules.length) {
      const r = rootPathLikelyBlocked(starRules);
      blocked = r.blocked;
      status = blocked ? 'wildcard_blocked' : 'wildcard_allowed';
      detail = blocked
        ? `No specific block for this bot; User-agent: * ${r.reason}`
        : `Falls under *; ${r.reason}`;
    }

    return {
      id: c.id,
      label: c.label,
      status,
      blocked,
      detail,
    };
  });
  return results;
}

function extractJsonLdTypes(html) {
  const types = new Set();
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    try {
      const j = JSON.parse(m[1].trim());
      const visit = (obj) => {
        if (!obj || typeof obj !== 'object') return;
        if (Array.isArray(obj)) {
          obj.forEach(visit);
          return;
        }
        if (obj['@graph']) visit(obj['@graph']);
        if (typeof obj['@type'] === 'string') types.add(obj['@type']);
        if (Array.isArray(obj['@type'])) obj['@type'].forEach((t) => types.add(t));
      };
      visit(j);
    } catch {
      /* invalid JSON-LD */
    }
  }
  return [...types];
}

function analyzeHtml(html, finalUrl) {
  const lower = html.slice(0, 80000).toLowerCase();
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = titleMatch ? titleMatch[1].replace(/\s+/g, ' ').trim() : '';
  const descMatch = /<meta[^>]*name=["']description["'][^>]*content=["']([^"']*)["']/i.exec(html);
  const descMatch2 = /<meta[^>]*content=["']([^"']*)["'][^>]*name=["']description["']/i.exec(html);
  const metaDesc = (descMatch && descMatch[1]) || (descMatch2 && descMatch2[1]) || '';
  const ogTitle = /<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']*)["']/i.exec(html);
  const ogDesc = /<meta[^>]*property=["']og:description["'][^>]*content=["']([^"']*)["']/i.exec(html);

  const h1s = html.match(/<h1[^>]*>[\s\S]*?<\/h1>/gi) || [];
  const canonical = /<link[^>]*rel=["']canonical["'][^>]*href=["']([^"']+)["']/i.exec(html);
  const hasMain = /<main[\s>]/i.test(html);
  const hasArticle = /<article[\s>]/i.test(html);
  const hasNav = /<nav[\s>]/i.test(html);
  const langMatch = /<html[^>]*lang=["']([^"']+)["']/i.exec(html);
  const metaRobots =
    /<meta[^>]*name=["']robots["'][^>]*content=["']([^"']*)["']/i.exec(html) ||
    /<meta[^>]*content=["']([^"']*)["'][^>]*name=["']robots["']/i.exec(html);
  const metaNoIndex = metaRobots && /noindex/i.test(metaRobots[1]);

  const jsonLdTypes = extractJsonLdTypes(html);
  const hasMicrodata = /\sitemscope\s/i.test(html) || /itemscope=/i.test(html);

  const issues = [];
  const wins = [];
  if (!title || title.length < 10) issues.push('Title missing or very short (aim for a clear, unique title).');
  else if (title.length > 70) issues.push('Title is long (>~60–70 chars); may truncate in snippets.');
  else wins.push('Title length looks reasonable.');

  if (!metaDesc || metaDesc.length < 50) issues.push('Meta description missing or short; AI and search use it for context.');
  else if (metaDesc.length > 180) issues.push('Meta description is long; consider a tighter summary.');
  else wins.push('Meta description present with useful length.');

  if (h1s.length === 0) issues.push('No H1 found; add one primary heading describing the page.');
  else if (h1s.length > 1) issues.push(`Multiple H1s (${h1s.length}); prefer one primary H1 per page.`);
  else wins.push('Single H1 detected.');

  if (jsonLdTypes.length) wins.push(`JSON-LD structured data: ${jsonLdTypes.slice(0, 8).join(', ')}${jsonLdTypes.length > 8 ? '…' : ''}.`);
  else issues.push('No valid JSON-LD found; consider Organization, WebSite, Article, or FAQPage where relevant.');

  if (!ogTitle && !ogDesc) issues.push('Missing Open Graph tags (og:title, og:description) for richer previews.');
  else wins.push('Some Open Graph metadata present.');

  if (!canonical) issues.push('No canonical URL; helps avoid duplicate-content confusion.');
  else wins.push('Canonical link present.');

  if (hasMain || hasArticle) wins.push('Semantic landmarks (main/article) help structure.');
  if (!hasMain && !hasArticle) issues.push('Consider <main> or <article> for primary content.');

  return {
    url: finalUrl,
    title: { text: title, length: title.length },
    metaDescription: { text: metaDesc.slice(0, 300), length: metaDesc.length },
    openGraph: { title: ogTitle ? ogTitle[1] : '', description: ogDesc ? ogDesc[1] : '' },
    headingStructure: { h1Count: h1s.length },
    jsonLdTypes,
    hasMicrodata,
    semanticHtml: { hasMain, hasArticle, hasNav, htmlLang: langMatch ? langMatch[1] : null },
    metaRobotsNoIndex: metaNoIndex,
    issues,
    wins,
  };
}

function scoreReport(parts) {
  let score = 100;
  const penalties = [];
  const { robots, html, llms, headers } = parts;

  if (!robots.fetched) {
    score -= 5;
    penalties.push('robots.txt could not be fetched');
  } else {
    const blockedCount = robots.crawlers.filter((c) => c.blocked).length;
    if (blockedCount > 0) {
      const p = Math.min(35, 5 + blockedCount * 3);
      score -= p;
      penalties.push(`${blockedCount} AI-relevant crawler rule(s) suggest blocking`);
    }
  }

  if (headers.xRobotsNoIndex || (html.metaRobotsNoIndex && !html.error)) {
    score -= 15;
    penalties.push('noindex via X-Robots-Tag or meta robots');
  }

  const htmlIssues = Array.isArray(html.issues)
    ? html.issues
    : html.error
      ? [String(html.error)]
      : [];
  htmlIssues.forEach((issue) => {
    if (/json-ld|structured/i.test(issue)) score -= 12;
    else if (/h1|title|meta description|canonical|Open Graph|semantic/i.test(issue)) score -= 5;
    else score -= 3;
  });

  if (llms.present) score += 5;
  else {
    score -= 8;
    penalties.push('No /llms.txt found (optional but recommended for AI guidance)');
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  let band = 'Strong';
  if (score < 50) band = 'Needs work';
  else if (score < 75) band = 'Moderate';
  return { score, band, penalties: penalties.slice(0, 8) };
}

/**
 * Run full GEO audit. @param {string} inputUrl
 */
async function runGeoAudit(inputUrl) {
  const norm = normalizeInputUrl(inputUrl);
  if (norm.error) return { ok: false, error: norm.error };

  const origin = norm.origin;
  const base = norm.url;

  const out = {
    ok: true,
    input: inputUrl,
    normalizedUrl: base,
    fetchedAt: new Date().toISOString(),
    robots: { fetched: false, url: `${origin}/robots.txt`, status: null, crawlers: [], rawPreview: '' },
    llmsTxt: { url: `${origin}/llms.txt`, present: false, status: null, preview: '', lineCount: 0 },
    aiTxt: { url: `${origin}/ai.txt`, present: false, status: null },
    page: null,
    headers: { xRobotsNoIndex: false, xRobotsDetail: '' },
    scoring: null,
    summaryBullets: [],
  };

  try {
    const robotsUrl = `${origin}/robots.txt`;
    const { res: rRes, finalUrl: rFinal } = await safeFetchBuffer(robotsUrl);
    out.robots.status = rRes.status;
    if (rRes.ok) {
      const txt = await readBodyCapped(rRes, 100000);
      out.robots.fetched = true;
      out.robots.rawPreview = txt.slice(0, 1200);
      out.robots.crawlers = analyzeRobotsForCrawlers(txt);
    } else {
      out.robots.crawlers = AI_CRAWLERS.map((c) => ({
        id: c.id,
        label: c.label,
        status: 'unknown',
        blocked: false,
        detail: `robots.txt returned HTTP ${rRes.status}`,
      }));
    }

    const { res: headRes, finalUrl: pageUrl } = await safeFetchBuffer(base, { method: 'GET' });
    const xRobots = headRes.headers.get('x-robots-tag') || '';
    out.headers.xRobotsNoIndex = /noindex/i.test(xRobots);
    out.headers.xRobotsDetail = xRobots.slice(0, 200);

    if (!headRes.ok) {
      out.page = { error: `Homepage returned HTTP ${headRes.status}`, url: pageUrl };
      out.scoring = scoreReport({
        robots: out.robots,
        html: { issues: ['Could not read HTML'], wins: [] },
        llms: out.llmsTxt,
        headers: out.headers,
      });
      return out;
    }

    const html = await readBodyCapped(headRes, MAX_BODY_BYTES);
    out.page = analyzeHtml(html, pageUrl);

    const { res: lRes } = await safeFetchBuffer(`${origin}/llms.txt`);
    out.llmsTxt.status = lRes.status;
    if (lRes.ok) {
      out.llmsTxt.present = true;
      const lt = await readBodyCapped(lRes, 50000);
      out.llmsTxt.preview = lt.slice(0, 2000);
      out.llmsTxt.lineCount = lt.split(/\r?\n/).length;
    }

    try {
      const { res: aRes } = await safeFetchBuffer(`${origin}/ai.txt`);
      out.aiTxt.status = aRes.status;
      out.aiTxt.present = aRes.ok;
    } catch {
      /* optional */
    }

    out.scoring = scoreReport({
      robots: out.robots,
      html: out.page,
      llms: out.llmsTxt,
      headers: out.headers,
    });

    out.summaryBullets = buildSummaryBullets(out);
    return out;
  } catch (e) {
    const msg = e.name === 'AbortError' ? 'Request timed out.' : e.message || 'Audit failed.';
    return { ok: false, error: msg, normalizedUrl: base };
  }
}

function buildSummaryBullets(state) {
  const b = [];
  if (state.robots.fetched) {
    const blocked = state.robots.crawlers.filter((c) => c.blocked).map((c) => c.label);
    if (blocked.length) b.push(`robots.txt may block or restrict: ${blocked.slice(0, 5).join('; ')}${blocked.length > 5 ? '…' : ''}.`);
    else b.push('robots.txt does not show a blanket block for listed AI crawlers (verify manually).');
  } else {
    b.push('Could not read robots.txt—check it exists and is reachable.');
  }
  if (state.llmsTxt.present) b.push(`/llms.txt is present (${state.llmsTxt.lineCount} lines)—good for AI-oriented site guidance.`);
  else b.push('No /llms.txt—consider adding one (see llmstxt.org) to describe how AI may use your content.');
  if (state.headers.xRobotsNoIndex) b.push('HTTP headers suggest noindex—generative engines may avoid indexing.');
  if (state.page && !state.page.error) {
    if (state.page.jsonLdTypes && state.page.jsonLdTypes.length) {
      b.push(`Structured data types found: ${state.page.jsonLdTypes.slice(0, 5).join(', ')}.`);
    } else b.push('Add JSON-LD (Organization, WebSite, etc.) where appropriate.');
  } else if (state.page && state.page.error) {
    b.push(`Homepage: ${state.page.error}`);
  }
  b.push(`Overall GEO score: ${state.scoring.score}/100 (${state.scoring.band}).`);
  return b;
}

module.exports = {
  runGeoAudit,
  normalizeInputUrl,
  AI_CRAWLERS,
};
