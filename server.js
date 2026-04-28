require('dotenv').config();

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const path = require('path');
const https = require('https');
const fs = require('fs');
const AnthropicBedrock = require('@anthropic-ai/bedrock-sdk');

const app = express();
app.use(express.json({ limit: '10mb' }));

const CLIENT_ID      = process.env.TABLEAU_CLIENT_ID;
const SECRET_ID      = process.env.TABLEAU_SECRET_ID;
const SECRET_VALUE   = process.env.TABLEAU_SECRET_VALUE;
const TABLEAU_USER   = process.env.TABLEAU_USER;
const TABLEAU_SERVER = process.env.TABLEAU_SERVER;
const TABLEAU_SITE   = process.env.TABLEAU_SITE;
const TABLEAU_API    = process.env.TABLEAU_API;

const anthropic = new AnthropicBedrock({ awsRegion: 'us-west-2' });

// ── Watched-metric allowlist ─────────────────────────────────────────────────
// Only metrics whose UUID appears here will be passed to Claude.
// Leave the array EMPTY to allow all metrics.
const WATCHED_METRICS = [
  '27a7b6ba-c91d-4154-93a2-e127f7508b19',
  '989699c4-4050-4f71-9b1e-1ba7873707e1',
  'e2f640ba-b8de-4abf-ac8a-3e742e7482d7',
  'e5c65fcb-222a-4cc5-b488-5fa6c02f1f0b',
  'fd8489cb-e46b-4a9e-9c58-3b173a586552',
  'e40b7b51-eb8a-4dd9-8e0e-54f7589fc04e',
  'a36a26bc-747a-411f-be88-9f6289067162',
  '4d5f31b1-3e6b-48d0-8c9b-991bdc63b5de',
  'e2e2bcb8-5c76-4252-a22d-f193f8b4e8ef',
  '3ba2da8e-9c7d-4b08-9fe0-95efd9349514',
  'ee823389-9503-4aad-9ed5-12c2cd393ce8',
  'bca29b0b-793f-4645-bb9f-8fd98b4b1952',
  '0d185291-73f7-431a-816b-e7c3f6649341',
  '07ee59a8-3783-4ecd-b589-e4abfc29289e'
];

// ── System prompt ────────────────────────────────────────────────────────────
const COO_SYSTEM_PROMPT = `
You are a business intelligence assistant for a COO at Hertz.
You have access to live Tableau Pulse MCP tools. Always call them to retrieve real metric data before writing your response.

CRITICAL — METRIC ALLOWLIST:
You must ONLY reference metrics whose UUID appears in the following approved list.
If any tool returns metrics with IDs not in this list, ignore them completely — do not mention them, do not use their data.
Approved metric IDs (these are the ONLY metrics you are permitted to use):
${WATCHED_METRICS.map(id => `  ${id}`).join('\n')}

YOUR OUTPUT MUST CONTAIN EXACTLY THREE THINGS — IN THIS ORDER — AND NOTHING ELSE:

  1. <h3>Key Observations</h3>
  2. A <ul> containing exactly 3 to 5 <li> items. Each <li> must:
       - Open with <strong>[Metric Name]:</strong>
       - State the specific problem or risk in one sentence, including the actual number and how far it deviates from target or prior period.
       - Follow with one to two sentences identifying the root cause or underlying driver.
  3. <hr><p><em>Data sourced from Tableau Pulse — [today's date].</em></p>
  4. A metric block for each of the 2 most important metrics, using EXACTLY this markup
     (copy the real UUID from the MCP tool results into data-metric-id — never invent one):

  <div class="metric-block" data-metric-id="EXACT-UUID-FROM-TOOL">
    <div class="metric-name">Metric display name</div>
    <div class="metric-stats">
      <span class="metric-value">Value: [actual number with units]</span>
      <span class="metric-change positive">[+X.X%]</span>
      <span class="metric-trend">↑</span>
    </div>
    <div class="metric-drivers">Drivers: one or two sentences explaining the key drivers.</div>
  </div>

ABSOLUTE RULES — violation of any of these is an error:
- Do NOT output any text, element, or whitespace before <h3>Key Observations</h3>.
- Do NOT output any headings, paragraphs, narrative, tables, or metric blocks of any kind.
- Do NOT include an introduction, executive summary, dashboard title, or overall performance statement.
- Do NOT include a table or any <table>, <thead>, <tbody>, <tr>, <th>, or <td> tags.
- Do NOT include any <span> elements.
- <div> is permitted ONLY for metric-ID tagging as described below.
- Do NOT include <html>, <head>, <body>, or <script> tags.
- Do NOT wrap output in markdown code fences.
- Do NOT use markdown syntax of any kind.
- The ONLY tags allowed in your response are: <h3> <ul> <li> <strong> <em> <hr> <p> <div>
- Focus exclusively on metrics that show a problem, risk, or need for action. Ignore positive or stable metrics.
`.trim();

// ── JWT builder ──────────────────────────────────────────────────────────────
function generateJWT() {
  const header = Buffer.from(JSON.stringify({
    alg: 'HS256', typ: 'JWT', kid: SECRET_ID
  })).toString('base64url');

  const payload = Buffer.from(JSON.stringify({
    iss: CLIENT_ID,
    exp: Math.floor(Date.now() / 1000) + 300,
    jti: uuidv4(),
    aud: 'tableau',
    sub: TABLEAU_USER,
    scp: [
      'tableau:views:embed',
      'tableau:views:embed_authoring',
      'tableau:metrics_subscriptions:read',
      'tableau:content:read',
      'tableau:insights:embed',
      'tableau:insight_metrics:read',
      'tableau:insights:read',
      'tableau:auth:signin'
    ]
  })).toString('base64url');

  const signature = crypto
    .createHmac('sha256', SECRET_VALUE)
    .update(`${header}.${payload}`)
    .digest('base64url');

  return `${header}.${payload}.${signature}`;
}

// ── Cached Tableau REST session ──────────────────────────────────────────────
let tableauSession = null;

async function getTableauSession() {
  const now = Date.now();
  if (tableauSession && tableauSession.expiresAt > now + 60_000) return tableauSession;

  const jwt = generateJWT();
  console.log(`\n─── Tableau signin (site="${TABLEAU_SITE}") ───`);

  const res = await fetch(`${TABLEAU_SERVER}/api/${TABLEAU_API}/auth/signin`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ credentials: { jwt, site: { contentUrl: TABLEAU_SITE } } })
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`Signin HTTP ${res.status}: ${text}`);

  const data   = JSON.parse(text);
  const token  = data.credentials?.token;
  const siteId = data.credentials?.site?.id;

  if (!token) throw new Error(`No token in signin response: ${text}`);
  console.log(`✔ Session acquired siteId=${siteId}`);

  tableauSession = { token, siteId, expiresAt: now + 3.5 * 60 * 60 * 1000 };
  return tableauSession;
}

// ── Persistent MCP client ────────────────────────────────────────────────────
let mcpClient     = null;
let mcpConnecting = false;

async function getMCPClient() {
  if (mcpClient) return mcpClient;
  if (mcpConnecting) {
    await new Promise(r => setTimeout(r, 1000));
    return getMCPClient();
  }
  mcpConnecting = true;
  try {
    const { Client }             = await import('@modelcontextprotocol/sdk/client/index.js');
    const { SSEClientTransport } = await import('@modelcontextprotocol/sdk/client/sse.js');
    const transport = new SSEClientTransport(new URL('http://localhost:3100/sse'));
    const client    = new Client({ name: 'hertz-portal', version: '1.0.0' }, { capabilities: {} });
    await client.connect(transport);
    mcpClient = client;
    console.log('MCP client connected');
    return client;
  } finally {
    mcpConnecting = false;
  }
}

async function callMCPTool(toolName, toolArgs = {}) {
  const client = await getMCPClient();
  console.log(`→ MCP: ${toolName}`, JSON.stringify(toolArgs));
  try {
    const result = await client.callTool({ name: toolName, arguments: toolArgs });
    return result.content;
  } catch (err) {
    console.log('MCP error — resetting client:', err.message);
    mcpClient = null;
    throw err;
  }
}

async function getMCPTools() {
  const client = await getMCPClient();
  return (await client.listTools()).tools;
}

// ── Fetch Pulse metrics via MCP (preferred path) ─────────────────────────────
async function getPulseMetricsViaMCP() {
  const tools     = await getMCPTools();
  const toolNames = tools.map(t => t.name);
  console.log('Available MCP tools:', toolNames.join(', '));

  const candidates = [
    'list_metrics',
    'get_pulse_metrics',
    'list_pulse_metrics',
    'get_metrics',
    'pulse_list_metrics',
    'tableau_pulse_list_metrics',
    'list_subscribed_metrics',
    'get_subscriptions'
  ];

  for (const name of candidates) {
    if (!toolNames.includes(name)) continue;
    console.log(`Trying MCP tool: ${name}`);
    try {
      const result = await callMCPTool(name, {});
      const text   = result.map(c => c.text || JSON.stringify(c)).join('\n');
      console.log(`✔ MCP tool ${name} returned ${text.length} chars`);
      return { source: `MCP:${name}`, data: text };
    } catch (e) {
      console.warn(`MCP tool ${name} failed:`, e.message);
    }
  }
  return null;
}

// ── Fetch Pulse metrics via direct Tableau REST (fallback) ───────────────────
async function getPulseMetricsDirect(session) {
  const headers = {
    'X-Tableau-Auth': session.token,
    'Content-Type':  'application/json',
    Accept:          'application/json'
  };

  const probes = [
    {
      method: 'POST',
      url:    `${TABLEAU_SERVER}/api/-/pulse/metrics`,
      body:   JSON.stringify({ page: { page_size: 50 } })
    },
    {
      method: 'POST',
      url:    `${TABLEAU_SERVER}/api/-/pulse/metrics`,
      body:   JSON.stringify({})
    },
    {
      method: 'POST',
      url:    `${TABLEAU_SERVER}/api/-/pulse/metrics:search`,
      body:   JSON.stringify({ page: { page_size: 50 } })
    },
    {
      method: 'GET',
      url:    `${TABLEAU_SERVER}/api/-/pulse/subscriptions`,
      body:   null
    },
    {
      method: 'GET',
      url:    `${TABLEAU_SERVER}/api/-/pulse/subscriptions?page_size=50`,
      body:   null
    }
  ];

  for (const probe of probes) {
    console.log(`\n── Direct probe: ${probe.method} ${probe.url}`);
    try {
      const opts = { method: probe.method, headers };
      if (probe.body) opts.body = probe.body;

      const r    = await fetch(probe.url, opts);
      const body = await r.text();
      console.log(`HTTP ${r.status} — ${body.length} chars — snippet: ${body.substring(0, 200)}`);

      if (r.ok) {
        console.log('✔ Direct API succeeded');
        return { source: probe.url, data: body };
      }

      if (r.status === 403 && probe.url.includes('subscriptions')) {
        console.log('403 on subscriptions — user likely has no Pulse subscriptions set up');
      }
    } catch (e) {
      console.error(`Fetch error: ${e.message}`);
    }
  }

  return null;
}

// ── Strip markdown code fences ────────────────────────────────────────────────
function stripCodeFences(text) {
  if (!text) return text;
  text = text.replace(/^```(?:html|xml)?\s*\n?/i, '');
  text = text.replace(/\n?```\s*$/,               '');
  text = text.replace(/```(?:html|xml)?/gi, '');
  text = text.replace(/```/g, '');
  return text.trim();
}

// ── Convert any surviving markdown fragments to HTML ──────────────────────────
function markdownToHtml(text) {
  if (!text) return '';
  if (/<(p|h[1-6]|ul|ol|div|strong|em)\b/i.test(text)) return text;
  return text
    .replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*(.+?)\*\*/g,     '<strong>$1</strong>')
    .replace(/__(.+?)__/g,          '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g,         '<em>$1</em>')
    .replace(/`([^`]+)`/g,         '<code>$1</code>')
    .replace(/^### (.+)$/gm,       '<h3>$1</h3>')
    .replace(/^## (.+)$/gm,        '<h2>$1</h2>')
    .replace(/^# (.+)$/gm,         '<h2>$1</h2>')
    .replace(/^[-*+] (.+)$/gm,     '<li>$1</li>')
    .replace(/(<li>[\s\S]+?<\/li>)/g, '<ul>$1</ul>')
    .replace(/\n{2,}/g,            '</p><p>')
    .replace(/^(?!<)/gm,           '<p>')
    .replace(/(?<!>)$/gm,          '</p>')
    .replace(/<p><\/p>/g,          '')
    .replace(/<p>(<h[23]>)/g,      '$1')
    .replace(/(<\/h[23]>)<\/p>/g,  '$1');
}

// ── Parse metrics from Claude's HTML response ─────────────────────────────────
function parseMetricsFromHTML(html) {
  const metrics = [];

  const nameRegex    = /<div class="metric-name">([\s\S]*?)<\/div>/i;
  const valueRegex   = /<span class="metric-value">([\s\S]*?)<\/span>/i;
  const changeRegex  = /<span class="metric-change[^"]*">([\s\S]*?)<\/span>/i;
  const trendRegex   = /<span class="metric-trend">([\s\S]*?)<\/span>/i;
  const driversRegex = /<div class="metric-drivers">([\s\S]*?)<\/div>/i;

  const blockOpenings = [
    ...html.matchAll(/<div class="metric-block"[^>]*data-metric-id="([0-9a-f-]{36})"[^>]*>/gi)
  ];

  for (const blockMatch of blockOpenings) {
    const id    = blockMatch[1];
    const slice = html.slice(blockMatch.index, blockMatch.index + 1200);

    metrics.push({
      id,
      name:    nameRegex.exec(slice)?.[1]?.trim()    ?? null,
      value:   valueRegex.exec(slice)?.[1]?.trim()   ?? null,
      change:  changeRegex.exec(slice)?.[1]?.trim()  ?? null,
      trend:   trendRegex.exec(slice)?.[1]?.trim()   ?? null,
      drivers: driversRegex.exec(slice)?.[1]?.trim() ?? null,
    });
  }

  return metrics;
}

// ── Log identified metrics ────────────────────────────────────────────────────
function logIdentifiedMetrics(metrics) {
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║         IDENTIFIED PULSE METRICS             ║');
  console.log('╚══════════════════════════════════════════════╝');

  if (!metrics.length) {
    console.log('  ⚠  No metrics parsed — Claude may not have included data-metric-id attributes.');
    return;
  }

  metrics.forEach((m, i) => {
    const idStatus = m.id ? `✔ ${m.id}` : '✘ MISSING — embed will fail';
    console.log(`\n  [${i + 1}] ${m.name}`);
    console.log(`       Value   : ${m.value   ?? '—'}`);
    console.log(`       Change  : ${m.change  ?? '—'}`);
    console.log(`       Trend   : ${m.trend   ?? '—'}`);
    console.log(`       Drivers : ${m.drivers ?? '—'}`);
    console.log(`       ID      : ${idStatus}`);
  });

  console.log('\n───────────────────────────────────────────────\n');
}

// ── Filter MCP metric payloads to WATCHED_METRICS ────────────────────────────
// Handles shapes: { metrics: [...] }  { subscriptions: [...] }  top-level array
// Returns the original string unchanged if shape is unrecognised or
// WATCHED_METRICS is empty.
const METRICS_TOOL_NAMES = new Set([
  'list_metrics', 'get_pulse_metrics', 'list_pulse_metrics',
  'get_metrics',  'pulse_list_metrics', 'tableau_pulse_list_metrics',
  'list_subscribed_metrics', 'get_subscriptions',
]);

function filterMetricPayload(rawText, watchlist) {
  if (!watchlist || watchlist.length === 0) return rawText;

  let parsed;
  try { parsed = JSON.parse(rawText); }
  catch { return rawText; }

  // All entries in WATCHED_METRICS are UUIDs, so we only need UUID matching
  const uuids = new Set(watchlist.map(w => w.toLowerCase()));

  const matches = item => {
    const id = (
      item.id         ||
      item.metric_id  ||
      item.metric?.id ||
      ''
    ).toLowerCase();
    return uuids.has(id);
  };

  // Shape A: top-level array
  if (Array.isArray(parsed)) {
    const kept = parsed.filter(matches);
    console.log(`  filter: ${parsed.length} → ${kept.length} metrics (array shape)`);
    return JSON.stringify(kept, null, 2);
  }

  // Shape B: keyed object  { metrics: [...] | subscriptions: [...] | data: [...] }
  const result = { ...parsed };
  for (const key of ['metrics', 'subscriptions', 'data']) {
    if (Array.isArray(parsed[key])) {
      const kept = parsed[key].filter(matches);
      console.log(`  filter: ${parsed[key].length} → ${kept.length} metrics ("${key}" shape)`);
      result[key] = kept;
    }
  }

  return JSON.stringify(result, null, 2);
}

// ── /watched-metrics ──────────────────────────────────────────────────────────
app.get('/watched-metrics', (req, res) => res.json({ metricIds: WATCHED_METRICS }));

// ── /token ────────────────────────────────────────────────────────────────────
app.get('/token', (req, res) => res.json({ token: generateJWT() }));

// ── /session-token ────────────────────────────────────────────────────────────
app.get('/session-token', async (req, res) => {
  try {
    const session = await getTableauSession();
    res.json({
      token:  session.token,
      siteId: session.siteId,
      server: TABLEAU_SERVER,
      site:   TABLEAU_SITE
    });
  } catch (err) {
    console.error('session-token error:', err.message);
    res.status(502).json({ error: err.message });
  }
});

// ── /tableau-proxy ────────────────────────────────────────────────────────────
app.all('/tableau-proxy/*path', async (req, res) => {
  let targetURL = '(not yet constructed)';

  try {
    const session = await getTableauSession();

    let capture = req.params.path;
    if (Array.isArray(capture)) capture = capture.join('/');
    const tableauPath = capture
      ? `/${capture}`
      : req.path.replace(/^\/tableau-proxy/, '');

    const query   = Object.keys(req.query).length
      ? '?' + new URLSearchParams(req.query).toString()
      : '';
    targetURL = `${TABLEAU_SERVER}${tableauPath}${query}`;

    console.log(`\n── Proxy: ${req.method} ${targetURL}`);

    const opts = {
      method:  req.method,
      headers: {
        'X-Tableau-Auth': session.token,
        'Content-Type':  'application/json',
        Accept:          'application/json'
      }
    };

    if (['POST', 'PUT', 'PATCH'].includes(req.method) && req.body) {
      opts.body = JSON.stringify(req.body);
    }

    const upstream = await fetch(targetURL, opts);
    const body     = await upstream.text();

    console.log(`Proxy response: HTTP ${upstream.status} — ${body.length} chars`);

    res
      .status(upstream.status)
      .type(upstream.headers.get('content-type') || 'application/json')
      .send(body);

  } catch (err) {
    const cause = err.cause;
    console.error(`\n✘ Proxy error`);
    console.error(`  targetURL : ${targetURL}`);
    console.error(`  message   : ${err.message}`);
    console.error(`  cause     : ${cause?.code ?? cause?.message ?? String(cause ?? '—')}`);

    res.status(502).json({
      error:     err.message,
      cause:     cause?.code ?? cause?.message ?? String(cause ?? 'unknown'),
      targetURL,
      hint:      'Check server.js terminal — targetURL and cause are logged above.'
    });
  }
});

// ── /debug-auth ───────────────────────────────────────────────────────────────
app.get('/debug-auth', async (req, res) => {
  const out = {};

  try {
    const tools    = await getMCPTools();
    out.mcpTools   = tools.map(t => ({ name: t.name, description: t.description?.substring(0, 80) }));
  } catch (e) {
    out.mcpTools = { error: e.message };
  }

  try {
    const r        = await fetch(`${TABLEAU_SERVER}/api/${TABLEAU_API}/serverinfo`,
      { headers: { Accept: 'application/json' } });
    out.serverInfo = { status: r.status, body: JSON.parse(await r.text()) };
  } catch (e) {
    out.serverInfo = { error: e.message };
  }

  let session = null;
  try {
    session    = await getTableauSession();
    out.signin = { ok: true, siteId: session.siteId };
  } catch (e) {
    out.signin = { ok: false, error: e.message };
    return res.json(out);
  }

  const probes = [
    { method: 'POST', url: `${TABLEAU_SERVER}/api/-/pulse/metrics`,
      body: JSON.stringify({ page: { page_size: 10 } }) },
    { method: 'POST', url: `${TABLEAU_SERVER}/api/-/pulse/metrics`,
      body: JSON.stringify({}) },
    { method: 'POST', url: `${TABLEAU_SERVER}/api/-/pulse/metrics:search`,
      body: JSON.stringify({ page: { page_size: 10 } }) },
    { method: 'GET',  url: `${TABLEAU_SERVER}/api/-/pulse/subscriptions`, body: null },
    { method: 'GET',  url: `${TABLEAU_SERVER}/api/-/pulse/metrics?page_size=10`, body: null },
  ];

  out.pulseProbes = [];
  for (const probe of probes) {
    try {
      const opts = {
        method:  probe.method,
        headers: { 'X-Tableau-Auth': session.token, 'Content-Type': 'application/json',
                   Accept: 'application/json' }
      };
      if (probe.body) opts.body = probe.body;

      const r    = await fetch(probe.url, opts);
      const body = await r.text();
      out.pulseProbes.push({
        method:  probe.method,
        url:     probe.url,
        status:  r.status,
        snippet: body.substring(0, 500)
      });
    } catch (e) {
      out.pulseProbes.push({ method: probe.method, url: probe.url, error: e.message });
    }
  }

  res.json(out);
});

// ── /pulse-metrics ────────────────────────────────────────────────────────────
app.get('/pulse-metrics', async (req, res) => {
  console.log('\n═══ /pulse-metrics: trying MCP first ═══');
  try {
    const mcpResult = await getPulseMetricsViaMCP();
    if (mcpResult) {
      console.log(`✔ Returning MCP data from ${mcpResult.source}`);
      return res.json({ source: mcpResult.source, raw: mcpResult.data });
    }
    console.log('No matching MCP tool found — falling back to direct API');
  } catch (e) {
    console.warn('MCP path failed:', e.message, '— falling back to direct API');
  }

  let session;
  try {
    session = await getTableauSession();
  } catch (err) {
    return res.status(502).json({ error: 'Tableau signin failed', detail: err.message });
  }

  const direct = await getPulseMetricsDirect(session);
  if (direct) {
    console.log(`✔ Returning direct API data from ${direct.source}`);
    return res.type('application/json').send(direct.data);
  }

  return res.status(502).json({
    error: 'All Pulse data strategies failed.',
    hint: [
      '1. Check /debug-auth — look for the first 2xx status.',
      '2. Confirm your user has metrics subscribed in Tableau Pulse.',
      '3. Confirm the Connected App has tableau:metrics_subscriptions:read scope.',
      '4. If /debug-auth shows no matching MCP tools, the MCP server may need configuration.'
    ],
    debug: '/debug-auth'
  });
});

// ── /mcp-tools ────────────────────────────────────────────────────────────────
app.get('/mcp-tools', async (req, res) => {
  try {
    const tools = await getMCPTools();
    res.json({ count: tools.length, tools: tools.map(t => ({ name: t.name, description: t.description })) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── /ask  (agentic loop) ──────────────────────────────────────────────────────
app.post('/ask', async (req, res) => {
  const { prompt } = req.body;
  try {
    const mcpTools       = await getMCPTools();
    const anthropicTools = mcpTools.map(t => ({
      name:         t.name,
      description:  t.description,
      input_schema: t.inputSchema || { type: 'object', properties: {} }
    }));

    const messages = [{
      role:    'user',
      content: prompt
    }];

    let rawAnswer       = '<p>No response generated.</p>';
    let iterations      = 0;
    const maxIterations = 10;

    while (iterations < maxIterations) {
      iterations++;
      console.log(`\n── Agentic loop iteration ${iterations} ──`);

      const response = await anthropic.messages.create({
        model:      'us.anthropic.claude-opus-4-5-20251101-v1:0',
        max_tokens: 8192,
        system:     COO_SYSTEM_PROMPT,
        tools:      anthropicTools,
        messages
      });

      console.log(`Stop reason: ${response.stop_reason}`);

      if (response.stop_reason === 'end_turn') {
        const tb = response.content.find(b => b.type === 'text');
        if (tb) rawAnswer = tb.text;
        break;
      }

      if (response.stop_reason === 'tool_use') {
        messages.push({ role: 'assistant', content: response.content });
        const toolResults = [];

        for (const block of response.content) {
          if (block.type !== 'tool_use') continue;
          console.log(`Claude requested tool: ${block.name}`, block.input);

          try {
            const mcpResult = await callMCPTool(block.name, block.input);
            let resultText  = mcpResult.map(c => c.text || JSON.stringify(c)).join('\n');

            // ── Apply metric allowlist filter for listing tools ────────────
            if (METRICS_TOOL_NAMES.has(block.name)) {
              const before = resultText.length;
              resultText   = filterMetricPayload(resultText, WATCHED_METRICS);
              console.log(`  Metric filter: ${before} → ${resultText.length} chars`);
            }

            toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: resultText });
          } catch (err) {
            toolResults.push({
              type: 'tool_result', tool_use_id: block.id,
              content: `Error: ${err.message}`, is_error: true
            });
          }
        }

        messages.push({ role: 'user', content: toolResults });

      } else if (response.stop_reason === 'max_tokens') {
        const tb = response.content.find(b => b.type === 'text');
        if (tb) rawAnswer = tb.text;
        break;
      } else {
        break;
      }
    }

    // ── Post-process the answer ───────────────────────────────────────────────
    const stripped    = stripCodeFences(rawAnswer);
    const finalAnswer = markdownToHtml(stripped);

    const hadFences   = stripped !== rawAnswer;
    const hadMarkdown = finalAnswer !== stripped;
    console.log(`\n── Response post-processing:`);
    console.log(`   Code fences stripped : ${hadFences}`);
    console.log(`   Markdown converted   : ${hadMarkdown}`);
    console.log(`   Final length         : ${finalAnswer.length} chars`);
    console.log(`   Snippet              : ${finalAnswer.substring(0, 200)}`);

    // ── Parse metrics and build metricIds ─────────────────────────────────────
    const identifiedMetrics = parseMetricsFromHTML(finalAnswer);
    logIdentifiedMetrics(identifiedMetrics);

    const metricIds = identifiedMetrics
      .filter(m => m.id)
      .map(m => ({ id: m.id, name: m.name || 'Unnamed Metric' }));

    console.log(`\n── /ask returning ${metricIds.length} metricId(s) to frontend:`);
    metricIds.forEach(m => console.log(`   • "${m.name}"  →  ${m.id}`));

    res.json({
      answer:             finalAnswer,
      rawAnswer,
      identifiedMetrics,
      metricIds,
      toolCallCount:      iterations
    });

  } catch (err) {
    console.error('Error in /ask:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── /tableau/auth — connection check for the Pulse Bundle Tester ─────────────
app.get('/tableau/auth', async (req, res) => {
  try {
    const session = await getTableauSession();
    res.json({
      ok:           true,
      siteId:       session.siteId,
      tokenPreview: session.token.substring(0, 12) + '…'
    });
  } catch (e) {
    console.error('[Pulse Tester] Auth check failed:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── /tableau/pulse/insights/:bundleType — proxy for Pulse Bundle Tester ───────
const VALID_BUNDLE_TYPES = ['ban', 'springboard', 'basic', 'exploration', 'breakdown', 'detail', 'brief'];

app.post('/tableau/pulse/insights/:bundleType', async (req, res) => {
  const { bundleType } = req.params;

  if (!VALID_BUNDLE_TYPES.includes(bundleType)) {
    return res.status(400).json({ error: `Invalid bundle type: "${bundleType}"` });
  }

  try {
    const session    = await getTableauSession();
    const tableauUrl = `${TABLEAU_SERVER}/api/-/pulse/insights/${bundleType}`;
    console.log(`[Pulse Tester] ${bundleType} → ${tableauUrl}`);

    const r = await fetch(tableauUrl, {
      method:  'POST',
      headers: {
        'Content-Type':   'application/json',
        Accept:           'application/json',
        'X-Tableau-Auth': session.token
      },
      body: JSON.stringify(req.body)
    });

    const data = await r.json();

    // If Tableau rejects the token, clear the cache so next call re-authenticates
    if (r.status === 401) tableauSession = null;

    res.status(r.status).json(data);
  } catch (e) {
    console.error(`[Pulse Tester] Proxy error (${bundleType}):`, e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Pulse Brief (server-side) — mirrors pulse-brief-utils.js ─────────────────
const SAFETY_METRIC_ID = process.env.SAFETY_METRIC_ID;

async function callPulseBriefDirect(session, metricIds, content) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'X-Tableau-Auth': session.token
  };

  const metricsRes = await fetch(`${TABLEAU_SERVER}/api/-/pulse/metrics:batchGet`, {
    method: 'POST', headers,
    body: JSON.stringify({ metric_ids: metricIds })
  });
  if (!metricsRes.ok) throw new Error(`metrics:batchGet HTTP ${metricsRes.status}`);
  const metrics = (await metricsRes.json()).metrics || [];
  if (!metrics.length) throw new Error('No metrics returned from batchGet');

  const defIds = [...new Set(metrics.map(m => m.definition_id).filter(Boolean))];
  const defsRes = await fetch(`${TABLEAU_SERVER}/api/-/pulse/definitions:batchGet`, {
    method: 'POST', headers,
    body: JSON.stringify({ definition_ids: defIds })
  });
  if (!defsRes.ok) throw new Error(`definitions:batchGet HTTP ${defsRes.status}`);
  const definitions = (await defsRes.json()).definitions || [];

  const defMap = {};
  definitions.forEach(d => { defMap[d.metadata.id] = d; });

  const contexts = metrics.map(m => {
    const def = defMap[m.definition_id];
    if (!def) return null;
    const spec = JSON.parse(JSON.stringify(m.specification));
    if (spec.comparison && Array.isArray(spec.comparison.comparison_period_override)
        && spec.comparison.comparison_period_override.length === 0) {
      delete spec.comparison.comparison_period_override;
    }
    const repOpts = JSON.parse(JSON.stringify(def.representation_options));
    delete repOpts.positive_only;
    if (repOpts.type === 'NUMBER_FORMAT_TYPE_PERCENT') {
      delete repOpts.number_units;
      delete repOpts.currency_code;
    } else if (repOpts.type === 'NUMBER_FORMAT_TYPE_NUMBER') {
      if (!repOpts.number_units) repOpts.number_units = { singular_noun: '', plural_noun: '' };
      if (repOpts.currency_code === 'CURRENCY_CODE_UNSPECIFIED') delete repOpts.currency_code;
    }
    return {
      metadata: { name: def.metadata.name, metric_id: m.id, definition_id: m.definition_id },
      metric: {
        definition: {
          datasource: def.specification.datasource,
          basic_specification: def.specification.basic_specification,
          is_running_total: def.specification.is_running_total
        },
        metric_specification: spec,
        extension_options: def.extension_options,
        representation_options: repOpts,
        insights_options: def.insights_options,
        candidates: []
      }
    };
  }).filter(Boolean);

  const payload = {
    messages: [{
      role: 'ROLE_USER',
      content,
      metric_group_context: contexts,
      metric_group_context_resolved: false,
      action_type: 'ACTION_TYPE_ANSWER'
    }],
    time_zone: 'America/New_York',
    language: 'LANGUAGE_EN_US',
    locale: 'LOCALE_EN_US'
  };

  const briefRes = await fetch(`${TABLEAU_SERVER}/api/-/pulse/insights/brief`, {
    method: 'POST', headers, body: JSON.stringify(payload)
  });
  if (!briefRes.ok) throw new Error(`insights/brief HTTP ${briefRes.status}: ${await briefRes.text()}`);
  return briefRes.json();
}

// ── /safety-pulse-summary ─────────────────────────────────────────────────────
app.get('/safety-pulse-summary', async (req, res) => {
  try {
    const session = await getTableauSession();

    const briefBody = await callPulseBriefDirect(
      session,
      [SAFETY_METRIC_ID],
      'What are the key trends and changes for this safety metric? Which Market Areas are contributing the most to the incident count? Focus on concerning trends, significant changes from the prior period, and the top contributing Market Areas.'
    );

    // Extract the top-level narrative
    let insightsText = '';
    if (briefBody.markup) {
      insightsText = briefBody.markup;
    } else if (briefBody.brief?.summary) {
      insightsText = briefBody.brief.summary;
    } else if (briefBody.messages?.[0]?.content) {
      insightsText = briefBody.messages[0].content;
    } else {
      insightsText = JSON.stringify(briefBody, null, 2);
    }

    // Separate Market Area breakdown insights from general insights
    const sourceInsights = briefBody.source_insights || [];
    const marketAreaInsights = sourceInsights.filter(ins =>
      (ins.question || ins.markup || '').toLowerCase().includes('market area')
    );
    const otherInsights = sourceInsights.filter(ins => !marketAreaInsights.includes(ins));

    const formatInsight = ins => ins.markup || ins.question || '';

    const marketAreaContext = marketAreaInsights.map(formatInsight).filter(Boolean).join('\n\n');
    const generalContext    = otherInsights.map(formatInsight).filter(Boolean).join('\n\n');

    const fullContext = [
      insightsText,
      marketAreaContext ? `\n\n=== MARKET AREA BREAKDOWN INSIGHTS ===\n${marketAreaContext}` : '',
      generalContext    ? `\n\n=== OTHER INSIGHTS ===\n${generalContext}` : ''
    ].join('');

    const response = await anthropic.messages.create({
      model: 'us.anthropic.claude-opus-4-5-20251101-v1:0',
      max_tokens: 1024,
      system: `You are a safety analyst for Hertz. You receive raw Tableau Pulse insight data for a safety metric.
Output valid HTML only. Allowed tags: <p> <strong> <em>. No markdown, no code fences, no headings, no lists, no other tags.
Structure your response as EXACTLY three items, nothing else:
1. One <p> containing the single most important takeaway about the overall safety metric — one or two sentences max, with a specific number.
2. One <p> starting with <strong>Top Market Area:</strong> followed by the name of the single highest-risk Market Area and its specific incident count or change. If no Market Area data is present, write <strong>Top Market Area:</strong> Not available.
3. One machine-readable tag on its own line: <market-area>EXACT MARKET AREA NAME HERE</market-area> — put the exact market area name from the data, or "unknown" if not available. This tag will be stripped from the display.`,
      messages: [{
        role: 'user',
        content: `Extract the key takeaway and top Market Area from these Tableau Pulse insights for a Hertz safety incident count metric. The MARKET AREA BREAKDOWN INSIGHTS section (if present) contains the dimensional data:\n\n${fullContext}`
      }]
    });

    const raw_text = response.content.find(b => b.type === 'text')?.text || '';
    const cleaned  = stripCodeFences(raw_text);

    // Extract the machine-readable market area tag
    const maMatch     = cleaned.match(/<market-area>(.*?)<\/market-area>/i);
    const topMarketArea = maMatch ? maMatch[1].trim() : null;
    const summary     = cleaned.replace(/<market-area>.*?<\/market-area>/i, '').trim();

    res.json({ summary, topMarketArea, raw: briefBody });
  } catch (e) {
    console.error('/safety-pulse-summary error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── /safety-incidents — serve CSV as JSON ────────────────────────────────────
app.get('/safety-incidents', (req, res) => {
  const csvPath = path.join(__dirname, 'Safety_Production_Mock_2.csv');
  try {
    const raw = fs.readFileSync(csvPath, 'utf8');
    const lines = raw.split('\n').filter(l => l.trim());
    const headers = parseCSVLine(lines[0]);
    const records = lines.slice(1).map(line => {
      const vals = parseCSVLine(line);
      const obj = {};
      headers.forEach((h, i) => { obj[h] = (vals[i] || '').trim(); });
      return obj;
    }).filter(r => r.Incident_number);
    res.json(records);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

function parseCSVLine(line) {
  const result = [];
  let cur = '', inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuote && line[i + 1] === '"') { cur += '"'; i++; }
      else inQuote = !inQuote;
    } else if (ch === ',' && !inQuote) {
      result.push(cur); cur = '';
    } else {
      cur += ch;
    }
  }
  result.push(cur);
  return result;
}

// ── /safety-rca — root cause analysis for a specific market area ──────────────
app.get('/safety-rca', async (req, res) => {
  const { marketArea } = req.query;
  if (!marketArea) return res.status(400).json({ error: 'marketArea query param required' });

  const csvPath = path.join(__dirname, 'Safety_Production_Mock_2.csv');
  try {
    const raw     = fs.readFileSync(csvPath, 'utf8');
    const lines   = raw.split('\n').filter(l => l.trim());
    const headers = parseCSVLine(lines[0]);
    const records = lines.slice(1).map(line => {
      const vals = parseCSVLine(line);
      const obj  = {};
      headers.forEach((h, i) => { obj[h] = (vals[i] || '').trim(); });
      return obj;
    }).filter(r => r.Incident_number);

    // Current-month boundaries (server local time)
    const now        = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const tomorrow   = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);

    // Filter to the market area AND current month (Date_of_incident is M/D/YYYY)
    const filtered = records.filter(r => {
      if (r.market_area?.trim().toLowerCase() !== marketArea.trim().toLowerCase()) return false;
      const d = new Date(r.Date_of_incident);
      return !isNaN(d) && d >= monthStart && d < tomorrow;
    });

    const monthLabel = now.toLocaleString('en-US', { month: 'long', year: 'numeric' });
    if (!filtered.length) {
      return res.status(404).json({ error: `No incidents found for "${marketArea}" in ${monthLabel}` });
    }

    // Extract the three root cause text fields
    const rcaEntries = filtered
      .map(r => ({
        incident: r.Incident_number,
        initial:  r.INITIAL_ROOT_CAUSE?.trim(),
        why:      r.WHY_DID_THIS_OCCUR__WHY?.trim(),
        why1:     r.WHY_DID_THIS_OCCUR__WHY1?.trim()
      }))
      .filter(r => r.initial || r.why || r.why1);

    const incidentText = rcaEntries.map(r =>
      `Incident ${r.incident}:\n` +
      (r.initial ? `  Initial Root Cause: ${r.initial}\n` : '') +
      (r.why     ? `  Why It Occurred: ${r.why}\n`        : '') +
      (r.why1    ? `  Further Why: ${r.why1}\n`           : '')
    ).join('\n');

    const response = await anthropic.messages.create({
      model:      'us.anthropic.claude-opus-4-5-20251101-v1:0',
      max_tokens: 1024,
      system:     `You are a workplace safety analyst for Hertz. You analyze root cause text from safety incidents to identify systemic investigation priorities.
Output valid HTML only. Allowed tags: <h3> <ul> <li> <p> <strong> <em>. No markdown, no code fences, no other tags.
Be concise. Structure your response as:
1. <h3>Key Investigation Areas</h3> — a <ul> of 3–5 <li> items, each naming a recurring theme found across the root cause fields with the approximate number of incidents mentioning it.
2. <h3>Recommended Focus</h3> — a single <p> of 2–3 sentences identifying the single highest-priority systemic issue and what action should be taken first.`,
      messages: [{
        role:    'user',
        content: `These are root cause fields (INITIAL_ROOT_CAUSE, WHY_DID_THIS_OCCUR__WHY, WHY_DID_THIS_OCCUR__WHY1) from ${rcaEntries.length} safety incidents in the "${marketArea}" market area. Identify the key areas of investigation:\n\n${incidentText}`
      }]
    });

    const text = response.content.find(b => b.type === 'text')?.text || '';
    res.json({
      analysis:        stripCodeFences(text),
      marketArea,
      monthLabel,
      totalIncidents:  filtered.length,
      recordsAnalyzed: rcaEntries.length
    });
  } catch (e) {
    console.error('/safety-rca error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── /analyze-safety — analyze one or many incidents with Claude ───────────────
app.post('/analyze-safety', async (req, res) => {
  const { incidents, mode = 'individual' } = req.body;
  if (!incidents || !incidents.length) {
    return res.status(400).json({ error: 'No incidents provided' });
  }

  const formatIncident = inc => `
Incident: ${inc.Incident_number}
Date: ${inc.Date_of_incident} | Location: ${inc.location_name} | Area: ${inc.description_of_location}
Division: ${inc.division} | Facility: ${inc.facility_type}
Type: ${inc.INCIDENT_TYPE} | Motor Vehicle: ${inc.WAS_A_MOTOR_VEHICLE_INVOLVED}
Employee Title: ${inc.INVOLVED_EMPLOYEE_TITLE}
How Injury Occurred: ${inc.HOW_DID_THE_INJURY_OCCUR}
Injury/Illness: ${inc.WHAT_WAS_THE_INJURY_OR_ILLNESS}
Description: ${inc.DESCRIPTION_OF_INCIDENT}
Root Cause: ${inc.ROOT_CAUSE}
Initial Root Cause: ${inc.INITIAL_ROOT_CAUSE}
Why It Occurred: ${inc.WHY_DID_THIS_OCCUR__WHY}
Further Why: ${inc.WHY_DID_THIS_OCCUR__WHY1}`.trim();

  let prompt, systemPrompt;

  if (mode === 'summary') {
    systemPrompt = `You are a workplace safety analyst for Hertz. Analyze multiple safety incidents and identify patterns, systemic risks, and organization-wide recommendations. Be specific and actionable. Output valid HTML only using these tags: <h3> <h4> <ul> <li> <p> <strong> <em> <hr> <div>. No markdown, no code fences.`;
    prompt = `Analyze these ${incidents.length} safety incidents as a group. Identify:
1. The top recurring themes and patterns
2. Which divisions, zones, or facility types are highest risk
3. The most common root causes
4. 5 specific, prioritized organization-wide recommendations to reduce incidents

Incidents:
${incidents.map(formatIncident).join('\n\n---\n\n')}`;
  } else {
    systemPrompt = `You are a workplace safety analyst for Hertz. Analyze this safety incident and provide a structured recommendation. Be specific and actionable. Output valid HTML only using these tags: <h3> <h4> <ul> <li> <p> <strong> <em> <hr> <div>. No markdown, no code fences.`;
    prompt = `Analyze this safety incident and provide:
1. A brief assessment of what went wrong and the severity
2. The true underlying root cause (beyond what is listed)
3. 3 specific corrective actions to prevent recurrence
4. Any immediate actions that should be taken

${formatIncident(incidents[0])}`;
  }

  try {
    const response = await anthropic.messages.create({
      model:      'us.anthropic.claude-opus-4-5-20251101-v1:0',
      max_tokens: 2048,
      system:     systemPrompt,
      messages:   [{ role: 'user', content: prompt }]
    });
    const text = response.content.find(b => b.type === 'text')?.text || '';
    res.json({ analysis: stripCodeFences(text) });
  } catch (e) {
    console.error('analyze-safety error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.use(express.static(path.join(__dirname)));

const options = {
  key:  fs.readFileSync('key.pem'),
  cert: fs.readFileSync('cert.pem')
};

https.createServer(options, app).listen(5500, () => {
  console.log('Running at https://localhost:5500');
  console.log('Diagnostics:');
  console.log('  https://localhost:5500/debug-auth     ← probes POST variants');
  console.log('  https://localhost:5500/mcp-tools      ← lists all MCP tools available');
  console.log('  https://localhost:5500/session-token  ← REST token for browser use');
  console.log('  https://localhost:5500/tableau-proxy/ ← CORS-safe Tableau API proxy');
});
