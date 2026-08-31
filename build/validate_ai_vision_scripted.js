// Test harness for the AI Vision Check node, deterministic variant: drives the REAL
// node body end-to-end with scripted model/probe responses — no live AI
// calls. Complements validate_ai_vision.js (which covers preai + real-AI full
// runs); this one exercises the guard/probe/sweep control flow deterministically.
//
// Usage (inside container n8n-visual-tester, NODE_PATH=/usr/local/lib/node_modules):
//   AVC_BODY=/tmp/vt/avc_body.js node validate_ai_vision_scripted.js <scenario> <baselinePng> <newPng> <slug>
//
// Scenarios (all script the main model to FAIL with "four footer links
// missing", defect_region 0, box in the tail zone):
//   veto    — pair whose bottoms ARE identical bottom-aligned. Expects the
//             bottom-identity veto to fire BEFORE any probe call, the
//             corrective retry (scripted PASS) to be accepted -> final PASS.
//   removal — pair with a TRUE removal near the bottom (bottoms differ).
//             All probes answer not-visible. Expects a FULL-COVERAGE sweep,
//             "claim verified", final FAIL with the model's reason intact
//             (never-miss upheld: the veto must NOT mask a real removal).
//   partial — like removal, but every sweep probe after the first 3 errors
//             on both attempts. Expects "sweep INCOMPLETE" in the trail and
//             the fail-closed verification-unavailable veto -> retry PASS.
//   found   — like removal, but every sweep probe answers VISIBLE (confirmed
//             by the scripted Gemini prober). Expects the hit to land in the
//             FIRST batch at the claim's height-shifted expected location
//             (y in the bottom half of the page) — proving claim-first window
//             ordering; the old top-down order would hit at y≈1100.
const fs = require('fs');

//   regionpin — tail-identical pair, but the scripted FAIL names a VALID
//             defect_region (with a garbage tail box). The bottom-identity
//             veto must NOT fire (defect_region is the authoritative location
//             signal); the claim must fall through to the probe/sweep
//             machinery instead (review major, 2026-08-05).
const SCENARIO = process.argv[2];
const BASE = process.argv[3];
const NEWP = process.argv[4];
const SLUG = process.argv[5] || 'vt-validate';

if (!['veto', 'removal', 'partial', 'found', 'regionpin'].includes(SCENARIO) || !BASE || !NEWP) {
  console.error('usage: node validate_ai_vision_scripted.js veto|removal|partial|found|regionpin <baselinePng> <newPng> <slug>');
  process.exit(2);
}

let body = fs.readFileSync(process.env.AVC_BODY || '/tmp/vt/avc_body.js', 'utf8')
  .replace('__MAX_WIDTH__', '1000')
  .replace('__MAX_PIXELS__', '4000000')
  .replace('const baselinePath = `/files/baseline_screenshots/baseline_${slug}.png`;', `const baselinePath = ${JSON.stringify(BASE)};`)
  .replace('const newPath = `/files/new_screenshots/new_${slug}.png`;', `const newPath = ${JSON.stringify(NEWP)};`);
if (body.includes('__MAX_WIDTH__') || body.includes('baseline_${slug}')) {
  console.error('FATAL: substitution failed — node body drifted from what this harness expects');
  process.exit(2);
}

const FAIL_ANSWER = {
  thought_process: 'stubbed confabulation for harness',
  status: 'FAIL',
  reason: "Four links ('Create your AI Character', 'Generate AI Images', 'Make your own videos', 'AI Roleplay') are missing from the bottom of the 'brand' footer column.",
  evidence: 'Baseline shows four links at the bottom of the brand column; New Version does not.',
  present_in_baseline: true,
  present_in_new: false,
  defect_region: 0,
  box: { ymin: 975, xmin: 20, ymax: 995, xmax: 400 }
};
const PASS_ANSWER = {
  thought_process: 'stubbed corrected answer', status: 'PASS', reason: 'None', evidence: 'None',
  present_in_baseline: true, present_in_new: true, defect_region: 0,
  box: { ymin: 0, xmin: 0, ymax: 0, xmax: 0 }
};

const calls = { mainFail: 0, retry: 0, qwenLocal: 0, qwenSweep: 0, qwenSweepErrors: 0, geminiProbe: 0 };
let retryFeedback = null;

const geminiResponse = (obj) => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] } }], modelVersion: 'stub-gemini' });
const qwenResponse = (obj) => ({ choices: [{ message: { content: JSON.stringify(obj) } }], model: 'stub-qwen' });

const helpers = {
  httpRequest: async (opts) => {
    if (String(opts.url).includes('generativelanguage')) {
      const schema = opts.body && opts.body.generationConfig && opts.body.generationConfig.response_schema;
      const isProbe = !!(schema && schema.properties && schema.properties.claimed_element_visible);
      if (isProbe) {
        calls.geminiProbe++;
        // In 'partial' the Gemini prober is down too — otherwise it would
        // rescue every erroring Qwen window and coverage would stay full.
        if (SCENARIO === 'partial') throw new Error('stub gemini prober down');
        // Gemini prober: confirms visibility in 'found', denies otherwise.
        return geminiResponse({ claimed_element_visible: SCENARIO === 'found', what_is_there: 'stub gemini prober answer' });
      }
      const promptText = opts.body.contents[0].parts[0].text || '';
      if (promptText.includes('## VERIFICATION FEEDBACK')) {
        calls.retry++;
        retryFeedback = promptText.slice(promptText.indexOf('## VERIFICATION FEEDBACK'));
        return geminiResponse(PASS_ANSWER);
      }
      calls.mainFail++;
      return geminiResponse(SCENARIO === 'regionpin' ? Object.assign({}, FAIL_ANSWER, { defect_region: 1 }) : FAIL_ANSWER);
    }
    if (String(opts.url).includes('openrouter')) {
      const msgs = opts.body.messages || [];
      const userContent = (msgs[1] && msgs[1].content) || [];
      const question = (Array.isArray(userContent) && userContent[0] && userContent[0].text) || '';
      const isSweep = question.includes('ONE SECTION of');
      if (!isSweep) {
        calls.qwenLocal++;
        return qwenResponse({ claimed_element_visible: false, what_is_there: 'More / Terms & Policies footer sections' });
      }
      calls.qwenSweep++;
      if (SCENARIO === 'partial' && calls.qwenSweep > 3) {
        calls.qwenSweepErrors++;
        throw new Error('stub transient probe failure');
      }
      return qwenResponse({
        claimed_element_visible: SCENARIO === 'found',
        what_is_there: SCENARIO === 'found' ? 'the four brand-column footer links' : 'grid tiles / text sections'
      });
    }
    throw new Error('unexpected URL in stub: ' + opts.url);
  },
  prepareBinaryData: async (buf, fileName, mimeType) => ({ fileName, mimeType, byteLength: buf.length })
};

const mock$ = (name) => {
  if (name === 'Loop Over Items') return { item: { json: { slug: SLUG, url: 'https://validate/' + SLUG, device: 'validate' } } };
  if (name === 'Pixel Diff Check') return { item: { json: { pixelMatch: false } } };
  throw new Error('unmocked node reference: ' + name);
};
const $env = { AI_API_KEY: 'stub-key', OPENROUTER_API_KEY: 'stub-key' };
const $input = { first: () => ({ json: {} }) };

// setTimeout sleeps (probe retry backoff, main retry 10s) burn wall-clock for
// nothing under stubs — shrink them so 'partial' (dozens of erroring probes)
// finishes fast without touching the body's logic.
const realSetTimeout = global.setTimeout;
const fastSetTimeout = (fn, ms, ...rest) => realSetTimeout(fn, Math.min(ms || 0, 20), ...rest);

const t0 = Date.now();
const fn = new Function('require', '$', '$input', '$env', '__helpers', 'setTimeout',
  `return (async function () {\n${body}\n}).call({ helpers: __helpers });`);

fn(require, mock$, $input, $env, helpers, fastSetTimeout).then((r) => {
  const out = r[0].json;
  const trail = out.verification_trail || '';
  const checks = [];
  const expect = (label, cond) => checks.push({ label, ok: !!cond });

  if (SCENARIO === 'veto') {
    expect('tailIdentity computed', !!out.tailIdentity);
    expect('bottom-identity veto in trail', trail.includes('bottom-identity veto'));
    expect('NO local/sweep probes ran', calls.qwenLocal === 0 && calls.qwenSweep === 0 && calls.geminiProbe === 0);
    expect('corrective retry received bottom-identity feedback', calls.retry === 1 && /bottom-identity/.test(retryFeedback || ''));
    expect('final status PASS via retry', out.ai.status === 'PASS' && out.reasonSource === 'model-retry');
  }
  if (SCENARIO === 'removal') {
    expect('tailIdentity NOT declared (bottoms differ)', !out.tailIdentity);
    expect('local probe ran', calls.qwenLocal === 1);
    expect('sweep ran with full coverage and verified the claim', /full-page new sweep \(\d+ windows, full coverage\): element not found — claim verified/.test(trail));
    expect('no corrective retry (claim upheld)', calls.retry === 0);
    expect('final status FAIL with model reason intact', out.ai.status === 'FAIL' && out.reasonSource === 'model' && /missing from the bottom/.test(out.ai.reason));
  }
  if (SCENARIO === 'partial') {
    expect('tailIdentity NOT declared (bottoms differ)', !out.tailIdentity);
    const mi = trail.match(/sweep INCOMPLETE \((\d+)\/(\d+) windows probed\)/);
    expect('sweep INCOMPLETE in trail', !!mi);
    expect('claim NOT accepted on trust', trail.includes('claim NOT accepted on trust'));
    // round 0 alone costs probed + 2*(failed) qwen calls; the retry round adds
    // 2*failed more — total strictly above the single-round count proves the
    // failed windows got their second attempt.
    expect('erroring windows were retried once', !!mi && calls.qwenSweep > Number(mi[1]) + 2 * (Number(mi[2]) - Number(mi[1])));
    expect('verification-unavailable veto -> retry -> PASS', out.ai.status === 'PASS' && out.reasonSource === 'model-retry' && /verification-unavailable/.test(retryFeedback || ''));
  }
  if (SCENARIO === 'regionpin') {
    expect('tailIdentity computed', !!out.tailIdentity);
    expect('bottom-identity veto did NOT fire (regionNo is authoritative)', !trail.includes('bottom-identity veto'));
    expect('claim fell through to probes', calls.qwenLocal === 1 && calls.qwenSweep > 0);
    expect('sweep verified (stub probes all not-visible) -> FAIL ships', out.ai.status === 'FAIL' && out.reasonSource === 'model');
  }
  if (SCENARIO === 'found') {
    const m = trail.match(/element FOUND at y≈(\d+)px/);
    expect('sweep found the element', !!m);
    expect('claim-first ordering: hit in the bottom half of the page (top-down order would hit y≈1100)', !!m && Number(m[1]) > 30000);
    expect('probe veto -> retry -> PASS', out.ai.status === 'PASS' && out.reasonSource === 'model-retry');
  }

  const failed = checks.filter(c => !c.ok);
  console.log(JSON.stringify({
    ok: failed.length === 0, scenario: SCENARIO, slug: SLUG, ms: Date.now() - t0,
    checks, calls, retryFeedback: retryFeedback ? retryFeedback.slice(0, 300) : null,
    tailIdentity: out.tailIdentity, status: out.ai.status, reason: String(out.ai.reason).slice(0, 140),
    reasonSource: out.reasonSource, trail
  }, null, 1));
  process.exit(failed.length === 0 ? 0 : 1);
}).catch((e) => {
  console.log(JSON.stringify({ ok: false, scenario: SCENARIO, error: String(e && e.stack || e).slice(0, 2000), calls }));
  process.exit(1);
});
