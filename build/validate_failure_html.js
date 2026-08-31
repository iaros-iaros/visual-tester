// PFH shim for the row-alignment insertion-seam fix (2026-08-01): runs the
// Test harness for the Prepare Failure HTML node. Runs the REAL node body (/tmp/vt/pfh_body.js in the container)
// against a given screenshot pair with a synthetic Result:Tested json, writes
// the highlighted JPEG to /tmp/vt/, prints the node's json output.
//
// Usage (inside container, NODE_PATH=/usr/local/lib/node_modules):
//   node validate_failure_html.js <baselinePng> <newPng> <slug> <rtJsonFile> <outJpg>
// rtJsonFile = json for $input.first().json (reason, box, defectRegion,
// defectRegionRect, defectRegionInsert, status, device, url, slug ...).
const fs = require('fs');

const BASE = process.argv[2], NEWP = process.argv[3], SLUG = process.argv[4];
const RTJSON = process.argv[5], OUTJPG = process.argv[6];
if (!BASE || !NEWP || !SLUG || !RTJSON || !OUTJPG) {
  console.error('usage: node validate_failure_html.js <baselinePng> <newPng> <slug> <rtJsonFile> <outJpg>');
  process.exit(2);
}
const rt = JSON.parse(fs.readFileSync(RTJSON, 'utf8'));

let body = fs.readFileSync('/tmp/vt/pfh_body.js', 'utf8')
  .replace('const newPath = `/files/new_screenshots/new_${slug}.png`;', `const newPath = ${JSON.stringify(NEWP)};`)
  .replace('const baselinePath = `/files/baseline_screenshots/baseline_${slug}.png`;', `const baselinePath = ${JSON.stringify(BASE)};`)
  .replace('fs.writeFileSync(`/files/failed_screenshots/${baselineSnapFile}`, snapBuf);', 'fs.writeFileSync(`/tmp/vt/snap_${baselineSnapFile}`, snapBuf);');
if (body.includes('/files/new_screenshots') || body.includes('/files/baseline_screenshots') || body.includes('/files/failed_screenshots')) {
  console.error('FATAL: path substitution failed — node body drifted from what this shim expects');
  process.exit(2);
}

const mock$ = (name) => {
  if (name === 'Loop Over Items') return { item: { json: { slug: SLUG, url: rt.url || ('https://validate/' + SLUG), device: rt.device || 'validate' } } };
  throw new Error('unmocked node reference: ' + name);
};
const $input = { first: () => ({ json: rt }) };
let outBuf = null;
const helpers = {
  prepareBinaryData: async (buf, fileName, mimeType) => { outBuf = buf; return { fileName, mimeType, byteLength: buf.length }; }
};

const t0 = Date.now();
const fn = new Function('require', '$', '$input', '__helpers',
  `return (async function () {\n${body}\n}).call({ helpers: __helpers });`);
fn(require, mock$, $input, helpers).then((r) => {
  if (outBuf) fs.writeFileSync(OUTJPG, outBuf);
  console.log(JSON.stringify({ ok: true, slug: SLUG, ms: Date.now() - t0, wrote: OUTJPG, bytes: outBuf ? outBuf.length : 0, json: r[0].json }, null, 1));
}).catch((e) => {
  console.log(JSON.stringify({ ok: false, slug: SLUG, error: String(e && e.stack || e).slice(0, 2000) }));
  process.exit(1);
});
