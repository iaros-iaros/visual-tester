const fs = require('fs');
// Upstream (Check Token) may emit a structured auth error — relay it untouched.
const pre = $input.item.json;
if (pre && pre.status === 'error') return { json: pre };
const query = pre.query || {};
const slug = query.slug;

// Security: Validate slug to prevent directory traversal
if (!slug || !/^[a-zA-Z0-9\-_.]+$/.test(slug)) {
  return { json: { status: 'error', httpCode: 400, message: 'Invalid or missing slug' } };
}

const sourcePath = `/files/new_screenshots/new_${slug}.png`;
const destPath = `/files/baseline_screenshots/baseline_${slug}.png`;

// v2 hardening (2026-07-29). Reports live for days but new_screenshots/ is
// wiped daily (21:00 cron) and re-captured up to 3x/day — an Accept click on
// an older report used to copy whatever file happened to be at that path NOW,
// i.e. possibly a capture the reviewer never saw, or nothing at all. Refuse:
//   1. missing source (deleted by the daily wipe);
//   2. non-PNG source (a capture_error JSON payload must never become the
//      baseline — it would then poison every later run for this page);
//   3. source RE-CAPTURED after the report was generated (reportTs query
//      param, epoch ms, added by Generate Report) — the reviewer approved a
//      different image; re-review the latest report instead.
// Refusals return structured errors (httpCode passthrough to the Respond
// node) so the report UI can show the actual reason instead of a generic 500.
try {
  if (!fs.existsSync(sourcePath)) {
    return { json: { status: 'error', httpCode: 409, message: `No current capture for ${slug} — the screenshot was cleaned up (daily 21:00 wipe). Re-run the tests and accept from the fresh report.` } };
  }
  const fd = fs.openSync(sourcePath, 'r');
  const head = Buffer.alloc(8);
  const n = fs.readSync(fd, head, 0, 8, 0);
  fs.closeSync(fd);
  const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (n !== 8 || !head.equals(PNG_MAGIC)) {
    return { json: { status: 'error', httpCode: 409, message: `Current capture for ${slug} is not a valid PNG (failed capture payload) — refusing to make it the baseline.` } };
  }
  const reportTs = Number(query.reportTs || 0);
  if (reportTs > 0) {
    const mtimeMs = fs.statSync(sourcePath).mtimeMs;
    if (mtimeMs > reportTs + 60000) {
      const fmt = (ms) => new Date(ms).toISOString().slice(0, 19) + 'Z';
      return { json: { status: 'error', httpCode: 409, message: `The page was re-captured at ${fmt(mtimeMs)}, AFTER this report was generated (${fmt(reportTs)}) — the image you reviewed is no longer the current capture. Accept from the latest report instead.` } };
    }
  }
  fs.copyFileSync(sourcePath, destPath);
  return { json: { status: 'success', httpCode: 200, slug: slug, message: 'Baseline updated' } };
} catch (error) {
  return { json: { status: 'error', httpCode: 500, message: `Failed to update baseline: ${error.message}` } };
}
