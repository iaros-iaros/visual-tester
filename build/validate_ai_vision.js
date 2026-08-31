// Test harness for the AI Vision Check node. Runs the REAL node body (build/ai_vision_check.js, copied to
// /tmp/vt/avc_body.js in the container) with mocked n8n globals.
//
// Usage (inside container n8n-visual-tester, NODE_PATH=/usr/local/lib/node_modules):
//   node validate_ai_vision.js preai <baselinePng> <newPng> <slug> [maxWidth] [maxPixels]
//     -> runs everything BEFORE the AI call (diff, clusters, row alignment,
//        seam regions, crops, grounding) and prints the diagnostics as JSON.
//   node validate_ai_vision.js full <baselinePng> <newPng> <slug> [maxWidth] [maxPixels]
//     -> runs the ENTIRE node incl. real Gemini/Qwen calls (needs AI_API_KEY /
//        OPENROUTER_API_KEY in the environment) and prints the output json.
const fs = require('fs');

const MODE = process.argv[2];
const BASE = process.argv[3];
const NEWP = process.argv[4];
const SLUG = process.argv[5] || 'validate';
const MAXW = process.argv[6] || '1000';
const MAXP = process.argv[7] || '4000000';

if (!MODE || !BASE || !NEWP) {
  console.error('usage: node validate_ai_vision.js preai|full <baselinePng> <newPng> <slug> [maxWidth] [maxPixels]');
  process.exit(2);
}

let body = fs.readFileSync(process.env.AVC_BODY || '/tmp/vt/avc_body.js', 'utf8')
  .replace('__MAX_WIDTH__', MAXW)
  .replace('__MAX_PIXELS__', MAXP)
  .replace('const baselinePath = `/files/baseline_screenshots/baseline_${slug}.png`;', `const baselinePath = ${JSON.stringify(BASE)};`)
  .replace('const newPath = `/files/new_screenshots/new_${slug}.png`;', `const newPath = ${JSON.stringify(NEWP)};`);
if (body.includes('__MAX_WIDTH__') || body.includes('baseline_${slug}') || body.includes('new_${slug}')) {
  console.error('FATAL: path/placeholder substitution failed — node body drifted from what this harness expects');
  process.exit(2);
}

if (MODE === 'preai') {
  const cut = body.indexOf('// --- Main flow ---');
  if (cut < 0) { console.error('FATAL: main-flow marker not found'); process.exit(2); }
  body = body.slice(0, cut) + `
return {
  dims: { bw: bMeta.width, bh: bMeta.height, nw: nMeta.width, nh: nMeta.height },
  heightsDiffer, overlapEndN: Math.round(overlapEndN * 10) / 10,
  clustersForPrompt, insertSeamNos,
  insertBands: insertBandsKept, alignCoverage, alignSkipReason, alignDeleteGaps,
  reshuffleEvidence, tailTop: tailZone ? Math.round(tailZone.top) : null,
  tailIdentity,
  shiftIdentity, shiftProvenRegionNos,
  cropLabels: cropPairs.map(c => c.label),
  groundingTextLen: groundingText.length,
  groundingText,
  trail
};`;
}

const mock$ = (name) => {
  if (name === 'Loop Over Items') return { item: { json: { slug: SLUG, url: 'https://validate/' + SLUG, device: 'validate' } } };
  if (name === 'Pixel Diff Check') return { item: { json: { pixelMatch: false } } };
  throw new Error('unmocked node reference: ' + name);
};
const $env = { AI_API_KEY: process.env.AI_API_KEY || 'dummy-key', OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY || null };
const $input = { first: () => ({ json: {} }) };
const helpers = {
  httpRequest: async (opts) => {
    const res = await fetch(opts.url, {
      method: opts.method || 'POST',
      headers: Object.assign({ 'content-type': 'application/json' }, opts.headers || {}),
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(opts.timeout || 120000)
    });
    if (!res.ok) {
      const txt = (await res.text().catch(() => '')).slice(0, 300);
      const e = new Error(`HTTP ${res.status}: ${txt}`);
      e.httpCode = res.status;
      throw e;
    }
    return await res.json();
  },
  prepareBinaryData: async (buf, fileName, mimeType) => ({ fileName, mimeType, byteLength: buf.length })
};

const t0 = Date.now();
const fn = new Function('require', '$', '$input', '$env', '__helpers',
  `return (async function () {\n${body}\n}).call({ helpers: __helpers });`);

fn(require, mock$, $input, $env, helpers).then((r) => {
  console.log(JSON.stringify({ ok: true, mode: MODE, slug: SLUG, ms: Date.now() - t0, rssMB: Math.round(process.memoryUsage().rss / 1048576), result: r }, null, 1));
}).catch((e) => {
  console.log(JSON.stringify({ ok: false, mode: MODE, slug: SLUG, ms: Date.now() - t0, error: String(e && e.stack || e).slice(0, 2000) }));
  process.exit(1);
});
