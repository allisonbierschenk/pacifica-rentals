/**
 * Pulse Brief Utilities
 * Shared functions for building and calling Tableau Pulse insights/brief endpoint
 */

/**
 * Fetch metrics via batchGet
 */
export async function apiBatchGetMetrics(ids) {
  const r = await fetch('/tableau-proxy/api/-/pulse/metrics:batchGet', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ metric_ids: ids })
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
  return r.json();
}

/**
 * Fetch definitions via batchGet
 */
export async function apiBatchGetDefs(ids) {
  const r = await fetch('/tableau-proxy/api/-/pulse/definitions:batchGet', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ definition_ids: ids })
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
  return r.json();
}

/**
 * Build the brief payload from metrics and definitions
 */
export function buildBriefPayload(metrics, definitions, content, tz, lang, locale) {
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

    // Fix representation_options to match UI payload structure
    if (repOpts.type === 'NUMBER_FORMAT_TYPE_PERCENT') {
      // Remove fields that don't belong on percent metrics
      delete repOpts.number_units;
      delete repOpts.currency_code;
    } else if (repOpts.type === 'NUMBER_FORMAT_TYPE_NUMBER') {
      // Ensure number_units is present for NUMBER types
      if (!repOpts.number_units) {
        repOpts.number_units = { singular_noun: '', plural_noun: '' };
      }

      // Clean up currency_code for non-currency numbers
      if (repOpts.currency_code === 'CURRENCY_CODE_UNSPECIFIED') {
        delete repOpts.currency_code;
      }
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

  return {
    messages: [{
      role: 'ROLE_USER',
      content,
      metric_group_context: contexts,
      metric_group_context_resolved: false,  // CRITICAL: false tells Tableau to resolve data and generate viz
      action_type: 'ACTION_TYPE_ANSWER'
    }],
    time_zone: tz,
    language: lang,
    locale
  };
}

/**
 * Call the insights/brief endpoint with a payload
 */
export async function callInsightsBrief(payload, endpoint = '/tableau-proxy/api/-/pulse/insights/brief') {
  const start = Date.now();
  const r = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const latency = Date.now() - start;
  const contentType = r.headers.get('content-type') || '';

  let body;
  try {
    body = contentType.includes('application/json') ? await r.json() : await r.text();
  } catch {
    body = '(empty response body)';
  }

  return {
    status: r.status,
    ok: r.ok,
    latency,
    contentType,
    body
  };
}

/**
 * Complete workflow: fetch data, build payload, call brief endpoint
 */
export async function fetchAndCallBrief(metricIds, options = {}) {
  const {
    content = 'What happened this period compared to the previous period?',
    timeZone = 'America/New_York',
    language = 'LANGUAGE_EN_US',
    locale = 'LOCALE_EN_US',
    endpoint = '/tableau-proxy/api/-/pulse/insights/brief'
  } = options;

  // Step 1: Fetch metrics
  const metricsData = await apiBatchGetMetrics(metricIds);
  const metrics = metricsData.metrics || [];

  if (!metrics.length) {
    throw new Error('No metrics returned from batchGet');
  }

  // Step 2: Fetch definitions
  const defIds = [...new Set(metrics.map(m => m.definition_id).filter(Boolean))];
  const defsData = await apiBatchGetDefs(defIds);
  const definitions = defsData.definitions || [];

  // Step 3: Build payload
  const payload = buildBriefPayload(metrics, definitions, content, timeZone, language, locale);

  // Step 4: Call brief endpoint
  const result = await callInsightsBrief(payload, endpoint);

  return {
    payload,
    result,
    metrics,
    definitions
  };
}
