// Test harness for the Generate Report node. Runs the REAL node body against a
// synthetic run (one FAIL with evidence, one crashed FAIL, PASS/SKIP/NEW rows)
// and writes the HTML, so report markup and the on-demand screenshot viewer can
// be checked in a browser without a deploy.
//
// Usage:
//   node validate_report.js <device> <outHtml> [baseUrl]
// baseUrl defaults to http://caddy — the internal, auth-free file server, so a
// browserless session on the same docker network can load the real evidence:
//   node validate_report.js mobile /tmp/vt/report.html
const fs = require('fs');
const path = require('path');

const DEVICE = process.argv[2] || 'mobile';
const OUT = process.argv[3];
const BASE = process.argv[4] || 'http://caddy';
if (!OUT) {
  console.error('usage: node validate_report.js <device> <outHtml> [baseUrl]');
  process.exit(2);
}

const body = fs.readFileSync(path.join(__dirname, 'generate_report.js'), 'utf8')
  .replace(/__DEVICE__/g, DEVICE);
if (/__[A-Z][A-Z0-9_]*__/.test(body)) {
  console.error('FATAL: unsubstituted placeholder — node body drifted from what this shim expects');
  process.exit(2);
}

// One item per shape Result: Tested / Prepare Failure HTML can emit.
const mk = (o) => ({ json: Object.assign({ device: DEVICE }, o) });
const items = [
  mk({ status: 'FAIL', url: 'https://example.test/image-to-video', slug: `image-to-video_${DEVICE}`,
       reason: 'Visual change detected in 4 region(s) — see highlighted region(s).',
       fileName: `/files/failed_screenshots/highlighted_image-to-video_${DEVICE}_STAMP.jpg`,
       baselineSnapFile: `baseline-at-fail_image-to-video_${DEVICE}_STAMP.jpg`,
       evidenceStamp: 'STAMP', modelVersion: 'gemini-3.1-pro-preview', reasonSource: 'pixeldiff-fallback',
       thought_process: 'A "quoted" phrase & <b>markup</b>, to check escaping.',
       verification_trail: 'local new probe: not visible\nfull-page sweep: FOUND at y≈11000px' }),
  mk({ status: 'FAIL', url: 'https://example.test/crashed', slug: `crashed_${DEVICE}`,
       reason: 'Screenshot crashed (Timeout or Memory)', fileName: null, baselineSnapFile: null }),
  mk({ status: 'PASS', url: 'https://example.test/passing', slug: `passing_${DEVICE}` }),
  mk({ status: 'SKIP', url: 'https://example.test/skipped', slug: `skipped_${DEVICE}`,
       reason: 'Capture Error: page scroll-locked by a modal' }),
  mk({ status: 'NEW', url: 'https://example.test/brand-new', slug: `brand-new_${DEVICE}` }),
  mk({ status: 'PASS', url: 'https://example.test/other-device', slug: 'other', device: 'other' }),
];

const mock$ = (name) => {
  if (name === 'Loop Over Items') return { all: () => items };
  throw new Error('unmocked node reference: ' + name);
};
const $env = { WEBHOOK_URL: BASE, UPDATE_BASELINE_TOKEN: 'validate-token' };

const out = new Function('$', '$env', 'Buffer', `return (function () {\n${body}\n})();`)(mock$, $env, Buffer);
const rep = out.find((r) => r.json.device === DEVICE);
if (!rep) { console.error(`FATAL: no report emitted for device ${DEVICE}`); process.exit(1); }
fs.writeFileSync(OUT, rep.json.fileContent);
console.log(JSON.stringify({ ok: true, device: DEVICE, wrote: OUT, bytes: rep.json.fileContent.length,
  pass: rep.json.passedCount, fail: rep.json.failedCount, skip: rep.json.skippedCount, total: rep.json.total }));
