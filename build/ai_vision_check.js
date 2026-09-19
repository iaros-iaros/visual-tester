const fs = require('fs');
const sharp = require('sharp');
let pixelmatch = require('pixelmatch');
if (pixelmatch.default) pixelmatch = pixelmatch.default;

const slug = $('Loop Over Items').item.json.slug;
const baselinePath = `/files/baseline_screenshots/baseline_${slug}.png`;
const newPath = `/files/new_screenshots/new_${slug}.png`;

// ---------------------------------------------------------------------------
// Capture/decode guard (2026-07-29). A failed capture writes a JSON error
// payload where the PNG should be, and on this n8n a sharp NATIVE decode error
// is FATAL to the whole task runner (the runner freezes Error.prototype, so
// sharp's error wrapper throws an uncatchable TypeError inside its native
// callback — no try/catch here can contain it; it killed the runner twice in
// the 12:31Z run). Short-circuit to a visible SKIP before sharp ever runs.
// ---------------------------------------------------------------------------
const pdcJson = $('Pixel Diff Check').item.json || {};
if (pdcJson.captureError) {
  return [{ json: { error: { message: `Capture/decode failed: ${pdcJson.captureError}`, kind: 'capture' }, resized_width: 0, mime_type: "image/png" } }];
}
{
  const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  for (const [label, p] of [['baseline', baselinePath], ['new', newPath]]) {
    let ok = false;
    try {
      const fd = fs.openSync(p, 'r');
      const head = Buffer.alloc(8);
      ok = fs.readSync(fd, head, 0, 8, 0) === 8 && head.equals(PNG_MAGIC);
      // Tail check too: a TRUNCATED png (capture killed mid-write, disk full)
      // passes the magic check but still detonates sharp's uncatchable native
      // error. A complete PNG ends with the IEND chunk (2026-08-01).
      if (ok) {
        const st = fs.fstatSync(fd);
        const tail = Buffer.alloc(12);
        ok = st.size > 20 && fs.readSync(fd, tail, 0, 12, st.size - 12) === 12 && tail.includes('IEND');
      }
      fs.closeSync(fd);
    } catch (e) { ok = false; }
    if (!ok) return [{ json: { error: { message: `Capture/decode failed: ${label} screenshot is not a valid PNG`, kind: 'capture' }, resized_width: 0, mime_type: "image/png" } }];
  }
}
const MAX_WIDTH = __MAX_WIDTH__;
const MAX_PIXELS = __MAX_PIXELS__;
const API_KEY = $env.AI_API_KEY;
// Kept as the -latest alias ON PURPOSE (owner decision 2026-07-27): pinned previews get
// retired under you (gemini-3-pro-preview 404s while still listed). Drift is handled by
// observability instead: modelVersion is persisted on every result and shown in reports.
const PRIMARY_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro-latest:generateContent?key=${API_KEY}`;
// Fallback is DeepSeek Flash via OpenRouter (2026-09-19 swap, benchmarked on an
// 18-pair truth battery vs the previous Qwen3.5 fallback: equal verdict
// quality, zero fabricated FAIL stories vs one for Qwen, ~2x faster, ~6.6x
// cheaper, 6/6 on the existence probes). NOT gemini-flash-latest: on the
// 2026-07-27 benchmark flash blind-PASSed a real regression 3/3 (silently
// flips true FAILs on 503 days). Alias kept ON PURPOSE like gemini-pro-latest;
// the served model is persisted per result. Provider is PINNED: the account's
// OpenRouter data policy already excludes the official 'deepseek' endpoint
// (trains on paid inputs), and the cheapest route (Relace fp4) does not
// support response_format — DeepInfra (fp8) supports it and pins serving, same
// philosophy as the old parasail pin. The fallback also serves the existence
// probe (cheap, deterministic). If OPENROUTER_API_KEY is absent both fallback
// and probe self-disable.
const OR_KEY = $env.OPENROUTER_API_KEY || null;
const OR_URL = 'https://openrouter.ai/api/v1/chat/completions';
const FALLBACK_MODEL = '~deepseek/deepseek-flash-latest';
const FALLBACK_PROVIDER = { only: ['deepinfra'] };

const GEMINI_PROMPT = "You are a Senior QA Engineer. Compare the TWO images provided. Image 1 is the Baseline. Image 2 is the New Version.\n\n## THE GOLDEN RULE (CONSERVATIVE MODE)\n**Default to PASS.** Only fail if the difference is OBVIOUS and breaks the user experience. If you have to \"squint\" or zoom in to see it, it is NOT a bug.\n\n## 1. IGNORE THESE (NOISE FILTER)\n- **Tiny Shifts:** Elements moving 1-5 pixels. (Common in browser rendering).\n- **Text Thickness:** Fonts looking slightly bolder/thinner (Anti-aliasing).\n- **Color Vibrance:** Slight changes in hue/brightness (Compression artifacts).\n- **Dynamic Data:** Timestamps, dates, view counts, random IDs.\n- **Icons:** Slight pixelation differences in icons.\n- **Rotating Content Grids:** Content/poster grids rotate their items between visits. Different, reordered, or additional grid thumbnails/rows are routine rotation -> PASS, unless the grid layout itself is broken (overlapping tiles, gaps, broken images).\n- **Moved/Reordered Content:** An element is missing ONLY if it is absent from the ENTIRE new page. A card, tile, banner, or CTA that appears at a DIFFERENT position (reordered within a grid, moved up or down the page) is NOT missing and NOT added -> PASS. Grid CTA/promo cards routinely move between grid positions during rotation.\n\n## 2. FLAG THESE (REAL BUGS)\n- **Missing Content:** A button, image, or paragraph exists on Left but is GONE on Right. Before flagging, verify at the same location in Image 2 (use the crops) that it is truly gone — an element that is restyled, moved, or lost an icon/dot is NOT missing. If the element might simply sit at a different position, scan the WHOLE of Image 2 before claiming removal.\n- **Added Content:** A paragraph, section, banner, or element appears on Right that did not exist on Left. Before flagging, verify at the same location in Image 1 that it is truly absent there — an element that exists in both but changed style (e.g. lost or gained an icon/dot) is NOT new. Report REAL additions — do NOT excuse them as an 'intentional update'; a human reviews the report and accepts intentional changes there.\n- **Layout Shifts:** If an unexpected element appears and pushes everything else down, identify the NEW element as the bug. Do NOT highlight the content that merely shifted below it.\n- **Broken Layout:** Elements overlapping, crushed, or completely misaligned.\n- **Logo/Brand Damage:** The site logo is an EXCEPTION to the restyling tolerance: a graphic, icon, or stylized character that is part of the logo disappearing, failing to load, or being replaced by plain text IS a real bug — report it as FAIL.\n\n## THINKING PROCESS (Must be in 'thought_process'):\n1. **Scan:** Look at the image globally.\n2. **List Candidates:** Identify potential differences.\n3. **The Filter:** For each candidate, ask: \"Does this prevent a user from using the site?\" or \"Is this just a rendering quirk?\"\n   - If it's a quirk -> DISCARD.\n   - If it's a real bug -> KEEP.\n4. **Verdict:** If NO candidates remain after filtering, the status is PASS.\n\n## OUTPUT RULES\n- If PASS: 'reason' must be 'None', 'box' must be all 0, 'defect_region' must be 0, 'evidence' must be 'None', and present_in_baseline/present_in_new must both be true.\n- If FAIL: 'reason' must describe the exact defect. 'evidence' must state what is VISIBLY at the defect location in EACH image (look again at both before writing it). 'present_in_baseline'/'present_in_new' state whether the affected element is visible in each image. 'defect_region' MUST be the NUMBER of the pixel-diff region (from the numbered PIXEL-DIFF GROUND TRUTH list, when present) that contains the root defect — this is the PRIMARY location signal and drives where the report highlights the defect; re-read the region list and pick the one whose area contains the defect you described. Use 0 ONLY if no region list was provided or the defect lies outside every listed region (e.g. in the uncompared bottom area when one is noted). 'box' MUST be an object: {\"ymin\": ..., \"xmin\": ..., \"ymax\": ..., \"xmax\": ...} wrapping ONLY the root defect relative to Image 2 (New Version) using native 0-1000 scale.";

const RESPONSE_SCHEMA = {
  type: "OBJECT",
  required: ["thought_process", "status", "reason", "evidence", "present_in_baseline", "present_in_new", "defect_region", "box"],
  properties: {
    thought_process: { type: "STRING" },
    status: { type: "STRING", enum: ["PASS", "FAIL"] },
    reason: { type: "STRING" },
    evidence: { type: "STRING", description: "What is visibly present at the defect location in Image 1 and in Image 2" },
    present_in_baseline: { type: "BOOLEAN", description: "Is the affected element visible in Image 1 (Baseline)?" },
    present_in_new: { type: "BOOLEAN", description: "Is the affected element visible in Image 2 (New Version)?" },
    defect_region: { type: "INTEGER", description: "Number of the pixel-diff region (from the numbered region list) containing the root defect; 0 if PASS, if no list was provided, or if the defect is outside every listed region" },
    box: {
      type: "OBJECT",
      description: "Bounding box of the root defect using native 0-1000 coordinates.",
      required: ["ymin", "xmin", "ymax", "xmax"],
      properties: {
        ymin: { type: "INTEGER", description: "Top edge (0-1000 scale)" },
        xmin: { type: "INTEGER", description: "Left edge (0-1000 scale)" },
        ymax: { type: "INTEGER", description: "Bottom edge (0-1000 scale)" },
        xmax: { type: "INTEGER", description: "Right edge (0-1000 scale)" }
      }
    }
  }
};

// ---------------------------------------------------------------------------
// Context images: resize by pixel AREA + width cap (unchanged from v1).
// ---------------------------------------------------------------------------
const bMeta = await sharp(baselinePath).metadata();
const nMeta = await sharp(newPath).metadata();

const b64len = (buf) => Math.ceil(buf.length / 3) * 4;
const shrinkToBudget = async (path, meta, pixelBudget) => {
  const scale = Math.min(1, Math.sqrt(pixelBudget / (meta.width * meta.height)));
  const width = Math.min(MAX_WIDTH, Math.max(1, Math.round(meta.width * scale)));
  const out = await sharp(path).resize(width, null, { withoutEnlargement: true }).png({ compressionLevel: 9 }).toBuffer();
  return { out, width };
};
let a = await shrinkToBudget(baselinePath, bMeta, MAX_PIXELS);
let b = await shrinkToBudget(newPath, nMeta, MAX_PIXELS);

// Aggregate-payload budget: Gemini's inline request cap is ~20MB of base64 and
// the context pair ALONE reaches ~17MB on the photo-dense home page. Re-shrink
// the context pair until it leaves headroom; crops respect the remainder below.
const CONTEXT_B64_BUDGET = 14 * 1024 * 1024;
let ctxPixelBudget = MAX_PIXELS;
for (let i = 0; i < 2 && b64len(a.out) + b64len(b.out) > CONTEXT_B64_BUDGET; i++) {
  ctxPixelBudget = Math.round(ctxPixelBudget * 0.6);
  a = await shrinkToBudget(baselinePath, bMeta, ctxPixelBudget);
  b = await shrinkToBudget(newPath, nMeta, ctxPixelBudget);
}
if (a.out.length > 10 * 1024 * 1024 || b.out.length > 10 * 1024 * 1024) {
  throw new Error("Images too large for Base64 conversion in n8n sandbox");
}
const resizedWidth = a.width;

// ---------------------------------------------------------------------------
// Diff clusters BEFORE the AI call. Same algorithm family as Prepare Failure
// HTML (600px-wide pixelmatch + connected components on an 8px cell grid) so
// the regions the AI is told about match the boxes later drawn on the report.
// Coordinates are 0-1000 normalized to the NEW image (Image 2) frame — the
// same frame the model's own box uses. Returns null when the pixel diff is
// unusable (native width changed = real re-layout), in which case the AI call
// degrades gracefully to v1 behavior (no hints, no crops, no geometry guard).
// ---------------------------------------------------------------------------
const DIFF_WIDTH = 600, CELL = 8, HOT_MIN = 2, DILATE = 1;
// Grounding wants COMPLETENESS, not drawing aesthetics: keep every blob with a
// meaningful share of the diff. (The drawing-oriented dominant-blob selection
// in Prepare Failure HTML dropped small-but-real clusters — e.g. the changed
// header band on tall grid pages — leaving the model ungrounded exactly where
// it confabulates. 2026-07-28 "header button added" incident.)
const GROUND_MIN_SHARE = 0.02, GROUND_MAX = 8, PAD = 0.012;

function clusterBoxes(red, W, H, total, normH) {
  if (!normH) normH = H;
  if (total === 0) return [];
  const GW = Math.ceil(W / CELL), GH = Math.ceil(H / CELL);
  const cellDiff = new Int32Array(GW * GH);
  for (let y = 0; y < H; y++) { const gy = (y / CELL) | 0; for (let x = 0; x < W; x++) if (red[y * W + x]) cellDiff[gy * GW + ((x / CELL) | 0)]++; }
  const hot = new Uint8Array(GW * GH);
  for (let i = 0; i < cellDiff.length; i++) hot[i] = cellDiff[i] >= HOT_MIN ? 1 : 0;
  let conn;
  if (DILATE > 0) {
    conn = new Uint8Array(GW * GH);
    for (let gy = 0; gy < GH; gy++) for (let gx = 0; gx < GW; gx++) {
      if (!hot[gy * GW + gx]) continue;
      for (let dy = -DILATE; dy <= DILATE; dy++) for (let dx = -DILATE; dx <= DILATE; dx++) {
        const ny = gy + dy, nx = gx + dx;
        if (nx >= 0 && ny >= 0 && nx < GW && ny < GH) conn[ny * GW + nx] = 1;
      }
    }
  } else { conn = hot; }
  const label = new Int32Array(GW * GH);
  const comps = [], stack = [];
  let lab = 0;
  for (let c = 0; c < GW * GH; c++) {
    if (!conn[c] || label[c]) continue;
    lab++; label[c] = lab; stack.length = 0; stack.push(c);
    let dsum = 0, minx = GW, maxx = 0, miny = GH, maxy = 0;
    while (stack.length) {
      const cur = stack.pop(), cx = cur % GW, cy = (cur / GW) | 0;
      if (hot[cur]) { dsum += cellDiff[cur]; if (cx < minx) minx = cx; if (cx > maxx) maxx = cx; if (cy < miny) miny = cy; if (cy > maxy) maxy = cy; }
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue; const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= GW || ny >= GH) continue;
        const nc = ny * GW + nx; if (conn[nc] && !label[nc]) { label[nc] = lab; stack.push(nc); }
      }
    }
    if (dsum > 0) comps.push({ dsum, cminx: minx, cmaxx: maxx, cminy: miny, cmaxy: maxy });
  }
  if (!comps.length) return [];
  for (const c of comps) {
    const x0 = c.cminx * CELL, x1 = Math.min(W - 1, (c.cmaxx + 1) * CELL - 1), y0 = c.cminy * CELL, y1 = Math.min(H - 1, (c.cmaxy + 1) * CELL - 1);
    let rminx = W, rmaxx = 0, rminy = H, rmaxy = 0, found = false;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (red[y * W + x]) { found = true; if (x < rminx) rminx = x; if (x > rmaxx) rmaxx = x; if (y < rminy) rminy = y; if (y > rmaxy) rmaxy = y; }
    if (found) { c.top = rminy; c.bottom = rmaxy; c.left = rminx; c.right = rmaxx; } else { c.top = y0; c.bottom = y1; c.left = x0; c.right = x1; }
  }
  comps.sort((x, y) => y.dsum - x.dsum);
  const total2 = comps.reduce((s, c) => s + c.dsum, 0);
  let kept = comps.filter(c => c.dsum / total2 >= GROUND_MIN_SHARE).slice(0, GROUND_MAX);
  if (!kept.length) kept = [comps[0]];
  const pY = Math.round(H * PAD), pX = Math.round(W * PAD);
  return kept.map(c => {
    const top = Math.max(0, c.top - pY), bottom = Math.min(H - 1, c.bottom + pY);
    const left = Math.max(0, c.left - pX), right = Math.min(W - 1, c.right + pX);
    return { top: (top / normH) * 1000, left: (left / W) * 1000, width: ((right - left + 1) / W) * 1000, height: ((bottom - top + 1) / normH) * 1000 };
  });
}

let clusters = null; // null = unusable diff; [] = usable but empty (shouldn't happen on a failing page)
let heightsDiffer = false, overlapEndN = 1000;
// Per-row red-pixel projection of the 600px diff (row index = diff frame row),
// kept for the insertion-seam corroboration gate below. ~128KB worst case.
let rowRedDiff = null, diffH600 = 0, newH600 = 0;
try {
  const rOpt = { withoutEnlargement: true };
  const baseRaw = await sharp(baselinePath).resize(DIFF_WIDTH, null, rOpt).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const newRaw = await sharp(newPath).resize(DIFF_WIDTH, null, rOpt).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = baseRaw.info.width;
  let bData = baseRaw.data, nData = newRaw.data, H = baseRaw.info.height;
  let usable = true;
  if (baseRaw.info.height !== newRaw.info.height) {
    if (bMeta.width === nMeta.width) {
      heightsDiffer = true;
      H = Math.min(baseRaw.info.height, newRaw.info.height);
      bData = baseRaw.data.subarray(0, W * H * 4);
      nData = newRaw.data.subarray(0, W * H * 4);
    } else {
      usable = false;
    }
  }
  if (usable) {
    const diff = Buffer.alloc(W * H * 4);
    pixelmatch(bData, nData, diff, W, H, { threshold: 0.1 });
    const red = new Uint8Array(W * H);
    let total = 0;
    rowRedDiff = new Uint32Array(H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      if (diff[i] > 150 && diff[i + 1] < 100 && diff[i + 2] < 100) { red[y * W + x] = 1; total++; rowRedDiff[y]++; }
    }
    diffH600 = H; newH600 = newRaw.info.height;
    clusters = clusterBoxes(red, W, H, total, newRaw.info.height);
    // Height changed: the rows below the shared overlap were NEVER compared.
    // Add a synthetic guard zone there so (a) the grounding text stays honest
    // and (b) the geometry veto cannot kill a true bottom-of-page finding.
    // (30-unit tolerance also covers removal claims when the new page is the
    // shorter one and the removed content has no exact Image-2 location.)
    if (heightsDiffer) {
      overlapEndN = Math.min(1000, (H / newRaw.info.height) * 1000);
      const zoneTop = Math.max(0, overlapEndN - 30);
      clusters.push({ top: zoneTop, left: 0, width: 1000, height: 1000 - zoneTop, tail: true });
    }
  }
} catch (e) { console.warn(`AVC: cluster diff failed for ${slug}; degrading to ungrounded call: ${e.message}`); clusters = null; }

// Machine-verification trail: every deterministic check appends here; the
// string travels through Result: Tested and Prepare Failure HTML into the
// report so a questionable verdict is diagnosable without replaying the run.
const trail = [];

// Node-wide time-budget anchor: gates the corrective retry AND the sweep
// deadline. Anchored BEFORE the deterministic work (alignment, dHash, crops)
// so their cost counts toward the 600s runner-kill budget (review, 2026-08-01).
const T0 = Date.now();

// ---------------------------------------------------------------------------
// Row-alignment insertion seams (2026-08-01). An inserted row (the footer-link
// incident) shifts everything below it: the pixel diff lights the DISPLACED
// content while the insertion blob itself (~0.06% share) sits far below
// GROUND_MIN_SHARE — so no numbered region ever contained the true defect and
// the defect_region contract had no correct answer (red boxes landed on
// shifted footer blocks; the incident pair violated never-miss). Patience-align
// per-row signatures of both pages: row runs that exist ONLY in the new
// version become INSERTION SEAM regions, exempt from the share floor, so the
// model can name them and the highlighter pins red to the actual insertion.
// ADDITIVE-ONLY by construction: any gate failure (width mismatch, low anchor
// coverage, no corroborating red diff rows, detector error) leaves the region
// list and every downstream path exactly as before.
const ALIGN_ENABLE = true; // kill-switch
const ALIGN_SIGW = 48, ALIGN_QSHIFT = 4, ALIGN_LOWINFO = 6, ALIGN_FUZZY = 10;
const ALIGN_MERGE = 24, ALIGN_MIN_H = 8, ALIGN_MIN_GAP = 12, ALIGN_MAX_BANDS = 2;
// A seam is by definition a SMALL insertion. Corpus sweep findings (112 pairs,
// 2026-08-01): capless bands turned blog-post rotation into 11,470px "seams"
// (routine churn the rotation rules should judge, not insertion evidence), and
// h-OR-gap gating admitted 10-30px slivers with gapNewLen 2-4 from small
// dynamic shifts. Bands must satisfy BOTH size gates and stay under the cap;
// anything else falls back to today's behavior (diff clusters still cover it).
const ALIGN_MAX_BAND_H = 400;
// Confidence gate is PER-BAND, not a global coverage floor: a band is trusted
// only when a genuinely matched row sits within ALIGN_FLANK px on BOTH sides
// (anchor-starved pages fail this locally). A global coverage floor was tried
// first and nearly killed the flagship incident pair, which aligns at
// coverage 0.16 because grid churn dominates the row count, yet its band
// flanks are matched 1 row away. Coverage is still reported for observability.
const ALIGN_PAD_PX = 40, ALIGN_FLANK = 300;
let insertBandsKept = [], alignCoverage = null, alignSkipReason = null, alignDeleteGaps = 0;
if (!ALIGN_ENABLE) alignSkipReason = 'disabled';
else if (!clusters) alignSkipReason = 'no-usable-diff';
else if (bMeta.width !== nMeta.width) alignSkipReason = 'width-mismatch';
else try {
  // Width-only downsample (48 x nativeH, fit:'fill') keeps native rows intact,
  // so a pure vertical shift leaves rows byte-comparable and row index = native y.
  const bH = bMeta.height, nH = nMeta.height;
  const bCols = await sharp(baselinePath).resize(ALIGN_SIGW, bH, { fit: 'fill' }).greyscale().raw().toBuffer();
  const nCols = await sharp(newPath).resize(ALIGN_SIGW, nH, { fit: 'fill' }).greyscale().raw().toBuffer();
  const rowMeta = (cols, H) => {
    // Flat one-shot strings via a scratch buffer (not += concat: 62k rows of
    // 48-deep ConsString chains would stack ~100MB of V8 heap on the pipeline
    // peak). Low-info rows keep an empty sig — they are never keyed/compared.
    const sig = new Array(H), low = new Uint8Array(H);
    const scratch = Buffer.alloc(ALIGN_SIGW);
    for (let y = 0; y < H; y++) {
      const off = y * ALIGN_SIGW;
      let mn = 255, mx = 0;
      for (let x = 0; x < ALIGN_SIGW; x++) { const v = cols[off + x]; if (v < mn) mn = v; if (v > mx) mx = v; scratch[x] = v >> ALIGN_QSHIFT; }
      const isLow = (mx - mn) <= ALIGN_LOWINFO; // near-uniform row: must never anchor or count as content
      low[y] = isLow ? 1 : 0;
      sig[y] = isLow ? '' : scratch.toString('latin1');
    }
    return { sig, low };
  };
  const B = rowMeta(bCols, bH), N = rowMeta(nCols, nH);
  // Anchor candidates: signatures unique among non-low rows in BOTH images
  const uniq = (m) => { const cnt = new Map(); for (let y = 0; y < m.sig.length; y++) { if (m.low[y]) continue; const k = m.sig[y]; cnt.set(k, cnt.has(k) ? -1 : y); } return cnt; };
  const uB = uniq(B), uN = uniq(N);
  const cand = [];
  for (const [k, by] of uB) { if (by < 0) continue; const ny = uN.get(k); if (ny !== undefined && ny >= 0) cand.push([by, ny]); }
  cand.sort((a, z) => a[0] - z[0]);
  // Longest strictly-increasing subsequence over new-row indices = monotonic anchor chain
  const tails = [], tailIdx = [], parent = new Int32Array(cand.length).fill(-1);
  for (let i = 0; i < cand.length; i++) {
    const v = cand[i][1];
    let lo = 0, hi = tails.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (tails[mid] < v) lo = mid + 1; else hi = mid; }
    tails[lo] = v; tailIdx[lo] = i; parent[i] = lo > 0 ? tailIdx[lo - 1] : -1;
  }
  const anchors = [];
  if (tails.length) for (let i = tailIdx[tails.length - 1]; i >= 0; i = parent[i]) anchors.push(cand[i]);
  anchors.reverse();
  const fuzzyEq = (by, ny) => {
    const bo = by * ALIGN_SIGW, no = ny * ALIGN_SIGW;
    for (let x = 0; x < ALIGN_SIGW; x++) if (Math.abs(bCols[bo + x] - nCols[no + x]) > ALIGN_FUZZY) return false;
    return true;
  };
  // Extend matches greedily into each inter-anchor gap from both ends; blank
  // (low-info) runs of unequal length are absorbed one-sidedly so the dark
  // theme's empty stretches can't block or fake a match.
  let matchedNonLowN = 0;
  let totalNonLowN = 0; for (let y = 0; y < nH; y++) if (!N.low[y]) totalNonLowN++;
  for (const [, ny] of anchors) if (!N.low[ny]) matchedNonLowN++;
  const rawBands = []; // unmatched runs with content ONLY on the new side
  const bounds = [[-1, -1]].concat(anchors, [[bH, nH]]);
  for (let k = 0; k + 1 < bounds.length; k++) {
    const [pb, pn] = bounds[k], [nb, nn] = bounds[k + 1];
    let b = pb + 1, n = pn + 1;
    while (b < nb && n < nn) {
      if (B.low[b] && N.low[n]) { b++; n++; continue; }
      if (B.low[b]) { b++; continue; }
      if (N.low[n]) { n++; continue; }
      if (B.sig[b] === N.sig[n] || fuzzyEq(b, n)) { matchedNonLowN++; b++; n++; continue; }
      break;
    }
    let be = nb - 1, ne = nn - 1;
    while (be >= b && ne >= n) {
      if (B.low[be] && N.low[ne]) { be--; ne--; continue; }
      if (B.low[be]) { be--; continue; }
      if (N.low[ne]) { ne--; continue; }
      if (B.sig[be] === N.sig[ne] || fuzzyEq(be, ne)) { matchedNonLowN++; be--; ne--; continue; }
      break;
    }
    // residual gap: base rows b..be vs new rows n..ne, classified by which side has content
    let nbB = 0; for (let y = b; y <= be; y++) if (!B.low[y]) nbB++;
    let nbN = 0, e0 = -1, e1 = -1;
    for (let y = n; y <= ne; y++) if (!N.low[y]) { nbN++; if (e0 < 0) e0 = y; e1 = y; }
    if (nbN > 0 && nbB === 0) rawBands.push({ y0: e0, y1: e1, h: e1 - e0 + 1, gapNewLen: ne - n + 1, flankUp: e0 - n + 1, flankDown: ne - e1 + 1 });
    else if (nbB > 0 && nbN === 0) alignDeleteGaps++;
    // content on BOTH sides = in-place modification (grid churn, resized
    // sections, displaced-content mixtures): never an insertion band.
  }
  alignCoverage = Math.round((matchedNonLowN / Math.max(1, totalNonLowN)) * 1000) / 1000;
  rawBands.sort((a, z) => a.y0 - z.y0);
  const merged = [];
  for (const bd of rawBands) {
    const last = merged[merged.length - 1];
    if (last && bd.y0 - last.y1 <= ALIGN_MERGE) { last.y1 = Math.max(last.y1, bd.y1); last.h = last.y1 - last.y0 + 1; last.gapNewLen += bd.gapNewLen; last.flankDown = bd.flankDown; }
    else merged.push({ y0: bd.y0, y1: bd.y1, h: bd.h, gapNewLen: bd.gapNewLen, flankUp: bd.flankUp, flankDown: bd.flankDown });
  }
  let kept = merged.filter(bd => bd.h >= ALIGN_MIN_H && bd.gapNewLen >= ALIGN_MIN_GAP
    && bd.h <= ALIGN_MAX_BAND_H
    && bd.flankUp <= ALIGN_FLANK && bd.flankDown <= ALIGN_FLANK);
  // Corroboration gate: a real insertion changed pixels at its own rows in the
  // 600px diff (bands fully beyond the compared overlap are exempt — that area
  // was never diffed, which is exactly why the tail-zone note exists).
  if (kept.length && rowRedDiff) {
    const s = newH600 / nH;
    kept = kept.filter(bd => {
      if (Math.floor(bd.y0 * s) >= diffH600) return true; // fully beyond the compared overlap (pure bottom append): nothing to corroborate against
      const d0 = Math.max(0, Math.floor(bd.y0 * s) - 2), d1 = Math.min(diffH600 - 1, Math.ceil(bd.y1 * s) + 2);
      for (let y = d0; y <= d1; y++) if (rowRedDiff[y]) return true;
      return false;
    });
  }
  kept.sort((a, z) => z.h - a.h);
  kept = kept.slice(0, ALIGN_MAX_BANDS).sort((a, z) => a.y0 - z.y0);
  insertBandsKept = kept;
  for (const bd of kept) {
    const top = Math.max(0, bd.y0 - ALIGN_PAD_PX), bot = Math.min(nH - 1, bd.y1 + ALIGN_PAD_PX);
    clusters.push({ top: (top / nH) * 1000, left: 0, width: 1000, height: ((bot - top + 1) / nH) * 1000, insert: true, bandPx: { y0: bd.y0, y1: bd.y1, h: bd.h, gapNewLen: bd.gapNewLen } });
    trail.push(`mechanical insertion evidence: rows y≈${bd.y0}-${bd.y1}px exist only in the new version (content inserted there; content below is baseline content shifted down)`);
  }
} catch (e) { alignSkipReason = `error: ${String(e.message).slice(0, 120)}`; console.warn(`AVC: row alignment failed for ${slug}: ${e.message}`); }

// ---------------------------------------------------------------------------
// Bottom-strip region (2026-09-19). GROUND_MIN_SHARE keeps the region list
// complete RELATIVE to the diff mass — but on churn-heavy pages a small REAL
// change in the page's bottom chrome (the pinned mobile nav bar) falls under
// the 2% share floor, no region covers the page bottom, and the grounding
// text then FORBIDS reporting it ("everything outside these regions is
// pixel-identical"). Proven on a churn-heavy mobile grid page 2026-09-19: a full
// bottom-nav A/B flip (9,874 red px = 0.28% of a grid-churn diff) was
// silenced on all four benchmarked models; PASS shipped. The floor is
// share-based by design, so the guard is ABSOLUTE: when the last
// BOTTOM_STRIP_PX rows of the compared diff hold real red mass and no kept
// region reaches them, append a full-width BOTTOM STRIP region — numbered,
// cropped, probe-able like any region; the model still judges it under the
// normal rules. Equal-heights pairs only: when the heights differ, the tail
// zone / PAGE-BOTTOM pair machinery already owns the page bottom. Threshold
// measured 2026-09-19: nav-change signal ≈9.9k red px, benign CTA shift 4.5k
// (forms its own >=2%-share region, so `covered` suppresses the strip), clean
// pages 0 — 400 sits 25x under the signal and above the measured zero noise.
// Additive-only; kill-switch below.
const BOTTOMSTRIP_ENABLE = true;
const BOTTOM_STRIP_PX = 420; // pinned mobile nav ~350px + margin
const BOTTOMSTRIP_MIN_RED = 400;
if (BOTTOMSTRIP_ENABLE && clusters && !heightsDiffer && rowRedDiff && nMeta.height > BOTTOM_STRIP_PX * 3) {
  try {
    const s = newH600 / nMeta.height;
    const d0 = Math.max(0, Math.floor((nMeta.height - BOTTOM_STRIP_PX) * s));
    let stripRed = 0;
    for (let y = d0; y < diffH600; y++) stripRed += rowRedDiff[y];
    const stripTop = ((nMeta.height - BOTTOM_STRIP_PX) / nMeta.height) * 1000;
    const covered = clusters.some(c => !c.tail && c.top + c.height >= stripTop - 2);
    if (stripRed >= BOTTOMSTRIP_MIN_RED && !covered) {
      clusters.push({ top: stripTop, left: 0, width: 1000, height: 1000 - stripTop, bottomStrip: true });
      trail.push(`bottom-strip region: ${stripRed} changed px in the last ${BOTTOM_STRIP_PX}px of the page fell under the region share floor — appended as a numbered region so the change stays reportable`);
    }
  } catch (e) { console.warn(`AVC: bottom-strip check failed for ${slug}: ${e.message}`); }
}

// ---------------------------------------------------------------------------
// Native-resolution crop pairs of the top diff regions. A 12px glyph that is
// sub-pixel noise in the downscaled context images is trivially legible in a
// native crop — this is what killed the "missing X" confabulation in testing.
// ---------------------------------------------------------------------------
const CROP_MAX = 3, CROP_PAD_PX = 24, CROP_MIN_W = 200, CROP_MIN_H = 120, CROP_MAX_PIXELS = 1200000;

const cropRegionPx = (boxN) => {
  // 0-1000 (NEW-image frame) -> native NEW pixels, padded and clamped
  let left = Math.round(boxN.left / 1000 * nMeta.width) - CROP_PAD_PX;
  let top = Math.round(boxN.top / 1000 * nMeta.height) - CROP_PAD_PX;
  let w = Math.round(boxN.width / 1000 * nMeta.width) + 2 * CROP_PAD_PX;
  let h = Math.round(boxN.height / 1000 * nMeta.height) + 2 * CROP_PAD_PX;
  if (w < CROP_MIN_W) { left -= Math.round((CROP_MIN_W - w) / 2); w = CROP_MIN_W; }
  if (h < CROP_MIN_H) { top -= Math.round((CROP_MIN_H - h) / 2); h = CROP_MIN_H; }
  left = Math.max(0, left); top = Math.max(0, top);
  return { left, top, w, h };
};

const extractCrop = async (path, meta, r) => {
  const left = Math.min(r.left, Math.max(0, meta.width - 1));
  const top = Math.min(r.top, Math.max(0, meta.height - 1));
  const w = Math.max(1, Math.min(r.w, meta.width - left));
  const h = Math.max(1, Math.min(r.h, meta.height - top));
  let pipe = sharp(path).extract({ left, top, width: w, height: h });
  if (w * h > CROP_MAX_PIXELS) {
    pipe = pipe.resize(Math.max(1, Math.round(w * Math.sqrt(CROP_MAX_PIXELS / (w * h)))), null);
  }
  return await pipe.png({ compressionLevel: 9 }).toBuffer();
};

const realClusters = (clusters || []).filter(c => !c.tail);
const tailZone = (clusters || []).find(c => c.tail) || null;

// ---------------------------------------------------------------------------
// Bottom-aligned tail identity (2026-08-05). When the page height changes, the
// top-aligned diff proves nothing about the page bottom, and the tail-zone
// note used to invite the model to "inspect" it on context images where footer
// text is ~7px tall — the 2026-08-05 incident confabulated "four footer links
// removed" while the bottom 6,000px of both captures were byte-identical (the
// rotating grid had served 1,683px less content; everything below shifted up).
// Deletions have no insertion-seam analogue yet (phase-2 gap), but this class
// is refutable deterministically: compare the LAST K rows of both images
// aligned at the page BOTTOM. If they match, nothing within K of the bottom
// was added, removed, or changed — the height change happened higher up. The
// proof feeds the grounding text (prevention) and a guard veto (cure); when
// the bottoms genuinely differ, a bottom-aligned crop pair ships instead so
// the model judges the tail on evidence, not thumbnails. Additive-only: any
// gate failure or error leaves every downstream path exactly as before.
// ---------------------------------------------------------------------------
const TAILCMP_ENABLE = true; // kill-switch
// Mismatch tolerance is TIGHT and ABSOLUTE on purpose: a structural change
// inside the zone misaligns everything above it (bottom-aligned) and lights
// 100k+ px, but a loose tolerance could absorb a small real defect (a
// vanished icon) that changes no height. The relative term alone would scale
// the allowance with K — i.e. with the size of the UNRELATED grid delta — so
// the absolute cap keeps forgiveness at sub-2.5k-px dynamic noise regardless
// of K (review major, 2026-08-05). Footers with bigger dynamic content simply
// don't get the evidence (old behavior).
const TAILCMP_MAX_MISMATCH = 0.0005, TAILCMP_MAX_ABS_PX = 2500, TAILCMP_MARGIN_PX = 200;
// Row cap bounds the two native-width raw RGBA buffers (2 x K x width x 4B —
// unbounded K reached ~580MB on big-delta shapes, an OOM-kill class inside the
// runner; review major, 2026-08-05). Over-cap deltas SKIP the check entirely:
// proving identity of a zone SMALLER than the claimable area would be unsound
// (a chopped-half page would "prove" its surviving bottom and veto true
// missing-content claims), so it is the unclamped K or nothing.
const TAILCMP_MAX_ROWS = 6000;
let tailIdentity = null; // {kPx, mismatchPx} once the bottom-aligned tail is PROVEN unchanged
if (TAILCMP_ENABLE && heightsDiffer && tailZone) {
  try {
    const minH = Math.min(bMeta.height, nMeta.height);
    const delta = Math.abs(bMeta.height - nMeta.height);
    // K covers everything a tail claim can be about: the uncompared remainder
    // of the taller page (delta) plus the new-frame tail zone, with slack for
    // sloppy claim boxes.
    const tailNewPx = Math.ceil((1000 - tailZone.top) / 1000 * nMeta.height);
    const K = delta + tailNewPx + TAILCMP_MARGIN_PX;
    // A mechanically-kept insertion band overlapping the zone is proof the
    // bottom DID change — the two mechanical evidences must never contradict
    // (blank-flanked seams can light fewer px than the noise tolerance;
    // review major, 2026-08-05).
    const seamInZone = insertBandsKept.some(bd => bd.y1 >= nMeta.height - K);
    if (K >= 400 && K <= Math.min(minH - 100, TAILCMP_MAX_ROWS) && !seamInZone) {
      const grabTail = (path, meta) => sharp(path)
        .extract({ left: 0, top: meta.height - K, width: meta.width, height: K })
        .ensureAlpha().raw().toBuffer();
      const [tb, tn] = await Promise.all([grabTail(baselinePath, bMeta), grabTail(newPath, nMeta)]);
      const mismatchPx = pixelmatch(tb, tn, null, bMeta.width, K, { threshold: 0.1 });
      if (mismatchPx <= Math.min(TAILCMP_MAX_MISMATCH * bMeta.width * K, TAILCMP_MAX_ABS_PX)) {
        tailIdentity = { kPx: K, mismatchPx };
        trail.push(`mechanical tail evidence: the bottom ${K}px of both pages are unchanged when aligned at the page bottom (${mismatchPx} differing px of ${bMeta.width * K}; the ${delta}px height change happened above) — nothing was added or removed within ${K}px of the page bottom`);
      }
    }
  } catch (e) { console.warn(`AVC: tail identity check failed for ${slug}: ${e.message}`); }
}

// ---------------------------------------------------------------------------
// Shift-aligned DISPLACEMENT PROOF (2026-08-16). The tail check above proves
// only the bottom K rows (delta + tail zone + slack = 3,740px on the incident
// pair) — but when a rotating grid serves fewer rows, EVERYTHING below it is
// displaced, 21,207px of it here. The top-aligned diff lights that whole area
// up, it becomes numbered regions, and the model — reading 254px-wide
// thumbnails of a 62k-px page — narrates the offset as an insertion: "a new
// text section was added, pushing the sections below it down" (mobile FAILs
// 2026-08-15 12:42Z and 2026-08-16 12:44Z on one content-grid page; the named
// section was byte-identical in both captures, 1,683px higher in the new one).
// Prove the displacement instead of guessing at it: compare both pages
// BOTTOM-ALIGNED, row by row, walking up from the page bottom until the rows
// stop matching. That boundary is exactly where the height change happened;
// everything below it is the same content at a different y.
//
// Width-only downsample (SHIFTID_W x nativeH, fit:'fill') is what makes this
// exact: rows are never resampled, so a pure vertical shift leaves them
// BYTE-identical (measured: 0 differing px across all 21,207 displaced rows,
// at both 300 and 600 wide), while the horizontal averaging quietly absorbs
// sub-pixel dynamic noise. Sensitivity was measured against injected defects
// inside the zone: a 20x20px dot on a heading = 202px over 20 rows (10/row), a
// blanked word = 3,408px — every one of them stops the scan AT the defect, so
// the proven zone never swallows a real change. Thresholds sit an order of
// magnitude below the smallest of those and above the measured noise floor.
// ---------------------------------------------------------------------------
const SHIFTID_ENABLE = true; // kill-switch
const SHIFTID_W = 600;              // = DIFF_WIDTH; rows stay native
const SHIFTID_ROW_MAX = 3;          // a row differing by more than this ENDS the proof
const SHIFTID_TOTAL_MAX = 120;      // cumulative allowance over the whole zone
const SHIFTID_MIN_PX = 4000;        // below this the tail check already covers it
let shiftIdentity = null; // {px, topN, mismatchPx, deltaPx} once the displacement is PROVEN
if (SHIFTID_ENABLE && heightsDiffer && bMeta.width === nMeta.width) {
  try {
    const cols = (path, meta) => sharp(path)
      .resize(SHIFTID_W, meta.height, { fit: 'fill' }).greyscale().raw().toBuffer();
    const [bc, nc] = await Promise.all([cols(baselinePath, bMeta), cols(newPath, nMeta)]);
    const rows = Math.min(bMeta.height, nMeta.height) - 100; // never claim the whole shorter page
    let k = 0, mismatchPx = 0;
    for (let i = 0; i < rows; i++) {
      const bo = (bMeta.height - 1 - i) * SHIFTID_W, no = (nMeta.height - 1 - i) * SHIFTID_W;
      let d = 0;
      for (let x = 0; x < SHIFTID_W; x++) if (Math.abs(bc[bo + x] - nc[no + x]) > 8) d++;
      if (d > SHIFTID_ROW_MAX || mismatchPx + d > SHIFTID_TOTAL_MAX) break;
      mismatchPx += d; k = i + 1;
    }
    // A mechanically-kept insertion band inside the zone is proof the bottom
    // DID change: the two mechanical evidences must never contradict each
    // other (same guard as the tail check; review major, 2026-08-05).
    const seamInZone = insertBandsKept.some(bd => bd.y1 >= nMeta.height - k);
    if (k >= SHIFTID_MIN_PX && !seamInZone) {
      const delta = Math.abs(bMeta.height - nMeta.height);
      const shrank = bMeta.height > nMeta.height; // the new page is the shorter one
      shiftIdentity = {
        px: k, topN: ((nMeta.height - k) / nMeta.height) * 1000, mismatchPx, deltaPx: delta,
        dirWord: shrank ? 'higher' : 'lower', causeWord: shrank ? 'shorter' : 'taller'
      };
      trail.push(`mechanical displacement proof: the bottom ${k}px of both pages are identical when aligned at the page bottom (${mismatchPx} differing px) — every section below y≈${nMeta.height - k}px of the new page is the SAME content sitting ${delta}px ${shiftIdentity.dirWord}, not added, removed, or changed`);
    }
  } catch (e) { console.warn(`AVC: displacement proof failed for ${slug}: ${e.message}`); }
}
// Regions lying ENTIRELY inside the proven zone differ only because their
// content moved: mechanically incapable of holding a defect.
const shiftProvenRegionNos = [];
if (shiftIdentity) realClusters.forEach((c, i) => {
  if (!c.insert && c.top >= shiftIdentity.topN) shiftProvenRegionNos.push(i + 1);
});

const TOTAL_B64_BUDGET = 18 * 1024 * 1024;
let payloadB64 = b64len(a.out) + b64len(b.out);
const contextScale = b.width / nMeta.width;

// Bottom-aligned PAGE-BOTTOM crop pair (2026-08-05): when the heights differ
// and the bottom was NOT proven identical, the model is asked to judge the
// uncompared tail — previously on the context thumbnails alone (footer text
// ~7px on 62k-px pages: pure confabulation surface). Ship the last rows of
// BOTH pages aligned at the page bottom, so a real removal or append is
// directly visible; skipped when tailIdentity or the displacement proof
// already showed the bottom unchanged (nothing to inspect, payload saved).
// Built FIRST so it wins the payload-budget race against megapixel region
// crops (same lesson as seam crops; review, 2026-08-05) — but PUSHED last so
// region crop numbering is untouched.
const TAILCROP_PX = 2400;
let bottomPair = null;
if (tailZone && !tailIdentity && !shiftIdentity) {
  try {
    const h = Math.min(TAILCROP_PX, bMeta.height, nMeta.height);
    const cb = await extractCrop(baselinePath, bMeta, { left: 0, top: bMeta.height - h, w: bMeta.width, h });
    const cn = await extractCrop(newPath, nMeta, { left: 0, top: nMeta.height - h, w: nMeta.width, h });
    if (payloadB64 + b64len(cb) + b64len(cn) <= TOTAL_B64_BUDGET) {
      payloadB64 += b64len(cb) + b64len(cn);
      bottomPair = {
        label: `PAGE-BOTTOM pair: the LAST ${h}px of each page, aligned at the page BOTTOM, high resolution — the page heights differ (baseline ${bMeta.height}px vs new ${nMeta.height}px), so this area could not be machine-compared; judge the uncompared bottom area from THIS pair, not from the full-page images`,
        baseB64: cb.toString('base64'),
        newB64: cn.toString('base64')
      };
    } else {
      trail.push('page-bottom crop pair dropped: payload budget exhausted by the context pair');
      console.warn(`AVC: page-bottom crop dropped for ${slug}: payload budget`);
    }
  } catch (e) { console.warn(`AVC: page-bottom crop failed for ${slug}: ${e.message}`); }
}

// Header strip: the banner/header zone is where site-wide changes land and
// where every confabulation so far has lived ("missing X", "added a header
// button") — and on grid pages the merged mega-cluster fails the crop gate, so
// the model never saw the header at native resolution. Whenever ANY cluster
// touches the top strip, always attach a full-width native-res crop of it.
const HEADER_STRIP_PX = 260;
const stripTopN = (HEADER_STRIP_PX / nMeta.height) * 1000;
const wantHeaderStrip = realClusters.some(c => c.top < stripTopN);

// Crop candidates: clusters whose crop would genuinely beat the context
// image's resolution (a huge rotation-case region downscaled to the crop pixel
// cap is LESS detailed than the full page, not more, and would mislead).
// Clusters already covered by the header strip are excluded from the picks.
// Displacement-proven regions are skipped: their two crops would be identical
// pictures at different y, spending megabytes of payload budget to invite the
// model to explain a difference that mechanically is not there (2026-08-16).
const cropCands = realClusters.filter(boxN => {
  if (wantHeaderStrip && boxN.top + boxN.height <= stripTopN) return false;
  if (shiftProvenRegionNos.includes(realClusters.indexOf(boxN) + 1)) return false;
  const r = cropRegionPx(boxN);
  return Math.min(1, Math.sqrt(CROP_MAX_PIXELS / (r.w * r.h))) > contextScale;
});
// Pick by mass, but ALWAYS include the topmost candidate: header/banner bands
// are small-mass yet are where site-wide changes (and confabulations) live.
let cropPicks = cropCands.slice(0, wantHeaderStrip ? CROP_MAX - 1 : CROP_MAX);
const topmost = cropCands.reduce((m, c) => (!m || c.top < m.top ? c : m), null);
if (topmost && !cropPicks.includes(topmost)) cropPicks[cropPicks.length - 1] = topmost;
// Insertion seams ALWAYS ship a crop — every seam, and FIRST: the crop loop
// below hard-stops at the payload budget, and a seam crop (~200px tall,
// trivial bytes) must never lose that race to a megapixel region crop
// (observed on the incident pair: budget break at crop 2 left the seam
// unshipped; a shared last slot also let seam 2 overwrite seam 1 — review).
// The bottom-strip region force-ships a crop the same way: it only exists when
// NO other region reaches the page bottom, so its crop pair is the model's
// only native-res look at the change it was appended for (~420px, trivial bytes).
cropPicks = realClusters.filter(c => c.insert || c.bottomStrip)
  .concat(cropPicks.filter(c => !c.insert && !c.bottomStrip))
  .slice(0, wantHeaderStrip ? CROP_MAX - 1 : CROP_MAX);

const cropPairs = []; // [{label, baseB64, newB64}] — base64 stays in this local const only
if (wantHeaderStrip) {
  try {
    const r = { left: 0, top: 0, w: nMeta.width, h: HEADER_STRIP_PX };
    const cb = await extractCrop(baselinePath, bMeta, r);
    const cn = await extractCrop(newPath, nMeta, r);
    if (payloadB64 + b64len(cb) + b64len(cn) <= TOTAL_B64_BUDGET) {
      payloadB64 += b64len(cb) + b64len(cn);
      const inStrip = realClusters.map((c, i) => (c.top < stripTopN ? i + 1 : 0)).filter(Boolean);
      cropPairs.push({
        label: `top-of-page strip (banner + header), full width, native resolution${inStrip.length ? ` — contains Region ${inStrip.join(', Region ')}` : ''}`,
        baseB64: cb.toString('base64'),
        newB64: cn.toString('base64')
      });
    }
  } catch (e) { console.warn(`AVC: header strip crop failed for ${slug}: ${e.message}`); }
}
for (const boxN of cropPicks) {
  try {
    const r = cropRegionPx(boxN);
    const cb = await extractCrop(baselinePath, bMeta, r);
    const cn = await extractCrop(newPath, nMeta, r);
    if (payloadB64 + b64len(cb) + b64len(cn) > TOTAL_B64_BUDGET) break;
    payloadB64 += b64len(cb) + b64len(cn);
    const regionNo = realClusters.indexOf(boxN) + 1;
    cropPairs.push({
      label: boxN.insert
        ? `Region ${regionNo} INSERTION SEAM: rows y≈${boxN.bandPx.y0}-${boxN.bandPx.y1}px of Image 2 exist ONLY in the new version — identify from THIS crop exactly what was inserted (the baseline crop shows the same location BEFORE the insertion)`
        : boxN.bottomStrip
          ? `Region ${regionNo} BOTTOM-OF-PAGE STRIP (last ${BOTTOM_STRIP_PX}px of the page, full width, native resolution) — judge this page-chrome strip from THIS crop pair`
          : `Region ${regionNo}: top=${Math.round(boxN.top)},left=${Math.round(boxN.left)},width=${Math.round(boxN.width)},height=${Math.round(boxN.height)}`,
      baseB64: cb.toString('base64'),
      newB64: cn.toString('base64')
    });
  } catch (e) { console.warn(`AVC: crop failed for ${slug}: ${e.message}`); }
}

// Change-front crop for GIANT regions. Whole-giant-region crops are correctly
// rejected by the resolution gate above (downscaled mush) — which left the
// model with ONLY the tiny context thumbnails for exactly the regions where
// removed-vs-reshuffled must be decided; that gap produced the 2026-07-29
// "avatar carousel missing" confabulation over a reshuffled 36,000px gallery.
// The TOP EDGE of a giant region is where a removal/insertion/reshuffle
// visibly manifests — show that sliver at native resolution instead.
const GIANT_N = 150, FRONT_CTX_PX = 350, FRONT_H_PX = 1400;
const giants = realClusters.filter(c => c.height > GIANT_N && !c.insert && !cropPicks.includes(c)
  && !shiftProvenRegionNos.includes(realClusters.indexOf(c) + 1));
if (giants.length) {
  const g = giants.reduce((m, c) => (c.top < m.top ? c : m), giants[0]); // topmost giant = the change front
  try {
    const topPx = Math.max(0, Math.round(g.top / 1000 * nMeta.height) - FRONT_CTX_PX);
    const r = { left: 0, top: topPx, w: nMeta.width, h: FRONT_H_PX + FRONT_CTX_PX };
    const cb = await extractCrop(baselinePath, bMeta, r);
    const cn = await extractCrop(newPath, nMeta, r);
    if (payloadB64 + b64len(cb) + b64len(cn) <= TOTAL_B64_BUDGET) {
      payloadB64 += b64len(cb) + b64len(cn);
      cropPairs.push({
        label: `Region ${realClusters.indexOf(g) + 1} CHANGE-FRONT (top edge of a very large changed area, native resolution) — the last matching content and the first differing content meet here; decide from THIS crop whether content was truly removed/added or merely reshuffled/rotated`,
        baseB64: cb.toString('base64'),
        newB64: cn.toString('base64')
      });
    }
  } catch (e) { console.warn(`AVC: change-front crop failed for ${slug}: ${e.message}`); }
}

// PAGE-BOTTOM pair was built (budget-reserved) before the region crops; append
// it after them so region crop-pair numbering stays stable.
if (bottomPair) cropPairs.push(bottomPair);

const clustersForPrompt = realClusters.map(c => c.insert
  // seam rects keep 1 decimal: whole-unit rounding is ±31px on a 62k-px page,
  // enough to shave a 35px band; 0.1 units keeps the drawn box on the rows
  ? { top: Math.round(c.top * 10) / 10, left: 0, width: 1000, height: Math.round(c.height * 10) / 10 }
  : { top: Math.round(c.top), left: Math.round(c.left), width: Math.round(c.width), height: Math.round(c.height) });
const insertSeamNos = realClusters.map((c, i) => (c.insert ? i + 1 : 0)).filter(Boolean);

// ---------------------------------------------------------------------------
// Deterministic reshuffle evidence for GIANT regions (2026-07-29). Masonry
// galleries re-rotate wholesale: one tile swap cascades a column, the whole
// grid becomes one giant diff blob, and the model narrates the churn as
// "content removed" (both 12:31Z confabulations transplanted top-of-page
// elements into that story). Tile-hash matching proves mechanically that the
// region's baseline content still exists at shifted positions, and the
// grounding text says so BEFORE the model answers.
// ---------------------------------------------------------------------------
// Baseline tiles on a coarse grid; new-image tiles on a DENSE stride-8 grid —
// masonry reshuffles move content by arbitrary pixel offsets, so an aligned
// grid misses most matches (34.8% measured on a true reshuffle) while the
// dense grid recovers them (83.6% vs a 25.5% unrelated-page control floor).
const RESHUFFLE_MIN_SHARE = 0.5, TILE = 32, NEW_STRIDE = 8, ANALYSIS_W = 512, HAM_MAX = 10;
const reshuffleEvidence = {}; // regionNo -> matched share (0..1)
const dhashTiles = (data, width, height, stride) => {
  const tiles = [];
  const cell = TILE / 8;
  for (let ty = 0; ty + TILE <= height; ty += stride) {
    for (let tx = 0; tx + TILE <= width; tx += stride) {
      // 9x8 box-averaged luminance -> 64-bit dHash as two 32-bit halves
      const cells = new Float64Array(72);
      let mn = 255, mx = 0;
      for (let gy = 0; gy < 8; gy++) for (let gx = 0; gx < 9; gx++) {
        const x0 = tx + Math.floor(gx * TILE / 9), x1 = Math.max(tx + Math.floor((gx + 1) * TILE / 9), x0 + 1);
        let s = 0, n = 0;
        for (let y = ty + gy * cell; y < ty + (gy + 1) * cell; y++)
          for (let x = x0; x < x1; x++) { s += data[y * width + x]; n++; }
        const v = s / n;
        cells[gy * 9 + gx] = v;
        if (v < mn) mn = v; if (v > mx) mx = v;
      }
      if (mx - mn < 10) continue; // flat tile: matches everything, proves nothing
      let hi = 0, lo = 0;
      for (let gy = 0; gy < 8; gy++) for (let gx = 0; gx < 8; gx++) {
        const bit = cells[gy * 9 + gx] < cells[gy * 9 + gx + 1] ? 1 : 0;
        if (gy * 8 + gx < 32) hi = ((hi << 1) | bit) >>> 0; else lo = ((lo << 1) | bit) >>> 0;
      }
      tiles.push([hi, lo]);
    }
  }
  return tiles;
};
const popcount = (x) => { x -= (x >> 1) & 0x55555555; x = (x & 0x33333333) + ((x >> 2) & 0x33333333); x = (x + (x >> 4)) & 0x0f0f0f0f; return (x * 0x01010101) >> 24; };
try {
  const GIANT_EVIDENCE_N = 150;
  for (const g of realClusters.filter(c => c.height > GIANT_EVIDENCE_N && !c.insert
    && !shiftProvenRegionNos.includes(realClusters.indexOf(c) + 1)).slice(0, 2)) {
    const regionNo = realClusters.indexOf(g) + 1;
    const grab = async (path, meta) => {
      const top = Math.max(0, Math.round(g.top / 1000 * meta.height));
      const h = Math.max(TILE * 4, Math.min(meta.height - top, Math.round(g.height / 1000 * meta.height)));
      return await sharp(path).extract({ left: 0, top, width: meta.width, height: h })
        .resize(ANALYSIS_W, null).greyscale().raw().toBuffer({ resolveWithObject: true });
    };
    const [bb, nn] = await Promise.all([grab(baselinePath, bMeta), grab(newPath, nMeta)]);
    const bt = dhashTiles(bb.data, bb.info.width, bb.info.height, TILE);
    const nt = dhashTiles(nn.data, nn.info.width, nn.info.height, NEW_STRIDE);
    if (bt.length < 20 || !nt.length) continue;
    let matched = 0;
    for (const [bh, bl] of bt) {
      for (let j = 0; j < nt.length; j++) {
        if (popcount((bh ^ nt[j][0]) >>> 0) + popcount((bl ^ nt[j][1]) >>> 0) <= HAM_MAX) { matched++; break; }
      }
    }
    const share = matched / bt.length;
    if (share >= RESHUFFLE_MIN_SHARE) {
      reshuffleEvidence[regionNo] = share;
      trail.push(`Region ${regionNo} reshuffle evidence: ${(share * 100).toFixed(0)}% of baseline tiles found relocated in the new version`);
    }
  }
} catch (e) { console.warn(`AVC: reshuffle evidence failed for ${slug}: ${e.message}`); }

let groundingText = '';
if (clustersForPrompt.length) {
  const regionList = clustersForPrompt.map((c, i) => {
    let extra = '';
    if (reshuffleEvidence[i + 1]) extra += ` — MECHANICAL RESHUFFLE EVIDENCE: ${(reshuffleEvidence[i + 1] * 100).toFixed(0)}% of this region's baseline content is present in the new version at shifted positions; this region is reordered/rotated content, NOT removed content`;
    if (shiftProvenRegionNos.includes(i + 1)) extra += ` — MECHANICAL DISPLACEMENT EVIDENCE: this region differs ONLY because its content sits ${shiftIdentity.deltaPx}px higher in the new version; a bottom-aligned pixel comparison PROVES the content itself is identical in both versions. Nothing here was added, removed, or changed — do NOT report a defect in this region`;
    const rc = realClusters[i];
    if (rc && rc.insert) extra += ` — MECHANICAL INSERTION EVIDENCE: rows y≈${rc.bandPx.y0}-${rc.bandPx.y1}px of Image 2 exist ONLY in the new version (content was INSERTED here; the content below is baseline content shifted down). If you report added content at this location, defect_region MUST be ${i + 1}. Whether the insertion is a defect remains YOUR judgment per the rules above (e.g. an extra tile row inside a rotating content grid is routine rotation)`;
    if (rc && rc.bottomStrip) extra += ` — BOTTOM PAGE STRIP: the last ${BOTTOM_STRIP_PX}px of the page (pinned navigation / footer chrome). Automated comparison found changed pixels here that were too small a share of the total diff to form a region of their own; inspect this strip's close-up crop pair and judge it under the normal rules`;
    return `Region ${i + 1}: ${JSON.stringify(c)}${extra}`;
  }).join('\n');
  groundingText =
    `\n\n## PIXEL-DIFF GROUND TRUTH\nAutomated pixel comparison found changed pixels ONLY inside these NUMBERED regions of Image 2 (0-1000 scale, {top,left,width,height}):\n${regionList}\nEverything OUTSIDE these regions ${tailZone ? `in the compared area (above y=${Math.round(overlapEndN)}) ` : ''}is pixel-identical between the two full-page images (apart from trivial scattered noise) — do not report any element outside them as changed, added, or missing${tailZone ? ' (EXCEPT in the uncompared bottom area described below)' : ''}. Any defect you report MUST be located inside one of these regions${tailZone ? ' or in the uncompared bottom area' : ''}, and 'defect_region' MUST name that region's number.` +
    (cropPairs.length ? `\nAfter the two full-page images, ${cropPairs.length} matching close-up crop pair(s) of the changed region(s) follow at full resolution (baseline crop first, then new crop). Use the crops to identify precisely what changed — they are far more detailed than the full pages.` : '');
}
if (tailZone) {
  const prefix = groundingText ? '\n' : '\n\n## PIXEL-DIFF GROUND TRUTH\n';
  const hasBottomPair = cropPairs.some(cp => cp.label.startsWith('PAGE-BOTTOM'));
  // The displacement proof subsumes the tail proof (its zone always includes
  // the page bottom), so it REPLACES that note rather than stacking with it.
  const shiftNote = shiftIdentity && (!tailIdentity || shiftIdentity.px > tailIdentity.kPx)
    ? `${prefix}NOTE: the page HEIGHT changed between versions (baseline ${bMeta.height}px vs new ${nMeta.height}px). Mechanical verification PROVED that the bottom ${shiftIdentity.px}px of the two pages are IDENTICAL when aligned at the page bottom: every section below y=${Math.round(shiftIdentity.topN)} (0-1000, Image 2 frame) is the SAME content, merely sitting ${shiftIdentity.deltaPx}px ${shiftIdentity.dirWord.toUpperCase()} in the new version because the content ABOVE it got ${shiftIdentity.causeWord} (typically a rotating grid serving more or fewer rows). Nothing below y=${Math.round(shiftIdentity.topN)} was added, removed, or changed — do NOT report any element there as added, removed, moved, or changed, and do NOT explain the vertical offset as "a new section was inserted and pushed the rest down": the offset is the height change, and it happened ABOVE y=${Math.round(shiftIdentity.topN)}.`
    : null;
  groundingText += shiftNote || (tailIdentity
    ? `${prefix}NOTE: the page HEIGHT changed between versions (baseline ${bMeta.height}px vs new ${nMeta.height}px), so rows below y=${Math.round(tailZone.top)} (0-1000, Image 2 frame) could not be compared top-aligned. HOWEVER, mechanical verification PROVED the bottom ${tailIdentity.kPx}px of both pages unchanged when aligned at the page bottom (pixel-level comparison, no difference beyond trivial noise): nothing was added, removed, or changed near the bottom of the page — the height difference comes from content higher up (typically a rotating grid serving more or fewer rows). Do NOT report bottom-of-page content (footer links, footer sections) as added, removed, or missing.`
    : `${prefix}NOTE: the page HEIGHT changed between versions, so rows below y=${Math.round(tailZone.top)} (0-1000, Image 2 frame) could NOT be pixel-compared — content may have been added or removed near the bottom of the page; inspect that area yourself${hasBottomPair ? ' using the PAGE-BOTTOM crop pair (both pages aligned at the page bottom — content present at the same distance from the page END in both crops is unchanged, merely shifted by the height difference)' : ''}.`);
}

// Base64 of context images lives only in these locals — never returned on json.
const baselineBase64 = a.out.toString('base64');
const newBase64 = b.out.toString('base64');

const buildGeminiParts = (extraFeedback) => {
  const parts = [
    { text: GEMINI_PROMPT + groundingText + (extraFeedback ? `\n\n## VERIFICATION FEEDBACK\n${extraFeedback}` : '') },
    { inline_data: { mime_type: "image/png", data: baselineBase64 } },
    { inline_data: { mime_type: "image/png", data: newBase64 } }
  ];
  cropPairs.forEach((cp, i) => {
    parts.push({ text: `Close-up crop pair ${i + 1} (${cp.label}) — BASELINE crop:` });
    parts.push({ inline_data: { mime_type: "image/png", data: cp.baseB64 } });
    parts.push({ text: `Close-up crop pair ${i + 1} — NEW VERSION crop:` });
    parts.push({ inline_data: { mime_type: "image/png", data: cp.newB64 } });
  });
  return parts;
};

const callGemini = async (extraFeedback) => {
  const response = await this.helpers.httpRequest({
    method: 'POST',
    url: PRIMARY_URL,
    body: {
      contents: [{ parts: buildGeminiParts(extraFeedback) }],
      generationConfig: { response_mime_type: "application/json", temperature: 0.0, response_schema: RESPONSE_SCHEMA }
    },
    json: true,
    timeout: 120000
  });
  const parsed = JSON.parse(response.candidates[0].content.parts[0].text);
  return { parsed, modelVersion: response.modelVersion || 'gemini-pro-latest' };
};

const FALLBACK_JSON_RULE = '\n\nCRITICAL: Return ONLY this exact JSON structure (no markdown, no other fields): {"thought_process": "...", "status": "PASS" or "FAIL", "reason": "...", "evidence": "...", "present_in_baseline": true/false, "present_in_new": true/false, "defect_region": 0, "box": {"ymin": 0, "xmin": 0, "ymax": 0, "xmax": 0}} — defect_region is the NUMBER of the pixel-diff region (from the numbered region list) containing the root defect (0 if PASS or no list applies); box in 0-1000 scale relative to Image 2 (New Version).';

const callFallback = async (messages, timeoutMs) => {
  if (!OR_KEY) throw new Error('OPENROUTER_API_KEY not set');
  const response = await this.helpers.httpRequest({
    method: 'POST',
    url: OR_URL,
    headers: { Authorization: `Bearer ${OR_KEY}` },
    body: {
      model: FALLBACK_MODEL,
      temperature: 0.0,
      // Load-bearing for DeepSeek: reasoning defaults ON at high effort, where
      // latency blows past this node's timeouts on photo-dense pages
      // (3x240s timeouts on the home page in the 2026-09-19 benchmark).
      reasoning: { enabled: false },
      messages,
      stream: false,
      response_format: { type: 'json_object' },
      provider: FALLBACK_PROVIDER
    },
    json: true,
    timeout: timeoutMs || 90000
  });
  return { content: JSON.parse(response.choices[0].message.content), served: response.model || FALLBACK_MODEL };
};

const callFallbackComparison = async () => {
  const userParts = [
    { type: 'text', text: 'Image 1 (Baseline):' },
    { type: 'image_url', image_url: { url: `data:image/png;base64,${baselineBase64}` } },
    { type: 'text', text: 'Image 2 (New Version):' },
    { type: 'image_url', image_url: { url: `data:image/png;base64,${newBase64}` } }
  ];
  cropPairs.forEach((cp, i) => {
    userParts.push({ type: 'text', text: `Close-up crop pair ${i + 1} (${cp.label}) — BASELINE crop:` });
    userParts.push({ type: 'image_url', image_url: { url: `data:image/png;base64,${cp.baseB64}` } });
    userParts.push({ type: 'text', text: `Close-up crop pair ${i + 1} — NEW VERSION crop:` });
    userParts.push({ type: 'image_url', image_url: { url: `data:image/png;base64,${cp.newB64}` } });
  });
  const r = await callFallback([
    { role: 'system', content: GEMINI_PROMPT + groundingText + FALLBACK_JSON_RULE },
    { role: 'user', content: userParts }
  ]);
  return { parsed: r.content, modelVersion: r.served };
};

// Existence probes: single-image questions sidestep the cross-image attention
// bias that produces "missing element" confabulations; benchmarked 100%
// reliable on all three models. v3 (2026-07-29): probes are FAIL-CLOSED
// (fallback prober x2 -> Gemini prober -> claim treated as unverifiable) and a
// claim that survives the local probe faces a FULL-PAGE sweep: "X is missing"
// is a statement about the whole page — if X is visible anywhere (it moved,
// the grid reordered), the claim is false. The 12:31Z run shipped two FAILs
// whose "missing" elements sat untouched at the top of both pages, where a
// diff-region-anchored probe could never see them; and one of them shipped
// unverified because a single Qwen error used to fail OPEN.
const PROBE_SCHEMA = {
  type: "OBJECT",
  required: ["claimed_element_visible", "what_is_there"],
  properties: {
    claimed_element_visible: { type: "BOOLEAN" },
    what_is_there: { type: "STRING" }
  }
};
const PROBE_SYSTEM = 'You are a precise visual inspector. Answer ONLY with JSON: {"claimed_element_visible": true or false, "what_is_there": "..."}';
// ---------------------------------------------------------------------------
// Near-match refutation (2026-08-16). The strict rule below is what keeps a
// generic lookalike from vetoing a true removal — but it also makes a claim
// UNFALSIFIABLE when the model misquotes the element it invented. On the
// mobile 2026-08-15/16 FAILs the claim quoted a five-word version of a
// six-word section heading, dropping one word out of the middle of it.
// Replayed offline, every prober READ that heading in the baseline sweep
// window and still answered false — qwen: "similar but not identical to the
// claimed element", gemini: "differs from the claimed text" — so all 31
// windows came back negative and the trail shipped "element not found — claim
// verified". One dropped word turned the refutation into a confirmation, and
// it was sitting in what_is_there the whole time.
// Compare the claim's quoted element against what the observer says it reads,
// symmetrically: Dice >= 0.90 over >= 3 tokens. That is tight enough
// that a longer neighbour ("Some Label" vs "Some Label Generator",
// Dice 0.86 — the SEO-link shape alignfix warned about) does NOT refute, while
// a one-word paraphrase of a six-word heading (Dice 0.92) does.
// ---------------------------------------------------------------------------
const NEARMATCH_ENABLE = true; // kill-switch
const NEARMATCH_DICE = 0.90, NEARMATCH_MIN_TOKENS = 3;
const quotedPhrases = (s) => {
  const str = String(s || ''), out = [], re = /['"‘’“”]([^'"‘’“”]{8,120})['"‘’“”]/g;
  let m;
  while ((m = re.exec(str))) out.push({ text: m[1], before: str.slice(Math.max(0, m.index - 60), m.index) });
  return out;
};
// Two things a prober writes that must NEVER read as confirmation: an ECHO of
// the claim ("...is not '<the claimed heading>'" — the observed
// wording is the claim's own, so it carries no observation), and a phrase
// under a negative ("there is no 'X' here"). The first is excluded by
// requiring near-but-not-EQUAL; the second by this cue scan of the run-up to
// the quote. Both directions matter — the probers echoed the claim verbatim in
// the offline replay of the 2026-08-15 sweep.
const NEG_RE = /\b(no|not|n't|never|without|absent|missing|lacks?|lacking|instead of|rather than|unlike|differs? from|different from|claim|claimed)\b[^.;!?]*$/i;
const NEG_ANY_RE = /\b(no|not|n't|none|nothing|never|without|absent|missing|lacks?|lacking|instead|unlike|rather|differs?|claim|claimed)\b/i;
const phraseTokens = (s) => new Set(String(s || '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim().split(' ').filter(Boolean));
const phraseKey = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
// Asked to quote the exact wording, both probers answer with the bare label and
// no quotation marks at all — what_is_there comes back as literally the
// heading itself, unquoted (measured on qwen AND gemini, 2026-08-16).
// A quoted-span-only matcher reads that as "the observer quoted nothing" and
// the misquote loophole stays open, so a short, cue-free answer counts as the
// phrase itself. Anything longer is prose and must quote to be heard.
const observedPhrases = (s) => {
  const str = String(s || '').trim();
  const q = quotedPhrases(str);
  if (q.length) return q;
  // Cue test here is the whole string, not the run-up: an unquoted answer has
  // no "before" to inspect, so any hedge anywhere in it disqualifies it.
  return (str.length >= 8 && str.length <= 120 && !NEG_ANY_RE.test(str)) ? [{ text: str, before: '' }] : [];
};
// -> {claim, seen} when the observer quoted a near-identical string, else null
const nearMatch = (reason, observed) => {
  if (!NEARMATCH_ENABLE) return null;
  const seen = observedPhrases(observed).filter(o => !NEG_RE.test(o.before));
  if (!seen.length) return null;
  for (const c of quotedPhrases(reason)) {
    const ct = phraseTokens(c.text), ck = phraseKey(c.text);
    if (ct.size < NEARMATCH_MIN_TOKENS) continue;
    for (const o of seen) {
      const ot = phraseTokens(o.text);
      if (ot.size < NEARMATCH_MIN_TOKENS || phraseKey(o.text) === ck) continue; // equal = an echo, not an observation
      let inter = 0;
      for (const t of ct) if (ot.has(t)) inter++;
      if ((2 * inter) / (ct.size + ot.size) >= NEARMATCH_DICE) return { claim: c.text, seen: o.text };
    }
  }
  return null;
};
const nearNote = (n) => n ? ` — NEAR-MATCH: the claim quotes "${n.claim}" but the verifier reads "${n.seen}" here; same element, different wording` : '';
// A probe answer counts as "the element is present here" when the prober says
// so OR when it quoted the element back at us under slightly different wording.
const probeSaysPresent = (reason, r) => (r && r.claimed_element_visible === true)
  ? null // present, verbatim: no near-match record to report
  : nearMatch(reason, r && r.what_is_there);
const probeQuestion = (target, reason, isSweep) => {
  const where = isSweep ? 'ONE SECTION of' : 'a crop around the reported location of';
  const strict = ' Answer claimed_element_visible=true ONLY if the SPECIFIC element described is clearly visible here — a similar, generic, or partially matching element does NOT count. Whatever you answer, ALWAYS quote in "what_is_there" the exact wording of any heading, label, or button you can read here that resembles the claimed element.';
  return target === 'baseline'
    ? `A QA system reported this defect about a screenshot: "${reason}". Below is ${where} the PREVIOUS (baseline) full-page screenshot. Is the element that was claimed to be NEWLY ADDED actually ALREADY VISIBLE here?${strict} If the claim is not about an added element, answer claimed_element_visible=false.`
    : `A QA system reported this defect about a screenshot: "${reason}". Below is ${where} the CURRENT (new) full-page screenshot. Is the element that was claimed missing/removed actually VISIBLE here?${strict} If the claim is not about a missing element, answer claimed_element_visible=false.`;
};
const callGeminiProbe = async (question, b64) => {
  const response = await this.helpers.httpRequest({
    method: 'POST',
    url: PRIMARY_URL,
    body: {
      contents: [{ parts: [{ text: question }, { inline_data: { mime_type: "image/png", data: b64 } }] }],
      generationConfig: { response_mime_type: "application/json", temperature: 0.0, response_schema: PROBE_SCHEMA }
    },
    json: true,
    timeout: 60000
  });
  return JSON.parse(response.candidates[0].content.parts[0].text);
};
const callFallbackProbe = async (question, b64) => {
  const q = await callFallback([
    { role: 'system', content: PROBE_SYSTEM },
    { role: 'user', content: [
      { type: 'text', text: question },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } }
    ] }
  ], 45000);
  return q.content;
};
// rPx = pixel rect {left,top,w,h} on the TARGET image. Throws err.probeUnavailable
// only when every prober (fallback x2, Gemini) is unreachable.
const probeOnRect = async (reason, rPx, target, isSweep) => {
  const isBase = target === 'baseline';
  const buf = await extractCrop(isBase ? baselinePath : newPath, isBase ? bMeta : nMeta, rPx);
  const b64 = buf.toString('base64');
  const question = probeQuestion(target, reason, isSweep);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await callFallbackProbe(question, b64);
      const near = probeSaysPresent(reason, r);
      return { visible: r.claimed_element_visible === true || !!near, near, what: String(r.what_is_there || ''), via: 'deepseek', b64, question };
    } catch (e) { await new Promise(res => setTimeout(res, 2000)); }
  }
  try {
    const g = await callGeminiProbe(question, b64);
    const near = probeSaysPresent(reason, g);
    return { visible: g.claimed_element_visible === true || !!near, near, what: String(g.what_is_there || ''), via: 'gemini', b64, question };
  } catch (e) {
    const err = new Error(`probe unavailable: ${e.message}`);
    err.probeUnavailable = true;
    throw err;
  }
};
// Full-page sweep for the claimed element. Windows fully inside the already
// probed local rect are skipped; the sweep stops at the first CONFIRMED hit.
// A fallback-prober hit is cross-checked by the Gemini prober (two independent
// models must agree before a FAIL is vetoed); if the confirmer is unreachable
// the fallback hit stands — the owner's contract prefers a degraded-generic
// FAIL over a fabricated story.
// SWEEP_MAX_WIN 28 -> 35 (2026-08-01): 28 windows cover only ~55.7k px, but
// real pages reach 67.6k — the unscanned bottom is the FOOTER, where this
// site's additions/moves concentrate, and the trail claimed "not found" over
// rows never scanned. 35 windows cover ~69.5k px.
// Claim-first ordering + honest coverage (2026-08-05): windows used to run
// top-down, so the 420s deadline always sacrificed the page BOTTOM — on the
// footer-links incident the ONE window containing the claimed element was
// among the 12 never probed, yet "element not found" shipped (12 unavailable
// was under the old >half threshold). Windows now run nearest-first to the
// claim's EXPECTED location (the claim rect shifted by the page-height delta:
// content below a shrink point sits |delta|px higher in the new capture),
// errored windows get ONE retry round, and `unavailable` reports exactly the
// windows never successfully probed — the CALLER refuses to call a partial
// sweep "verified".
const SWEEP_WIN_PX = 2200, SWEEP_STRIDE_PX = 1980, SWEEP_MAX_WIN = 35, SWEEP_CONC = 6;
const sweepForElement = async (reason, target, excludePxRect) => {
  const meta = target === 'baseline' ? bMeta : nMeta;
  const wins = [];
  // coveredToPx tracks GENERATION coverage (exclude-skipped windows count —
  // the local probe already covered those rows). If SWEEP_MAX_WIN truncates
  // generation before the page bottom, the remainder has NO windows at all and
  // would be invisible to the unavailable accounting — report it so the caller
  // fail-closes instead of claiming full coverage (review major, 2026-08-05).
  let coveredToPx = 0;
  for (let top = 0; top + 200 <= meta.height && wins.length < SWEEP_MAX_WIN; top += SWEEP_STRIDE_PX) {
    const h = Math.min(SWEEP_WIN_PX, meta.height - top);
    coveredToPx = top + h;
    if (excludePxRect && top >= excludePxRect.top - 100 && top + h <= excludePxRect.top + excludePxRect.h + 100) continue;
    wins.push({ left: 0, top, w: meta.width, h });
  }
  const uncoveredPx = Math.max(0, meta.height - coveredToPx);
  if (excludePxRect) {
    const shift = (bMeta.height - nMeta.height) * (target === 'new' ? -1 : 1);
    const expectYc = excludePxRect.top + excludePxRect.h / 2 + shift;
    wins.sort((a, z) => Math.abs(a.top + a.h / 2 - expectYc) - Math.abs(z.top + z.h / 2 - expectYc) || a.top - z.top);
  }
  let unavailable = 0, hit = null;
  let queue = wins;
  for (let round = 0; round < 2 && !hit && queue.length; round++) {
    const failedRound = [];
    let deadlineBroke = false;
    for (let i = 0; i < queue.length && !hit; i += SWEEP_CONC) {
      // Runner-kill guard: a fallback-degraded sweep (2x45s timeouts per window) can
      // stack past the 600s task kill. Fail toward "unverifiable" (the caller's
      // fail-closed veto) instead — never toward the kill.
      if (Date.now() - T0 > 420000) { unavailable = queue.length - i + failedRound.length; deadlineBroke = true; break; }
      const batch = queue.slice(i, i + SWEEP_CONC);
      const results = await Promise.all(batch.map(async (w) => {
        try { return { w, r: await probeOnRect(reason, w, target, true) }; }
        catch (e) { failedRound.push(w); return null; }
      }));
      for (const x of results) {
        if (!x || !x.r.visible) continue;
        // Sequential confirmations are deadline-gated too: several slow-but-
        // successful Gemini answers used to be able to stack ~360s past the
        // 420s line (review, 2026-08-05). Past the deadline the confirmer is
        // treated as down — the fallback hit stands, same as the catch below.
        if (x.r.via !== 'gemini' && Date.now() - T0 <= 420000) {
          try {
            const g = await callGeminiProbe(x.r.question, x.r.b64);
            // The confirmer is held to the same rule as the prober: quoting the
            // element back under different wording IS agreement that it is here.
            const gNear = g.claimed_element_visible === true ? null : nearMatch(reason, g.what_is_there);
            if (g.claimed_element_visible !== true && !gNear) continue; // unconfirmed -> not a hit
            if (gNear && !x.r.near) x.r.near = gNear; // the trail should name whichever model near-matched
          } catch (e) { /* confirmer down: the fallback hit stands */ }
        }
        hit = { yPx: Math.round(x.w.top + x.w.h / 2), what: x.r.what, near: x.r.near };
        break;
      }
    }
    if (deadlineBroke) break;
    queue = failedRound; // transient probe errors get exactly one more attempt
    unavailable = queue.length;
  }
  return { hit, scanned: wins.length, unavailable, uncoveredPx };
};
// Local probe window: box-informed (the box pulls the crop toward the CLAIMED
// element) and capped so a giant named region cannot blind the probe with a
// uselessly downscaled crop. Normalized to the Image-2 frame.
const localProbeRectN = (p, regionNo) => {
  const region = regionNo ? clustersForPrompt[regionNo - 1] : (clusterForBox(p.box) || clusters[0]);
  // A degenerate all-zero box is "no location", not y=0 — without this it
  // pulled the probe window to the page TOP whenever the model omitted a box
  // (review major, 2026-08-01; mirrors the degeneracy test used by the guards).
  const b0 = normBox(p.box);
  const bxc = (b0 && (b0.ymax - b0.ymin > 0 || b0.xmax - b0.xmin > 0)) ? b0 : null;
  let regionN = {
    top: bxc ? Math.min(bxc.ymin, region.top) : region.top,
    left: bxc ? Math.min(bxc.xmin, region.left) : region.left,
    width: Math.max(region.width, 40), height: Math.max(region.height, 20)
  };
  // Height-shift compensation (2026-08-05): when the claim resolves to the
  // synthetic tail cluster and the page height changed, the claimed content's
  // position in the probed frame is up to |delta|px ABOVE the claim coords —
  // the incident's four footer links ended 1px above the probe window and the
  // probe honestly reported "not visible". Extend the window upward by the
  // delta so height-shifted content stays inside the crop; the cap below keeps
  // the window's TOP (where shifted content lands) and the page bottom it cuts
  // is covered by the sweep (windows no longer fully inside the moved rect).
  if (region.tail && heightsDiffer) {
    const deltaN = (Math.abs(bMeta.height - nMeta.height) / nMeta.height) * 1000;
    const extTop = Math.max(0, regionN.top - deltaN);
    regionN.height += regionN.top - extTop;
    regionN.top = extTop;
  }
  const CAP_N = (2200 / nMeta.height) * 1000;
  if (regionN.height > CAP_N) {
    regionN = { top: regionN.top, left: 0, width: 1000, height: CAP_N };
  }
  return {
    top: Math.max(0, regionN.top - 15), left: Math.max(0, regionN.left - 15),
    width: Math.min(1000, regionN.width + 30), height: Math.min(1000, regionN.height + 30)
  };
};
// Clamped to the image so the rect (and the y-range printed in the trail) is
// what the probe actually sees — the incident trail printed "y≈59091-62804px"
// on a 61875px image (2026-08-05).
const nRectToPx = (rectN, meta) => {
  const left = Math.max(0, Math.round(rectN.left / 1000 * meta.width));
  const top = Math.max(0, Math.round(rectN.top / 1000 * meta.height));
  return {
    left, top,
    w: Math.max(1, Math.min(Math.round(rectN.width / 1000 * meta.width), meta.width - left)),
    h: Math.max(1, Math.min(Math.round(rectN.height / 1000 * meta.height), meta.height - top))
  };
};

// --- Guards ---------------------------------------------------------------
const MISSING_RE = /\b(missing|removed|disappear\w*|gone|no longer (?:present|visible|shown)|absent)\b/i;
const ADDED_RE = /\b((?:has|have|had|was|were) been added|(?:has|have|was|were) added|newly added|added to (?:the|a|an)\b|now (?:appears|present|visible|shown))\b/i;

const normBox = (raw) => {
  if (Array.isArray(raw) && raw.length === 4) return { ymin: raw[0], xmin: raw[1], ymax: raw[2], xmax: raw[3] };
  if (raw && typeof raw === 'object' && raw.ymin !== undefined) return raw;
  return null;
};
const boxIntersectsClusters = (rawBox, cls) => {
  const bx = normBox(rawBox);
  if (!bx || (bx.ymax - bx.ymin <= 0 && bx.xmax - bx.xmin <= 0)) return false;
  // Tolerance in 0-1000 units. A flat 30 was ±300 PIXELS on a 10,000px-tall
  // page — no discriminating power (2026-07-28 incident). Cap the vertical
  // tolerance at ~120px-equivalent; keep a floor for very tall pages so a
  // slightly sloppy-but-honest model box still passes.
  const TOLX = 30;
  const TOLY = Math.min(30, Math.max(6, (120 / nMeta.height) * 1000));
  return cls.some(c => {
    const cy0 = c.top - TOLY, cy1 = c.top + c.height + TOLY;
    const cx0 = c.left - TOLX, cx1 = c.left + c.width + TOLX;
    return bx.ymin < cy1 && bx.ymax > cy0 && bx.xmin < cx1 && bx.xmax > cx0;
  });
};
const clusterForBox = (rawBox) => {
  const bx = normBox(rawBox);
  if (!bx || !clusters || !clusters.length) return null;
  let best = clusters[0], bestD = Infinity;
  const bcy = (bx.ymin + bx.ymax) / 2, bcx = (bx.xmin + bx.xmax) / 2;
  for (const c of clusters) {
    const d = Math.abs(c.top + c.height / 2 - bcy) + Math.abs(c.left + c.width / 2 - bcx);
    if (d < bestD) { bestD = d; best = c; }
  }
  return best;
};

// --- Main flow --------------------------------------------------------------
let parsed = null, modelVersion = null, aiProvider = 'gemini', reasonSource = 'model';
let primaryError = null;

try {
  ({ parsed, modelVersion } = await callGemini(null));
} catch (err) {
  primaryError = err;
  // Non-429 4xx errors are deterministic (bad payload, safety block) — a
  // sleep+retry of the identical request just wastes 100+s per failing page.
  const code = err.httpCode || err.statusCode || 0;
  const retryable = code === 429 || !(code >= 400 && code < 500);
  console.warn(`AVC: primary Gemini failed for ${slug} (${code || err.message}); ${retryable ? 'retrying once' : 'not retryable, going to fallback'}`);
  let retryErrMsg = 'skipped (non-retryable 4xx)';
  if (retryable) {
    await new Promise(r => setTimeout(r, 10000));
    try {
      ({ parsed, modelVersion } = await callGemini(null));
    } catch (err2) { retryErrMsg = err2.message; }
  }
  if (!parsed) {
    console.warn(`AVC: Gemini unavailable for ${slug}; trying DeepSeek fallback`);
    try {
      ({ parsed, modelVersion } = await callFallbackComparison());
      aiProvider = 'deepseek-fallback';
    } catch (fbErr) {
      return [{
        json: {
          error: { message: `Primary: ${primaryError.message}; Retry: ${retryErrMsg}; DeepSeek fallback: ${fbErr.message}` },
          resized_width: resizedWidth,
          mime_type: "image/png"
        }
      }];
    }
  }
}

// Guard FAIL reasons against the pixel-diff ground truth. PASS keeps full AI
// authority (that is the noise filtering this node exists for) — the guards
// only police what a FAIL *claims*, which is where the confabulations lived.
const validRegionNo = (p) => (p && Number.isInteger(p.defect_region) && p.defect_region >= 1 && p.defect_region <= clustersForPrompt.length) ? p.defect_region : 0;

if (parsed && parsed.status === 'FAIL' && clusters && clusters.length) {
  const applyGuards = async (p) => {
    // Insertion-seam backstop (2026-08-01): when row alignment found exactly
    // ONE inserted band and the model reports ADDED content but names no
    // region (the reflow-seam escape hatch: correct reason, location
    // signal pointing ~1000px below the real link into the tail zone), pin
    // the claim to the seam region deterministically instead of vetoing an
    // honest answer. Runs for the initial answer AND the corrective retry.
    if (!validRegionNo(p) && insertSeamNos.length === 1 && (ADDED_RE.test(p.reason || '') || p.present_in_baseline === false)) {
      const seam = clustersForPrompt[insertSeamNos[0] - 1];
      const bx0 = normBox(p.box);
      const degenerate = !bx0 || (bx0.ymax - bx0.ymin <= 0 && bx0.xmax - bx0.xmin <= 0);
      // The tail-box redirect only applies when the seam itself sits near the
      // tail: a genuine bottom-append claim must never be re-pinned to an
      // unrelated seam higher up the page (review blocker, 2026-08-01).
      const seamNearTail = !!(tailZone && seam.top + seam.height >= tailZone.top - 60);
      const near = degenerate || (bx0.ymin < seam.top + seam.height + 60 && bx0.ymax > seam.top - 60) || (seamNearTail && !!(tailZone && bx0.ymax > tailZone.top));
      if (near) {
        p.defect_region = insertSeamNos[0];
        trail.push(`insertion-seam backstop: added-content claim with no named region pinned to seam Region ${insertSeamNos[0]}`);
      }
    }
    // Location contract (2026-07-29 incident): the model's raw box coordinates
    // are unreliable — correct "logo missing" reason arrived with a box over
    // mid-page blobs, so the report highlighted 3 irrelevant areas. A FAIL must
    // commit to one of OUR numbered pixel-diff regions; the box alone is only
    // accepted for the uncompared tail zone (no numbered region exists there).
    const regionNo = validRegionNo(p);
    if (!regionNo) {
      const bx = normBox(p.box);
      const inTail = !!(tailZone && bx && bx.ymax > tailZone.top);
      if (!inTail && clustersForPrompt.length) return 'location: the defect was not attributed to any numbered pixel-diff region — set defect_region to the number of the listed region that contains it (or PASS if none does)';
      if (!inTail && !boxIntersectsClusters(p.box, clusters)) return 'geometry: the reported box contains no changed pixels — the difference you described is not where pixels actually changed';
    }
    // Bottom-identity veto (2026-08-05): the tail zone is exempt from both the
    // region contract and the geometry veto, so tail claims used to rest
    // entirely on probes — and the probe window missed content the height
    // change had shifted upward while the deadline-cut sweep failed open.
    // When the bottom-aligned comparison PROVED the bottom unchanged, a FAIL
    // located inside that zone is mechanically false — vetoed before a
    // probe/sweep spends 400s on it. Applies to every claim type: pixel
    // identity rules out styling and layout changes too, not just add/remove.
    // Gated on regionNo === 0: defect_region is the AUTHORITATIVE location
    // signal (regionfix contract) and raw box coords are garbage — a claim
    // pinned to a numbered region (including a seam pinned by the backstop
    // above) must fall through to the probe machinery, not die on its box
    // (review major, 2026-08-05). NOTE for degraded modes (deepseek-fallback or
    // T0 past the retry gate): this veto still lands on the generic
    // pixeldiff-fallback FAIL — a deliberately conservative rendering of a
    // mechanically-disproven claim, kept for owner review rather than PASS.
    if (tailIdentity && !regionNo) {
      const bxt = normBox(p.box);
      const kN = (tailIdentity.kPx / nMeta.height) * 1000;
      if (bxt && (bxt.ymax - bxt.ymin > 0 || bxt.xmax - bxt.xmin > 0) && bxt.ymin >= 1000 - kN + 2) {
        trail.push('bottom-identity veto: FAIL claim located inside the mechanically-proven unchanged bottom zone');
        return `bottom-identity: the bottom ${tailIdentity.kPx}px of both pages are unchanged when aligned at the page bottom (pixel-level comparison, no difference beyond trivial noise) — nothing was added, removed, or changed there; the page height difference comes from content higher up (e.g. a rotating grid serving fewer rows). Re-examine the images or PASS`;
      }
    }
    // Displacement veto (2026-08-16). Where the tail veto proves a strip at the
    // page bottom, this one proves everything below the height change — the
    // 21,207px the displacement confabulation lived in. It is NOT gated
    // on regionNo === 0 (unlike the tail veto, which defers to the region
    // contract because a raw box is a weak location signal): here the REGION
    // ITSELF is the thing proven unchanged, which is strictly stronger evidence
    // than any probe could return. Runs before the probe block so a claim about
    // provably-identical pixels never spends 400s of sweep on being disproven —
    // and can never be "verified" by a prober that misread the claim's wording.
    if (shiftIdentity) {
      const bxd = normBox(p.box);
      const boxInProven = !!bxd && (bxd.ymax - bxd.ymin > 0 || bxd.xmax - bxd.xmin > 0) && bxd.ymin >= shiftIdentity.topN + 2;
      if (shiftProvenRegionNos.includes(regionNo) || (!regionNo && boxInProven)) {
        trail.push(`displacement veto: FAIL claim located inside the mechanically-proven displaced zone (bottom ${shiftIdentity.px}px, identical in both pages when bottom-aligned)`);
        return `displacement: the area you reported is inside the bottom ${shiftIdentity.px}px of the page, which a bottom-aligned pixel comparison PROVED identical in both versions — that content is the same, it only sits ${shiftIdentity.deltaPx}px ${shiftIdentity.dirWord} because the page above it got ${shiftIdentity.causeWord}. Nothing there was added, removed, or changed. Look above y=${Math.round(shiftIdentity.topN)} (0-1000, Image 2 frame) or PASS`;
      }
    }
    const missingClaim = MISSING_RE.test(p.reason || '') || p.present_in_new === false;
    const addedClaim = ADDED_RE.test(p.reason || '') || p.present_in_baseline === false;
    if (missingClaim || addedClaim) {
      // Claim-location consistency (free, runs before any probe): a REAL
      // removal/addition changes pixels AT the claimed location — everything
      // outside the diff clusters is pixel-identical, so nothing can have
      // appeared or vanished there. A missing/added claim whose own box points
      // into the identical zone is a confabulation (2026-07-29 "avatar
      // carousel missing" FP: carousel present in both, box at the untouched
      // page top while the only diff was a reshuffled gallery below).
      const bxc = normBox(p.box);
      if (bxc && (bxc.ymax - bxc.ymin > 0 || bxc.xmax - bxc.xmin > 0) && !boxIntersectsClusters(p.box, clusters)) {
        return 'location: you claim content was added or removed at a spot where the two screenshots are pixel-identical — nothing changed there; re-examine the images (the difference may be reshuffled/rotated grid content elsewhere) or PASS';
      }
      // Existence verification, FAIL-CLOSED (2026-07-29): a removal/addition
      // claim ships ONLY after machine verification. Local probe at the claim
      // location first; if the element is not there, sweep the ENTIRE page —
      // a confabulated claim about an element that actually lives in the
      // pixel-identical zone can never be refuted by a diff-anchored probe
      // (12:31Z: "avatar list missing" while the avatar list sat untouched at
      // the top of the page). If no prober is reachable the claim is vetoed as
      // unverifiable — never accepted on trust (the old fail-open shipped
      // "Generate now card missing" on a single Qwen error).
      try {
        const rectN = localProbeRectN(p, regionNo);
        for (const [claim, target] of [[missingClaim, 'new'], [addedClaim, 'baseline']]) {
          if (!claim) continue;
          const meta = target === 'baseline' ? bMeta : nMeta;
          const localPx = nRectToPx(rectN, meta);
          const local = await probeOnRect(p.reason, localPx, target, false);
          // A probe HIT vetoes a FAIL, so it needs two-model agreement: a loose
          // fallback-prober "something card-like is visible" answer must not
          // overturn a true removal (caught with the then-Qwen prober by the
          // synthetic truth set on 2026-07-29).
          let localHit = local.visible;
          if (localHit && local.via !== 'gemini') {
            try {
              const g = await callGeminiProbe(local.question, local.b64);
              if (g.claimed_element_visible !== true && !nearMatch(p.reason, g.what_is_there)) {
                localHit = false;
                trail.push(`local ${target} probe (y≈${localPx.top}-${localPx.top + localPx.h}px): ${local.via} hit NOT confirmed by gemini — treating as not visible`);
              }
            } catch (e) { /* confirmer down: the fallback hit stands */ }
          }
          if (localHit) {
            trail.push(`local ${target} probe (y≈${localPx.top}-${localPx.top + localPx.h}px, via ${local.via}): element VISIBLE at claim location (confirmed)${nearNote(local.near)}`);
            return target === 'new'
              ? `probe: the element you claimed missing IS visible in the new screenshot (verifier saw: "${local.what.slice(0, 160)}")`
              : `probe: the element you claimed was newly added ALREADY EXISTS in the baseline screenshot (verifier saw: "${local.what.slice(0, 160)}")`;
          }
          if (!local.visible) trail.push(`local ${target} probe (y≈${localPx.top}-${localPx.top + localPx.h}px, via ${local.via}): not visible at claim location`);
          // Seam-attributed ADDED claims skip the baseline existence SWEEP:
          // the seam is machine proof that these rows are new, and an added
          // footer/keyword link legitimately repeats anchor text used
          // elsewhere on these SEO pages — "exists anywhere in baseline" is
          // not a refutation of an insertion (review, 2026-08-01). The local
          // probe above still ran and can still veto.
          if (target === 'baseline' && regionNo && realClusters[regionNo - 1] && realClusters[regionNo - 1].insert) {
            trail.push('baseline sweep skipped: claim is pinned to a mechanically-proven insertion seam');
            continue;
          }
          const sw = await sweepForElement(p.reason, target, localPx);
          if (sw.hit) {
            trail.push(`full-page ${target} sweep (${sw.scanned} windows): element FOUND at y≈${sw.hit.yPx}px — "${sw.hit.what.slice(0, 120)}"${nearNote(sw.hit.near)}`);
            return target === 'new'
              ? `probe: the element you claimed missing IS present elsewhere in the new screenshot (around y=${sw.hit.yPx}px of ${meta.height}px; verifier saw: "${sw.hit.what.slice(0, 160)}") — content that moved or was reordered is NOT missing`
              : `probe: the element you claimed was newly added ALREADY EXISTS elsewhere in the baseline screenshot (around y=${sw.hit.yPx}px of ${meta.height}px; verifier saw: "${sw.hit.what.slice(0, 160)}") — content that moved or was reordered is NOT new`;
          }
          // Partial coverage is NOT verification (2026-08-05): the old >half
          // threshold shipped "element not found — claim verified" while the
          // 12 windows covering the page bottom — and the claimed element —
          // were never probed. Any window never successfully probed (or page
          // rows beyond the window-generation cap) means the element may sit
          // exactly there; route to the fail-closed verification-unavailable
          // veto instead.
          if (sw.unavailable > 0 || sw.uncoveredPx > 0) {
            const gap = sw.uncoveredPx > 0 ? `; bottom ${sw.uncoveredPx}px beyond window coverage` : '';
            trail.push(`full-page ${target} sweep INCOMPLETE (${sw.scanned - sw.unavailable}/${sw.scanned} windows probed${gap}): element not found in probed windows — coverage too partial to verify the claim`);
            const e = new Error(`sweep incomplete: ${sw.scanned - sw.unavailable}/${sw.scanned} windows probed${gap}`);
            e.probeUnavailable = true;
            throw e;
          }
          if (sw.scanned === 0) trail.push(`full-page ${target} sweep skipped: the local probe window already covers the page — claim verified by the local probe`);
          else trail.push(`full-page ${target} sweep (${sw.scanned} windows, full coverage): element not found — claim verified`);
        }
      } catch (pe) {
        trail.push(`verification unavailable (${String(pe.message).slice(0, 120)}) — claim NOT accepted on trust`);
        console.warn(`AVC: verification unavailable for ${slug}: ${pe.message}`);
        return 'verification-unavailable: the removal/addition claim could not be machine-verified (probe service unreachable) — report only what the close-up crops directly show, or PASS';
      }
    }
    return null;
  };

  let veto = await applyGuards(parsed);
  // Bound the guard chain: skip the corrective retry when the accumulated API
  // time is already large, so the task can never approach the 600s runner kill.
  if (veto && aiProvider === 'gemini' && (Date.now() - T0) < 300000) {
    console.warn(`AVC: veto for ${slug} -> corrective retry (${veto.slice(0, 80)})`);
    try {
      const retry = await callGemini(`Your previous answer reported: "${parsed.reason}". That claim failed automated verification (${veto}). Re-examine the images, focusing STRICTLY on the pixel-diff regions listed above, the uncompared bottom area (if one is noted), and the close-up crops, and report the actual difference (or PASS if it is only noise).`);
      // Re-run the FULL guard set on the retry (a repeated fabrication with a
      // plausible box must not slip through on geometry alone).
      const retryVeto = retry.parsed.status === 'PASS' ? null : await applyGuards(retry.parsed);
      if (!retryVeto) {
        parsed = retry.parsed; modelVersion = retry.modelVersion; reasonSource = 'model-retry'; veto = null;
        trail.push(`corrective retry accepted: ${retry.parsed.status}${retry.parsed.status === 'FAIL' ? ` — "${String(retry.parsed.reason || '').slice(0, 100)}"` : ''}`);
      } else {
        trail.push(`corrective retry also vetoed (${String(retryVeto).slice(0, 80)})`);
      }
      // Carry the API error into the report: successful executions are not saved
      // (saveDataSuccessExecution: none), so console.warn alone is unrecoverable by
      // the time anyone reads the report, and a retry that fails systematically --
      // e.g. always on the tallest pages, if it is a payload limit -- would stay
      // invisible while its page keeps falling back to the generic reason.
    } catch (re) {
      const why = String((re && re.message) || re).slice(0, 140);
      console.warn(`AVC: corrective retry failed for ${slug}: ${why}`);
      trail.push(`corrective retry call failed: ${why}`);
    }
  }
  if (veto) {
    const c0 = realClusters[0] || clusters[0];
    // Keep the rejected claim OUT of the headline reason. Quoting it there put the
    // one sentence this branch just decided was false at the top of the report cell,
    // in red, ahead of its own disclaimer -- it read as the finding (2026-08-11:
    // terms_mobile, "Section '8. Privacy' has been completely removed", reported as
    // the failure reason although the probe had already confirmed section 8 visible).
    // It still belongs in the record: a wrong veto is only spottable by reading the
    // claim, so it moves one click away into the verification trail, not away.
    const discarded = String(parsed.reason || '').slice(0, 200);
    parsed = {
      thought_process: (parsed.thought_process || '') + ` | AUTO-VETO: ${veto}`,
      status: 'FAIL',
      reason: `Visual change detected in ${realClusters.length || clusters.length} region(s) — see highlighted region(s). The AI's description of it failed automated verification and was discarded (verification trail below).`,
      evidence: 'pixel-diff clusters (see highlight boxes)',
      present_in_baseline: true, present_in_new: true,
      defect_region: 0,
      box: { ymin: Math.round(c0.top), xmin: Math.round(c0.left), ymax: Math.round(c0.top + c0.height), xmax: Math.round(c0.left + c0.width) }
    };
    reasonSource = 'pixeldiff-fallback';
    trail.push(`AI description discarded — highlight pinned to pixel-diff region(s) with a generic reason (discarded claim: "${discarded}")`);
  }
}

// Authoritative defect location for the report highlighter: the model's chosen
// pixel-diff region (never its raw coordinates). Null when no region applies
// (veto fallback, tail-zone finding, degraded ungrounded call).
const finalRegionNo = validRegionNo(parsed);

return [{
  json: {
    ai: {
      status: parsed.status,
      reason: parsed.reason,
      box: parsed.box,
      defect_region: parsed.defect_region,
      thought_process: String(parsed.thought_process || '').slice(0, 2000),
      evidence: parsed.evidence,
      present_in_baseline: parsed.present_in_baseline,
      present_in_new: parsed.present_in_new
    },
    modelVersion,
    aiProvider,
    reasonSource,
    defectRegion: finalRegionNo,
    defectRegionRect: finalRegionNo ? clustersForPrompt[finalRegionNo - 1] : null,
    defectRegionInsert: !!(finalRegionNo && realClusters[finalRegionNo - 1] && realClusters[finalRegionNo - 1].insert),
    alignInsertBands: insertBandsKept.length ? insertBandsKept.map(bd => ({ y0: bd.y0, y1: bd.y1, h: bd.h, gapNewLen: bd.gapNewLen })) : null,
    alignCoverage,
    alignSkipReason,
    alignDeleteGaps,
    tailIdentity,
    shiftIdentity: shiftIdentity ? { px: shiftIdentity.px, mismatchPx: shiftIdentity.mismatchPx, deltaPx: shiftIdentity.deltaPx, provenRegions: shiftProvenRegionNos } : null,
    diffClusters: clustersForPrompt,
    verification_trail: trail.length ? trail.join('\n') : null,
    resized_width: resizedWidth,
    mime_type: "image/png"
  }
}];
